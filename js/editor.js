// ============================================================
// editor.js — TipTap-based rich text editor.
//
// Public API (unchanged from the contenteditable era — main.js calls these):
//   mountEditor({editorEl, titleEl, toolbarEl, onChange})
//   loadChapter(chapter)
//   snapshotChapter() -> {title, html}
//   flushPending()
//   cancelPending()
//
// Implementation: TipTap (v2) loaded as ESM from esm.sh — no build step.
// We register the same StarterKit extensions the project needed before
// (paragraph, heading, bold, italic, blockquote, history) PLUS the new
// rich-text capabilities the user asked for: images, links, tables,
// underline, strike, alignment, lists, undo/redo (built into history),
// placeholder, and a custom SceneBreak node so the existing
// `<p class="scene-break">` markers round-trip correctly.
//
// Migration safety: main.js auto-publishes a 'Pre-TipTap-migration' version
// on first run (see ensureTipTapMigration()).
// ============================================================

import { stats } from './stats.js';
import { debounce } from './utils.js';
import { sanitizeHtml } from './sanitize.js';

// Lazy-loaded once at first mount.
let _tiptap = null;

const CDN = {
  core:        'https://esm.sh/@tiptap/core@2.10.3',
  starterKit:  'https://esm.sh/@tiptap/starter-kit@2.10.3',
  image:       'https://esm.sh/@tiptap/extension-image@2.10.3',
  link:        'https://esm.sh/@tiptap/extension-link@2.10.3',
  underline:   'https://esm.sh/@tiptap/extension-underline@2.10.3',
  textAlign:   'https://esm.sh/@tiptap/extension-text-align@2.10.3',
  table:       'https://esm.sh/@tiptap/extension-table@2.10.3',
  tableRow:    'https://esm.sh/@tiptap/extension-table-row@2.10.3',
  tableCell:   'https://esm.sh/@tiptap/extension-table-cell@2.10.3',
  tableHeader: 'https://esm.sh/@tiptap/extension-table-header@2.10.3',
  placeholder: 'https://esm.sh/@tiptap/extension-placeholder@2.10.3',
};

async function loadTipTap() {
  if (_tiptap) return _tiptap;
  const [core, starter, image, link, underline, textAlign, table, tr, td, th, placeholder] = await Promise.all([
    import(CDN.core),
    import(CDN.starterKit),
    import(CDN.image),
    import(CDN.link),
    import(CDN.underline),
    import(CDN.textAlign),
    import(CDN.table),
    import(CDN.tableRow),
    import(CDN.tableCell),
    import(CDN.tableHeader),
    import(CDN.placeholder),
  ]);

  _tiptap = {
    Editor: core.Editor,
    Node: core.Node,
    mergeAttributes: core.mergeAttributes,
    StarterKit: starter.default || starter.StarterKit,
    Image: image.default || image.Image,
    Link: link.default || link.Link,
    Underline: underline.default || underline.Underline,
    TextAlign: textAlign.default || textAlign.TextAlign,
    Table: table.default || table.Table,
    TableRow: tr.default || tr.TableRow,
    TableCell: td.default || td.TableCell,
    TableHeader: th.default || th.TableHeader,
    Placeholder: placeholder.default || placeholder.Placeholder,
  };
  return _tiptap;
}

let editor = null;          // TipTap Editor instance
let titleEl = null;
let toolbarEl = null;
let onChange = null;
let currentChapter = null;
let mountTarget = null;     // the element where TipTap's contenteditable lives

/**
 * Mount the editor. Replaces `editorEl`'s contents with TipTap's
 * managed DOM. Called once on app boot.
 */
export async function mountEditor(opts) {
  mountTarget = opts.editorEl;
  titleEl = opts.titleEl;
  toolbarEl = opts.toolbarEl;
  onChange = opts.onChange;

  // Show a tiny loading state while the bundle downloads.
  mountTarget.innerHTML = '<p style="color:#9a9a9a;font-style:italic">Loading editor…</p>';
  mountTarget.contentEditable = 'false';

  const T = await loadTipTap();

  // ============ Custom SceneBreak node ============
  // Survives round-trip with the existing `<p class="scene-break">` markup.
  const SceneBreak = T.Node.create({
    name: 'sceneBreak',
    group: 'block',
    atom: true,
    selectable: true,
    parseHTML() {
      return [{ tag: 'p.scene-break' }];
    },
    renderHTML({ HTMLAttributes }) {
      return ['p', T.mergeAttributes(HTMLAttributes, { class: 'scene-break', contenteditable: 'false' })];
    },
    addCommands() {
      return {
        insertSceneBreak: () => ({ commands }) => commands.insertContent({ type: this.name }),
      };
    },
  });

  editor = new T.Editor({
    element: mountTarget,
    content: '<p></p>',
    extensions: [
      T.StarterKit.configure({
        // History is on by default — provides Cmd+Z / Cmd+Shift+Z.
      }),
      T.Underline,
      T.Link.configure({
        openOnClick: false,
        autolink: true,
        protocols: ['http', 'https', 'mailto'],
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
      T.Image.configure({ inline: false, allowBase64: true }),
      T.TextAlign.configure({ types: ['heading', 'paragraph'] }),
      T.Table.configure({ resizable: true, HTMLAttributes: { class: 'editor-table' } }),
      T.TableRow,
      T.TableCell,
      T.TableHeader,
      T.Placeholder.configure({ placeholder: 'Begin your chapter here…' }),
      SceneBreak,
    ],
    onUpdate: () => {
      fireChange();
      refreshToolbar();
      refreshWordCount();
    },
    onSelectionUpdate: () => {
      refreshToolbar();
    },
  });

  // ============ Toolbar wiring ============
  toolbarEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.tb-btn, .dropdown-item[data-cmd]');
    if (!btn) return;
    const cmd = btn.dataset.cmd;
    if (!cmd) return;
    e.preventDefault();
    runCommand(cmd, btn);
    editor.commands.focus();
    refreshToolbar();
  });

  // Keep title in sync.
  titleEl.addEventListener('input', () => fireChange());

  refreshToolbar();
  refreshWordCount();
}

// ============ CHAPTER LOAD/SAVE ============

/** Load a chapter into the editor. */
export function loadChapter(chapter) {
  currentChapter = chapter;
  if (editor) {
    // emitUpdate:false avoids re-firing onChange during load.
    editor.commands.setContent(chapter.html || '<p></p>', false);
  }
  if (titleEl) titleEl.value = chapter.title || '';
  refreshToolbar();
  refreshWordCount();
}

/** Returns current chapter snapshot (title + html). */
export function snapshotChapter() {
  return {
    title: titleEl ? titleEl.value : (currentChapter?.title ?? ''),
    html: editor ? sanitizeHtml(editor.getHTML()) : (currentChapter?.html ?? ''),
  };
}

// ============ DEBOUNCED CHANGE NOTIFICATION ============

const fireChangeDebounced = debounce(() => {
  if (!currentChapter || !onChange) return;
  const snap = snapshotChapter();
  onChange({ ...currentChapter, ...snap });
}, 600, { maxWait: 8000 });

function fireChange() {
  refreshWordCount();
  fireChangeDebounced();
}

/** Flush pending debounce — call before swapping chapters or persisting. */
export function flushPending() {
  fireChangeDebounced.flush?.();
}

/** Cancel any pending debounce — call after replacing the doc. */
export function cancelPending() {
  fireChangeDebounced.cancel?.();
}

// ============ TOOLBAR HELPERS ============

function refreshWordCount(html) {
  if (!editor) return;
  const s = stats(html ?? editor.getHTML());
  const wc = document.getElementById('chapter-word-count');
  const rt = document.getElementById('chapter-reading-time');
  if (wc) wc.textContent = s.words;
  if (rt) rt.textContent = s.readingLabel;
}

function refreshToolbar() {
  if (!editor || !toolbarEl) return;
  const checks = {
    bold:        () => editor.isActive('bold'),
    italic:      () => editor.isActive('italic'),
    underline:   () => editor.isActive('underline'),
    strike:      () => editor.isActive('strike'),
    h1:          () => editor.isActive('heading', { level: 1 }),
    h2:          () => editor.isActive('heading', { level: 2 }),
    blockquote:  () => editor.isActive('blockquote'),
    paragraph:   () => editor.isActive('paragraph'),
    bulletList:  () => editor.isActive('bulletList'),
    orderedList: () => editor.isActive('orderedList'),
    link:        () => editor.isActive('link'),
    'align-left':    () => editor.isActive({ textAlign: 'left' }),
    'align-center':  () => editor.isActive({ textAlign: 'center' }),
    'align-right':   () => editor.isActive({ textAlign: 'right' }),
    'align-justify': () => editor.isActive({ textAlign: 'justify' }),
  };
  toolbarEl.querySelectorAll('.tb-btn').forEach(btn => {
    const cmd = btn.dataset.cmd;
    const fn = checks[cmd];
    btn.classList.toggle('active', !!(fn && fn()));
  });
}

function runCommand(cmd, btn) {
  if (!editor) return;
  const C = editor.chain().focus();
  switch (cmd) {
    case 'bold':            return C.toggleBold().run();
    case 'italic':          return C.toggleItalic().run();
    case 'underline':       return C.toggleUnderline().run();
    case 'strike':          return C.toggleStrike().run();
    case 'h1':              return C.toggleHeading({ level: 1 }).run();
    case 'h2':              return C.toggleHeading({ level: 2 }).run();
    case 'blockquote':      return C.toggleBlockquote().run();
    case 'paragraph':       return C.setParagraph().run();
    case 'bulletList':      return C.toggleBulletList().run();
    case 'orderedList':     return C.toggleOrderedList().run();
    case 'align-left':      return C.setTextAlign('left').run();
    case 'align-center':    return C.setTextAlign('center').run();
    case 'align-right':     return C.setTextAlign('right').run();
    case 'align-justify':   return C.setTextAlign('justify').run();
    case 'undo':            return C.undo().run();
    case 'redo':            return C.redo().run();
    case 'scenebreak':      return C.insertSceneBreak().run();
    case 'link':            return promptLink();
    case 'image':           return promptImage();
    case 'table':           return C.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    case 'find':            return openFindBar();
  }
}

function promptLink() {
  const prev = editor.getAttributes('link').href || '';
  const url = window.prompt('Link URL (leave empty to remove):', prev);
  if (url === null) return;
  if (!url) {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    return;
  }
  // Basic safety: only http(s) and mailto.
  const safe = /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`;
  editor.chain().focus().extendMarkRange('link').setLink({ href: safe }).run();
}

/**
 * Prompt for an image. Two paths: paste a URL or upload from disk.
 * On disk uploads, we read as base64 so the image embeds in the doc and
 * survives Drive sync without needing a separate file store.
 */
function promptImage() {
  const choice = window.prompt('Paste an image URL, or leave blank to upload from your computer:');
  if (choice === null) return;
  const url = (choice || '').trim();
  if (url) {
    if (!/^https?:\/\//i.test(url)) {
      alert('Image URL must start with http(s)://');
      return;
    }
    editor.chain().focus().setImage({ src: url }).run();
    return;
  }
  // No URL → file picker.
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/png,image/jpeg,image/gif,image/webp';
  inp.onchange = () => {
    const f = inp.files?.[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) {
      if (!confirm(`That image is ${(f.size / 1024 / 1024).toFixed(1)} MB. Embedding large images bloats your book file. Continue?`)) return;
    }
    const r = new FileReader();
    r.onload = () => {
      editor.chain().focus().setImage({ src: r.result, alt: f.name }).run();
    };
    r.readAsDataURL(f);
  };
  inp.click();
}

// ============ FIND / REPLACE (per-chapter) ============

let findBar = null;

function openFindBar() {
  if (!findBar) {
    findBar = document.getElementById('find-bar');
    if (!findBar) return;
    findBar.querySelector('[data-find=close]')?.addEventListener('click', closeFindBar);
    findBar.querySelector('[data-find=next]')?.addEventListener('click', () => findStep(+1));
    findBar.querySelector('[data-find=prev]')?.addEventListener('click', () => findStep(-1));
    findBar.querySelector('[data-find=replace]')?.addEventListener('click', findReplaceOne);
    findBar.querySelector('[data-find=replace-all]')?.addEventListener('click', findReplaceAll);
    findBar.querySelector('input[name=q]')?.addEventListener('input', findReset);
  }
  findBar.hidden = false;
  findBar.querySelector('input[name=q]')?.focus();
}

function closeFindBar() {
  if (findBar) findBar.hidden = true;
  editor?.commands.focus();
}

let findMatches = [];
let findIdx = -1;

function collectMatches(query) {
  if (!editor || !query) return [];
  const out = [];
  const re = new RegExp(escapeRegex(query), 'gi');
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    let m;
    while ((m = re.exec(node.text || '')) !== null) {
      out.push({ from: pos + m.index, to: pos + m.index + m[0].length });
    }
    return true;
  });
  return out;
}

function findReset() {
  findIdx = -1;
  findMatches = [];
}

function findStep(dir) {
  const q = findBar?.querySelector('input[name=q]')?.value || '';
  if (!q) return;
  if (!findMatches.length) findMatches = collectMatches(q);
  if (!findMatches.length) return;
  findIdx = (findIdx + dir + findMatches.length) % findMatches.length;
  const m = findMatches[findIdx];
  editor.chain().focus().setTextSelection({ from: m.from, to: m.to }).scrollIntoView().run();
}

function findReplaceOne() {
  const q = findBar?.querySelector('input[name=q]')?.value || '';
  const r = findBar?.querySelector('input[name=r]')?.value || '';
  if (!q) return;
  // Replace currently-selected match (or step to first) and advance.
  const sel = editor.state.selection;
  const selText = editor.state.doc.textBetween(sel.from, sel.to);
  if (selText.toLowerCase() === q.toLowerCase()) {
    editor.chain().focus().insertContentAt({ from: sel.from, to: sel.to }, r).run();
    findReset();
    findStep(+1);
  } else {
    findStep(+1);
  }
}

function findReplaceAll() {
  const q = findBar?.querySelector('input[name=q]')?.value || '';
  const r = findBar?.querySelector('input[name=r]')?.value || '';
  if (!q) return;
  const matches = collectMatches(q).reverse();   // reverse so positions stay valid
  let chain = editor.chain().focus();
  for (const m of matches) chain = chain.insertContentAt({ from: m.from, to: m.to }, r);
  chain.run();
  findReset();
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
