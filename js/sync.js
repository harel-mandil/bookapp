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

const DRIVE_PUSH_DEBOUNCE_MS = 4000;
const DRIVE_PUSH_MAX_WAIT_MS = 30000;

let bookFolderId = null;
let bookFileId = null;
let lastSyncAt = 0;
let lastDriveModifiedTime = null;
let pendingDoc = null;
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
  lastSyncAt = await db.metaGet('lastSyncAt', 0);
  lastDriveModifiedTime = await db.metaGet('lastDriveModifiedTime', null);
  emit(auth.isAuthorized() ? 'synced' : 'local');
}

/**
 * Called once after auth completes.
 * Ensures BookApp folder exists, loads remote doc if newer.
 */
export async function reconcileWithDrive(localDoc, applyRemote) {
  emit('syncing');
  try {
    if (!bookFolderId) {
      bookFolderId = await drive.findOrCreateFolder(FOLDER_NAME);
      await db.metaSet('driveFolderId', bookFolderId);
    }

    // Find the file id once if we don't have it.
    if (!bookFileId) {
      const files = await drive.listFiles(bookFolderId);
      const existing = files.find(f => f.name === BOOK_FILE_NAME);
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

/** Mark doc as dirty; schedules a debounced Drive push. */
export function markDirty(doc) {
  pendingDoc = doc;
  if (auth.isAuthorized()) {
    schedulePush();
  }
}

const schedulePush = debounce(() => {
  pushNow().catch(e => console.warn('drive push failed', e));
}, DRIVE_PUSH_DEBOUNCE_MS, { maxWait: DRIVE_PUSH_MAX_WAIT_MS });

/** Force a push immediately (e.g. before page hide). */
export async function pushNow() {
  if (!auth.isAuthorized()) return;
  const doc = pendingDoc;
  if (!doc) return;

  emit('syncing');
  try {
    if (!bookFolderId) {
      bookFolderId = await drive.findOrCreateFolder(FOLDER_NAME);
      await db.metaSet('driveFolderId', bookFolderId);
    }
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
