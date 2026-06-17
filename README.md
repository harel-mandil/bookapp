# BookApp 📖

A private, single-user writing studio that lives in your browser and saves to your own Google Drive.

🌐 **Live:** <https://harel-mandil.github.io/bookapp/>

## What it does

- **Autosaves** every keystroke (locally, in milliseconds)
- **Version history** — every meaningful change is snapshotted, browseable, restorable
- **Publish Versions** — promote any moment to a named, frozen version that never expires (e.g. "Draft 1 — sent to editor")
- **Google Drive backup** — your book lives in *your* Drive: `BookApp/book.json` (live) + optional `BookApp/book.docx` mirror + `BookApp/versions/` (frozen published versions, in both .json and .docx)
- **Word-style rich editor** — bold/italic/underline/strike, headings, lists (bullet + numbered), tables, images, links, alignment, undo/redo, find/replace
- **Import .docx** — upload a Word doc; choose "add as one chapter" / "split by H1 into multiple chapters" / "replace entire book". Always non-destructive — a safety version is published before any change.
- **Export** — download as .docx (full book or single chapter), print/PDF, or JSON backup
- **Dashboard** — words today, total, daily goal, streak, chapter progress
- **Ideas + Journey + History** — capture, log, and look back

No accounts, no servers, no monthly fees. The only thing on the internet is the file you put on your own Drive.

## Get started

→ Read **[SETUP.md](SETUP.md)** for the one-time Google Cloud setup (10 min).

Short version:
1. Open <https://harel-mandil.github.io/bookapp/>
2. Start writing immediately — local-only is fine
3. When you're ready for cloud backup, follow SETUP.md to connect Google Drive

## Architecture

The app is plain HTML / ES-module JS / CSS. **No build step, no server, no framework.**
Hosted statically on GitHub Pages.

External libraries are loaded lazily from [esm.sh](https://esm.sh) only when first used:
- [TipTap](https://tiptap.dev) (ProseMirror) — rich text editor
- [docx](https://github.com/dolanmiu/docx) — generates real `.docx` files in the browser
- [mammoth.js](https://github.com/mwilliamson/mammoth.js) — converts `.docx` → HTML on import

See **[KNOWN_ISSUES.md](KNOWN_ISSUES.md)** for current limitations.

## Files

```
index.html           — single-page shell + modals
SETUP.md             — Google Cloud setup walkthrough
KNOWN_ISSUES.md      — current limitations + workarounds
start.command        — local dev launcher (optional)
styles/
  app.css            — app chrome (sidebar, dropdowns, modals, badges)
  editor.css         — book-page typography + rich-editor extensions
  dashboard.css      — dashboard tweaks
js/
  main.js            — entry point; wires everything
  auth.js            — Google Sign-In (GIS) token client
  drive.js           — Google Drive API v3 client (JSON + binary)
  sync.js            — orchestrates IndexedDB ⇄ Drive (json + docx mirror)
  db.js              — IndexedDB wrapper (v2 schema)
  editor.js          — TipTap rich editor mount + toolbar
  sanitize.js        — HTML allow-list sanitizer
  format.js          — legacy shim, re-exports sanitize
  snapshots.js       — version history (auto + published kinds)
  publish.js         — Publish Version flow
  export.js          — .docx / PDF / JSON export
  import.js          — .docx import (mammoth)
  dashboard.js       — dashboard rendering
  journey.js         — milestone events
  stats.js           — word count, reading time, page estimate
  utils.js           — small helpers
```

## License

Personal project. Use it however you like.
