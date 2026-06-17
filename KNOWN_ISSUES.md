# Known Issues — BookApp

Things that don't work the way you might expect, with the *why* and the workaround.

## Import / Export

### `.docx` import drops some Word features
We use the open-source [mammoth.js](https://github.com/mwilliamson/mammoth.js) library, which intentionally focuses on semantic content. These are stripped on import:
- **Footnotes & endnotes** — body text is kept, but the references and notes themselves disappear.
- **Comments & tracked changes** — body text is kept, comments/changes vanish.
- **Embedded equations** (Word's equation editor) — vanish silently.
- **Embedded objects** (Excel charts, PDFs, etc.) — dropped.
- **Most fancy Word styles** — only Heading 1/2/3, Title, Subtitle, Quote, and basic bold/italic/underline survive.

If you see a yellow **"X feature(s) from Word were not imported"** toast after importing, this is what it's referring to.

**Workaround:** for important footnotes, convert them to inline parentheticals before importing.

### `.docx` import doesn't bring images yet
Mammoth can extract images from a Word file, but the current build doesn't pipe them into the editor. That's a planned upgrade.

### `.docx` export with external image URLs drops them
If you embed an image by URL (not by upload), the .docx export can't fetch it from the browser due to CORS. The export silently replaces the image with a `[image: <alt text>]` placeholder.

**Workaround:** upload images directly (via the toolbar's image button → "leave URL blank to upload"). Uploaded images embed as base64 inside `book.json` and survive export round-trips.

---

## Storage

### Images bloat `book.json`
Images are stored as base64 strings inside `book.json` — every 1 MB of image becomes ~1.4 MB of JSON. Practical limit is roughly **50 medium-resolution images** before the file gets unwieldy (~50 MB). Past that, Drive sync slows noticeably.

**Long-term fix:** store images as separate files in `BookApp/media/` and reference them by Drive ID. Not yet built.

### `book.docx` mirror lags `book.json` by ~30 seconds
The JSON working file pushes to Drive 4 seconds after you stop typing. The `.docx` mirror waits ~30 seconds (longer if you're actively typing) and runs the conversion during browser idle time. This is on purpose — generating .docx is 200-800 ms of CPU work and running it on every keystroke would stutter typing.

**Behavior:** book.docx is for "open in Word" workflows, not live collaboration. Treat it as ~30 seconds stale.

### Two browser tabs editing the same book = upgrade-blocked toast
If you have BookApp open in two tabs and one tries to upgrade the IndexedDB schema (e.g. after a deploy), the second tab's upgrade is blocked. You'll see a toast asking you to close the other tab and reload.

**Workaround:** keep one tab. If you see the toast, close all other BookApp tabs and refresh.

### `drive.file` scope: deleting Drive files manually creates orphans
The app uses Google's `drive.file` OAuth scope, which means it can only see files it created. If you go to Drive's web UI and manually delete `book.json` or move the `BookApp` folder, the app:
1. Can't see that the deletion happened
2. Will create a duplicate `book.json` on next save (with a new file ID)
3. Your old data still exists locally in IndexedDB

**Recommendation:** don't manually edit the `BookApp` folder in Drive. Use the in-app **Reset everything (local only)** button if you need to start fresh.

---

## Editor

### Find / Replace is per-chapter only
The find bar only searches the chapter you're currently viewing. Cross-chapter find is a planned upgrade.

**Workaround:** click each chapter, search separately. (Or use your browser's native `Cmd+F` on the rendered page — works for find, not replace.)

### Drop cap only renders on the first paragraph
The big colored first-letter (drop cap) is CSS-driven and applies to the *first paragraph* of the chapter. If your first block is a heading or scene break, the drop cap moves to the next paragraph after it.

### Pasting from Google Docs / Word strips formatting
On purpose. The sanitizer aggressively strips style overrides because Google Docs paste contains 100s of inline `style=""` attributes that pollute the document. We keep: paragraphs, headings, bold/italic/underline, strikethrough, blockquotes, lists, tables, links, images, and text alignment. Everything else (font, color, custom spacing) is dropped.

**Workaround:** if you need exact-formatting preservation, paste into a fresh paragraph and re-apply formatting using the toolbar.

---

## Versions / History

### Restoring an old version creates two new versions
When you restore a snapshot, the app:
1. Creates a `pre_restore` snapshot (your current state)
2. Replaces the document with the restored version
3. Creates a `post_restore` snapshot (the new state)

This is intentional — it makes restore reversible. It can clutter History; use the **Auto** filter pill to hide them.

### Published versions are immortal
By design — they never get pruned by the retention sweep. If you publish many versions you'll never lose any of them, but the `versions/` folder in Drive grows over time. Manually delete from Drive if needed (the app won't see it again — see "drive.file scope" above).

---

## Migration

### One-time `Pre-TipTap-migration` published version on first load
After upgrading to the rich editor, the app auto-publishes a `Pre-TipTap-migration` snapshot before initializing the new editor. This is your safety net in case anything renders unexpectedly. It only fires once per book.

**You can delete it from History** once you've verified your chapters look correct.
