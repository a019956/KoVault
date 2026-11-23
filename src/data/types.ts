/** Every synced record carries these fields so devices can merge by last-writer-wins. */
export interface Syncable {
  id: string;
  updatedAt: number;
  /** Tombstone: kept (without content) so deletions propagate through sync. */
  deleted?: boolean;
}

export interface Folder extends Syncable {
  name: string;
  parentId: string | null;
}

/**
 * Lightweight note metadata. This is the only part of a note held in memory;
 * the body and sketch are loaded from IndexedDB on demand.
 */
export interface NoteMeta extends Syncable {
  title: string;
  folderId: string | null;
  labels: string[];
  createdAt: number;
  hasSketch: boolean;
  pinned?: boolean;
}

export interface NoteContent {
  id: string;
  body: string;
  /** Compact stroke encoding produced by strokeCodec.encodeStrokes. */
  sketch: string;
}

export type TaskScope = 'day' | 'week';

export interface Task extends Syncable {
  title: string;
  done: boolean;
  scope: TaskScope;
  /** YYYY-MM-DD. For weekly tasks this is the Monday of the week. */
  period: string;
  order: number;
}

/** Full portable snapshot, used for Drive sync and import/export. */
export interface VaultSnapshot {
  format: 'kovault';
  version: 1;
  exportedAt: number;
  folders: Folder[];
  notes: (NoteMeta & { body: string; sketch: string })[];
  tasks: Task[];
}
