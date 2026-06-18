// ============================================================
// paginate.js — Visual page-break injection for the contenteditable.
//
// The model: ONE underlying #editor (contenteditable). We never split
// the DOM. We measure block-level children and insert/move zero-height
// `<hr class="page-break" data-page-num="N" data-book="..." data-chapter="..."
//   contenteditable="false">` elements at the right offsets. CSS draws the
// page footer + header chrome via ::before / ::after pseudo-elements.
//
// Caret behavior: HRs are non-editable so the caret naturally crosses
// them as it would cross any other block element.
//
// Performance: ResizeObserver + 120ms debounce + requestIdleCallback.
// We bail early if the editor's content height hasn't changed AND no
// content was added/removed since the last layout pass.
//
// Page metrics come from CSS variables (--page-h, --page-margin) so the
// settings UI can change page format and the pagination updates within
// one layout cycle.
//
// Public API:
//   mountPaginator({ editorEl, getBookTitle, getChapterTitle, getPageHeight })
//   refresh()       — force a relayout (called by main.js after font-size change)
//   unmount()
// ============================================================

let editorEl = null;
let getBookTitle = () => '';
let getChapterTitle = () => '';
let getPageHeight = null;
let observer = null;
let mutObserver = null;
let scheduled = false;
let lastSig = '';

const BREAK_TAG = 'HR';
const BREAK_CLASS = 'page-break';

export function mountPaginator(opts) {
  editorEl = opts.editorEl;
  getBookTitle = opts.getBookTitle || (() => '');
  getChapterTitle = opts.getChapterTitle || (() => '');
  getPageHeight = opts.getPageHeight || defaultPageHeight;

  if (!editorEl) return;

  // Initial pass after layout settles.
  schedule();

  // Re-paginate on size change (window resize, settings change, etc.)
  observer = new ResizeObserver(schedule);
  observer.observe(editorEl);

  // Re-paginate when content changes — but ignore mutations we caused
  // (the page-break HRs and their attributes).
  mutObserver = new MutationObserver((records) => {
    for (const r of records) {
      if (r.target.classList?.contains(BREAK_CLASS)) continue;
      if ([...(r.addedNodes || [])].some(n => n.classList?.contains?.(BREAK_CLASS))) continue;
      if ([...(r.removedNodes || [])].some(n => n.classList?.contains?.(BREAK_CLASS))) continue;
      schedule();
      return;
    }
  });
  mutObserver.observe(editorEl, { childList: true, subtree: true, characterData: true });
}

export function refresh() { schedule(); }

export function unmount() {
  observer?.disconnect();
  mutObserver?.disconnect();
  observer = null;
  mutObserver = null;
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  const run = () => {
    scheduled = false;
    try { layout(); } catch (e) { console.warn('paginate failed', e); }
  };
  if (window.requestIdleCallback) {
    requestIdleCallback(run, { timeout: 250 });
  } else {
    setTimeout(run, 120);
  }
}

function defaultPageHeight() {
  // Read from the .book-page so we get the user's chosen page size.
  const bp = document.querySelector('.book-page');
  if (!bp) return 720; // ~9in @ 80dpi fallback
  const rect = bp.getBoundingClientRect();
  // Pad headroom to leave room for the title + header on the FIRST page,
  // and a small bottom buffer for orphan-control.
  return Math.max(420, rect.height - 140);
}

/** A signature derived cheaply to detect "nothing changed" between passes. */
function contentSignature() {
  if (!editorEl) return '';
  // Use scrollHeight + child count as a fast change-detector.
  const childCount = editorEl.children.length;
  return editorEl.scrollHeight + ':' + childCount;
}

function layout() {
  if (!editorEl) return;

  // Bail if nothing changed since last layout (no resize, no content delta).
  const sig = contentSignature();
  if (sig === lastSig) return;

  // Phase 1 — strip every existing HR.page-break we own. We re-create them
  // each pass; reusing in place adds complexity for negligible gain.
  removeOurBreaks();

  const blocks = [...editorEl.children].filter(n => n.tagName !== BREAK_TAG);
  if (!blocks.length) {
    lastSig = contentSignature();
    return;
  }

  const pageHeight = getPageHeight();
  if (!Number.isFinite(pageHeight) || pageHeight < 200) {
    lastSig = contentSignature();
    return;
  }

  const editorTop = editorEl.getBoundingClientRect().top;
  const bookTitle = (getBookTitle() || '').toUpperCase();
  const chapterTitle = (getChapterTitle() || '').toUpperCase();

  let pageNum = 1;
  let pageStartTop = 0;

  // We measure each block's BOTTOM relative to the editor's top. When the
  // bottom would exceed pageStartTop + pageHeight, we insert a break BEFORE
  // this block (pushing it onto the next page).
  for (let i = 0; i < blocks.length; i++) {
    const el = blocks[i];
    const rect = el.getBoundingClientRect();
    const top    = rect.top - editorTop;
    const bottom = rect.bottom - editorTop;

    // Block doesn't fit on the current page → insert break before it.
    if (i > 0 && bottom > pageStartTop + pageHeight) {
      const hr = createBreak(pageNum, bookTitle, chapterTitle);
      editorEl.insertBefore(hr, el);
      pageNum++;
      // After insertion, the HR adds vertical space — re-measure block top.
      pageStartTop = el.getBoundingClientRect().top - editorTop;
      // If the block itself is taller than a page (a huge image / table),
      // we just let it overflow rather than splitting elements.
    }
  }

  lastSig = contentSignature();
}

function removeOurBreaks() {
  for (const hr of [...editorEl.querySelectorAll(`hr.${BREAK_CLASS}`)]) hr.remove();
}

function createBreak(pageNum, book, chapter) {
  const hr = document.createElement('hr');
  hr.className = BREAK_CLASS;
  hr.setAttribute('contenteditable', 'false');
  hr.dataset.pageNum = String(pageNum);
  hr.dataset.book = book || '';
  hr.dataset.chapter = chapter || '';
  return hr;
}

/** Strip every page-break HR — used by export to feed clean HTML downstream. */
export function stripBreaksFromHtml(html) {
  return String(html || '').replace(/<hr[^>]*class=["'][^"']*page-break[^"']*["'][^>]*>/gi, '');
}
