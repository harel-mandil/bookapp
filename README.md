# BookApp 📖

A private, single-user writing studio that lives in your browser and saves to your own Google Drive.

🌐 **Live:** <https://harel-mandil.github.io/bookapp/>

## What it does

- **Light + Dark theme** — auto-matches your OS, with a one-click toggle in the topbar
- **Word-like visual pages** — book renders as a stack of 6×9 trade-paperback pages with running headers + page numbers, picked at Settings → Page format (also 5×8, US Letter, A4, A5)
- **Autosaves** every keystroke (locally, in milliseconds)
- **Version history** — every meaningful change is snapshotted, browseable, restorable
- **Publish Versions** — promote any moment to a named, frozen version (e.g. "Draft 1 — sent to editor"); never expires
- **Google Drive backup** — your book lives in your Drive: `BookApp/book.json` (live) + optional `BookApp/book.docx` mirror + `BookApp/versions/` (frozen versions in `.json` and `.docx`)
- **Word-style rich editor** — bold/italic/underline/strike, headings, lists, tables, images, links, alignment, undo/redo
- **Cross-chapter find / replace** (`⌘⇧F`) and per-chapter find (`⌘F`)
- **Quick-open chapter palette** (`⌘P`)
- **Distraction-free / focus mode** (`⌘.`)
- **Writing-sprint timer** — set N minutes or N words, get a chip in the corner, auto-publish a snapshot when done
- **Per-chapter author notes** — private scratchpad, never exported
- **Per-chapter word goals** with progress bars on the dashboard
- **Word-count sparkline** showing your last 30 days
- **Drag-reorder chapters** in the sidebar
- **Smart typography** — `--` → em-dash, `...` → ellipsis, curly quotes
- **Import .docx** — non-destructive (a safety version is published before any change)
- **Export** — `.docx` (book or chapter), EPUB 3, Markdown, Print/PDF, JSON backup
- **Dashboard** — words today, total, daily goal, streak, chapter progress, sparkline

No accounts, no servers, no monthly fees.

## Get started

→ Read **[SETUP.md](SETUP.md)** for the one-time Google Cloud setup (10 min).

Short version:
1. Open <https://harel-mandil.github.io/bookapp/>
2. Start writing immediately — local-only is fine
3. When ready for cloud backup, follow SETUP.md

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Bold / Italic / Underline | `⌘B` / `⌘I` / `⌘U` |
| Insert link | `⌘K` |
| Find in chapter | `⌘F` |
| Find / replace whole book | `⌘⇧F` |
| Quick-open chapter | `⌘P` |
| Toggle distraction-free | `⌘.` |
| Toggle author notes | `⌘⇧N` |
| Toggle theme | `⌘⇧L` |
| Show this help | `⌘/` |
| Undo / Redo | `⌘Z` / `⌘⇧Z` |

## Architecture

Plain HTML / ES-module JS / CSS. **No build step, no server, no framework.** Hosted statically on GitHub Pages.

External libraries are loaded lazily from [esm.sh](https://esm.sh) only when first used:
- [docx](https://github.com/dolanmiu/docx) — generates `.docx` in the browser
- [mammoth.js](https://github.com/mwilliamson/mammoth.js) — converts `.docx` → HTML on import
- [jszip](https://stuk.github.io/jszip/) — zips EPUB output

See **[KNOWN_ISSUES.md](KNOWN_ISSUES.md)** for current limitations + the deferred-features backlog.

## Files

```
index.html            — single-page shell + modals
styles/
  tokens.css          — design tokens (light + dark themes)
  app.css             — app chrome (sidebar, topbar, dashboard, modals)
  editor.css          — book-page typography + visual pagination
  dashboard.css       — dashboard pills
js/
  main.js             — entry point; wires everything
  theme.js            — light / dark / system theme switching
  paginate.js         — visual page-break injector (single-editable model)
  editor.js           — vanilla contenteditable editor + toolbar
  search.js           — cross-chapter find / replace
  sprint.js           — writing-sprint timer
  focus.js            — distraction-free mode
  notes.js            — per-chapter author notes
  typography.js       — smart quotes / em-dash / ellipsis
  wordgraph.js        — daily word-count sparkline
  epub.js             — EPUB 3 + Markdown export
  export.js           — .docx + PDF + JSON export
  import.js           — .docx import (mammoth)
  publish.js          — Publish Version flow
  snapshots.js        — version history
  sync.js             — IndexedDB ⇄ Drive
  drive.js            — Google Drive API v3 client
  auth.js             — Google Sign-In
  db.js               — IndexedDB wrapper
  sanitize.js         — HTML allow-list sanitizer
  format.js           — re-export shim
  dashboard.js        — dashboard rendering
  journey.js          — milestone events
  stats.js            — word count, reading time, page estimate
  utils.js            — small helpers
```

## License

Personal project. Use it however you like.
