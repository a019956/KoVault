// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/sync/google', () => ({
  getAccessToken: async () => 'test-token',
  invalidateToken: () => {},
  storedUser: () => ({ email: 'a@example.com', name: 'A' }),
}));

import { Vault } from '../src/data/vault';
import { resetDBForTests } from '../src/data/db';
import { SyncEngine } from '../src/sync/syncEngine';
import { gunzipToText } from '../src/lib/compress';

/** In-memory stand-in for the slice of the Drive v3 REST API that KoVault uses. */
function fakeDrive() {
  const files = new Map<string, { name: string; mimeType: string; parents: string[]; data: Uint8Array }>();
  let next = 1;
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token');
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } });

    if (method === 'GET' && url.pathname === '/drive/v3/files') {
      const q = url.searchParams.get('q')!;
      const name = /name='([^']+)'/.exec(q)![1];
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const out = [...files.entries()]
        .filter(([, f]) => f.name === name && (!parent || f.parents.includes(parent)))
        .map(([id, f]) => ({ id, name: f.name }));
      return json({ files: out });
    }
    if (method === 'POST' && url.pathname === '/drive/v3/files') {
      const meta = JSON.parse(String(init.body));
      const id = `f${next++}`;
      files.set(id, { name: meta.name, mimeType: meta.mimeType, parents: [], data: new Uint8Array() });
      return json({ id });
    }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && m && url.searchParams.get('alt') === 'media') {
      return new Response(files.get(m[1])!.data as BodyInit);
    }
    if (method === 'POST' && url.pathname === '/upload/drive/v3/files') {
      const form = init.body as FormData;
      const meta = JSON.parse(await (form.get('metadata') as Blob).text());
      const id = `f${next++}`;
      files.set(id, { ...meta, data: new Uint8Array(await (form.get('file') as Blob).arrayBuffer()) });
      return json({ id, name: meta.name });
    }
    const u = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (method === 'PATCH' && u) {
      files.get(u[1])!.data = new Uint8Array(await (init.body as Blob).arrayBuffer());
      return json({ id: u[1], name: files.get(u[1])!.name });
    }
    return new Response('not found', { status: 404 });
  };
  return { files, calls, fetchImpl };
}

let dbN = 0;
async function device() {
  resetDBForTests();
  const v = new Vault(`sync-${dbN++}`);
  await v.load();
  return { vault: v, sync: new SyncEngine(v) };
}

describe('Drive sync', () => {
  let drive: ReturnType<typeof fakeDrive>;
  beforeEach(() => {
    drive = fakeDrive();
    vi.stubGlobal('fetch', drive.fetchImpl);
  });

  it('uploads to a KoVault folder and a second device loads it', async () => {
    const phone = await device();
    const f = await phone.vault.createFolder('Journal', null);
    const n = await phone.vault.createNote(f.id, 'Day 1');
    await phone.vault.updateNote(n.id, { labels: ['diary'] }, { body: 'Hello from the phone', sketch: '1BBCAA' });
    await phone.vault.addTask('Buy milk', 'day', '2026-11-23');
    await phone.sync.syncNow();

    const names = [...drive.files.values()].map((x) => x.name).sort();
    expect(names).toEqual(['KoVault', 'kovault-vault.json.gz']);
    const vaultFile = [...drive.files.values()].find((x) => x.name.endsWith('.gz'))!;
    expect(vaultFile.data[0]).toBe(0x1f); // gzipped
    expect(JSON.parse(await gunzipToText(vaultFile.data)).notes).toHaveLength(1);

    const laptop = await device();
    await laptop.sync.syncNow();
    expect(laptop.vault.liveFolders().map((x) => x.name)).toEqual(['Journal']);
    expect(await laptop.vault.getContent(n.id)).toMatchObject({ body: 'Hello from the phone', sketch: '1BBCAA' });
    expect(laptop.vault.tasksFor('day', '2026-11-23')).toHaveLength(1);
    expect(laptop.sync.status.phase).toBe('idle');
  });

  it('does not re-upload when nothing changed, and converges after concurrent edits', async () => {
    const a = await device();
    const note = await a.vault.createNote(null, 'Shared');
    await a.sync.syncNow();
    const b = await device();
    await b.sync.syncNow();

    drive.calls.length = 0;
    await b.sync.syncNow();
    expect(drive.calls.some((c) => c.startsWith('PATCH'))).toBe(false);

    await a.vault.updateNote(note.id, { title: 'Renamed on A' });
    await new Promise((r) => setTimeout(r, 3));
    await b.vault.createNote(null, 'New on B');
    await a.sync.syncNow();
    await b.sync.syncNow();
    await a.sync.syncNow();

    const titles = (v: Vault) => v.liveNotes().map((x) => x.title).sort();
    expect(titles(a.vault)).toEqual(['New on B', 'Renamed on A']);
    expect(titles(b.vault)).toEqual(titles(a.vault));
  });

  it('reports errors in status', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 403 }));
    const a = await device();
    await expect(a.sync.syncNow()).rejects.toThrow(/403: quota/);
    expect(a.sync.status).toMatchObject({ phase: 'error' });
  });
});
