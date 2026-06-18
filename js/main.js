// ============================================================
// main.js — entry point. Wires all modules + the UI.
//
// Boot sequence:
//   1. Theme (so dark mode is applied before first paint)
//   2. Open IndexedDB.
//   3. Load doc (or starter).
//   4. Mount editor + paginator.
//   5. Sidebar + view routing.
//   6. Sync init.
//   7. Snapshot scheduler.
//   8. Boot all of: search, sprint, focus, notes, typography, shortcuts.
//   9. Render dashboard.
//  10. Persistence-on-hide handlers.
// ============================================================

import * as db from './db.js';
import * as auth from './auth.js';
import * as sync from './sync.js';
import * as snapshots from './snapshots.js';
import * as exportLib from './export.js';
import * as theme from './theme.js';
import * as paginate from './paginate.js';
import * as search from './search.js';
import * as sprint from './sprint.js';
import * as focus from './focus.js';
import * as notes from './notes.js';
import { setSmartTypography } from './typography.js';
import { exportBookEpub, exportBookMarkdown } from './epub.js';
import { publishCurrentVersion } from './publish.js';
import { docxBlobToHtml, splitHtmlByH1 } from './import.js';
import {
  mountEditor, loadChapter, snapshotChapter, getEditorElement,
  flushPending as flushEditor, cancelPending as cancelEditor,
} from './editor.js';
import { sanitizeHtml } from './format.js';
import { renderDashboard } from './dashboard.js';
import { logEvent, checkWordMilestones, checkReEntry, renderTimeline } from './journey.js';
import { stats, totalStats, wordsOf } from './stats.js';
import { uid, todayKey, toast, fmtTime, debounce, escapeHtml } from './utils.js';
import { replaceInHtml } from './search.js';

// ============ APP STATE ============

const state = {
  doc: null,
  activeChapterId: null,
  activeView: 'dashboard',
  prevTotalWords: 0,
  historyFilter: 'all',
  scrollByChapter: {},   // chapterId → wrap.scrollTop (restore on switch)
};

// Page-size table (width × height in CSS in/cm).
const PAGE_SIZES = {
  '6x9':    { w: '6in',     h: '9in',     margin: '0.75in' },
  '5x8':    { w: '5in',     h: '8in',     margin: '0.6in'  },
  'letter': { w: '8.5in',   h: '11in',    margin: '1in'    },
  'a4':     { w: '210mm',   h: '297mm',   margin: '20mm'   },
  'a5':     { w: '148mm',   h: '210mm',   margin: '15mm'   },
};
const FONT_FACES = {
  serif: `'Iowan Old Style','Hoefler Text','Cambria','Georgia',serif`,
  sans:  `-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif`,
  mono:  `'SF Mono', Menlo, Consolas, monospace`,
};

// ============ BOOT ============

async function boot() {
  await theme.initTheme();
  await db.persistStorage().catch(() => {});

  let doc = await db.docLoad();
  if (!doc) {
    doc = createStarterDoc();
    await db.docSave(doc);
  }
  state.doc = doc;
  state.prevTotalWords = totalStats(doc.chapters || []).words;
  state.activeChapterId = doc.chapters[0]?.id || null;

  // Apply the user's page format + typography preferences BEFORE editor mount,
  // so the first layout uses the right metrics.
  await applyTypographyFromMeta();

  await mountEditor({
    editorEl: document.getElementById('editor'),
    titleEl:  document.getElementById('chapter-title-input'),
    toolbarEl: document.querySelector('.editor-toolbar'),
    onChange: handleEditorChange,
  });

  if (state.activeChapterId) {
    const c = doc.chapters.find(c => c.id === state.activeChapterId);
    if (c) loadChapter(c);
  }

  refreshPageHeader();

  setupNav();
  renderSidebarChapters();
  loadSettingsForm();
  refreshSyncStatus('local');

  await sync.initSync();
  sync.onSyncStatus(refreshSyncStatus);

  await snapshots.initSnapshots({
    getDoc: () => state.doc,
    onSnap: () => { if (state.activeView === 'history') renderHistory(); },
  });

  const clientId = await db.metaGet('googleClientId');
  if (clientId) {
    auth.initAuth(clientId).then(updateConnectButton).catch(e => console.warn('auth init failed', e));
  }
  updateConnectButton();

  await renderDashboard(state.doc, { onGoalChange: () => renderSidebarChapters() });

  checkReEntry().catch(() => {});

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll();
  });
  window.addEventListener('pagehide', () => flushAll());

  window.addEventListener('auth:error', (e) => {
    toast('Drive auth error: ' + (e.detail?.type || 'unknown'), 'error');
  });
  window.addEventListener('auth:needs-reconnect', () => {
    updateConnectButton();
    toast('Drive disconnected. Click "Connect Google Drive" to reconnect.', 'error', 5000);
  });

  // Diagnostics
  document.getElementById('diagnostics-btn').addEventListener('click', openDiagnostics);
  document.getElementById('diag-close').addEventListener('click', () => {
    document.getElementById('diag-overlay').hidden = true;
  });
  document.getElementById('diag-copy').addEventListener('click', copyDiagnostics);

  // Drive
  document.getElementById('connect-drive-btn').addEventListener('click', onConnectDriveClick);

  // Settings
  document.getElementById('save-client-id-btn').addEventListener('click', saveClientId);
  document.getElementById('edit-goal-btn').addEventListener('click', editDailyGoal);
  document.getElementById('reset-app-btn').addEventListener('click', resetEverything);
  document.getElementById('export-json-btn').addEventListener('click', () => exportLib.exportBookJson(state.doc));
  document.getElementById('import-json-btn').addEventListener('click', () => {
    document.getElementById('import-file-input').click();
  });
  document.getElementById('import-file-input').addEventListener('change', importJson);

  const mirrorEl = document.getElementById('setting-mirror-docx');
  if (mirrorEl) {
    mirrorEl.checked = !!(await db.metaGet('mirrorDocxEnabled', false));
    mirrorEl.addEventListener('change', async (e) => {
      await db.metaSet('mirrorDocxEnabled', e.target.checked);
      if (e.target.checked && auth.isAuthorized()) {
        sync.markDirty(state.doc);
        toast('Drive will receive book.docx within ~30 s.', 'success');
      } else if (e.target.checked) {
        toast('Connect Google Drive first — mirror is enabled but inactive.', 'warning', 4000);
      } else {
        toast('book.docx mirror disabled.', '');
      }
    });
  }

  setupExportMenu();
  setupPublishFlow();

  // Live book metadata wiring
  document.getElementById('setting-book-title').addEventListener('input', e => {
    state.doc.title = e.target.value;
    document.getElementById('book-title-display').textContent = state.doc.title || 'Untitled Book';
    document.getElementById('page-header-book').textContent = (state.doc.title || '').toUpperCase();
    persistDocSoon();
    paginate.refresh();
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

  // Theme + typography settings
  setupAppearanceSettings();

  // Chapters
  document.getElementById('add-chapter-btn').addEventListener('click', addChapter);
  setupQuickDocxImport();
  setupSettingsDocxImport();
  setupChapterListDropZone();
  setupBookToc();

  // Ideas
  document.getElementById('add-idea-btn').addEventListener('click', addIdeaFromInput);
  document.getElementById('idea-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addIdeaFromInput();
  });

  // Dashboard nav
  window.addEventListener('nav:chapter', (e) => {
    setActiveChapter(e.detail.chapterId);
    setActiveView('book');
  });

  // Cross-chapter find/replace + sprint + focus + notes + quick-open + kbd-help
  setupSearch();
  setupSprint();
  await focus.initFocus();
  await notes.initNotes();
  setupQuickOpen();
  setupKbdHelp();
  setupTopbarShortcutButtons();

  // Mount paginator (after editor + chapter loaded).
  paginate.mountPaginator({
    editorEl: getEditorElement(),
    getBookTitle: () => state.doc.title || '',
    getChapterTitle: () => {
      const c = state.doc.chapters.find(c => c.id === state.activeChapterId);
      return c?.title || '';
    },
  });

  // Restore scroll position when switching chapters
  document.getElementById('book-page-wrap')?.addEventListener('scroll', () => {
    if (!state.activeChapterId) return;
    state.scrollByChapter[state.activeChapterId] = document.getElementById('book-page-wrap').scrollTop;
  });

  setupGlobalShortcuts();
}

// ============ DOC / EDITOR PLUMBING ============

function sanitizeDoc(doc) {
  if (!doc || !Array.isArray(doc.chapters)) return doc;
  return {
    ...doc,
    chapters: doc.chapters.map(c => ({ ...c, html: sanitizeHtml(c.html || '') })),
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
    chapters: [{
      id: firstChId,
      title: 'Chapter 1',
      html: '<p><br></p>',
      status: 'drafting',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
  };
}

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

  updateTodaySession(wordDelta).catch(() => {});

  const newTotal = totalStats(state.doc.chapters).words;
  checkWordMilestones(newTotal, state.prevTotalWords).catch(() => {});
  state.prevTotalWords = newTotal;

  renderSidebarChapters();
  scheduleTocRefresh();

  document.getElementById('page-header-chapter').textContent = (updatedChapter.title || '').toUpperCase();

  persistDocSoon();
  snapshots.noteChange();
  paginate.refresh();
}

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

  if (view === 'dashboard') renderDashboard(state.doc, { onGoalChange: () => renderSidebarChapters() });
  if (view === 'journey') renderTimeline();
  if (view === 'ideas') renderIdeas();
  if (view === 'history') renderHistory();
  if (view === 'settings') {
    loadSettingsForm();
    refreshStorageInfo();
  }
  if (view === 'book') {
    // Restore scroll for the active chapter.
    setTimeout(() => {
      const wrap = document.getElementById('book-page-wrap');
      if (wrap && state.activeChapterId && state.scrollByChapter[state.activeChapterId] != null) {
        wrap.scrollTop = state.scrollByChapter[state.activeChapterId];
      }
      paginate.refresh();
    }, 30);
  }
}

function renderSidebarChapters() {
  const ul = document.getElementById('chapters-list');
  if (!ul) return;
  ul.innerHTML = state.doc.chapters.map(c => {
    const isActive = c.id === state.activeChapterId;
    const status = c.status || 'drafting';
    return `<li data-id="${escapeHtml(c.id)}" class="${isActive ? 'active' : ''}" draggable="true">
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
    setupChapterDrag(li);
  });
}

function setActiveChapter(id) {
  if (state.activeChapterId === id) return;
  flushEditor();
  snapshots.forceSnapshot('chapter_switch').catch(() => {});

  // Save scroll for outgoing chapter.
  const wrap = document.getElementById('book-page-wrap');
  if (wrap && state.activeChapterId) {
    state.scrollByChapter[state.activeChapterId] = wrap.scrollTop;
  }

  state.activeChapterId = id;
  const c = state.doc.chapters.find(ch => ch.id === id);
  if (c) {
    loadChapter(c);
    refreshPageHeader();
  }
  renderSidebarChapters();
  renderBookToc();
  // Restore scroll for incoming chapter.
  setTimeout(() => {
    if (wrap && state.scrollByChapter[id] != null) wrap.scrollTop = state.scrollByChapter[id];
    paginate.refresh();
  }, 50);
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
  renderBookToc();
}

// ============ CHAPTER DRAG-REORDER ============

let _dragSrcId = null;
function setupChapterDrag(li) {
  li.addEventListener('dragstart', (e) => {
    _dragSrcId = li.dataset.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Prevent the docx-drop handler on the UL from kicking in.
    e.dataTransfer.setData('text/x-bookapp-chapter', li.dataset.id);
  });
  li.addEventListener('dragend', () => {
    _dragSrcId = null;
    document.querySelectorAll('.chapters-list li').forEach(n => n.classList.remove('dragging', 'drop-above', 'drop-below'));
  });
  li.addEventListener('dragover', (e) => {
    if (!_dragSrcId) return;
    if (_dragSrcId === li.dataset.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = li.getBoundingClientRect();
    const before = (e.clientY - r.top) < r.height / 2;
    li.classList.toggle('drop-above', before);
    li.classList.toggle('drop-below', !before);
  });
  li.addEventListener('dragleave', () => li.classList.remove('drop-above', 'drop-below'));
  li.addEventListener('drop', (e) => {
    if (!_dragSrcId) return;
    e.preventDefault();
    e.stopPropagation();
    const targetId = li.dataset.id;
    const r = li.getBoundingClientRect();
    const before = (e.clientY - r.top) < r.height / 2;
    reorderChapter(_dragSrcId, targetId, before);
  });
}

function reorderChapter(srcId, targetId, before) {
  if (srcId === targetId) return;
  const arr = state.doc.chapters;
  const srcIdx = arr.findIndex(c => c.id === srcId);
  let dstIdx = arr.findIndex(c => c.id === targetId);
  if (srcIdx < 0 || dstIdx < 0) return;
  const [moved] = arr.splice(srcIdx, 1);
  if (srcIdx < dstIdx) dstIdx--;
  if (!before) dstIdx++;
  arr.splice(dstIdx, 0, moved);
  state.doc.updatedAt = Date.now();
  persistDocSoon();
  renderSidebarChapters();
  renderBookToc();
  if (state.activeView === 'dashboard') renderDashboard(state.doc);
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

  if (!filtered.length) { ul.innerHTML = `<li class="empty-state">No versions yet.</li>`; return; }

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
  await snapshots.forceSnapshot('pre_restore');
  cancelEditor();
  state.doc = sanitizeDoc(JSON.parse(JSON.stringify(snap.doc)));
  state.doc.updatedAt = Date.now();
  await db.docSave(state.doc);
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

  // Theme + typography
  const t = theme.getTheme();
  document.querySelectorAll('input[name="theme"]').forEach(r => { r.checked = (r.value === t); });
  document.getElementById('setting-page-size').value     = (await db.metaGet('pageSize', '6x9'));
  document.getElementById('setting-font-face').value     = (await db.metaGet('fontFace', 'serif'));
  document.getElementById('setting-font-size').value     = String(await db.metaGet('fontSize', 15));
  document.getElementById('setting-line-height').value   = String(await db.metaGet('lineHeight', 1.62));
  document.getElementById('setting-smart-typography').checked = !!(await db.metaGet('smartTypography', true));
}

function setupAppearanceSettings() {
  document.querySelectorAll('input[name="theme"]').forEach(r => {
    r.addEventListener('change', () => theme.setTheme(r.value));
  });
  document.getElementById('setting-page-size').addEventListener('change', async (e) => {
    await db.metaSet('pageSize', e.target.value);
    applyTypographyFromMeta();
  });
  document.getElementById('setting-font-face').addEventListener('change', async (e) => {
    await db.metaSet('fontFace', e.target.value);
    applyTypographyFromMeta();
  });
  document.getElementById('setting-font-size').addEventListener('change', async (e) => {
    await db.metaSet('fontSize', parseInt(e.target.value, 10) || 15);
    applyTypographyFromMeta();
  });
  document.getElementById('setting-line-height').addEventListener('change', async (e) => {
    await db.metaSet('lineHeight', parseFloat(e.target.value) || 1.62);
    applyTypographyFromMeta();
  });
  document.getElementById('setting-smart-typography').addEventListener('change', async (e) => {
    await db.metaSet('smartTypography', e.target.checked);
    setSmartTypography(e.target.checked);
  });
}

async function applyTypographyFromMeta() {
  const pageSize   = await db.metaGet('pageSize', '6x9');
  const fontFace   = await db.metaGet('fontFace', 'serif');
  const fontSize   = await db.metaGet('fontSize', 15);
  const lineHeight = await db.metaGet('lineHeight', 1.62);
  const smart      = !!(await db.metaGet('smartTypography', true));

  const dims = PAGE_SIZES[pageSize] || PAGE_SIZES['6x9'];
  const root = document.documentElement;
  root.style.setProperty('--page-w', dims.w);
  root.style.setProperty('--page-h', dims.h);
  root.style.setProperty('--page-margin', dims.margin);
  root.style.setProperty('--book-font-face', FONT_FACES[fontFace] || FONT_FACES.serif);
  root.style.setProperty('--book-font-size', `${fontSize}px`);
  root.style.setProperty('--book-line-height', String(lineHeight));

  setSmartTypography(smart);
  paginate.refresh();
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
    state.doc = sanitizeDoc(data);
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
  flushEditor();
  persistDocSoon.flush?.();
  try {
    await auth.initAuth(clientId);
    await auth.authorize({ silent: false });
    toast('Connected to Google Drive.', 'success');
    updateConnectButton();
    await sync.reconcileWithDrive(state.doc, async (remoteDoc) => {
      const proceed = confirm('A newer copy of your book was found on Drive. Use Drive copy? (Cancel = keep local)');
      if (proceed) {
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
    sync.markDirty(state.doc);
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
  const detailDiv = document.getElementById('drive-status-detail');
  if (detailDiv) {
    const ds = sync.getDriveStatus();
    detailDiv.innerHTML = ds.fileId
      ? `Connected. Last sync: ${escapeHtml(ds.lastSyncLabel)}. Drive file id: <code>${escapeHtml(ds.fileId)}</code>`
      : 'Not connected.';
  }
}

function showSaveIndicator(s) {
  const txt = document.getElementById('save-text');
  const ind = document.getElementById('save-indicator');
  if (!txt || !ind) return;
  ind.className = 'save-indicator ' + (s === 'saving' ? 'saving' : s === 'saved' ? 'saved' : s === 'error' ? 'error' : '');
  txt.textContent = s === 'saving' ? 'Saving…' : s === 'saved' ? 'Saved' : s === 'error' ? 'Save error' : 'Ready';
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
    theme: { setting: theme.getTheme(), effective: theme.getEffectiveTheme() },
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

function flushAll() {
  flushEditor();
  persistDocSoon.flush?.();
  sync.pushNow?.().catch(() => {});
  snapshots.forceSnapshot('hidden').catch(() => {});
}

// ============ DOCX IMPORT FLOW ============

async function applyDocxImport({ mode, file }) {
  let html, messages;
  try {
    ({ html, messages } = await docxBlobToHtml(file));
  } catch (e) {
    toast('Could not read .docx: ' + e.message, 'error', 5000);
    return;
  }

  try {
    await publishCurrentVersion(`Pre-import: ${file.name}`, state.doc, { auth });
  } catch (e) {
    console.warn('safety publish failed (continuing import)', e);
  }

  const fallbackTitle = file.name.replace(/\.docx$/i, '') || 'Imported chapter';
  let newChapters;
  if (mode === 'split-h1') {
    newChapters = splitHtmlByH1(html, fallbackTitle).map(c => makeChapter(c.title, c.html));
  } else {
    newChapters = [makeChapter(fallbackTitle, html || '<p><br></p>')];
  }

  flushEditor();
  cancelEditor();
  if (mode === 'replace') state.doc.chapters = newChapters;
  else state.doc.chapters = state.doc.chapters.concat(newChapters);

  state.doc.updatedAt = Date.now();
  await db.docSave(state.doc);

  state.activeChapterId = newChapters[0].id;
  loadChapter(newChapters[0]);
  refreshPageHeader();
  renderSidebarChapters();
  setActiveView('book');

  sync.markDirty(state.doc);
  sync.pushNow?.().catch(() => {});

  const lossyMsg = (messages || []).filter(m => m.type === 'warning').length;
  if (mode === 'replace') toast(`Replaced book with ${newChapters.length} chapter(s) from ${file.name}.`, 'success', 4500);
  else if (mode === 'split-h1') toast(`Imported ${newChapters.length} chapter(s) from ${file.name}.`, 'success', 4500);
  else toast(`Added "${newChapters[0].title}" from ${file.name}.`, 'success', 4500);
  if (lossyMsg) toast(`${lossyMsg} feature(s) from Word were not imported (footnotes, comments, etc).`, 'warning', 6000);
  logEvent('imported_docx', `Imported ${file.name}`, { mode, chapters: newChapters.length }).catch(() => {});
}

function makeChapter(title, html) {
  return {
    id: uid('ch_'),
    title: (title || 'Imported chapter').slice(0, 200),
    html, status: 'drafting',
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}

function setupQuickDocxImport() {
  const btn = document.getElementById('add-chapter-from-docx-btn');
  const input = document.getElementById('import-docx-input');
  if (!btn || !input) return;
  btn.addEventListener('click', () => { input.dataset.target = 'quick'; input.click(); });
  input.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (input.dataset.target === 'quick') {
      delete input.dataset.target;
      await applyDocxImport({ mode: 'one-chapter', file });
      e.target.value = '';
    } else {
      openImportDocxModal(file);
      e.target.value = '';
    }
  });
}

function setupSettingsDocxImport() {
  const btn = document.getElementById('import-docx-btn');
  const input = document.getElementById('import-docx-input');
  if (!btn || !input) return;
  btn.addEventListener('click', () => { input.dataset.target = 'modal'; input.click(); });

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
  const radios = overlay.querySelectorAll('input[name="import-mode"]');
  radios.forEach(r => { r.checked = (r.value === 'one-chapter'); });
  const msg = document.getElementById('import-docx-messages');
  if (msg) { msg.hidden = true; msg.innerHTML = ''; }
  confirm.disabled = false;
  confirm.textContent = 'Import';
  overlay.hidden = false;

  const newConfirm = confirm.cloneNode(true);
  confirm.parentNode.replaceChild(newConfirm, confirm);
  newConfirm.addEventListener('click', async () => {
    const mode = (overlay.querySelector('input[name="import-mode"]:checked') || {}).value || 'one-chapter';
    if (mode === 'replace') {
      const ok = window.confirm(
        `Replace your entire book with "${_pendingImportFile.name}"?\n\nA "Pre-import" version will be saved automatically — you can always restore from History.`
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

function setupChapterListDropZone() {
  const ul = document.getElementById('chapters-list');
  if (!ul) return;
  let dragCount = 0;

  // Only react to FILE drags; chapter-reorder drags carry x-bookapp-chapter.
  const isFileDrag = (e) => {
    const items = e.dataTransfer?.items;
    if (!items) return false;
    for (const it of items) if (it.kind === 'file') return true;
    return false;
  };

  ul.addEventListener('dragenter', (e) => { if (!isFileDrag(e)) return; e.preventDefault(); dragCount++; ul.classList.add('drag-over'); });
  ul.addEventListener('dragover',  (e) => { if (!isFileDrag(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  ul.addEventListener('dragleave', () => { dragCount = Math.max(0, dragCount - 1); if (dragCount === 0) ul.classList.remove('drag-over'); });
  ul.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
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

// ============ BOOK TOC (left panel) ============

let _tocRefreshScheduled = false;

function setupBookToc() {
  document.getElementById('toc-collapse-btn')?.addEventListener('click', () => {
    document.querySelector('.book-body')?.classList.add('toc-collapsed');
  });
  document.getElementById('toc-show-btn')?.addEventListener('click', () => {
    document.querySelector('.book-body')?.classList.remove('toc-collapsed');
  });
  window.addEventListener('book:toc-dirty', scheduleTocRefresh);
  renderBookToc();
}

function scheduleTocRefresh() {
  if (_tocRefreshScheduled) return;
  _tocRefreshScheduled = true;
  setTimeout(() => { _tocRefreshScheduled = false; renderBookToc(); }, 300);
}

function renderBookToc() {
  const body = document.getElementById('book-toc-body');
  if (!body) return;
  body.innerHTML = '';

  state.doc.chapters.forEach((ch, idx) => {
    const isActive = ch.id === state.activeChapterId;
    const btn = document.createElement('button');
    btn.className = 'toc-chapter' + (isActive ? ' active' : '');

    const num = document.createElement('span');
    num.className = 'toc-chapter-num';
    num.textContent = (idx + 1) + '.';
    btn.appendChild(num);

    const name = document.createTextNode((ch.title || 'Untitled').slice(0, 60));
    btn.appendChild(name);

    const words = document.createElement('span');
    words.className = 'toc-chapter-words';
    words.textContent = wordsOf(ch).toLocaleString();
    btn.appendChild(words);

    btn.addEventListener('click', () => {
      if (state.activeChapterId !== ch.id) setActiveChapter(ch.id);
      else scrollEditorToTop();
      setActiveView('book');
    });
    body.appendChild(btn);

    if (isActive) {
      const headings = extractHeadings(ch.html);
      if (headings.length) {
        const sub = document.createElement('div');
        sub.className = 'toc-headings';
        headings.forEach(h => {
          const hb = document.createElement('button');
          hb.className = 'toc-heading h' + h.level;
          hb.textContent = h.text;
          hb.title = h.text;
          hb.addEventListener('click', () => scrollToHeading(h.text, h.level));
          sub.appendChild(hb);
        });
        body.appendChild(sub);
      }
    }
  });
}

function extractHeadings(html) {
  const out = [];
  const re = /<h([12])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(html || '')) !== null) {
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    if (text) out.push({ level: parseInt(m[1], 10), text });
  }
  return out;
}

function scrollToHeading(text, level) {
  const editor = document.getElementById('editor');
  if (!editor) return;
  const tag = 'H' + level;
  const candidate = [...editor.querySelectorAll(tag)].find(
    el => el.textContent.trim() === text
  );
  if (!candidate) return;
  const wrap = document.querySelector('.book-page-wrap');
  if (!wrap) return;
  const wrapRect = wrap.getBoundingClientRect();
  const elRect = candidate.getBoundingClientRect();
  wrap.scrollBy({ top: elRect.top - wrapRect.top - 80, behavior: 'smooth' });
  const range = document.createRange();
  range.selectNodeContents(candidate);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  editor.focus();
}

function scrollEditorToTop() {
  const wrap = document.querySelector('.book-page-wrap');
  if (wrap) wrap.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============ EXPORT MENU + PUBLISH FLOW ============

function setupExportMenu() {
  const dropdown = document.getElementById('export-dropdown');
  const btn = document.getElementById('export-btn');
  const menu = document.getElementById('export-menu');
  if (!dropdown || !btn || !menu) return;
  const close = () => { menu.hidden = true; };
  const open = () => { menu.hidden = false; };
  btn.addEventListener('click', (e) => { e.stopPropagation(); if (menu.hidden) open(); else close(); });
  document.addEventListener('click', (e) => { if (!dropdown.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  menu.addEventListener('click', async (e) => {
    const item = e.target.closest('.dropdown-item');
    if (!item) return;
    close();
    flushEditor();
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
      } else if (action === 'epub') {
        toast('Building book.epub…', '', 1500);
        await exportBookEpub(state.doc);
      } else if (action === 'markdown') {
        exportBookMarkdown(state.doc);
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

// ============ CROSS-CHAPTER SEARCH ============

function setupSearch() {
  search.setupSearch({
    getDoc: () => state.doc,
    getActiveChapterId: () => state.activeChapterId,
    setActiveChapter: (id) => { setActiveChapter(id); setActiveView('book'); },
    scrollToCurrentMatch: scrollToCrossChapterMatch,
    applyReplacementToChapter: applyReplacementInChapter,
  });
  document.getElementById('search-project-btn')?.addEventListener('click', () => search.open());
}

function scrollToCrossChapterMatch(query, idx, m) {
  const editor = getEditorElement();
  if (!editor) return;
  // Find first text node containing the query and scroll to it.
  const re = new RegExp(escapeRe(query), 'i');
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) {
    const found = n.nodeValue.search(re);
    if (found < 0) continue;
    const range = document.createRange();
    range.setStart(n, found);
    range.setEnd(n, found + query.length);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    const wrap = document.getElementById('book-page-wrap');
    const wrapRect = wrap.getBoundingClientRect();
    const elRect = range.getBoundingClientRect();
    wrap.scrollBy({ top: elRect.top - wrapRect.top - 120, behavior: 'smooth' });
    return;
  }
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function applyReplacementInChapter(chapterId, find, replace, once, caseSensitive) {
  const idx = state.doc.chapters.findIndex(c => c.id === chapterId);
  if (idx < 0) return;
  const ch = state.doc.chapters[idx];
  const newHtml = replaceInHtml(ch.html || '', find, replace, caseSensitive, once);
  if (newHtml === ch.html) return;
  state.doc.chapters[idx] = { ...ch, html: newHtml, updatedAt: Date.now() };
  state.doc.updatedAt = Date.now();
  if (state.activeChapterId === chapterId) {
    loadChapter(state.doc.chapters[idx]);
  }
  renderSidebarChapters();
  persistDocSoon();
}

// ============ SPRINT TIMER ============

function setupSprint() {
  sprint.setupSprint({
    getTotalWords: () => totalStats(state.doc.chapters || []).words,
    publishSnapshot: (label) => publishCurrentVersion(label, state.doc, { auth }),
    toast,
  });
  const btn = document.getElementById('sprint-btn');
  const overlay = document.getElementById('sprint-overlay');
  const startBtn = document.getElementById('sprint-start');
  const cancelBtn = document.getElementById('sprint-cancel');
  if (!btn || !overlay || !startBtn) return;

  btn.addEventListener('click', () => {
    if (sprint.isRunning()) { sprint.stop(); return; }
    overlay.hidden = false;
    setTimeout(() => document.getElementById('sprint-target').focus(), 30);
  });
  cancelBtn.addEventListener('click', () => overlay.hidden = true);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.hidden = true; });

  startBtn.addEventListener('click', () => {
    const kind = (overlay.querySelector('input[name="sprint-kind"]:checked') || {}).value || 'minutes';
    const target = parseInt(document.getElementById('sprint-target').value, 10) || 25;
    sprint.start({ kind, target });
    overlay.hidden = true;
    db.metaSet('sprintGoal', { kind, target }).catch(() => {});
  });
}

// ============ QUICK-OPEN PALETTE (⌘P) ============

function setupQuickOpen() {
  const overlay = document.getElementById('qopen-overlay');
  const input = document.getElementById('qopen-input');
  const list = document.getElementById('qopen-list');
  if (!overlay || !input || !list) return;

  let cursor = 0;
  let entries = [];

  const close = () => { overlay.hidden = true; };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    entries = state.doc.chapters
      .map((c, i) => ({ id: c.id, title: c.title || `Chapter ${i + 1}`, idx: i, words: wordsOf(c) }))
      .filter(c => !q || c.title.toLowerCase().includes(q))
      .slice(0, 30);
    cursor = Math.min(cursor, entries.length - 1);
    if (cursor < 0) cursor = 0;
    list.innerHTML = entries.map((e, i) => `
      <li class="${i === cursor ? 'active' : ''}" data-id="${escapeHtml(e.id)}">
        <span>${escapeHtml(e.idx + 1 + '. ' + e.title)}</span>
        <span class="qopen-meta">${e.words.toLocaleString()} words</span>
      </li>`).join('');
  };
  const choose = (idx) => {
    const e = entries[idx];
    if (!e) return;
    setActiveChapter(e.id);
    setActiveView('book');
    close();
  };

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(entries.length - 1, cursor + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(0, cursor - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(cursor); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const idx = entries.findIndex(x => x.id === li.dataset.id);
    if (idx >= 0) choose(idx);
  });

  window.addEventListener('qopen:open', () => {
    cursor = 0;
    input.value = '';
    overlay.hidden = false;
    setTimeout(() => { input.focus(); render(); }, 30);
  });
}

// ============ KBD HELP OVERLAY ============

function setupKbdHelp() {
  const overlay = document.getElementById('kbd-overlay');
  const close = () => overlay.hidden = true;
  document.getElementById('kbd-close')?.addEventListener('click', close);
  overlay?.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.getElementById('kbd-help-btn')?.addEventListener('click', () => overlay.hidden = false);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });
}

// ============ TOPBAR SHORTCUT BUTTONS ============

function setupTopbarShortcutButtons() {
  document.getElementById('theme-toggle-btn')?.addEventListener('click', () => theme.toggleTheme());
  document.getElementById('focus-toggle-btn')?.addEventListener('click', () => focus.toggle());
  document.getElementById('notes-toggle-btn')?.addEventListener('click', () => {
    if (notes.isOpen()) notes.close();
    else notes.open(state.activeChapterId);
  });

  // Refresh the icon glyph when theme changes.
  const refreshThemeIcon = () => {
    const eff = theme.getEffectiveTheme();
    const btn = document.getElementById('theme-toggle-btn');
    if (btn) btn.textContent = eff === 'dark' ? '☀' : '☾';
  };
  window.addEventListener('theme:change', refreshThemeIcon);
  refreshThemeIcon();
}

// ============ GLOBAL KEYBOARD SHORTCUTS ============

function setupGlobalShortcuts() {
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key;

    // ⌘F — per-chapter find (handled by editor's toolbar; only when book view)
    if (k === 'f' && !e.shiftKey && !e.altKey && state.activeView === 'book') {
      e.preventDefault();
      document.querySelector('.tb-btn[data-cmd="find"]')?.click();
      return;
    }

    // ⌘⇧F — cross-chapter search
    if ((k === 'f' || k === 'F') && e.shiftKey) {
      e.preventDefault();
      search.open();
      return;
    }

    // ⌘P — quick-open palette
    if (k === 'p' && !e.shiftKey) {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('qopen:open'));
      return;
    }

    // ⌘. — toggle focus mode
    if (k === '.') {
      e.preventDefault();
      focus.toggle();
      return;
    }

    // ⌘⇧L — toggle theme
    if ((k === 'l' || k === 'L') && e.shiftKey) {
      e.preventDefault();
      theme.toggleTheme();
      return;
    }

    // ⌘⇧N — toggle notes
    if ((k === 'n' || k === 'N') && e.shiftKey) {
      e.preventDefault();
      if (notes.isOpen()) notes.close();
      else notes.open(state.activeChapterId);
      return;
    }

    // ⌘/ — kbd help
    if (k === '/') {
      e.preventDefault();
      const overlay = document.getElementById('kbd-overlay');
      if (overlay) overlay.hidden = false;
      return;
    }
  });
}

// ============ KICK OFF ============

boot().catch(e => {
  console.error('Boot failed', e);
  toast('Failed to start: ' + e.message, 'error', 6000);
});
