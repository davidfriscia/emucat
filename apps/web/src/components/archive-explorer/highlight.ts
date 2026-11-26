import { sanitizeHighlighted } from './safe-html';

/**
 * Syntax highlighting with the highlight.js build Vditor already ships and this application already serves from its
 * own origin (decision 0053): no new dependency, nothing from a third party. It is loaded once, on first use. Its
 * output is escaped text in `span`s, and is sanitized again before it is shown (decision 0056).
 */

export interface HighlightJs {
  getLanguage(name: string): unknown;
  highlight(
    code: string,
    options: { language: string; ignoreIllegals: boolean },
  ): { value: string };
}

/** Set by the script, as a global (Vditor's own typings declare it too). */
const loaded = () => (window as unknown as { hljs?: HighlightJs }).hljs ?? null;

/** Larger text is shown plain: highlighting it would hold up the page for little benefit. */
export const MAX_HIGHLIGHT_CHARACTERS = 256 * 1024;

let loading: Promise<HighlightJs | null> | null = null;

export function loadHighlighter(): Promise<HighlightJs | null> {
  const ready = loaded();
  if (ready) return Promise.resolve(ready);
  loading ??= new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = `${__VDITOR_CDN__}/dist/js/highlight.js/highlight.min.js`;
    script.async = true;
    script.onload = () => resolve(loaded());
    script.onerror = () => {
      loading = null;
      resolve(null);
    };
    document.head.append(script);
  });
  return loading;
}

/** Highlighted HTML, or `null` when the language is unknown, the text too long, or highlighting failed. */
export function highlight(highlighter: HighlightJs, text: string, language: string): string | null {
  if (text.length > MAX_HIGHLIGHT_CHARACTERS || !highlighter.getLanguage(language)) return null;
  try {
    return sanitizeHighlighted(
      highlighter.highlight(text, { language, ignoreIllegals: true }).value,
    );
  } catch {
    return null;
  }
}
