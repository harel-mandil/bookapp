# BookApp 📖

A private, single-user writing studio that lives on your Mac and saves to your Google Drive.

- **Autosaves** every keystroke (locally, in milliseconds)
- **Version history** — every meaningful change is snapshotted, browseable, restorable
- **Google Drive backup** — your book lives in your own Drive, not someone else's database
- **Book-page editor** — Amazon-preview style: justified serif, drop cap, running header
- **Dashboard** — words today, total, daily goal, streak, chapter progress
- **Ideas + Journey + History** — capture, log, and look back

No accounts, no servers, no monthly fees. The only thing on the internet is the file you put on your own Drive.

## Get started

→ Read **[SETUP.md](SETUP.md)** for the 10-minute walkthrough.

Short version:
1. Run `python3 -m http.server 5173` from this folder (or double-click `start.command`)
2. Open <http://localhost:5173>
3. Start writing. Drive setup is optional.

## How development works

The app is plain HTML/JS/CSS — no build step. To fix a bug or add a feature, you describe what you want in plain English, I edit the right `.js` files, you reload the browser tab. Done.

Your **book content** (in Drive + browser cache) is never touched by code changes. The two are separate.

## Files

```
index.html           — single-page shell
SETUP.md             — Google Cloud setup walkthrough
start.command        — double-click to launch
styles/
  app.css            — app chrome
  editor.css         — book-page typography
  dashboard.css      — small dashboard tweaks
js/
  main.js            — entry point; wires everything
  auth.js            — Google Sign-In (GIS) token client
  drive.js           — Google Drive API v3 client
  sync.js            — orchestrates IndexedDB ⇄ Drive
  db.js              — IndexedDB wrapper
  editor.js          — contenteditable mounting + toolbar
  format.js          — bold/italic/H1/H2/blockquote helpers
  snapshots.js       — version history with smart triggers
  dashboard.js       — dashboard rendering
  journey.js         — milestone events
  stats.js           — word count, reading time, page estimate
  utils.js           — small helpers
```

## License

Personal project. Use it however you like.
