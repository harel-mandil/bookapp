// ============================================================
// auth.js — Google Identity Services (GIS) token client.
// Single-user browser OAuth, no backend.
// ============================================================

const SCOPE = 'https://www.googleapis.com/auth/drive.file';

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;
let clientId = null;

/** Wait for window.google.accounts.oauth2 (the GIS script loads async). */
function waitForGis(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const start = Date.now();
    const id = setInterval(() => {
      if (window.google?.accounts?.oauth2) { clearInterval(id); resolve(); return; }
      if (Date.now() - start > timeoutMs) {
        clearInterval(id);
        reject(new Error('Google Identity Services failed to load (timeout). Check internet connection or content blockers.'));
      }
    }, 50);
  });
}

/** Initialize the token client. Safe to call multiple times. */
export async function initAuth(idFromSettings) {
  clientId = idFromSettings;
  if (!clientId) throw new Error('No OAuth Client ID configured.');
  await waitForGis();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPE,
    callback: () => {}, // overridden per-request via callback override
    error_callback: (err) => {
      console.error('GIS error:', err);
      window.dispatchEvent(new CustomEvent('auth:error', { detail: err }));
    },
  });
  return true;
}

/** Returns true if we currently have a non-expired token. */
export function isAuthorized() {
  return !!accessToken && Date.now() < tokenExpiresAt - 30 * 1000;
}

/**
 * Trigger the OAuth popup. MUST be called from a user-gesture click handler
 * the first time, or popup blockers will eat it.
 *
 * Concurrent calls are serialized — second caller awaits the first's result
 * (review fix H1). The error_callback rejects the in-flight promise so a
 * closed popup or third-party-cookie block surfaces fast (review fix H5).
 *
 * @param {{ silent?: boolean }} [opts] silent: try without consent UI
 */
let inFlight = null;
export function authorize({ silent = false } = {}) {
  if (!tokenClient) throw new Error('Auth not initialized. Provide a Client ID first.');
  if (inFlight) return inFlight;
  inFlight = new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      inFlight = null;
      if (resp.error) {
        reject(new Error(resp.error_description || resp.error));
        return;
      }
      accessToken = resp.access_token;
      tokenExpiresAt = Date.now() + (resp.expires_in * 1000);
      window.dispatchEvent(new CustomEvent('auth:ready'));
      resolve(accessToken);
    };
    tokenClient.error_callback = (err) => {
      inFlight = null;
      window.dispatchEvent(new CustomEvent('auth:error', { detail: err }));
      reject(new Error(err?.message || err?.type || 'OAuth failed (popup closed or cookies blocked).'));
    };
    // First-time interactive consent vs silent reuse:
    // 'consent' forces the OAuth popup; '' tries silent (still pops a brief popup).
    tokenClient.requestAccessToken({
      prompt: silent || accessToken ? '' : 'consent',
    });
  });
  return inFlight;
}

/**
 * Returns a valid access token, silently refreshing if near expiry.
 * On failure (cookies cleared, ITP, revoked), throws — caller should
 * surface a "Reconnect Drive" UI.
 */
export async function getValidToken() {
  if (isAuthorized()) return accessToken;
  if (!tokenClient) throw new Error('Auth not initialized.');
  // Try silent refresh first.
  try {
    return await authorize({ silent: true });
  } catch (e) {
    // Caller is responsible for re-prompting interactively (must be user-gesture).
    throw new Error('Drive token expired. Click "Reconnect Drive".');
  }
}

/** Sign out — discard the in-memory token. (We do not revoke the grant; user can do that in their Google account.) */
export function signOut() {
  accessToken = null;
  tokenExpiresAt = 0;
  window.dispatchEvent(new CustomEvent('auth:signout'));
}

/** Diagnostics dump. */
export function authDiag() {
  return {
    clientIdConfigured: !!clientId,
    isAuthorized: isAuthorized(),
    expiresInSec: tokenExpiresAt ? Math.max(0, Math.round((tokenExpiresAt - Date.now()) / 1000)) : 0,
    gisLoaded: !!window.google?.accounts?.oauth2,
  };
}
