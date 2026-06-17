// ============================================================
// publish.js — "Publish Version" flow.
//
// Writes a snapshot pair (book.json + book.docx) into Drive's
// BookApp/versions/ subfolder under a timestamp-prefixed name, then
// records a kind:'published' snapshot in IndexedDB.
//
// Published snapshots are immortal: snapshots.js's retention sweep
// skips them.
// ============================================================

import * as drive from './drive.js';
import * as sync from './sync.js';
import * as snapshots from './snapshots.js';
import { htmlToDocxBlob, slugify } from './export.js';
import { isoForFilename } from './utils.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Promote the current document to a Published version.
 *
 * Steps:
 *   1. Create the IndexedDB snapshot (kind: 'published') so even if the Drive
 *      writes fail, the user has a local frozen copy.
 *   2. (If authorized) write <iso>_<slug>.json + .docx into BookApp/versions/.
 *
 * @param {string} label  user-supplied version name
 * @param {object} doc    the live book document
 * @returns {Promise<{snapshotId, jsonFileId?, docxFileId?, label, slug, timestamp}>}
 */
export async function publishCurrentVersion(label, doc, { auth } = {}) {
  // 1. Always snapshot locally first — Drive failures shouldn't lose the version.
  const snap = await snapshots.publishVersion(label);
  const slug = slugify(label);
  const stamp = isoForFilename();
  const baseName = `${stamp}_${slug}`;

  // 2. Drive mirroring is best-effort.
  let jsonFileId = null;
  let docxFileId = null;
  try {
    if (auth?.isAuthorized && !auth.isAuthorized()) {
      return { snapshotId: snap.id, label: snap.label, slug, timestamp: snap.timestamp };
    }
    const versionsFolderId = await sync.ensureVersionsFolder();

    // JSON write — full doc payload tagged with the version label.
    const jsonContent = { ...doc, _publishedAs: { label, timestamp: snap.timestamp } };
    const jsonResp = await drive.saveFile({
      name: `${baseName}.json`,
      parentId: versionsFolderId,
      content: jsonContent,
    });
    jsonFileId = jsonResp.id;

    // DOCX write — generated from the live doc.
    const blob = await htmlToDocxBlob(doc, { includeTitlePage: true, includeTOC: true });
    const docxResp = await drive.saveBlobFile({
      name: `${baseName}.docx`,
      parentId: versionsFolderId,
      blob,
      mimeType: DOCX_MIME,
    });
    docxFileId = docxResp.id;
  } catch (e) {
    console.warn('publish: Drive write failed (snapshot still saved locally)', e);
  }

  return {
    snapshotId: snap.id,
    label: snap.label,
    slug,
    timestamp: snap.timestamp,
    jsonFileId,
    docxFileId,
  };
}
