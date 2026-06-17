// ============================================================
// stats.js — word count, reading time, page estimate.
// One canonical word-count function used everywhere.
// ============================================================

const WPM = 250;            // hardcoded reading speed (research §5.5)
const WORDS_PER_PAGE = 280; // 6x9 trade @ 11pt body, ~1.45 leading

/**
 * Strip HTML tags and return plain text.
 */
function htmlToText(html) {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.textContent || '').normalize('NFC');
}

/**
 * Count words in a string. Splits on Unicode word boundaries.
 * Counts CJK ideographs as separate "words" for reading-time purposes.
 */
export function countWords(text) {
  if (!text) return 0;
  // Latin-style words: letters/digits with internal apostrophes/hyphens.
  const latinWordRe = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;
  // CJK ranges (simplified set covering Chinese, Japanese kana, Korean Hangul).
  const cjkRe = /[一-鿿぀-ヿ가-힯]/gu;

  const matches = text.match(latinWordRe) || [];
  // Filter out tokens that are purely CJK (we'll count those separately).
  const latin = matches.filter(w => !cjkRe.test(w));
  const cjk = (text.match(cjkRe) || []).length;
  return latin.length + cjk;
}

/**
 * Headline stats for a chunk of HTML — used by editor toolbar, dashboard, etc.
 */
export function stats(html) {
  const text = htmlToText(html);
  const words = countWords(text);
  const chars = [...text].length;
  const charsNoWs = [...text.replace(/\s+/gu, '')].length;
  const sentences = (text.match(/[.!?。！？]+(\s|$)/gu) || []).length;

  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';
  const paragraphs = (tmp.querySelectorAll('p,h1,h2,h3,blockquote,li').length) || (text ? 1 : 0);

  const minutes = words / WPM;
  const readingLabel =
    minutes < 1 ? '< 1 min'
    : minutes < 60 ? `${Math.ceil(minutes)} min`
    : `${Math.floor(minutes / 60)}h ${Math.ceil(minutes % 60)}m`;

  const pages = Math.max(words ? 1 : 0, Math.ceil(words / WORDS_PER_PAGE));

  return { words, chars, charsNoWs, sentences, paragraphs, readingMinutes: minutes, readingLabel, pages };
}

/**
 * Total stats across all chapters.
 */
export function totalStats(chapters) {
  let words = 0, chars = 0;
  for (const c of chapters) {
    const s = stats(c.html || '');
    words += s.words;
    chars += s.chars;
  }
  const minutes = words / WPM;
  const readingLabel =
    minutes < 1 ? '< 1 min'
    : minutes < 60 ? `${Math.ceil(minutes)} min`
    : `${Math.floor(minutes / 60)}h ${Math.ceil(minutes % 60)}m`;
  const pages = Math.max(words ? 1 : 0, Math.ceil(words / WORDS_PER_PAGE));
  return { words, chars, readingMinutes: minutes, readingLabel, pages };
}

/**
 * Per-chapter words shortcut.
 */
export function wordsOf(chapter) {
  return stats(chapter?.html || '').words;
}
