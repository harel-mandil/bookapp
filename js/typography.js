// ============================================================
// typography.js — Smart-quote, em-dash, ellipsis transforms.
//
// Hook: attach to an editor's `input` event. We don't fight the user —
// only transform on insertions, never inside <code>, never on paste
// (paste comes through the editor's paste handler already).
//
// Rules:
//   "  → curly quotes (left/right) based on neighboring whitespace
//   '  → curly apostrophe / single quote
//   -- → — (em dash)  (when surrounded by word chars)
//   ...→ … (ellipsis)
//
// Disabled by default; toggle in settings (meta.smartTypography = true).
// ============================================================

let _enabled = true;

export function setSmartTypography(on) { _enabled = !!on; }

export function attach(editorEl) {
  if (!editorEl) return;
  editorEl.addEventListener('input', (e) => {
    if (!_enabled) return;
    if (e.isComposing) return;
    if (e.inputType && /paste|drop/i.test(e.inputType)) return;
    handleTextNode();
  });
}

function handleTextNode() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return;
  const node = range.startContainer;
  if (!node || node.nodeType !== 3) return;
  const offset = range.startOffset;
  const text = node.nodeValue;
  if (!text) return;

  // Try transforms looking BACKWARD from the caret. We only modify if a
  // transform applies, then preserve caret position by recalculating offset.
  const replacements = [
    // ellipsis: literal "..." → "…"
    { pattern: /\.\.\.$/, replace: () => '…', delta: -2 },
    // em dash: literal "--" → "—"
    { pattern: /--$/,     replace: () => '—', delta: -1 },
    // closing/opening curly double quote (decided by char before)
    { pattern: /"$/, replace: (m, idx) => idx > 0 && /[\w.,!?)\]”]/.test(text[idx - 1]) ? '”' : '“', delta: 0 },
    // curly single quote / apostrophe
    { pattern: /'$/, replace: (m, idx) => idx > 0 && /[\w.,!?)\]”’]/.test(text[idx - 1]) ? '’' : '‘', delta: 0 },
  ];

  for (const r of replacements) {
    const slice = text.slice(0, offset);
    const m = slice.match(r.pattern);
    if (!m) continue;
    const matchStart = slice.length - m[0].length;
    const repl = r.replace(m[0], matchStart);
    if (!repl) continue;
    const before = text.slice(0, matchStart);
    const after  = text.slice(offset);
    const newText = before + repl + after;
    if (newText === text) return;
    node.nodeValue = newText;
    const newOffset = matchStart + repl.length;
    const newRange = document.createRange();
    newRange.setStart(node, newOffset);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
    return;
  }
}
