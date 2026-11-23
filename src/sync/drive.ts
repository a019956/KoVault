import { getAccessToken, invalidateToken } from './google';

/** Minimal Google Drive v3 REST client (no SDK, keeps the bundle small). */

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER_NAME = 'KoVault';
export const VAULT_FILE = 'kovault-vault.json.gz';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveFile {
  id: string;
  name: string;
  modifiedTime?: string;
  size?: string;
}

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const token = await getAccessToken();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const r = await fetch(url, { ...init, headers });
  if (r.status === 401 && retry) {
    invalidateToken();
    return call(url, init, false);
  }
  if (!r.ok) {
    let detail = '';
    try {
      detail = ((await r.json()) as { error?: { message?: string } }).error?.message ?? '';
    } catch {
      /* not JSON */
    }
    throw new DriveError(`Google Drive error ${r.status}${detail ? `: ${detail}` : ''}`, r.status);
  }
  return r;
}

function q(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function list(query: string): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    q: query,
    spaces: 'drive',
    fields: 'files(id,name,modifiedTime,size)',
    orderBy: 'modifiedTime desc',
    pageSize: '10',
  });
  const r = await call(`${API}/files?${params}`);
  return ((await r.json()) as { files: DriveFile[] }).files;
}

export async function ensureFolder(): Promise<string> {
  const found = await list(`name='${q(FOLDER_NAME)}' and mimeType='${FOLDER_MIME}' and trashed=false`);
  if (found.length) return found[0].id;
  const r = await call(`${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
  });
  return ((await r.json()) as { id: string }).id;
}

export async function findFile(folderId: string, name: string): Promise<DriveFile | null> {
  const found = await list(`name='${q(name)}' and '${q(folderId)}' in parents and trashed=false`);
  return found[0] ?? null;
}

export async function download(fileId: string): Promise<Uint8Array> {
  const r = await call(`${API}/files/${encodeURIComponent(fileId)}?alt=media`);
  return new Uint8Array(await r.arrayBuffer());
}

export async function upload(
  folderId: string,
  name: string,
  data: Uint8Array | string,
  mimeType: string,
  existingId?: string,
): Promise<DriveFile> {
  const blob = new Blob([data as BlobPart], { type: mimeType });
  if (existingId) {
    const r = await call(`${UPLOAD}/files/${encodeURIComponent(existingId)}?uploadType=media&fields=id,name,modifiedTime,size`, {
      method: 'PATCH',
      headers: { 'Content-Type': mimeType },
      body: blob,
    });
    return (await r.json()) as DriveFile;
  }
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ name, parents: [folderId], mimeType })], { type: 'application/json' }));
  form.append('file', blob);
  const r = await call(`${UPLOAD}/files?uploadType=multipart&fields=id,name,modifiedTime,size`, {
    method: 'POST',
    body: form,
  });
  return (await r.json()) as DriveFile;
}
