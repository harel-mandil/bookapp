// ============================================================
// sync.js — orchestrates IndexedDB ⇄ Google Drive.
//
// The local IndexedDB document is the live working buffer; Drive holds
// the canonical book.json. We push to Drive on a separate, longer debounce
// so we don't burn API quota on every keystroke.
// ============================================================

import * as db from './db.js';
import * as drive from './drive.js';
import * as auth from './auth.js';
import { debounce, fmtTime } from './utils.js';

const FOLDER_NAME = 'BookApp';
const BOOK_FILE_NAME = 'book.json';
export const BOOK_DOCX_NAME = 'book.docx';
export const VERSIONS_FOLDER_NAME = 'versions';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Live working file: keyboard-fast.
const DRIVE_PUSH_DEBOUNCE_MS = 4000;
const DRIVE_PUSH_MAX_WAIT_MS = 30000;

// docx mirror: longer cadence — generation is 200–800ms of CPU and the file
// is for "open in Word" workflows, not live collaboration.
const DOCX_PUSH_DEBOUNCE_MS = 30000;
const DOCX_PUSH_MAX_WAIT_MS = 120000;

let bookFolderId = null;
let bookFileId = null;
let bookDocxFileId = null;
let versionsFolderId = null;
let lastSyncAt = 0;
let lastDriveModifiedTime = null;
let pendingDoc = null;
let lastDocxPushedRevision = null;     // dedupe: skip if doc unchanged
let onStatus = () => {};

/** Subscribe to sync status updates: 'local' | 'syncing' | 'synced' | 'error' */
export function onSyncStatus(cb) { onStatus = cb; }

/**
 * Bootstrap: load cached folder/file IDs from meta.
 * Drive is contacted lazily when the user authorizes.
 */
export async function initSync() {
  bookFolderId = await db.metaGet('driveFolderId');
  bookFileId = await db.metaGet('driveBookFileId');
  bookDocxFileId = await db.metaGet('driveBookDocxFileId');
  versionsFolderId = await db.metaGet('driveVersionsFolderId');
  lastSyncAt = await db.metaGet('lastSyncAt', 0);
  lastDriveModifiedTime = await db.metaGet('lastDriveModifiedTime', null);
  emit(auth.isAuthorized() ? 'synced' : 'local');
}

/** Lazy: ensure the BookApp/ folder exists; cache id in meta. Returns id. */
export async function ensureBookFolder() {
  if (bookFolderId) return bookFolderId;
  bookFolderId = await drive.findOrCreateFolder(FOLDER_NAME);
  await db.metaSet('driveFolderId', bookFolderId);
  return bookFolderId;
}

/** Lazy: ensure BookApp/versions/ exists. Returns id. */
export async function ensureVersionsFolder() {
  if (versionsFolderId) return versionsFolderId;
  const parent = await ensureBookFolder();
  versionsFolderId = await drive.findOrCreateFolder(VERSIONS_FOLDER_NAME, parent);
  await db.metaSet('driveVersionsFolderId', versionsFolderId);
  return versionsFolderId;
}

/** Lazy: resolve (don't create) book.docx file id by listing the BookApp folder. */
export async function ensureDocxMirrorFileId() {
  if (bookDocxFileId) return bookDocxFileId;
  const parent = await ensureBookFolder();
  const existing = await drive.findFileByName(BOOK_DOCX_NAME, parent);
  if (existing) {
    bookDocxFileId = existing.id;
    await db.metaSet('driveBookDocxFileId', bookDocxFileId);
  }
  return bookDocxFileId;
}

/** Set/clear the cached book.docx file id. Used by Phase 2's docx mirror writer. */
export async function setDocxMirrorFileId(id) {
  bookDocxFileId = id;
  if (id) await db.metaSet('driveBookDocxFileId', id);
}

/** Read-only access to the cached IDs (for Phase 2 publishers). */
export function getCachedIds() {
  return { bookFolderId, bookFileId, bookDocxFileId, versionsFolderId };
}

/**
 * Called once after auth completes.
 * Ensures BookApp folder exists, loads remote doc if newer.
 */
export async function reconcileWithDrive(localDoc, applyRemote) {
  emit('syncing');
  try {
    await ensureBookFolder();

    // Find the file id once if we don't have it.
    if (!bookFileId) {
      const existing = await drive.findFileByName(BOOK_FILE_NAME, bookFolderId);
      if (existing) {
        bookFileId = existing.id;
        await db.metaSet('driveBookFileId', bookFileId);
      }
    }

    // Always check Drive's modifiedTime against our last-known sync —
    // catches multi-device edits, not just first connect (review fix H2).
    if (bookFileId) {
      const meta = await drive.fileMeta(bookFileId);
      const driveTime = new Date(meta.modifiedTime).getTime();
      const lastKnown = lastDriveModifiedTime ? new Date(lastDriveModifiedTime).getTime() : 0;
      if (driveTime > lastKnown) {
        // Drive ahead — pull remote.
        const remoteDoc = await drive.loadFile(bookFileId);
        if (remoteDoc && (!localDoc || isMoreRecent(remoteDoc, localDoc))) {
          await applyRemote(remoteDoc);
        }
        lastDriveModifiedTime = meta.modifiedTime;
        await db.metaSet('lastDriveModifiedTime', meta.modifiedTime);
      }
    }

    lastSyncAt = Date.now();
    await db.metaSet('lastSyncAt', lastSyncAt);
    emit('synced');
  } catch (e) {
    console.error('reconcileWithDrive failed', e);
    emit('error', e.message);
    throw e;
  }
}

/** Mark doc as dirty; schedules a debounced Drive push (json + optional docx). */
export function markDirty(doc) {
  pendingDoc = doc;
  if (auth.isAuthorized()) {
    schedulePush();
    schedulePushDocx();
  }
}

const schedulePush = debounce(() => {
  pushNow().catch(e => console.warn('drive push failed', e));
}, DRIVE_PUSH_DEBOUNCE_MS, { maxWait: DRIVE_PUSH_MAX_WAIT_MS });

// docx mirror — gated by the user's Settings toggle, deduped by revision,
// generation deferred to idle time so it never stutters typing.
const schedulePushDocx = debounce(() => {
  pushDocxIfEnabled().catch(e => console.warn('docx mirror push failed', e));
}, DOCX_PUSH_DEBOUNCE_MS, { maxWait: DOCX_PUSH_MAX_WAIT_MS });

async function pushDocxIfEnabled() {
  if (!auth.isAuthorized()) return;
  const enabled = await db.metaGet('mirrorDocxEnabled', false);
  if (!enabled) return;
  const doc = pendingDoc;
  if (!doc) return;
  // Dedupe: skip if doc hasn't changed since last successful docx push.
  const rev = doc.updatedAt || 0;
  if (lastDocxPushedRevision === rev) return;

  // Defer the heavy work to idle time. requestIdleCallback is widely available;
  // fall back to setTimeout for Safari pre-17.4.
  await new Promise(resolve => {
    const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 0));
    idle(() => resolve());
  });

  const { htmlToDocxBlob } = await import('./export.js');
  let blob;
  try {
    blob = await htmlToDocxBlob(doc);
  } catch (e) {
    console.warn('docx generation failed', e);
    return;
  }

  try {
    await ensureBookFolder();
    if (!bookDocxFileId) {
      // Resolve existing first to avoid duplicates if the file was created elsewhere.
      const existing = await drive.findFileByName(BOOK_DOCX_NAME, bookFolderId);
      if (existing) bookDocxFileId = existing.id;
    }
    const r = await drive.saveBlobFile({
      fileId: bookDocxFileId,
      name: BOOK_DOCX_NAME,
      parentId: bookFolderId,
      blob,
      mimeType: DOCX_MIME,
    });
    bookDocxFileId = r.id;
    await db.metaSet('driveBookDocxFileId', bookDocxFileId);
    lastDocxPushedRevision = rev;
  } catch (e) {
    console.warn('docx mirror upload failed', e);
    if (e?.status === 401) {
      window.dispatchEvent(new CustomEvent('auth:needs-reconnect'));
    }
  }
}

/** Force an immediate docx mirror push (e.g. right after publishing). No-op if disabled. */
export async function pushDocxNow() {
  return pushDocxIfEnabled();
}

/** Force a push immediately (e.g. before page hide). */
export async function pushNow() {
  if (!auth.isAuthorized()) return;
  const doc = pendingDoc;
  if (!doc) return;

  emit('syncing');
  try {
    await ensureBookFolder();
    const r = await drive.saveFile({
      fileId: bookFileId,
      name: BOOK_FILE_NAME,
      parentId: bookFolderId,
      content: doc,
    });
    bookFileId = r.id;
    lastDriveModifiedTime = r.modifiedTime;
    lastSyncAt = Date.now();
    await db.metaSet('driveBookFileId', bookFileId);
    await db.metaSet('lastDriveModifiedTime', r.modifiedTime);
    await db.metaSet('lastSyncAt', lastSyncAt);
    pendingDoc = null;
    emit('synced');
  } catch (e) {
    console.error('pushNow failed', e);
    // If the token just expired, surface a reconnect-needed signal so the UI
    // can re-enable the Connect button (review fix H4).
    if (e?.status === 401 || /expired|auth/i.test(e?.message || '')) {
      window.dispatchEvent(new CustomEvent('auth:needs-reconnect'));
    }
    emit('error', e.message);
    // Don't throw — local copy is safe; user will retry on next change.
  }
}

/** Returns ISO modifiedTime of the Drive file the last time we synced. */
export function getDriveStatus() {
  return {
    folderId: bookFolderId,
    fileId: bookFileId,
    lastSyncAt,
    lastSyncLabel: lastSyncAt ? fmtTime(lastSyncAt) : 'never',
    lastDriveModifiedTime,
  };
}

function emit(status, detail = null) {
  try { onStatus(status, detail); } catch {}
}

/**
 * Compare two docs by their `updatedAt` field; remote-wins if remote is newer.
 * Both docs maintain `updatedAt` as a Date.now() value when persisted.
 */
function isMoreRecent(remote, local) {
  return (remote?.updatedAt ?? 0) > (local?.updatedAt ?? 0);
}
