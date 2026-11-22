import DOMPurify from 'dompurify';
import { useEffect, useRef, useState } from 'react';
import Vditor from 'vditor';
import 'vditor/dist/index.css';

/**
 * Markdown editing and display with Vditor (https://github.com/Vanessa219/vditor, MIT), for content an administrator
 * wrote and that is still untrusted: it is shown back to every administrator (decision 0053).
 *
 * - Vditor's own files are served by this application, never by a third party (see `vditor-assets.ts`).
 * - Uploads are off: there is no upload URL, and no upload button.
 * - Rendered HTML is sanitized twice: by Lute's sanitizer, and then by DOMPurify, which also forbids scripts, styles,
 *   forms, frames and event handlers, and makes every link open safely.
 * - Vditor keeps nothing in localStorage: the server holds the only copy.
 */

export type { MarkdownTheme } from '../theme';
import type { MarkdownTheme } from '../theme';

const CDN = __VDITOR_CDN__;

let hooksInstalled = false;

/** Web links, mail links, fragments and paths on this site: nothing that could run or embed. */
const SAFE_URI = /^(?:https?:|mailto:|#|\/(?!\/))/i;

/** Removes everything that could run or leak, and makes links safe to follow. */
export function sanitizeHtml(html: string): string {
  if (!hooksInstalled) {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      // DOMPurify allows data: URIs on images and media; notes have no use for them, and they can carry SVG.
      for (const attribute of ['src', 'href', 'xlink:href', 'poster']) {
        const value = node.getAttribute(attribute);
        if (value !== null && !SAFE_URI.test(value.trim())) node.removeAttribute(attribute);
      }
      if (node.tagName === 'A' && node.hasAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer nofollow');
      }
    });
    hooksInstalled = true;
  }
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    FORBID_TAGS: [
      'style',
      'form',
      'input',
      'button',
      'textarea',
      'select',
      'iframe',
      'object',
      'embed',
    ],
    FORBID_ATTR: ['style'],
    ALLOWED_URI_REGEXP: SAFE_URI,
  });
}

const markdownOptions = { sanitize: true, autoSpace: false, toc: false, mark: true };

const hljs = (theme: MarkdownTheme) => ({
  style: theme === 'dark' ? 'github-dark' : 'github',
  lineNumber: false,
});

/** The toolbar, without upload, record, export or anything that leaves the page. */
const TOOLBAR = [
  'headings',
  'bold',
  'italic',
  'strike',
  'link',
  '|',
  'list',
  'ordered-list',
  'check',
  'outdent',
  'indent',
  '|',
  'quote',
  'line',
  'code',
  'inline-code',
  'table',
  '|',
  'undo',
  'redo',
  '|',
  'edit-mode',
  'fullscreen',
  'outline',
];

/**
 * One Vditor editor, made when this mounts and destroyed when it unmounts, so that there is never more than one per
 * component and nothing is left behind. `initialValue` is read once; the editor owns the text afterwards and reports
 * every change through `onChange`.
 */
export function MarkdownEditor({
  initialValue,
  onChange,
  onReady,
  label,
  theme,
  minHeight = 360,
}: {
  initialValue: string;
  onChange: (markdown: string) => void;
  onReady?: () => void;
  /** The editor's accessible name. */
  label: string;
  theme: MarkdownTheme;
  minHeight?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Vditor | null>(null);
  const ready = useRef(false);
  // What the editor's callbacks read, kept current after every render. Declared before the effect that makes the
  // editor, so that it runs first.
  const latest = useRef({ onChange, onReady, initialValue, theme });
  useEffect(() => {
    latest.current = { onChange, onReady, initialValue, theme };
  });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    ready.current = false;
    let instance: Vditor | null = null;
    try {
      instance = new Vditor(element, {
        value: latest.current.initialValue,
        mode: 'sv',
        lang: 'en_US',
        icon: 'ant',
        cdn: CDN,
        minHeight,
        height: 'auto',
        placeholder: 'Write notes in Markdown…',
        theme: latest.current.theme === 'dark' ? 'dark' : 'classic',
        toolbar: TOOLBAR,
        toolbarConfig: { pin: true },
        cache: { enable: false },
        counter: { enable: true, type: 'markdown' },
        link: { isOpen: false },
        preview: {
          delay: 300,
          mode: 'both',
          // No device-width or third-party "copy to" buttons above the preview.
          actions: [],
          markdown: markdownOptions,
          hljs: hljs(latest.current.theme),
          theme: {
            current: latest.current.theme === 'dark' ? 'dark' : 'light',
            path: `${CDN}/dist/css/content-theme`,
          },
          transform: sanitizeHtml,
        },
        input: (value) => latest.current.onChange(value),
        after: () => {
          if (disposed) {
            // Unmounted before it finished starting: destroy it now that it can be.
            instance?.destroy();
            return;
          }
          ready.current = true;
          // The editing area of split view, the mode used here: a textarea in Vditor 4.
          const area = element.querySelector('.vditor-sv') ?? element.querySelector('textarea');
          area?.setAttribute('aria-label', label);
          latest.current.onReady?.();
        },
      });
      editor.current = instance;
    } catch {
      // Vditor refused to start: say so, from outside the effect's own run.
      queueMicrotask(() => {
        if (!disposed) setFailed(true);
      });
    }
    return () => {
      disposed = true;
      if (ready.current) instance?.destroy();
      editor.current = null;
      ready.current = false;
    };
    // The editor is made once per mount: later props are read through `latest` or applied below.
  }, [minHeight, label]);

  useEffect(() => {
    if (!ready.current || !editor.current) return;
    editor.current.setTheme(
      theme === 'dark' ? 'dark' : 'classic',
      theme === 'dark' ? 'dark' : 'light',
      hljs(theme).style,
      `${CDN}/dist/css/content-theme`,
    );
  }, [theme]);

  if (failed) {
    return (
      <div className="alert alert-danger small" role="alert">
        The Markdown editor could not be started. Reload the page and try again.
      </div>
    );
  }
  return <div ref={host} className="markdown-editor" data-theme={theme} />;
}

/** Markdown rendered for reading, sanitized as the editor's preview is. Nothing in it can run. */
export function MarkdownView({
  markdown,
  theme,
  label,
}: {
  markdown: string;
  theme: MarkdownTheme;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let current = true;
    void Vditor.preview(element as HTMLDivElement, markdown, {
      mode: theme,
      lang: 'en_US',
      cdn: CDN,
      icon: 'ant',
      markdown: markdownOptions,
      hljs: hljs(theme),
      theme: { current: theme, path: `${CDN}/dist/css/content-theme` },
      transform: (html) => (current ? sanitizeHtml(html) : ''),
    });
    return () => {
      current = false;
      element.replaceChildren();
    };
  }, [markdown, theme]);
  return (
    <div
      ref={host}
      className="markdown-view vditor-reset"
      role="document"
      aria-label={label}
      data-theme={theme}
    />
  );
}
