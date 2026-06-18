# Known Issues — BookApp

Things that don't work the way you might expect, with the *why* and the workaround.

## Pagination

### Page breaks won't split inside a single block
The visual page-break feature (the cards that look like a stack of 6×9 paperback pages) inserts breaks BETWEEN block-level elements (paragraphs, headings, lists, tables). It does NOT split the middle of a long blockquote, table, or oversized image. If a block is taller than the page itself, it overflows the page rather than splitting.

**Workaround:** for very long blockquotes or tables, break them up into multiple blocks. The editor handles this naturally as you type.

### Page numbers shown on screen are approximate
The on-screen page count is computed by measuring rendered block heights at the current font size and page format. Word's `.docx` and the print/PDF output re-paginate using their own engines; expect ±10% drift between the on-screen count and the final printed page count.

### Changing font / page format re-flows visibly
Switching page size (e.g. 6×9 → A4) or font size in Settings causes pagination to recompute, which can make the editor flash for ~200 ms and shift the caret position relative to the page. Your content is untouched; only the page chrome moves.

---

## Theming

### Dark-mode book-page color is warm graphite, not black
The "paper" in dark mode is `#1f1f1c` — a warm dark gray that's easier on the eyes for long sessions. If you prefer pure black, this can be exposed as a setting later.

### Sidebar is always dark
By design — visually anchors the app the way Notion / Linear / Slack do. If you really want a light sidebar, file an issue.

---

## Import / Export

### `.docx` import drops some Word features
We use the open-source [mammoth.js](https://github.com/mwilliamson/mammoth.js) library, which intentionally focuses on semantic content. These are stripped on import:
- **Footnotes & endnotes** — body text is kept, but the references and notes themselves disappear.
- **Comments & tracked changes** — body text is kept, comments/changes vanish.
- **Embedded equations** — vanish silently.
- **Embedded objects** (Excel charts, PDFs, etc.) — dropped.
- **Most fancy Word styles** — only Heading 1/2/3, Title, Subtitle, Quote, and basic bold/italic/underline survive.

### `.docx` import doesn't bring images yet
Mammoth can extract images, but the current build doesn't pipe them into the editor. Planned.

### `.docx` export with external image URLs drops them
URL images can't be fetched at export time due to CORS. They're replaced with a `[image: <alt text>]` placeholder. Upload images directly (toolbar → image button) to embed them as base64.

### EPUB export is minimal
The EPUB export is a valid EPUB 3 (passes Apple Books, Calibre, most readers) but doesn't yet include cover image metadata, ISBN, or per-chapter rich metadata. Planned.

### Markdown export is best-effort
The Markdown converter handles paragraphs, headings, lists, blockquotes, links, images, tables, bold/italic. It does NOT preserve text alignment, scene breaks (rendered as `* * *`), or custom spacing.

---

## Storage

### Images bloat `book.json`
Images are stored as base64 inside `book.json` — every 1 MB of image becomes ~1.4 MB of JSON. Practical limit is roughly **50 medium-resolution images**.

### `book.docx` mirror lags `book.json` by ~30 seconds
On purpose — `.docx` generation is 200–800 ms of CPU work and running it on every keystroke would stutter typing.

### Two browser tabs editing the same book = upgrade-blocked toast
Keep one tab. If you see the toast, close all other BookApp tabs and refresh.

### `drive.file` scope: deleting Drive files manually creates orphans
The app uses Google's `drive.file` OAuth scope. Don't manually edit the `BookApp` folder in Drive — use **Reset everything (local only)** to start fresh.

---

## Editor

### Drop cap only renders on the first paragraph
CSS-driven; if your first block is a heading or scene break, the drop cap moves to the next paragraph after it.

### Pasting from Google Docs / Word strips formatting
On purpose. We keep: paragraphs, headings, bold/italic/underline, strikethrough, blockquotes, lists, tables, links, images, and text alignment. Everything else (font, color, custom spacing) is dropped.

### Smart-typography is conservative
Curly quotes / em-dash / ellipsis only fire when you've JUST typed the trigger character — they don't sweep through existing text. To turn off, uncheck **Settings → Appearance → Smart typography**.

---

## Versions / History

### Restoring an old version creates two new versions
- `pre_restore` (your current state)
- `post_restore` (the restored state)

Intentional — makes restore reversible. Use the **Auto** filter pill to hide them.

### Published versions are immortal
By design. They live forever in IndexedDB and Drive's `versions/` folder.

---

## Backlog (planned but not yet built)

These are tracked features that aren't blocking. Ask for any by number.

| # | Feature | Notes |
|---|---|---|
| 11 | Typewriter mode | Caret stays vertically centered |
| 12 | Focus current paragraph | Fade others to 0.4 opacity |
| 13 | Two-page spread view | Side-by-side review layout |
| 14 | Prominent KDP page count on dashboard | Already estimated; surface it bigger |
| 18 | Inline rename of chapter from sidebar | Double-click the row |
| 19 | Heading auto-numbering | "Chapter 7" prefix |
| 20 | Block-style dropdown | Title / H1 / H2 / H3 / Body / Quote |
| 21 | Footnotes | Superscript markers + bottom-of-page rendering |
| 22 | Markdown shortcuts while typing | `# `, `> `, `* ` |
| 28 | Calendar heatmap | GitHub-style writing-day grid |
| 29 | Daily streak history view | List of streaks |
| 32 | Bookmarks (`⌘D`) | Flag a paragraph |
| 33 | Go-to-page (`⌘G`) | Jump by page number |
| 35 | Character sheet templates | Structured doc type |
| 36 | Location / world-building cards | Same |
| 37 | Timeline view | Chapter cards on a date axis |
| 40 | Manuscript-format `.docx` preset | Times 12pt, double-spaced, 1″ margins |
| 41 | WYSIWYG print preview | Full-window preview before printing |
| 42 | Multi-select chapter export | Pick a subset |
| 45 | Snippets | Reusable text blocks |
| 46 | Recently-edited chapters list | Quick-list in sidebar |
| 48 | Dyslexia-friendly font option | OpenDyslexic from CDN |
| 49 | Screen-reader audit | ARIA labels, focus order |
| 50 | RTL toggle | Hebrew / Arabic / Farsi |
