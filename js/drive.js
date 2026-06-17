// ============================================================
// drive.js — Google Drive API v3 client (browser, no backend).
// Uses the drive.file scope: only sees files this app created.
// ============================================================

import { getValidToken } from './auth.js';
import { driveEscape, sleep } from './utils.js';

const META_BASE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files';

/** fetch() wrapper that injects auth + handles rate-limit/transient errors with backoff. */
async function driveFetch(url, init = {}, attempt = 0) {
  const token = await getValidToken();
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  const resp = await fetch(url, { ...init, headers });

  if (resp.ok) return resp;

  // Read error body for diagnostics.
  let errText = '';
  try { errText = await resp.clone().text(); } catch {}

  // 401: token expired → caller must re-auth. Surface immediately.
  if (resp.status === 401) {
    throw Object.assign(new Error('Drive auth expired'), { status: 401, body: errText });
  }
  // 429 / 403 (rate limit) / 5xx → exponential backoff.
  const retriable = resp.status === 429 || resp.status >= 500 ||
    (resp.status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(errText));
  if (retriable && attempt < 5) {
    const wait = Math.min(2 ** attempt * 1000 + Math.random() * 1000, 32000);
    await sleep(wait);
    return driveFetch(url, init, attempt + 1);
  }

  throw Object.assign(new Error(`Drive ${resp.status}: ${errText.slice(0, 300)}`), {
    status: resp.status,
    body: errText,
  });
}

// ============ FOLDERS ============

/** Create a folder. parentId optional. Returns folder metadata. */
export async function createFolder(name, parentId = null) {
  const body = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) body.parents = [parentId];
  const r = await driveFetch(META_BASE + '?fields=id,name', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

/** Find first folder by name (within parentId, or root). Null if none. */
export async function findFolderByName(name, parentId = null) {
  const parts = [
    `name='${driveEscape(name)}'`,
    `mimeType='application/vnd.google-apps.folder'`,
    `trashed=false`,
  ];
  if (parentId) parts.push(`'${driveEscape(parentId)}' in parents`);
  const q = encodeURIComponent(parts.join(' and '));
  const url = `${META_BASE}?q=${q}&fields=files(id,name)`;
  const r = await driveFetch(url);
  const j = await r.json();
  return j.files?.[0] || null;
}

/** Find or create folder. Returns folder id. */
export async function findOrCreateFolder(name, parentId = null) {
  const existing = await findFolderByName(name, parentId);
  if (existing) return existing.id;
  const created = await createFolder(name, parentId);
  return created.id;
}

// ============ FILES ============

/** Multipart upload body builder. CRLF-correct. */
function buildMultipart(boundary, metadata, contentJson) {
  // Note: with drive.file scope, "metadata" includes name + parents (on create only) + mimeType.
  return (
    `\r\n--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    contentJson +
    `\r\n--${boundary}--`
  );
}

/**
 * Save file (create if no fileId, otherwise PATCH). content is a JS object;
 * we serialize it as JSON. Returns { id, name, modifiedTime }.
 */
export async function saveFile({ fileId, name, parentId, content }) {
  const boundary = '-------bookapp_' + (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2));
  const meta = fileId
    ? { name }
    : { name, parents: parentId ? [parentId] : undefined, mimeType: 'application/json' };
  const body = buildMultipart(boundary, meta, JSON.stringify(content));

  const url = fileId
    ? `${UPLOAD_BASE}/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id,name,modifiedTime`
    : `${UPLOAD_BASE}?uploadType=multipart&fields=id,name,modifiedTime`;

  const r = await driveFetch(url, {
    method: fileId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return r.json();
}

/** Download file content as parsed JSON. Throws on parse error. */
export async function loadFile(fileId) {
  const r = await driveFetch(`${META_BASE}/${encodeURIComponent(fileId)}?alt=media`);
  return r.json();
}

/** List files in a folder. */
export async function listFiles(folderId) {
  const q = encodeURIComponent(`'${driveEscape(folderId)}' in parents and trashed=false`);
  const fields = encodeURIComponent('files(id,name,modifiedTime,size)');
  const url = `${META_BASE}?q=${q}&fields=${fields}&orderBy=modifiedTime desc&pageSize=200`;
  const r = await driveFetch(url);
  const j = await r.json();
  return j.files || [];
}

/** Delete a file. */
export async function deleteFile(fileId) {
  await driveFetch(`${META_BASE}/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
}

/** Get file metadata (modifiedTime, size, etc.). Useful for conflict detection. */
export async function fileMeta(fileId) {
  const fields = encodeURIComponent('id,name,modifiedTime,size');
  const r = await driveFetch(`${META_BASE}/${encodeURIComponent(fileId)}?fields=${fields}`);
  return r.json();
}
