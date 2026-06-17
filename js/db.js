// ============================================================
// db.js — IndexedDB wrapper.
// One database "bookapp" with these stores:
//   meta       — singleton config (driveFolderId, driveBookFileId, prefs, clientId)
//   document   — id "current" → the live working document JSON (crash-recovery buffer)
//   snapshots  — auto-incrementing version history
//   journey    — milestone events
//   sessions   — per-day stats (key = YYYY-MM-DD)
//   ideas      — captured ideas
// ============================================================

const DB_NAME = 'bookapp';
// v2 (2026-06): added `kind` and `label` fields to snapshots so the user can
// distinguish auto-saved versions from named "Published" ones. Migration in
// onupgradeneeded backfills `kind: 'auto'` on every existing snapshot.
const DB_VERSION = 2;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    // Two tabs / windows on the same origin will block this upgrade.
    // Surface that clearly so the user knows what to do.
    req.onblocked = () => {
      try {
        // Dynamic import keeps utils.js out of the cold-path require graph.
        import('./utils.js').then(({ toast }) => {
          toast('Please close other BookApp tabs and reload — database upgrade pending.', 'warning', 6000);
        }).catch(() => {});
      } catch {}
    };
    req.onupgradeneeded = (e) => {
      const db = req.result;
      const oldVersion = e.oldVersion;

      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('document')) {
        db.createObjectStore('document', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('snapshots')) {
        const s = db.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true });
        s.createIndex('byTimestamp', 'timestamp');
      }
      if (!db.objectStoreNames.contains('journey')) {
        const s = db.createObjectStore('journey', { keyPath: 'id', autoIncrement: true });
        s.createIndex('byTimestamp', 'timestamp');
      }
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'date' });
      }
      if (!db.objectStoreNames.contains('ideas')) {
        const s = db.createObjectStore('ideas', { keyPath: 'id' });
        s.createIndex('byTimestamp', 'createdAt');
      }

      // v1 → v2: backfill `kind: 'auto'` on every existing snapshot.
      // Use the upgrade transaction (req.transaction) — opening a new tx
      // here would deadlock.
      if (oldVersion < 2 && db.objectStoreNames.contains('snapshots')) {
        const store = req.transaction.objectStore('snapshots');
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (!cursor) return;
          const row = cursor.value;
          if (row && row.kind == null) {
            cursor.update({ ...row, kind: 'auto', label: row.label ?? null });
          }
          cursor.continue();
        };
      }
    };
  });
  return dbPromise;
}

function tx(storeName, mode = 'readonly') {
  return open().then(db => {
    const t = db.transaction(storeName, mode);
    return { tx: t, store: t.objectStore(storeName) };
  });
}

function asPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ============ META ============

export async function metaGet(key, fallback = null) {
  const { store } = await tx('meta');
  const row = await asPromise(store.get(key));
  return row ? row.value : fallback;
}

export async function metaSet(key, value) {
  const { store } = await tx('meta', 'readwrite');
  await asPromise(store.put({ key, value }));
}

export async function metaAll() {
  const { store } = await tx('meta');
  const rows = await asPromise(store.getAll());
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// ============ DOCUMENT (the live buffer) ============

export async function docLoad() {
  const { store } = await tx('document');
  const row = await asPromise(store.get('current'));
  return row ? row.data : null;
}

export async function docSave(data) {
  const { store } = await tx('document', 'readwrite');
  await asPromise(store.put({ id: 'current', data, savedAt: Date.now() }));
}

// ============ SNAPSHOTS ============

export async function snapshotAdd(snap) {
  const { store } = await tx('snapshots', 'readwrite');
  return asPromise(store.add(snap));
}

export async function snapshotsAll() {
  const { store } = await tx('snapshots');
  const idx = store.index('byTimestamp');
  return asPromise(idx.getAll());
}

export async function snapshotGet(id) {
  const { store } = await tx('snapshots');
  return asPromise(store.get(id));
}

export async function snapshotDelete(id) {
  const { store } = await tx('snapshots', 'readwrite');
  return asPromise(store.delete(id));
}

/** Filter snapshots by `kind` ('auto' | 'published'). Defaults to 'auto' for legacy rows. */
export async function snapshotsByKind(kind) {
  const all = await snapshotsAll();
  return all.filter(s => (s.kind ?? 'auto') === kind);
}

// ============ JOURNEY ============

export async function journeyAdd(event) {
  const { store } = await tx('journey', 'readwrite');
  return asPromise(store.add({ ...event, timestamp: event.timestamp ?? Date.now() }));
}

export async function journeyAll() {
  const { store } = await tx('journey');
  const idx = store.index('byTimestamp');
  return asPromise(idx.getAll());
}

// ============ SESSIONS ============

export async function sessionGet(date) {
  const { store } = await tx('sessions');
  return asPromise(store.get(date));
}

export async function sessionUpsert(date, patch) {
  const { store } = await tx('sessions', 'readwrite');
  const existing = await asPromise(store.get(date));
  const next = { date, wordsAdded: 0, wordsRemoved: 0, msActive: 0, sessions: 0, ...existing, ...patch };
  await asPromise(store.put(next));
  return next;
}

export async function sessionsAll() {
  const { store } = await tx('sessions');
  return asPromise(store.getAll());
}

// ============ IDEAS ============

export async function ideaAdd(idea) {
  const { store } = await tx('ideas', 'readwrite');
  return asPromise(store.put(idea));
}
export async function ideaUpdate(id, patch) {
  const { store } = await tx('ideas', 'readwrite');
  const existing = await asPromise(store.get(id));
  if (!existing) return;
  await asPromise(store.put({ ...existing, ...patch }));
}
export async function ideaDelete(id) {
  const { store } = await tx('ideas', 'readwrite');
  return asPromise(store.delete(id));
}
export async function ideasAll() {
  const { store } = await tx('ideas');
  const idx = store.index('byTimestamp');
  return asPromise(idx.getAll());
}

// ============ STORAGE INFO ============

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  return navigator.storage.estimate();
}

export async function persistStorage() {
  if (!navigator.storage?.persist) return false;
  return navigator.storage.persist();
}

// ============ RESET ============

export async function resetAll() {
  const db = await open();
  db.close();
  dbPromise = null;
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}
