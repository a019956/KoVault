import { gunzipToText, gzip } from '../lib/compress';
import type { VaultSnapshot } from '../data/types';
import type { Vault } from '../data/vault';
import { ensureFolder, findFile, download, upload, VAULT_FILE } from './drive';
import { storedUser } from './google';

export type SyncPhase = 'off' | 'idle' | 'syncing' | 'error';

export interface SyncStatus {
  phase: SyncPhase;
  lastSyncedAt?: number;
  message?: string;
}

type Listener = () => void;

const LAST_SYNC_KEY = 'sync.lastSyncedAt';
const FILE_ID_KEY = 'sync.fileId';
const DEBOUNCE_MS = 4000;
const PERIODIC_MS = 5 * 60 * 1000;

/**
 * Keeps the local vault and a single gzipped snapshot file in the user's Drive in step:
 * download → merge (last-writer-wins per record) → upload only if the remote is behind.
 */
export class SyncEngine {
  status: SyncStatus = { phase: 'off' };
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private vault: Vault) {}

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getStatus = () => this.status;

  private set(s: Partial<SyncStatus>) {
    this.status = { ...this.status, ...s };
    this.listeners.forEach((l) => l());
  }

  async start(): Promise<void> {
    const last = await this.vault.getSetting<number>(LAST_SYNC_KEY);
    this.set({ phase: storedUser() ? 'idle' : 'off', lastSyncedAt: last });
    this.vault.onLocalChange(() => this.schedule());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.schedule(500);
    });
    window.addEventListener('online', () => this.schedule(500));
    this.interval = setInterval(() => this.schedule(0), PERIODIC_MS);
    if (storedUser()) this.schedule(300);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
  }

  /** Debounced sync request. No-op when signed out. */
  schedule(delay = DEBOUNCE_MS): void {
    if (!storedUser()) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.syncNow().catch(() => {}), delay);
  }

  async signedOut(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.vault.setSetting(FILE_ID_KEY, undefined);
    this.set({ phase: 'off', message: undefined });
  }

  /** Run a full sync. Concurrent calls coalesce into one extra pass. */
  syncNow(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async pass(): Promise<void> {
    if (!storedUser()) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.set({ phase: 'error', message: 'Offline — changes are saved on this device and will sync later.' });
      return;
    }
    this.set({ phase: 'syncing', message: undefined });
    try {
      const folderId = await ensureFolder();
      const file = await findFile(folderId, VAULT_FILE);
      let needsUpload = true;
      if (file) {
        const remote = JSON.parse(await gunzipToText(await download(file.id))) as VaultSnapshot;
        const { remoteStale } = await this.vault.applySnapshot(remote);
        needsUpload = remoteStale;
      }
      if (needsUpload) {
        const snap = await this.vault.exportSnapshot();
        const saved = await upload(folderId, VAULT_FILE, await gzip(JSON.stringify(snap)), 'application/gzip', file?.id);
        await this.vault.setSetting(FILE_ID_KEY, saved.id);
      }
      const now = Date.now();
      await this.vault.setSetting(LAST_SYNC_KEY, now);
      this.set({ phase: 'idle', lastSyncedAt: now, message: undefined });
    } catch (e) {
      let message = e instanceof Error ? e.message : String(e);
      if (/popup|not signed in|expired|access_denied/i.test(message)) message = 'Google session expired — tap ⟳ to reconnect.';
      this.set({ phase: 'error', message });
      throw e;
    }
  }
}
