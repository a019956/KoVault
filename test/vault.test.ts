import { beforeEach, describe, expect, it } from 'vitest';
import { Vault } from '../src/data/vault';
import { resetDBForTests } from '../src/data/db';
import { parseQuery } from '../src/data/search';

let n = 0;
async function freshVault(): Promise<Vault> {
  resetDBForTests();
  const v = new Vault(`test-${n++}`);
  await v.load();
  return v;
}

describe('Vault', () => {
  let v: Vault;
  beforeEach(async () => {
    v = await freshVault();
  });

  it('creates folders and notes, and keeps bodies out of memory', async () => {
    const f = await v.createFolder('Work', null);
    const note = await v.createNote(f.id, 'Plan');
    await v.updateNote(note.id, { labels: ['#Project X', 'urgent', 'urgent'] }, { body: 'Ship the thing' });
    const meta = v.notes.get(note.id)!;
    expect(meta.labels).toEqual(['project-x', 'urgent']);
    expect('body' in meta).toBe(false);
    expect((await v.getContent(note.id)).body).toBe('Ship the thing');
  });

  it('deleting a folder deletes subfolders and moves notes to its parent', async () => {
    const a = await v.createFolder('A', null);
    const b = await v.createFolder('B', a.id);
    const c = await v.createFolder('C', b.id);
    const note = await v.createNote(c.id, 'deep');
    await v.deleteFolder(b.id);
    expect(v.liveFolders().map((f) => f.name)).toEqual(['A']);
    expect(v.notes.get(note.id)!.folderId).toBe(a.id);
  });

  it('refuses to move a folder into its own subtree', async () => {
    const a = await v.createFolder('A', null);
    const b = await v.createFolder('B', a.id);
    await v.moveFolder(a.id, b.id);
    expect(v.folders.get(a.id)!.parentId).toBeNull();
  });

  it('searches title and body with label filters', async () => {
    const n1 = await v.createNote(null, 'Groceries');
    await v.updateNote(n1.id, { labels: ['home'] }, { body: 'milk, eggs, bread' });
    const n2 = await v.createNote(null, 'Recipe');
    await v.updateNote(n2.id, { labels: ['home/cooking'] }, { body: 'needs eggs and flour' });
    const n3 = await v.createNote(null, 'Eggs report');
    await v.updateNote(n3.id, { labels: ['work'] }, { body: 'quarterly numbers' });

    const all = await v.search('eggs');
    expect(all.map((h) => h.title)).toEqual(['Eggs report', expect.any(String), expect.any(String)]);
    expect((await v.search('eggs #home')).map((h) => h.title).sort()).toEqual(['Groceries', 'Recipe']);
    expect((await v.search('#home/cooking')).map((h) => h.title)).toEqual(['Recipe']);
    expect(await v.search('eggs flour')).toHaveLength(1);
    expect(await v.search('nothing-here')).toEqual([]);
  });

  it('manages daily and weekly tasks with overdue carry-over', async () => {
    await v.addTask('old', 'day', '2026-01-01');
    const t = await v.addTask('today', 'day', '2026-01-05');
    await v.addTask('week', 'week', '2026-01-05');
    expect(v.tasksFor('day', '2026-01-05').map((x) => x.title)).toEqual(['today']);
    const overdue = v.overdue('day', '2026-01-05');
    expect(overdue.map((x) => x.title)).toEqual(['old']);
    await v.moveTasks(overdue.map((x) => x.id), '2026-01-05');
    await v.updateTask(t.id, { done: true });
    expect(v.tasksFor('day', '2026-01-05').map((x) => x.title)).toEqual(['old', 'today']);
    expect(v.tasksFor('week', '2026-01-05')).toHaveLength(1);
  });

  it('merges snapshots between two devices with last-writer-wins and tombstones', async () => {
    const a = v;
    const shared = await a.createNote(null, 'Shared');
    await a.updateNote(shared.id, {}, { body: 'v1' });
    const doomed = await a.createNote(null, 'Doomed');

    const b = await freshVault();
    let r = await b.applySnapshot(await a.exportSnapshot());
    expect(r.applied).toBe(2);
    expect((await b.getContent(shared.id)).body).toBe('v1');

    await new Promise((res) => setTimeout(res, 5));
    await b.updateNote(shared.id, {}, { body: 'v2 from B' });
    await a.deleteNote(doomed.id);
    const onlyA = await a.createNote(null, 'Only on A');

    // A pulls B's snapshot: gets the newer body, keeps its own delete, and knows B is stale.
    r = await a.applySnapshot(await b.exportSnapshot());
    expect((await a.getContent(shared.id)).body).toBe('v2 from B');
    expect(a.notes.get(doomed.id)!.deleted).toBe(true);
    expect(r.remoteStale).toBe(true);

    // B pulls A's merged snapshot: converges.
    r = await b.applySnapshot(await a.exportSnapshot());
    expect(b.notes.get(doomed.id)!.deleted).toBe(true);
    expect(b.notes.get(onlyA.id)!.title).toBe('Only on A');
    expect(r.remoteStale).toBe(false);
    expect(b.liveNotes().map((x) => x.title).sort()).toEqual(a.liveNotes().map((x) => x.title).sort());
  });

  it('rejects foreign files', async () => {
    await expect(v.applySnapshot({ format: 'x' } as never)).rejects.toThrow();
  });
});

describe('parseQuery', () => {
  it('splits label filters from terms', () => {
    expect(parseQuery('  Foo #Bar baz #')).toEqual({ terms: ['foo', 'baz', '#'], labels: ['bar'] });
  });
});
