import { Capacitor } from '@capacitor/core';

/**
 * Google sign-in.
 *  - Web: Google Identity Services token client (popup, no backend needed).
 *  - Android: native Credential Manager via @capgo/capacitor-social-login.
 *
 * Only the `drive.file` scope is requested: KoVault can see the files it creates
 * in the user's Drive and nothing else.
 */

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const WEB_SCOPES = `openid email profile ${DRIVE_SCOPE}`;
export const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

export interface GoogleUser {
  email: string;
  name: string;
  picture?: string;
}

interface TokenState {
  token: string;
  expiresAt: number;
}

const USER_KEY = 'kovault.user';
let tokenState: TokenState | null = null;

export function isConfigured(): boolean {
  return GOOGLE_CLIENT_ID.length > 0;
}

export function storedUser(): GoogleUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as GoogleUser) : null;
  } catch {
    return null;
  }
}

function rememberUser(u: GoogleUser | null): void {
  try {
    if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
    else localStorage.removeItem(USER_KEY);
  } catch {
    /* storage unavailable: user just has to sign in again next time */
  }
}

// ---------------- Web (Google Identity Services) ----------------

interface GisTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}
interface GisTokenClient {
  requestAccessToken(overrides?: { prompt?: string; login_hint?: string }): void;
  callback: (r: GisTokenResponse) => void;
  error_callback?: (e: { type: string; message?: string }) => void;
}
declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(cfg: {
            client_id: string;
            scope: string;
            callback: (r: GisTokenResponse) => void;
            error_callback?: (e: { type: string; message?: string }) => void;
          }): GisTokenClient;
          revoke(token: string, done?: () => void): void;
        };
      };
    };
  }
}

let gisLoading: Promise<void> | null = null;
function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisLoading) {
    gisLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        gisLoading = null;
        reject(new Error('Could not load Google sign-in. Check your connection.'));
      };
      document.head.appendChild(s);
    });
  }
  return gisLoading;
}

async function webRequestToken(interactive: boolean, hint?: string): Promise<TokenState> {
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: WEB_SCOPES,
      callback: (r) => {
        if (r.error || !r.access_token) reject(new Error(r.error_description || r.error || 'Sign-in failed'));
        else resolve({ token: r.access_token, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000 });
      },
      error_callback: (e) => reject(new Error(e.message || e.type)),
    });
    client.requestAccessToken({ prompt: interactive ? 'consent' : '', login_hint: hint });
  });
}

async function fetchProfile(token: string): Promise<GoogleUser> {
  const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Could not read Google profile (${r.status})`);
  const p = (await r.json()) as { email: string; name?: string; picture?: string };
  return { email: p.email, name: p.name ?? p.email, picture: p.picture };
}

// ---------------- Android (Capacitor plugin) ----------------

let nativeReady: Promise<void> | null = null;
async function native() {
  const { SocialLogin } = await import('@capgo/capacitor-social-login');
  if (!nativeReady) nativeReady = SocialLogin.initialize({ google: { webClientId: GOOGLE_CLIENT_ID, mode: 'online' } });
  await nativeReady;
  return SocialLogin;
}

async function nativeLogin(): Promise<{ state: TokenState; user: GoogleUser }> {
  const SocialLogin = await native();
  const res = await SocialLogin.login({ provider: 'google', options: { scopes: [DRIVE_SCOPE] } });
  const r = res.result;
  if (r.responseType !== 'online' || !r.accessToken?.token) throw new Error('Google did not grant Drive access');
  // Android access tokens last ~1h; refresh a little early.
  const state = { token: r.accessToken.token, expiresAt: Date.now() + 50 * 60 * 1000 };
  const user = { email: r.profile.email ?? '', name: r.profile.name ?? r.profile.email ?? '', picture: r.profile.imageUrl ?? undefined };
  return { state, user };
}

// ---------------- public API ----------------

export async function signIn(): Promise<GoogleUser> {
  if (!isConfigured()) throw new Error('Google client ID is not configured (VITE_GOOGLE_CLIENT_ID).');
  let user: GoogleUser;
  if (Capacitor.isNativePlatform()) {
    const r = await nativeLogin();
    tokenState = r.state;
    user = r.user;
  } else {
    tokenState = await webRequestToken(true);
    user = await fetchProfile(tokenState.token);
  }
  rememberUser(user);
  return user;
}

export async function signOut(): Promise<void> {
  const t = tokenState?.token;
  tokenState = null;
  rememberUser(null);
  try {
    if (Capacitor.isNativePlatform()) await (await native()).logout({ provider: 'google' });
    else if (t && window.google) window.google.accounts.oauth2.revoke(t);
  } catch {
    /* best effort */
  }
}

/**
 * Returns a valid access token, silently renewing it when possible.
 * `interactive` allows showing the Google prompt again if the silent renew fails.
 */
export async function getAccessToken(interactive = false): Promise<string> {
  if (tokenState && tokenState.expiresAt - 60_000 > Date.now()) return tokenState.token;
  const user = storedUser();
  if (!user) throw new NotSignedInError();
  if (Capacitor.isNativePlatform()) {
    tokenState = (await nativeLogin()).state;
  } else {
    try {
      tokenState = await webRequestToken(false, user.email);
    } catch (e) {
      if (!interactive) throw e;
      tokenState = await webRequestToken(true, user.email);
    }
  }
  return tokenState.token;
}

export function invalidateToken(): void {
  tokenState = null;
}

export class NotSignedInError extends Error {
  constructor() {
    super('Not signed in to Google');
  }
}
