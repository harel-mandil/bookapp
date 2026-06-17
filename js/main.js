// ============================================================
// main.js — entry point. Wires all modules + the UI.
//
// Boot sequence:
//   1. Open IndexedDB.
//   2. Load the live document (or create a starter one).
//   3. Mount the editor.
//   4. Set up sidebar + view routing.
//   5. Initialize sync, and if a Drive client ID is configured,
//      initialize auth in the background (NOT auto-popup — user clicks).
//   6. Set up auto-save: editor → IndexedDB (fast) → Drive (slower).
//   7. Set up snapshot scheduler.
//   8. Render dashboard.
//   9. Attach beforeunload / pagehide handlers.
// ============================================================

import * as db from './db.js';
import * as auth from './auth.js';
import * as sync from './sync.js';
import * as snapshots from './snapshots.js';
import * as exportLib from './export.js';
import { publishCurrentVersion } from './publish.js';
import { docxBlobToHtml, splitHtmlByH1 } from './import.js';
import { mountEditor, loadChapter, snapshotChapter, flushPending as flushEditor, cancelPending as cancelEditor } from './editor.js';
import { sanitizeHtml } from './format.js';
import { renderDashboard } from './dashboard.js';
import { logEvent, checkWordMilestones, checkReEntry, renderTimeline } from './journey.js';
import { stats, totalStats, wordsOf } from './stats.js';
import { uid, todayKey, toast, fmtTime, debounce, escapeHtml, isoForFilename } from './utils.js';

// ============ APP STATE ============

const state = {
  doc: null,                    // { id, title, chapters: [], updatedAt, ... }
  activeChapterId: null,
  activeView: 'dashboard',
  prevTotalWords: 0,            // for milestone tracking
  historyFilter: 'all',         // 'all' | 'auto' | 'published'
};

// ============ BOOT ============

async function boot() {
  await db.persistStorage().catch(() => {});

  // Load doc (or create a starter)
  let doc = await db.docLoad();
  if (!doc) {
    doc = createStarterDoc();
    await db.docSave(doc);
  }
  state.doc = doc;
  state.prevTotalWords = totalStats(doc.chapters || []).words;
  state.activeChapterId = doc.chapters[0]?.id || null;

  // Mount editor
  mountEditor({
    editorEl: document.getElementById('editor'),
    titleEl: document.getElementById('chapter-title-input'),
    toolbarEl: document.querySelector('.editor-toolbar'),
    onChange: handleEditorChange,
  });

  if (state.activeChapterId) {
    const c = doc.chapters.find(c => c.id === state.activeChapterId);
    if (c) loadChapter(c);
  }

  // Page header reflects book + chapter title
  refreshPageHeader();

  // Sidebar + nav
  setupNav();
  renderSidebarChapters();
  loadSettingsForm();
  refreshSyncStatus('local');

  // Sync init
  await sync.initSync();
  sync.onSyncStatus(refreshSyncStatus);

  // Snapshot scheduler
  await snapshots.initSnapshots({
    getDoc: () => state.doc,
    onSnap: () => { if (state.activeView === 'history') renderHistory(); },
  });

  // Auth init in background if client ID exists
  const clientId = await db.metaGet('googleClientId');
  if (clientId) {
    auth.initAuth(clientId).then(() => {
      // Try silent token refresh — quietly succeeds if user previously consented in this browser session.
      // We DON'T popup automatically; the user clicks "Connect" to start.
      updateConnectButton();
    }).catch(e => console.warn('auth init failed', e));
  }
  updateConnectButton();

  // Dashboard
  await renderDashboard(state.doc);

  // Journey re-entry check
  checkReEntry().catch(() => {});

  // Persistence safety: flush before tab hide.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushAll();
    }
  });
  window.addEventListener('pagehide', () => flushAll());

  // Wire toast for errors
  window.addEventListener('auth:error', (e) => {
    toast('Drive auth error: ' + (e.detail?.type || 'unknown'), 'error');
  });

  // When sync detects a 401, the Connect button comes back to life.
  window.addEventListener('auth:needs-reconnect', () => {
    updateConnectButton();
    toast('Drive disconnected. Click "Connect Google Drive" to reconnect.', 'error', 5000);
  });

  // Diagnostics panel
  document.getElementById('diagnostics-btn').addEventListener('click', openDiagnostics);
  document.getElementById('diag-close').addEventListener('click', () => {
    document.getElementById('diag-overlay').hidden = true;
  });
  document.getElementById('diag-copy').addEventListener('click', copyDiagnostics);

  // Connect Drive button (only one across the app)
  document.getElementById('connect-drive-btn').addEventListener('click', onConnectDriveClick);

  // Settings form actions
  document.getElementById('save-client-id-btn').addEventListener('click', saveClientId);
  document.getElementById('edit-goal-btn').addEventListener('click', editDailyGoal);
  document.getElementById('reset-app-btn').addEventListener('click', resetEverything);
  document.getElementById('export-json-btn').addEventListener('click', () => exportLib.exportBookJson(state.doc));
  document.getElementById('import-json-btn').addEventListener('click', () => {
    document.getElementById('import-file-input').click();
  });
  document.getElementById('import-file-input').addEventListener('change', importJson);

  // Mirror docx toggle (off by default).
  const mirrorEl = document.getElementById('setting-mirror-docx');
  if (mirrorEl) {
    mirrorEl.checked = !!(await db.metaGet('mirrorDocxEnabled', false));
    mirrorEl.addEventListener('change', async (e) => {
      await db.metaSet('mirrorDocxEnabled', e.target.checked);
      if (e.target.checked && auth.isAuthorized()) {
        sync.markDirty(state.doc); // schedules first docx push
        toast('Drive will receive book.docx within ~30 s.', 'success');
      } else if (e.target.checked) {
        toast('Connect Google Drive first — mirror is enabled but inactive.', 'warning', 4000);
      } else {
        toast('book.docx mirror disabled.', '');
      }
    });
  }

  // Export dropdown menu
  setupExportMenu();
  // Publish version button + modal
  setupPublishFlow();

  // Settings live-update wiring
  document.getElementById('setting-book-title').addEventListener('input', e => {
    state.doc.title = e.target.value;
    document.getElementById('book-title-display').textContent = state.doc.title || 'Untitled Book';
    document.getElementById('page-header-book').textContent = (state.doc.title || '').toUpperCase();
    persistDocSoon();
  });
  document.getElementById('setting-daily-goal').addEventListener('change', async (e) => {
    const v = Math.max(0, parseInt(e.target.value, 10) || 0);
    await db.metaSet('dailyGoal', v);
    if (state.activeView === 'dashboard') renderDashboard(state.doc);
  });
  document.getElementById('setting-total-target').addEventListener('change', async (e) => {
    await db.metaSet('totalTarget', parseInt(e.target.value, 10) || 0);
  });
  document.getElementById('setting-deadline').addEventListener('change', async (e) => {
    await db.metaSet('deadline', e.target.value || null);
  });

  // Add chapter
  document.getElementById('add-chapter-btn').addEventListener('click', addChapter);
  // Add chapter from .docx (sidebar quick action — skips the modal, always one-chapter)
  setupQuickDocxImport();
  // Settings → Import .docx (full modal with mode picker)
  setupSettingsDocxImport();
  // Drag-and-drop .docx onto the chapters list
  setupChapterListDropZone();

  // Ideas
  document.getElementById('add-idea-btn').addEventListener('click', addIdeaFromInput);
  document.getElementById('idea-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addIdeaFromInput();
  });

  // Listen for nav-to-chapter from dashboard table
  window.addEventListener('nav:chapter', (e) => {
    setActiveChapter(e.detail.chapterId);
    setActiveView('book');
  });
}

// ============ DOC / EDITOR PLUMBING ============

/**
 * Defensive sanitizer for any doc that wasn't created in-app this session.
 * Strips scripts / event handlers / dangerous URLs from chapter HTML.
 * Applied to: imported JSON files, restored snapshots, Drive-loaded docs.
 */
function sanitizeDoc(doc) {
  if (!doc || !Array.isArray(doc.chapters)) return doc;
  return {
    ...doc,
    chapters: doc.chapters.map(c => ({
      ...c,
      html: sanitizeHtml(c.html || ''),
    })),
  };
}

function createStarterDoc() {
  const firstChId = uid('ch_');
  return {
    id: uid('book_'),
    title: 'Untitled Book',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 1,
    chapters: [
      {
        id: firstChId,
        title: 'Chapter 1',
        html: '<p><br></p>',
        status: 'drafting',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  };
}

/** Editor change → update doc, persist locally, schedule Drive push. */
function handleEditorChange(updatedChapter) {
  if (!state.activeChapterId) return;
  const idx = state.doc.chapters.findIndex(c => c.id === state.activeChapterId);
  if (idx < 0) return;

  const before = state.doc.chapters[idx];
  const beforeWords = wordsOf(before);

  state.doc.chapters[idx] = {
    ...before,
    title: updatedChapter.title,
    html: updatedChapter.html,
    updatedAt: Date.now(),
  };
  state.doc.updatedAt = Date.now();

  const afterWords = wordsOf(state.doc.chapters[idx]);
  const wordDelta = afterWords - beforeWords;

  // Update today's session
  updateTodaySession(wordDelta).catch(() => {});

  // Milestones
  const newTotal = totalStats(state.doc.chapters).words;
  checkWordMilestones(newTotal, state.prevTotalWords).catch(() => {});
  state.prevTotalWords = newTotal;

  // Reflect in sidebar
  renderSidebarChapters();

  // Reflect in page header chapter title
  document.getElementById('page-header-chapter').textContent = (updatedChapter.title || '').toUpperCase();

  persistDocSoon();
  snapshots.noteChange();
}

/** Persist doc to IndexedDB (fast) + schedule Drive push (slower). */
const persistDocSoon = debounce(async () => {
  showSaveIndicator('saving');
  try {
    await db.docSave(state.doc);
    showSaveIndicator('saved');
    sync.markDirty(state.doc);
  } catch (e) {
    console.error('persist failed', e);
    showSaveIndicator('error');
  }
}, 350, { maxWait: 3000 });

/** Updates today's session row with the most recent word delta. */
async function updateTodaySession(wordDelta) {
  const date = todayKey();
  const existing = (await db.sessionGet(date)) || {
    date, wordsAdded: 0, wordsRemoved: 0, msActive: 0, sessions: 0, firstActiveAt: Date.now(),
  };
  if (wordDelta > 0) existing.wordsAdded = (existing.wordsAdded || 0) + wordDelta;
  if (wordDelta < 0) existing.wordsRemoved = (existing.wordsRemoved || 0) + Math.abs(wordDelta);
  existing.lastActiveAt = Date.now();
  await db.sessionUpsert(date, existing);
}

// ============ NAV / VIEWS ============

function setupNav() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => setActiveView(btn.dataset.view));
  });
}

function setActiveView(view) {
  state.activeView = view;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  document.getElementById('view-title').textContent =
    { dashboard: 'Dashboard', book: 'The Book', journey: 'Journey', ideas: 'Ideas', history: 'Version History', settings: 'Settings' }[view] || view;

  if (view === 'dashboard') renderDashboard(state.doc);
  if (view === 'journey') renderTimeline();
  if (view === 'ideas') renderIdeas();
  if (view === 'history') renderHistory();
  if (view === 'settings') {
    loadSettingsForm();
    refreshStorageInfo();
  }
}

function renderSidebarChapters() {
  const ul = document.getElementById('chapters-list');
  if (!ul) return;
  ul.innerHTML = state.doc.chapters.map(c => {
    const isActive = c.id === state.activeChapterId;
    const status = c.status || 'drafting';
    return `<li data-id="${escapeHtml(c.id)}" class="${isActive ? 'active' : ''}">
      <span class="chapter-status-dot ${status}"></span>
      <span class="chapter-name">${escapeHtml(c.title || 'Untitled')}</span>
      <span class="chapter-words">${wordsOf(c).toLocaleString()}</span>
    </li>`;
  }).join('');
  ul.querySelectorAll('li').forEach(li => {
    li.addEventListener('click', () => {
      setActiveChapter(li.dataset.id);
      setActiveView('book');
    });
  });
}

function setActiveChapter(id) {
  if (state.activeChapterId === id) return;
  // CRITICAL: flush any pending editor debounce so the OUTGOING chapter's
  // last keystrokes get captured before we swap (review fix C1).
  flushEditor();
  // Snapshot the doc before switching (per snapshot rule §4.2.5).
  snapshots.forceSnapshot('chapter_switch').catch(() => {});

  state.activeChapterId = id;
  const c = state.doc.chapters.find(ch => ch.id === id);
  if (c) {
    loadChapter(c);
    refreshPageHeader();
  }
  renderSidebarChapters();
}

function refreshPageHeader() {
  document.getElementById('page-header-book').textContent = (state.doc.title || '').toUpperCase();
  const ch = state.doc.chapters.find(c => c.id === state.activeChapterId);
  document.getElementById('page-header-chapter').textContent = (ch?.title || '').toUpperCase();
  document.getElementById('book-title-display').textContent = state.doc.title || 'Untitled Book';
}

function addChapter() {
  const ch = {
    id: uid('ch_'),
    title: `Chapter ${state.doc.chapters.length + 1}`,
    html: '<p><br></p>',
    status: 'drafting',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.doc.chapters.push(ch);
  state.doc.updatedAt = Date.now();
  setActiveChapter(ch.id);
  setActiveView('book');
  persistDocSoon();
  logEvent('started_chapter', `Started "${ch.title}"`).catch(() => {});
}

// ============ IDEAS ============

async function renderIdeas() {
  const ul = document.getElementById('ideas-list');
  const ideas = (await db.ideasAll()).sort((a, b) => b.createdAt - a.createdAt);
  if (!ideas.length) {
    ul.innerHTML = `<li class="empty-state">No ideas yet. Capture one above.</li>`;
    return;
  }
  ul.innerHTML = ideas.map(i => `
    <li>
      <div>
        <div class="idea-text">${escapeHtml(i.text)}</div>
        <div class="idea-meta">${escapeHtml(fmtTime(i.createdAt))}</div>
      </div>
      <div class="idea-actions">
        <button class="btn-link" data-act="del" data-id="${escapeHtml(i.id)}">Delete</button>
      </div>
    </li>
  `).join('');
  ul.querySelectorAll('button[data-act="del"]').forEach(b => {
    b.addEventListener('click', async () => {
      await db.ideaDelete(b.dataset.id);
      renderIdeas();
    });
  });
}

async function addIdeaFromInput() {
  const inp = document.getElementById('idea-input');
  const text = (inp.value || '').trim();
  if (!text) return;
  await db.ideaAdd({ id: uid('idea_'), text, createdAt: Date.now() });
  inp.value = '';
  renderIdeas();
}

// ============ HISTORY ============

async function renderHistory() {
  const ul = document.getElementById('history-list');
  if (!ul) return;
  const all = (await db.snapshotsAll()).sort((a, b) => b.timestamp - a.timestamp);

  // Render filter pills above the list (idempotent — replace any prior pill row).
  const host = ul.parentElement;
  let pillRow = host.querySelector('.history-filter');
  if (!pillRow) {
    pillRow = document.createElement('div');
    pillRow.className = 'history-filter';
    pillRow.innerHTML = `
      <button data-filter="all">All</button>
      <button data-filter="published">Published</button>
      <button data-filter="auto">Auto</button>
    `;
    host.insertBefore(pillRow, ul);
    pillRow.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-filter]');
      if (!btn) return;
      state.historyFilter = btn.dataset.filter;
      renderHistory();
    });
  }
  pillRow.querySelectorAll('button[data-filter]').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === state.historyFilter);
  });

  const filtered = all.filter(s => {
    const kind = s.kind ?? 'auto';
    if (state.historyFilter === 'all') return true;
    return kind === state.historyFilter;
  });

  if (!filtered.length) {
    ul.innerHTML = `<li class="empty-state">No versions yet.</li>`;
    return;
  }

  ul.innerHTML = filtered.map(s => {
    const sign = s.wordDelta > 0 ? 'positive' : (s.wordDelta < 0 ? 'negative' : '');
    const deltaTxt = s.wordDelta > 0 ? `+${s.wordDelta}` : (s.wordDelta < 0 ? s.wordDelta : '±0');
    const isPub = (s.kind ?? 'auto') === 'published';
    const badge = isPub ? `<span class="badge published">Published</span>` : '';
    const label = isPub && s.label ? `<span class="history-label">${escapeHtml(s.label)}</span>` : '';
    return `
      <li data-id="${s.id}">
        <div>
          <div class="history-time">${escapeHtml(fmtTime(s.timestamp))} ${badge}${label}</div>
          <div class="history-delta ${sign}">${deltaTxt} words · ${s.words.toLocaleString()} total · ${escapeHtml(s.reason || '')}</div>
        </div>
        <div>
          <button class="btn-link" data-act="restore">Restore</button>
        </div>
      </li>
    `;
  }).join('');
  ul.querySelectorAll('button[data-act="restore"]').forEach(b => {
    b.addEventListener('click', async () => {
      const id = parseInt(b.closest('li').dataset.id, 10);
      await restoreSnapshot(id);
    });
  });
}

async function restoreSnapshot(id) {
  const snap = await db.snapshotGet(id);
  if (!snap) return;
  if (!confirm(`Restore version from ${fmtTime(snap.timestamp)}? A new snapshot of your current state will be saved first, so this is reversible.`)) return;
  // Save current as a snapshot first.
  await snapshots.forceSnapshot('pre_restore');
  cancelEditor();
  // Sanitize on restore (defense in depth — snapshots are local but may have
  // come from an imported doc that pre-dates the import-time sanitizer).
  state.doc = sanitizeDoc(JSON.parse(JSON.stringify(snap.doc)));
  state.doc.updatedAt = Date.now();
  await db.docSave(state.doc);
  // Re-mount editor on the active chapter (or first).
  state.activeChapterId = state.doc.chapters[0]?.id || null;
  if (state.activeChapterId) {
    const c = state.doc.chapters.find(c => c.id === state.activeChapterId);
    if (c) loadChapter(c);
  }
  renderSidebarChapters();
  refreshPageHeader();
  await snapshots.forceSnapshot('post_restore');
  toast('Version restored.', 'success');
  sync.markDirty(state.doc);
  if (state.activeView === 'history') renderHistory();
}

// ============ SETTINGS ============

async function loadSettingsForm() {
  document.getElementById('setting-book-title').value = state.doc.title || '';
  document.getElementById('setting-daily-goal').value = await db.metaGet('dailyGoal', 500);
  document.getElementById('setting-total-target').value = await db.metaGet('totalTarget', '');
  document.getElementById('setting-deadline').value = (await db.metaGet('deadline', '')) || '';
  document.getElementById('setting-client-id').value = (await db.metaGet('googleClientId', '')) || '';
}

async function refreshStorageInfo() {
  const div = document.getElementById('storage-info');
  if (!div) return;
  const est = await db.storageEstimate();
  if (!est) { div.textContent = 'Storage info unavailable.'; return; }
  const usedMB = (est.usage / (1024 * 1024)).toFixed(2);
  const quotaMB = (est.quota / (1024 * 1024)).toFixed(0);
  const pct = ((est.usage / est.quota) * 100).toFixed(2);
  div.innerHTML = `Using <strong>${usedMB} MB</strong> of <strong>${quotaMB} MB</strong> (${pct}%).`;
}

async function saveClientId() {
  const v = (document.getElementById('setting-client-id').value || '').trim();
  if (!v) { toast('Paste your OAuth Client ID first.', 'error'); return; }
  await db.metaSet('googleClientId', v);
  try {
    await auth.initAuth(v);
    toast('Client ID saved. Click "Connect Google Drive" to authorize.', 'success');
    updateConnectButton();
  } catch (e) {
    toast('Auth init failed: ' + e.message, 'error');
  }
}

async function editDailyGoal() {
  const cur = await db.metaGet('dailyGoal', 500);
  const v = prompt('Daily word goal:', cur);
  if (v == null) return;
  const n = Math.max(0, parseInt(v, 10) || 0);
  await db.metaSet('dailyGoal', n);
  if (state.activeView === 'dashboard') renderDashboard(state.doc);
}

async function exportJson() {
  // Kept for backward compatibility — delegates to exportLib.
  exportLib.exportBookJson(state.doc);
}

async function importJson(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!confirm('Importing will replace your current book with the file contents (a snapshot will be saved first). Continue?')) {
    e.target.value = '';
    return;
  }
  try {
    const txt = await file.text();
    const data = JSON.parse(txt);
    if (!data || !Array.isArray(data.chapters)) throw new Error('Not a valid book JSON file.');
    await snapshots.forceSnapshot('pre_import');
    cancelEditor();
    state.doc = sanitizeDoc(data); // strip any malicious html (review fix H10)
    state.doc.updatedAt = Date.now();
    await db.docSave(state.doc);
    state.activeChapterId = state.doc.chapters[0]?.id || null;
    if (state.activeChapterId) {
      const c = state.doc.chapters.find(c => c.id === state.activeChapterId);
      if (c) loadChapter(c);
    }
    renderSidebarChapters();
    refreshPageHeader();
    sync.markDirty(state.doc);
    toast('Book imported.', 'success');
  } catch (err) {
    toast('Import failed: ' + err.message, 'error');
  } finally {
    e.target.value = '';
  }
}

async function resetEverything() {
  if (!confirm('This will erase ALL local data: book, snapshots, ideas, sessions. Drive copies are NOT touched. Continue?')) return;
  if (!confirm('Are you absolutely sure? This cannot be undone locally.')) return;
  await db.resetAll();
  location.reload();
}

// ============ DRIVE CONNECT ============

async function onConnectDriveClick() {
  const clientId = await db.metaGet('googleClientId');
  if (!clientId) {
    setActiveView('settings');
    toast('Paste your OAuth Client ID in Settings first. See SETUP.md.', 'error', 4000);
    return;
  }
  // Flush pending edits BEFORE we possibly swap doc with the remote copy (review fix H3).
  flushEditor();
  persistDocSoon.flush?.();
  try {
    await auth.initAuth(clientId);
    await auth.authorize({ silent: false });
    toast('Connected to Google Drive.', 'success');
    updateConnectButton();
    // Reconcile (find/create folder, possibly load remote book).
    await sync.reconcileWithDrive(state.doc, async (remoteDoc) => {
      const proceed = confirm('A newer copy of your book was found on Drive. Use Drive copy? (Cancel = keep local)');
      if (proceed) {
        // Cancel any debounce that might fire stale data into the new doc.
        cancelEditor();
        state.doc = sanitizeDoc(remoteDoc);
        await db.docSave(state.doc);
        state.activeChapterId = state.doc.chapters[0]?.id || null;
        if (state.activeChapterId) {
          const c = state.doc.chapters.find(c => c.id === state.activeChapterId);
          if (c) loadChapter(c);
        }
        renderSidebarChapters();
        refreshPageHeader();
        toast('Drive copy loaded.', 'success');
      }
    });
    sync.markDirty(state.doc); // schedules a push
  } catch (e) {
    toast('Connect failed: ' + e.message, 'error', 4000);
  }
}

function updateConnectButton() {
  const btn = document.getElementById('connect-drive-btn');
  if (!btn) return;
  if (auth.isAuthorized()) {
    btn.textContent = 'Drive ✓';
    btn.disabled = true;
    btn.style.opacity = '0.7';
  } else {
    btn.textContent = 'Connect Google Drive';
    btn.disabled = false;
    btn.style.opacity = '1';
  }
}

// ============ STATUS / DIAG ============

function refreshSyncStatus(status, detail) {
  const dot = document.getElementById('sync-dot');
  const txt = document.getElementById('sync-text');
  const ind = document.getElementById('save-indicator');
  if (!dot || !txt) return;
  dot.className = 'sync-dot ' + status;
  txt.textContent = ({
    local: 'Local only',
    syncing: 'Syncing…',
    synced: 'Synced ' + (sync.getDriveStatus().lastSyncLabel || ''),
    error: 'Sync error',
  })[status] || status;
  if (ind) {
    ind.className = 'save-indicator ' + (status === 'syncing' ? 'saving' : status === 'synced' ? 'saved' : status === 'error' ? 'error' : '');
  }

  // Drive status block in settings
  const detailDiv = document.getElementById('drive-status-detail');
  if (detailDiv) {
    const ds = sync.getDriveStatus();
    detailDiv.innerHTML = ds.fileId
      ? `Connected. Last sync: ${escapeHtml(ds.lastSyncLabel)}. Drive file id: <code>${escapeHtml(ds.fileId)}</code>`
      : 'Not connected.';
  }
}

function showSaveIndicator(state) {
  const txt = document.getElementById('save-text');
  const ind = document.getElementById('save-indicator');
  if (!txt || !ind) return;
  ind.className = 'save-indicator ' + (state === 'saving' ? 'saving' : state === 'saved' ? 'saved' : state === 'error' ? 'error' : '');
  txt.textContent = state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : state === 'error' ? 'Save error' : 'Ready';
}

async function openDiagnostics() {
  const overlay = document.getElementById('diag-overlay');
  const content = document.getElementById('diag-content');
  const data = await collectDiagnostics();
  content.textContent = JSON.stringify(data, null, 2);
  overlay.hidden = false;
}

async function copyDiagnostics() {
  const text = document.getElementById('diag-content').textContent;
  await navigator.clipboard.writeText(text);
  toast('Copied diagnostics to clipboard.', 'success');
}

async function collectDiagnostics() {
  const totals = totalStats(state.doc.chapters || []);
  const est = await db.storageEstimate().catch(() => null);
  const snaps = await db.snapshotsAll().catch(() => []);
  const sessions = await db.sessionsAll().catch(() => []);
  const ideas = await db.ideasAll().catch(() => []);
  const journey = await db.journeyAll().catch(() => []);
  return {
    timestamp: new Date().toISOString(),
    book: {
      title: state.doc.title,
      chapters: state.doc.chapters.length,
      totalWords: totals.words,
      pages: totals.pages,
      lastUpdated: new Date(state.doc.updatedAt).toISOString(),
    },
    activeChapterId: state.activeChapterId,
    auth: auth.authDiag(),
    drive: sync.getDriveStatus(),
    indexedDb: {
      snapshots: snaps.length,
      sessions: sessions.length,
      ideas: ideas.length,
      journeyEvents: journey.length,
    },
    storage: est ? {
      usageMB: (est.usage / (1024 * 1024)).toFixed(2),
      quotaMB: (est.quota / (1024 * 1024)).toFixed(0),
      percent: ((est.usage / est.quota) * 100).toFixed(2) + '%',
    } : 'unavailable',
    browser: navigator.userAgent,
  };
}

// ============ FLUSH ON HIDE ============

function flushAll() {
  // CRITICAL ORDER: flush the EDITOR first so the latest keystrokes get
  // synthesized into state.doc before we persist (review fix C2).
  flushEditor();
  persistDocSoon.flush?.();
  // Drive push won't necessarily complete before the page unloads, but the local
  // copy is already in IndexedDB so nothing is lost.
  sync.pushNow?.().catch(() => {});
  snapshots.forceSnapshot('hidden').catch(() => {});
}

// ============ DOCX IMPORT FLOW ============

/**
 * Apply a .docx import to state.doc. Always non-destructive: a Published
 * snapshot ('Pre-import: <filename>') is created BEFORE any mutation, so the
 * pre-import state is always reachable from History (and from Drive's
 * versions/ folder once Drive is connected).
 *
 * @param {object} opts
 * @param {'one-chapter'|'split-h1'|'replace'} opts.mode
 * @param {File} opts.file
 */
async function applyDocxImport({ mode, file }) {
  // 1. Convert .docx → sanitized HTML.
  let html, messages;
  try {
    ({ html, messages } = await docxBlobToHtml(file));
  } catch (e) {
    toast('Could not read .docx: ' + e.message, 'error', 5000);
    return;
  }

  // 2. Safety publish — frozen snapshot of the current state, named after the import.
  try {
    await publishCurrentVersion(`Pre-import: ${file.name}`, state.doc, { auth });
  } catch (e) {
    console.warn('safety publish failed (continuing import)', e);
  }

  // 3. Build new chapter rows.
  const fallbackTitle = file.name.replace(/\.docx$/i, '') || 'Imported chapter';
  let newChapters;
  if (mode === 'split-h1') {
    newChapters = splitHtmlByH1(html, fallbackTitle).map(c => makeChapter(c.title, c.html));
  } else {
    // one-chapter and replace both produce a single chapter from the file.
    newChapters = [makeChapter(fallbackTitle, html || '<p><br></p>')];
  }

  // 4. Apply.
  flushEditor();
  cancelEditor();
  if (mode === 'replace') {
    state.doc.chapters = newChapters;
  } else {
    state.doc.chapters = state.doc.chapters.concat(newChapters);
  }
  state.doc.updatedAt = Date.now();
  await db.docSave(state.doc);

  // 5. Activate the first newly-imported chapter so the user sees the result.
  state.activeChapterId = newChapters[0].id;
  loadChapter(newChapters[0]);
  refreshPageHeader();
  renderSidebarChapters();
  setActiveView('book');

  // 6. Push immediately — don't wait for debounce.
  sync.markDirty(state.doc);
  sync.pushNow?.().catch(() => {});

  // 7. Tell the user, and surface mammoth's "things I dropped" warnings if any.
  const lossyMsg = (messages || []).filter(m => m.type === 'warning').length;
  if (mode === 'replace') {
    toast(`Replaced book with ${newChapters.length} chapter(s) from ${file.name}.`, 'success', 4500);
  } else if (mode === 'split-h1') {
    toast(`Imported ${newChapters.length} chapter(s) from ${file.name}.`, 'success', 4500);
  } else {
    toast(`Added "${newChapters[0].title}" from ${file.name}.`, 'success', 4500);
  }
  if (lossyMsg) {
    toast(`${lossyMsg} feature(s) from Word were not imported (footnotes, comments, etc).`, 'warning', 6000);
  }
  logEvent('imported_docx', `Imported ${file.name}`, { mode, chapters: newChapters.length }).catch(() => {});
}

/** Build a fresh chapter object with sane metadata from imported title + html. */
function makeChapter(title, html) {
  return {
    id: uid('ch_'),
    title: (title || 'Imported chapter').slice(0, 200),
    html,
    status: 'drafting',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Sidebar's 📄+ button — quick path, always one-chapter, no modal. */
function setupQuickDocxImport() {
  const btn = document.getElementById('add-chapter-from-docx-btn');
  const input = document.getElementById('import-docx-input');
  if (!btn || !input) return;
  btn.addEventListener('click', () => {
    // Use a separate handler instance so the Settings modal doesn't fight us.
    input.dataset.target = 'quick';
    input.click();
  });
  input.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (input.dataset.target === 'quick') {
      delete input.dataset.target;
      await applyDocxImport({ mode: 'one-chapter', file });
      e.target.value = '';
    } else {
      // Settings flow — open the modal.
      openImportDocxModal(file);
      e.target.value = '';
    }
  });
}

/** Settings → "Import .docx…" — opens the modal. */
function setupSettingsDocxImport() {
  const btn = document.getElementById('import-docx-btn');
  const input = document.getElementById('import-docx-input');
  if (!btn || !input) return;
  btn.addEventListener('click', () => {
    input.dataset.target = 'modal';
    input.click();
  });

  // Modal wiring.
  const overlay = document.getElementById('import-docx-overlay');
  const cancel = document.getElementById('import-docx-cancel');
  const confirm = document.getElementById('import-docx-confirm');
  if (!overlay || !cancel || !confirm) return;
  cancel.addEventListener('click', closeImportDocxModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeImportDocxModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) closeImportDocxModal();
  });
}

let _pendingImportFile = null;

function openImportDocxModal(file) {
  _pendingImportFile = file;
  const overlay = document.getElementById('import-docx-overlay');
  const nameEl = document.getElementById('import-docx-name');
  const confirm = document.getElementById('import-docx-confirm');
  if (!overlay || !confirm) return;
  nameEl.textContent = file.name;
  // Reset to default selection.
  const radios = overlay.querySelectorAll('input[name="import-mode"]');
  radios.forEach(r => { r.checked = (r.value === 'one-chapter'); });
  // Hide leftover messages.
  const msg = document.getElementById('import-docx-messages');
  if (msg) { msg.hidden = true; msg.innerHTML = ''; }
  confirm.disabled = false;
  confirm.textContent = 'Import';

  overlay.hidden = false;

  // Replace the click handler each open so we capture the current file.
  const newConfirm = confirm.cloneNode(true);
  confirm.parentNode.replaceChild(newConfirm, confirm);
  newConfirm.addEventListener('click', async () => {
    const mode = (overlay.querySelector('input[name="import-mode"]:checked') || {}).value || 'one-chapter';
    if (mode === 'replace') {
      const ok = window.confirm(
        `Replace your entire book with "${_pendingImportFile.name}"?\n\n` +
        `A "Pre-import" version will be saved automatically — you can always restore from History.`
      );
      if (!ok) return;
    }
    newConfirm.disabled = true;
    newConfirm.textContent = 'Importing…';
    try {
      await applyDocxImport({ mode, file: _pendingImportFile });
      closeImportDocxModal();
    } catch (e) {
      toast('Import failed: ' + e.message, 'error', 5000);
    } finally {
      _pendingImportFile = null;
    }
  });
}

function closeImportDocxModal() {
  const overlay = document.getElementById('import-docx-overlay');
  if (overlay) overlay.hidden = true;
  _pendingImportFile = null;
}

/**
 * Drag-and-drop a .docx onto the chapter list — appends as one new chapter.
 * The editor's existing drop handler explicitly rejects file drops, so the
 * editor stays a safe surface; the chapter list is the only file-drop target.
 */
function setupChapterListDropZone() {
  const ul = document.getElementById('chapters-list');
  if (!ul) return;

  let dragCount = 0;

  const isDocxDrag = (e) => {
    const items = e.dataTransfer?.items;
    if (!items) return false;
    for (const it of items) {
      // During dragover the file isn't accessible yet — check type heuristically.
      if (it.kind === 'file') return true;
    }
    return false;
  };

  ul.addEventListener('dragenter', (e) => {
    if (!isDocxDrag(e)) return;
    e.preventDefault();
    dragCount++;
    ul.classList.add('drag-over');
  });
  ul.addEventListener('dragover', (e) => {
    if (!isDocxDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  ul.addEventListener('dragleave', () => {
    dragCount = Math.max(0, dragCount - 1);
    if (dragCount === 0) ul.classList.remove('drag-over');
  });
  ul.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCount = 0;
    ul.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer?.files || []);
    const docx = files.find(f => /\.docx$/i.test(f.name));
    if (!docx) {
      if (files.length) toast('Only .docx files are supported here.', 'warning', 3500);
      return;
    }
    await applyDocxImport({ mode: 'one-chapter', file: docx });
  });
}

// ============ EXPORT MENU + PUBLISH FLOW ============

function setupExportMenu() {
  const dropdown = document.getElementById('export-dropdown');
  const btn = document.getElementById('export-btn');
  const menu = document.getElementById('export-menu');
  if (!dropdown || !btn || !menu) return;

  const close = () => { menu.hidden = true; };
  const open = () => { menu.hidden = false; };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) open(); else close();
  });
  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  menu.addEventListener('click', async (e) => {
    const item = e.target.closest('.dropdown-item');
    if (!item) return;
    close();
    flushEditor();              // make sure latest keystrokes are in state.doc
    const action = item.dataset.export;
    try {
      if (action === 'book-docx') {
        toast('Building book.docx…', '', 1500);
        await exportLib.exportBookDocx(state.doc);
      } else if (action === 'chapter-docx') {
        const ch = state.doc.chapters.find(c => c.id === state.activeChapterId);
        if (!ch) { toast('Open a chapter first.', 'warning'); return; }
        toast('Building chapter.docx…', '', 1500);
        await exportLib.exportChapterDocx(ch, state.doc.title);
      } else if (action === 'print') {
        exportLib.printBook(state.doc);
      } else if (action === 'json') {
        exportLib.exportBookJson(state.doc);
      }
    } catch (err) {
      console.error('Export failed', err);
      toast('Export failed: ' + err.message, 'error', 5000);
    }
  });
}

function setupPublishFlow() {
  const trigger = document.getElementById('publish-version-btn');
  const overlay = document.getElementById('publish-overlay');
  const input = document.getElementById('publish-label-input');
  const cancelBtn = document.getElementById('publish-cancel');
  const confirmBtn = document.getElementById('publish-confirm');
  if (!trigger || !overlay || !confirmBtn) return;

  const open = () => {
    flushEditor();
    input.value = `Draft — ${new Date().toLocaleDateString()}`;
    overlay.hidden = false;
    setTimeout(() => input.focus(), 0);
    input.select?.();
  };
  const close = () => { overlay.hidden = true; };

  trigger.addEventListener('click', open);
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmBtn.click(); }
    if (e.key === 'Escape') close();
  });

  confirmBtn.addEventListener('click', async () => {
    const label = (input.value || '').trim() || 'Untitled version';
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Publishing…';
    try {
      const r = await publishCurrentVersion(label, state.doc, { auth });
      close();
      if (auth.isAuthorized() && (r.jsonFileId || r.docxFileId)) {
        toast(`Published "${label}" to Drive ✓`, 'success', 4000);
      } else if (auth.isAuthorized()) {
        toast(`Published "${label}" locally — Drive write failed (will retry).`, 'warning', 5000);
      } else {
        toast(`Published "${label}" locally — connect Drive to mirror.`, '', 4000);
      }
      logEvent('published_version', `Published "${label}"`).catch(() => {});
      if (state.activeView === 'history') renderHistory();
    } catch (err) {
      console.error('Publish failed', err);
      toast('Publish failed: ' + err.message, 'error', 5000);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Publish';
    }
  });
}

// ============ KICK OFF ============

boot().catch(e => {
  console.error('Boot failed', e);
  toast('Failed to start: ' + e.message, 'error', 6000);
});
