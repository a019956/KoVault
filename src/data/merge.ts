import type { Syncable } from './types';

/** Last-writer-wins: does the incoming record replace the one we have? */
export function incomingWins(local: Syncable | undefined, incoming: Syncable): boolean {
  if (!local) return true;
  if (incoming.updatedAt !== local.updatedAt) return incoming.updatedAt > local.updatedAt;
  // Same timestamp: a deletion beats an edit so deletes are never silently undone.
  return !!incoming.deleted && !local.deleted;
}

/** Tombstones older than this are dropped from snapshots to keep the vault small. */
export const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export function isExpiredTombstone(r: Syncable, now = Date.now()): boolean {
  return !!r.deleted && now - r.updatedAt > TOMBSTONE_TTL_MS;
}
