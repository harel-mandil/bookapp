# SETUP — BookApp

This is your one-time setup. After this, you just open the app and write.

You're going to do **two things**:
1. **Run the app** (one terminal command, then a browser tab).
2. **Connect Google Drive** (10 minutes in Google Cloud Console — done once, ever).

You can do step 1 and start writing today. Drive sync is optional — your work is safe locally without it. Set it up when you have 10 minutes.

---

## 1. Run the app

The app is a static website — no installation, no `npm install`. But browsers block Google Sign-In on `file://` URLs, so we serve it from a tiny local web server.

### Easiest way — one command

Open Terminal, paste:

```bash
cd /Users/C5415849/Desktop/BOOKAPPWEBSITE && python3 -m http.server 5173
```

Then open: **http://localhost:5173**

That's it. Leave the terminal window open while you write. To stop the server: `Ctrl+C` in the terminal.

### Even easier — double-click

There's a `start.command` file in this folder. Double-click it. It does the same thing.

---

## 2. Connect Google Drive (10 min, one time)

Until you do this, the app saves everything locally to your browser's storage — your book is safe and never leaves your Mac. Connect Drive when you want cloud backup + multi-device access.

### Step-by-step

#### 2.1 Create a Google Cloud project

1. Go to <https://console.cloud.google.com/>
2. Sign in with the Google account where you want your book stored.
3. Top bar → click the project dropdown → **"New Project"**.
4. Name: `BookApp` (or anything). Click **Create**.
5. Wait ~10 seconds, then make sure that project is selected in the top bar.

#### 2.2 Enable the Drive API

1. Left sidebar → **APIs & Services → Library**.
2. Search for **"Google Drive API"** → click it → **Enable**.

#### 2.3 Set up the OAuth consent screen

1. Left sidebar → **APIs & Services → OAuth consent screen**.
2. User Type: **External** → **Create**.
3. Fill the required fields:
   - App name: `BookApp`
   - User support email: your email
   - Developer contact email: your email
4. Click **Save and Continue**.
5. **Scopes** step → click **"Add or Remove Scopes"** → search for `drive.file` → check the box for `.../auth/drive.file` → **Update** → **Save and Continue**.
6. **Test users** → **Add Users** → add your own Google email → **Save and Continue**.
7. Back to the Dashboard. **Leave the publishing status as "Testing"** — that's all you need for personal use. (No Google verification, no review, no annual security audit.)

#### 2.4 Create the OAuth Client ID

1. Left sidebar → **APIs & Services → Credentials**.
2. **+ Create Credentials → OAuth client ID**.
3. Application type: **Web application**.
4. Name: `BookApp Web Client`.
5. **Authorized JavaScript origins** → **+ Add URI**: paste exactly `http://localhost:5173`
   - No path, no trailing slash. Just the origin.
   - If you ever host the app elsewhere (GitHub Pages, your own domain), add that origin too.
6. **Authorized redirect URIs**: leave **empty**.
7. **Create**.
8. A dialog pops up showing a Client ID like `123456789-abc...xyz.apps.googleusercontent.com`. **Copy it.**

#### 2.5 Paste it into the app

1. Open the app (http://localhost:5173).
2. Sidebar → **Settings**.
3. **Google Drive** → paste your Client ID → **Save Client ID**.
4. Top right → **Connect Google Drive**.
5. Google's consent popup → pick your account → "Continue" through the warning ("App not verified" — that's expected since you didn't submit it for review; it's safe because you only granted `drive.file` which is per-file scope) → "Continue" → done.

You'll see **"Drive ✓"** in the top right. From now on, every change you make autosaves locally instantly and pushes to Drive every few seconds.

In your Drive, a folder called **`BookApp`** appears containing **`book.json`**. Don't manually edit those files — let the app manage them.

---

## What's stored where?

| What | Where |
|---|---|
| Your book content (chapters, ideas, sessions) | **Google Drive** (`BookApp/book.json`) + **IndexedDB** (browser cache) |
| Version history snapshots | **IndexedDB** (browser cache) — local only for now |
| The app itself (HTML/JS/CSS) | This folder on your Mac |
| Your OAuth Client ID | **IndexedDB** (browser cache) — re-paste if you reset |

Your **Mac dying** would lose: the app code (rebuildable in minutes), version history snapshots (the most recent state is still in Drive). Your **Drive being deleted** would lose: cloud backup. Your **browser cache being cleared** would lose: snapshots + session stats; the book itself reloads from Drive next time you connect.

---

## Troubleshooting

**"Connect failed: popup_closed_by_user"** — The popup blocker ate it, or you closed the popup. Try again — make sure you click **Connect Google Drive** directly (don't click anything else first).

**"Connect failed: redirect_uri_mismatch"** — The origin you're running on isn't in the authorized list in Google Cloud Console. Check: are you on `http://localhost:5173` exactly? (Not `127.0.0.1`, not a different port.) Or update the authorized origin in the Console.

**"Drive auth expired"** — Tokens last 1 hour. The app silently refreshes most of the time, but Safari and private windows sometimes block silent refresh. Click **Connect Google Drive** again to re-auth.

**Sync indicator shows "error"** — Open **Diagnostics** (sidebar bottom) → click **Copy to clipboard** → paste it here in chat. It tells me exactly what failed.

**"Storage info unavailable"** — Some browsers (older Safari) don't expose `navigator.storage.estimate()`. The app still works; you just can't see usage stats.

**Resetting** — **Settings → Reset everything (local only)**. This wipes the local cache. Drive copies are untouched; reconnect after reset and your book reloads.
