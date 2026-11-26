import DOMPurify from 'dompurify';

/**
 * HTML made from archive contents (decision 0056): Markdown rendered by Lute and syntax highlighting from
 * highlight.js. Archive files are untrusted, more so than VM notes, so this has its own DOMPurify instance with its
 * own, stricter rules, and shares no hooks with the notes editor's:
 *
 * - Only text formatting survives: no images, media, frames, forms, styles, scripts, SVG or MathML.
 * - Nothing loads: no element keeps a `src`, `srcset`, `poster`, `style` or `background`, so a preview never makes a
 *   request, to this server or any other.
 * - Links do not navigate: an external link becomes inert text that shows its target; only `#fragment` links stay.
 * - No `id` or `name`, so content cannot clobber the page's own DOM.
 */

const purifier = typeof window === 'undefined' ? null : DOMPurify(window);

const TEXT_TAGS = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'br',
  'hr',
  'strong',
  'b',
  'em',
  'i',
  'u',
  'del',
  's',
  'mark',
  'code',
  'pre',
  'kbd',
  'samp',
  'blockquote',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'a',
  'span',
  'div',
  'sup',
  'sub',
  'details',
  'summary',
];

let hooked = false;

function install(): void {
  if (!purifier || hooked) return;
  hooked = true;
  // A second line of defence: whatever reached the sanitizer with a target other than a fragment loses it.
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName !== 'A') return;
    const href = node.getAttribute('href')?.trim() ?? '';
    if (!(href.startsWith('#') && href.length > 1)) node.removeAttribute('href');
  });
}

/**
 * Images are replaced by a note saying that there was one, and links lose their target to a title that shows it, in a
 * parsed document that has no browsing context: such a document never fetches anything, so nothing is loaded even
 * before sanitizing.
 */
function withoutImages(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const link of [...parsed.querySelectorAll('a[href]')]) {
    const href = link.getAttribute('href')?.trim() ?? '';
    if (href.startsWith('#') && href.length > 1) continue;
    link.removeAttribute('href');
    if (href) {
      link.setAttribute('title', `Link not followed: ${href.slice(0, 500)}`);
      link.classList.add('archive-inert-link');
    }
  }
  for (const image of [...parsed.querySelectorAll('img')]) {
    const alt = image.getAttribute('alt')?.trim();
    const placeholder = parsed.createElement('span');
    placeholder.className = 'archive-blocked-image';
    placeholder.textContent = `[image${alt ? `: ${alt}` : ''}, not loaded]`;
    image.replaceWith(placeholder);
  }
  return parsed.body.innerHTML;
}

export function sanitizeArchiveHtml(html: string): string {
  if (!purifier) return '';
  install();
  return purifier.sanitize(withoutImages(html), {
    ALLOWED_TAGS: TEXT_TAGS,
    ALLOWED_ATTR: ['href', 'title', 'class', 'align', 'start', 'colspan', 'rowspan', 'open'],
    ALLOWED_URI_REGEXP: /^#/,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    KEEP_CONTENT: true,
    SANITIZE_DOM: true,
  });
}

/** Highlighted code: nothing but `span`s with classes around text. */
export function sanitizeHighlighted(html: string): string {
  if (!purifier) return '';
  return purifier.sanitize(html, {
    ALLOWED_TAGS: ['span'],
    ALLOWED_ATTR: ['class'],
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: true,
  });
}
