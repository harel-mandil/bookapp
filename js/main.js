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
  document.getElementById('export-json-btn').addEventListener('click', exportJson);
  document.getElementById('import-json-btn').addEventListener('click', () => {
    document.getElementById('import-file-input').click();
  });
  document.getElementById('import-file-input').addEventListener('change', importJson);

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
  const all = (await db.snapshotsAll()).sort((a, b) => b.timestamp - a.timestamp);
  if (!all.length) {
    ul.innerHTML = `<li class="empty-state">No versions yet.</li>`;
    return;
  }
  ul.innerHTML = all.map(s => {
    const sign = s.wordDelta > 0 ? 'positive' : (s.wordDelta < 0 ? 'negative' : '');
    const deltaTxt = s.wordDelta > 0 ? `+${s.wordDelta}` : (s.wordDelta < 0 ? s.wordDelta : '±0');
    return `
      <li data-id="${s.id}">
        <div>
          <div class="history-time">${escapeHtml(fmtTime(s.timestamp))}</div>
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
  const blob = new Blob([JSON.stringify(state.doc, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(state.doc.title || 'book').replace(/[^a-z0-9]+/gi, '-')}-${isoForFilename()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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

// ============ KICK OFF ============

boot().catch(e => {
  console.error('Boot failed', e);
  toast('Failed to start: ' + e.message, 'error', 6000);
});
