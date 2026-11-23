import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Folder, NoteContent, NoteMeta, Task } from './types';

interface KoVaultDB extends DBSchema {
  folders: { key: string; value: Folder };
  notes: { key: string; value: NoteMeta };
  contents: { key: string; value: NoteContent };
  tasks: { key: string; value: Task; indexes: { period: string } };
  kv: { key: string; value: unknown };
}

export type DB = IDBPDatabase<KoVaultDB>;

let dbPromise: Promise<DB> | null = null;

export function getDB(name = 'kovault'): Promise<DB> {
  if (!dbPromise) {
    dbPromise = openDB<KoVaultDB>(name, 1, {
      upgrade(db) {
        db.createObjectStore('folders', { keyPath: 'id' });
        db.createObjectStore('notes', { keyPath: 'id' });
        db.createObjectStore('contents', { keyPath: 'id' });
        const tasks = db.createObjectStore('tasks', { keyPath: 'id' });
        tasks.createIndex('period', 'period');
        db.createObjectStore('kv');
      },
    });
  }
  return dbPromise;
}

/** Test helper: forget the cached connection so a fresh database can be opened. */
export function resetDBForTests(): void {
  dbPromise = null;
}
