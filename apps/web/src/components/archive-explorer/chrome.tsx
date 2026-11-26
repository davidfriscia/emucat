import {
  CircleAlert,
  Info,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ArchivePreviewBytes } from '../../api';
import { formatBytes } from '../Agents';
import { ICON_SIZE } from '../ui/IconButton';
import type { FileSource } from './source';

/**
 * The file panel's chrome (decision 0058): one contextual toolbar above the preview and one status bar below it.
 * Each viewer keeps its own state and puts its controls and status into those two places through portals, so that
 * the panel has a single toolbar whatever is shown, and the preview keeps all the space between them.
 */

interface Chrome {
  toolbar: HTMLElement | null;
  status: HTMLElement | null;
  integrityScope: FileSource['integrityScope'];
}

export const ViewerChromeContext = createContext<Chrome>({
  toolbar: null,
  status: null,
  integrityScope: 'server',
});

export const useViewerChrome = () => useContext(ViewerChromeContext);

/** Controls of the current viewer, shown in the file's toolbar. */
export function ViewerTools({ children }: { children: ReactNode }) {
  const { toolbar } = useViewerChrome();
  return toolbar ? createPortal(children, toolbar) : null;
}

/** Status of the current viewer, shown in the status bar. */
export function ViewerStatus({ children }: { children: ReactNode }) {
  const { status } = useViewerChrome();
  return status ? createPortal(children, status) : null;
}

const TONES: Record<'info' | 'success' | 'warning' | 'danger', LucideIcon> = {
  info: Info,
  success: ShieldCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
};

/** One item of the status bar: an icon, never alone, and its words. */
export function StatusItem({
  tone = 'info',
  icon,
  children,
  live,
}: {
  tone?: keyof typeof TONES;
  icon?: LucideIcon | null;
  children: ReactNode;
  /** Announced when it changes. */
  live?: boolean;
}) {
  const Icon = icon === null ? null : (icon ?? TONES[tone]);
  return (
    <span className={`status-item status-${tone}`} role={live ? 'status' : undefined}>
      {Icon ? <Icon size={ICON_SIZE - 2} aria-hidden="true" /> : null}
      <span>{children}</span>
    </span>
  );
}

/** What reading this preview proved, in the words that fit where the bytes came from. */
export function integrityText(
  preview: ArchivePreviewBytes,
  scope: FileSource['integrityScope'],
): {
  tone: 'success' | 'info' | 'warning';
  icon: LucideIcon;
  text: string;
} {
  if (preview.truncated) {
    return {
      tone: 'info',
      icon: ShieldQuestion,
      text: `Showing the first ${formatBytes(preview.bytes.length)} of ${formatBytes(preview.totalBytes)}. Only this part was read: no checksum covers part of a file.`,
    };
  }
  if (preview.integrity === 'verified') {
    return scope === 'server'
      ? {
          tone: 'success',
          icon: ShieldCheck,
          text: 'Verified: the whole file was read and matched its recorded checksum.',
        }
      : {
          tone: 'success',
          icon: ShieldCheck,
          text: 'The whole file matched the CRC-32 its archive records (this detects damage, not tampering).',
        };
  }
  if (preview.integrity === 'complete') {
    return {
      tone: 'info',
      icon: ShieldAlert,
      text: 'The whole file was read. This archive format records no checksum for it.',
    };
  }
  return {
    tone: 'info',
    icon: ShieldQuestion,
    text: 'Part of the file was read: no checksum covers part of a file.',
  };
}

export function IntegrityStatus({ preview }: { preview: ArchivePreviewBytes }) {
  const { integrityScope } = useViewerChrome();
  const { tone, icon, text } = integrityText(preview, integrityScope);
  return (
    <ViewerStatus>
      <StatusItem tone={tone} icon={icon}>
        {text}
      </StatusItem>
    </ViewerStatus>
  );
}
