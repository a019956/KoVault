import { getDB, type DB } from './db';
import { incomingWins, isExpiredTombstone } from './merge';
import { matchNote, parseQuery, normalizeLabel } from './search';
import type { Folder, NoteContent, NoteMeta, Task, TaskScope, VaultSnapshot } from './types';
import { newId } from '../lib/ids';

export interface SearchHit {
  id: string;
  title: string;
  snippet: string;
  score: number;
}

type Listener = () => void;

/**
 * The vault keeps only small metadata (folders, note titles/labels, tasks) in memory.
 * Note bodies and sketches stay in IndexedDB and are read one at a time when a note is
 * opened or while a search streams through them with a cursor.
 */
export class Vault {
  folders = new Map<string, Folder>();
  notes = new Map<string, NoteMeta>();
  tasks = new Map<string, Task>();
  /** note id → updatedAt of the version last written by a sync/import (lets open editors reload). */
  remoteApplied = new Map<string, number>();

  private version = 0;
  private listeners = new Set<Listener>();
  private changeHooks = new Set<Listener>();
  private db!: DB;

  constructor(private dbName = 'kovault') {}

  async load(): Promise<void> {
    this.db = await getDB(this.dbName);
    const [folders, notes, tasks] = await Promise.all([
      this.db.getAll('folders'),
      this.db.getAll('notes'),
      this.db.getAll('tasks'),
    ]);
    folders.forEach((f) => this.folders.set(f.id, f));
    notes.forEach((n) => this.notes.set(n.id, n));
    tasks.forEach((t) => this.tasks.set(t.id, t));
    this.emit(false);
  }

  // ---- subscription (React useSyncExternalStore) ----
  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = (): number => this.version;

  /** Called after every local edit (used to schedule a Drive sync). */
  onLocalChange(fn: Listener): () => void {
    this.changeHooks.add(fn);
    return () => this.changeHooks.delete(fn);
  }

  private emit(local = true): void {
    this.version++;
    this.listeners.forEach((l) => l());
    if (local) this.changeHooks.forEach((l) => l());
  }

  // ---- key/value settings ----
  async getSetting<T>(key: string): Promise<T | undefined> {
    return (await this.db.get('kv', key)) as T | undefined;
  }
  async setSetting(key: string, value: unknown): Promise<void> {
    await this.db.put('kv', value, key);
  }

  // ---- folders ----
  liveFolders(): Folder[] {
    return [...this.folders.values()].filter((f) => !f.deleted).sort((a, b) => a.name.localeCompare(b.name));
  }

  async createFolder(name: string, parentId: string | null): Promise<Folder> {
    const f: Folder = { id: newId(), name: name.trim() || 'New folder', parentId, updatedAt: Date.now() };
    this.folders.set(f.id, f);
    await this.db.put('folders', f);
    this.emit();
    return f;
  }

  async renameFolder(id: string, name: string): Promise<void> {
    const f = this.folders.get(id);
    if (!f || !name.trim()) return;
    const next = { ...f, name: name.trim(), updatedAt: Date.now() };
    this.folders.set(id, next);
    await this.db.put('folders', next);
    this.emit();
  }

  async moveFolder(id: string, parentId: string | null): Promise<void> {
    const f = this.folders.get(id);
    if (!f || id === parentId) return;
    // Refuse to move a folder inside its own subtree.
    for (let p = parentId; p; p = this.folders.get(p)?.parentId ?? null) if (p === id) return;
    const next = { ...f, parentId, updatedAt: Date.now() };
    this.folders.set(id, next);
    await this.db.put('folders', next);
    this.emit();
  }

  /** Deletes a folder and its subfolders. Notes inside are moved up to the deleted folder's parent. */
  async deleteFolder(id: string): Promise<void> {
    const root = this.folders.get(id);
    if (!root) return;
    const doomed = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of this.folders.values()) {
        if (!f.deleted && f.parentId && doomed.has(f.parentId) && !doomed.has(f.id)) {
          doomed.add(f.id);
          grew = true;
        }
      }
    }
    const now = Date.now();
    const tx = this.db.transaction(['folders', 'notes'], 'readwrite');
    for (const fid of doomed) {
      const f = { ...this.folders.get(fid)!, deleted: true, updatedAt: now };
      this.folders.set(fid, f);
      tx.objectStore('folders').put(f);
    }
    for (const n of this.notes.values()) {
      if (n.folderId && doomed.has(n.folderId)) {
        const moved = { ...n, folderId: root.parentId, updatedAt: now };
        this.notes.set(n.id, moved);
        tx.objectStore('notes').put(moved);
      }
    }
    await tx.done;
    this.emit();
  }

  folderPath(id: string | null): string {
    const parts: string[] = [];
    for (let f = id ? this.folders.get(id) : undefined; f; f = f.parentId ? this.folders.get(f.parentId) : undefined) {
      parts.unshift(f.name);
    }
    return parts.join(' / ');
  }

  // ---- notes ----
  liveNotes(): NoteMeta[] {
    return [...this.notes.values()].filter((n) => !n.deleted);
  }

  async createNote(folderId: string | null, title = 'Untitled', labels: string[] = []): Promise<NoteMeta> {
    const now = Date.now();
    const meta: NoteMeta = { id: newId(), title, folderId, labels, createdAt: now, updatedAt: now, hasSketch: false };
    this.notes.set(meta.id, meta);
    const tx = this.db.transaction(['notes', 'contents'], 'readwrite');
    tx.objectStore('notes').put(meta);
    tx.objectStore('contents').put({ id: meta.id, body: '', sketch: '' });
    await tx.done;
    this.emit();
    return meta;
  }

  async getContent(id: string): Promise<NoteContent> {
    return (await this.db.get('contents', id)) ?? { id, body: '', sketch: '' };
  }

  async updateNote(
    id: string,
    patch: Partial<Pick<NoteMeta, 'title' | 'folderId' | 'labels' | 'pinned'>>,
    content?: Partial<Pick<NoteContent, 'body' | 'sketch'>>,
  ): Promise<number | undefined> {
    if (!this.notes.get(id) || this.notes.get(id)!.deleted) return;
    const tx = this.db.transaction(['notes', 'contents'], 'readwrite');
    let hasSketch: boolean | undefined;
    if (content) {
      const old = (await tx.objectStore('contents').get(id)) ?? { id, body: '', sketch: '' };
      const merged = { ...old, ...content };
      hasSketch = merged.sketch.length > 0;
      tx.objectStore('contents').put(merged);
    }
    // Read the in-memory meta only after the await so concurrent edits don't clobber each other.
    const meta = this.notes.get(id)!;
    const next: NoteMeta = { ...meta, ...patch, updatedAt: Math.max(Date.now(), meta.updatedAt + 1) };
    if (hasSketch !== undefined) next.hasSketch = hasSketch;
    if (patch.labels) next.labels = [...new Set(patch.labels.map(normalizeLabel).filter(Boolean))];
    this.notes.set(id, next);
    tx.objectStore('notes').put(next);
    this.emit(); // in-memory state is already current; don't make the UI wait for disk
    await tx.done;
    return next.updatedAt;
  }

  async deleteNote(id: string): Promise<void> {
    const meta = this.notes.get(id);
    if (!meta) return;
    const next: NoteMeta = { ...meta, deleted: true, labels: [], hasSketch: false, updatedAt: Date.now() };
    this.notes.set(id, next);
    const tx = this.db.transaction(['notes', 'contents'], 'readwrite');
    tx.objectStore('notes').put(next);
    tx.objectStore('contents').delete(id);
    await tx.done;
    this.emit();
  }

  findNoteByTitle(title: string): NoteMeta | undefined {
    const t = title.trim().toLowerCase();
    return this.liveNotes().find((n) => n.title.trim().toLowerCase() === t);
  }

  // ---- labels ----
  labelCounts(): [string, number][] {
    const counts = new Map<string, number>();
    for (const n of this.notes.values()) {
      if (n.deleted) continue;
      for (const l of n.labels) counts.set(l, (counts.get(l) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  // ---- search ----
  /** Streams note bodies through a cursor so memory stays flat regardless of vault size. */
  async search(query: string, limit = 100): Promise<SearchHit[]> {
    const { terms, labels } = parseQuery(query);
    if (!terms.length && !labels.length) return [];
    const candidates = new Map<string, NoteMeta>();
    for (const n of this.notes.values()) {
      if (n.deleted) continue;
      if (labels.every((l) => n.labels.some((nl) => nl === l || nl.startsWith(l + '/')))) candidates.set(n.id, n);
    }
    const hits: SearchHit[] = [];
    if (!terms.length) {
      for (const n of candidates.values()) hits.push({ id: n.id, title: n.title, snippet: '', score: 0 });
    } else {
      let cursor = await this.db.transaction('contents').store.openCursor();
      while (cursor) {
        const meta = candidates.get(cursor.key);
        if (meta) {
          const m = matchNote(meta.title, cursor.value.body, terms);
          if (m) hits.push({ id: meta.id, title: meta.title, ...m });
        }
        cursor = await cursor.continue();
      }
    }
    hits.sort((a, b) => b.score - a.score || (this.notes.get(b.id)!.updatedAt - this.notes.get(a.id)!.updatedAt));
    return hits.slice(0, limit);
  }

  // ---- tasks ----
  tasksFor(scope: TaskScope, period: string): Task[] {
    return [...this.tasks.values()]
      .filter((t) => !t.deleted && t.scope === scope && t.period === period)
      .sort((a, b) => Number(a.done) - Number(b.done) || a.order - b.order);
  }

  /** Unfinished tasks from earlier periods of the same scope. */
  overdue(scope: TaskScope, period: string): Task[] {
    return [...this.tasks.values()]
      .filter((t) => !t.deleted && !t.done && t.scope === scope && t.period < period)
      .sort((a, b) => a.period.localeCompare(b.period) || a.order - b.order);
  }

  async addTask(title: string, scope: TaskScope, period: string): Promise<Task> {
    const existing = this.tasksFor(scope, period);
    const t: Task = {
      id: newId(),
      title: title.trim(),
      done: false,
      scope,
      period,
      order: existing.length ? Math.max(...existing.map((e) => e.order)) + 1 : 0,
      updatedAt: Date.now(),
    };
    this.tasks.set(t.id, t);
    this.emit(); // update the UI immediately; persistence follows
    await this.db.put('tasks', t);
    return t;
  }

  async updateTask(id: string, patch: Partial<Pick<Task, 'title' | 'done' | 'period' | 'order'>>): Promise<void> {
    const t = this.tasks.get(id);
    if (!t) return;
    const next = { ...t, ...patch, updatedAt: Date.now() };
    this.tasks.set(id, next);
    this.emit(); // update the UI immediately; persistence follows
    await this.db.put('tasks', next);
  }

  async moveTasks(ids: string[], period: string): Promise<void> {
    const now = Date.now();
    const tx = this.db.transaction('tasks', 'readwrite');
    for (const id of ids) {
      const t = this.tasks.get(id);
      if (!t) continue;
      const next = { ...t, period, updatedAt: now };
      this.tasks.set(id, next);
      tx.store.put(next);
    }
    await tx.done;
    this.emit();
  }

  async deleteTask(id: string): Promise<void> {
    const t = this.tasks.get(id);
    if (!t) return;
    const next = { ...t, deleted: true, title: '', updatedAt: Date.now() };
    this.tasks.set(id, next);
    this.emit(); // update the UI immediately; persistence follows
    await this.db.put('tasks', next);
  }

  // ---- snapshot / sync ----
  async exportSnapshot(): Promise<VaultSnapshot> {
    const now = Date.now();
    const contents = new Map((await this.db.getAll('contents')).map((c) => [c.id, c]));
    const keep = (r: { id: string; updatedAt: number; deleted?: boolean }) => !isExpiredTombstone(r, now);
    return {
      format: 'kovault',
      version: 1,
      exportedAt: now,
      folders: [...this.folders.values()].filter(keep),
      notes: [...this.notes.values()].filter(keep).map((n) => {
        const c = contents.get(n.id);
        return { ...n, body: n.deleted ? '' : c?.body ?? '', sketch: n.deleted ? '' : c?.sketch ?? '' };
      }),
      tasks: [...this.tasks.values()].filter(keep),
    };
  }

  /**
   * Merge a snapshot (from Drive or an import file) into the local vault.
   * Returns how many local records changed and whether the remote is missing anything we have.
   */
  async applySnapshot(snap: VaultSnapshot): Promise<{ applied: number; remoteStale: boolean }> {
    if (snap.format !== 'kovault' || snap.version !== 1) throw new Error('Not a KoVault backup');
    let applied = 0;
    const tx = this.db.transaction(['folders', 'notes', 'contents', 'tasks'], 'readwrite');

    for (const f of snap.folders) {
      if (incomingWins(this.folders.get(f.id), f)) {
        this.folders.set(f.id, f);
        tx.objectStore('folders').put(f);
        applied++;
      }
    }
    for (const { body, sketch, ...meta } of snap.notes) {
      if (incomingWins(this.notes.get(meta.id), meta)) {
        this.notes.set(meta.id, meta);
        this.remoteApplied.set(meta.id, meta.updatedAt);
        tx.objectStore('notes').put(meta);
        if (meta.deleted) tx.objectStore('contents').delete(meta.id);
        else tx.objectStore('contents').put({ id: meta.id, body, sketch });
        applied++;
      }
    }
    for (const t of snap.tasks) {
      if (incomingWins(this.tasks.get(t.id), t)) {
        this.tasks.set(t.id, t);
        tx.objectStore('tasks').put(t);
        applied++;
      }
    }
    await tx.done;

    // The remote needs an upload if we hold anything it lacks or anything newer than it.
    const remoteTimes = new Map<string, number>();
    [...snap.folders, ...snap.notes, ...snap.tasks].forEach((r) => remoteTimes.set(r.id, r.updatedAt));
    let remoteStale = false;
    for (const r of [...this.folders.values(), ...this.notes.values(), ...this.tasks.values()]) {
      if (isExpiredTombstone(r)) continue;
      const rt = remoteTimes.get(r.id);
      if (rt === undefined || rt < r.updatedAt) {
        remoteStale = true;
        break;
      }
    }

    if (applied) this.emit(false);
    return { applied, remoteStale };
  }
}

export const vault = new Vault();
