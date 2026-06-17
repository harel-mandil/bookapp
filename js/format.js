// ============================================================
// format.js — legacy shim. The contenteditable-era formatter has been
// replaced by TipTap (see editor.js). This file now only re-exports
// the sanitizer for backwards-compatible imports elsewhere in the app.
// ============================================================

export { sanitizeHtml } from './sanitize.js';
