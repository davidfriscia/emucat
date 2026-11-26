import type { LocalDetails, LocalImageRead, LocalRead } from './engine';
import type { LocalArchiveErrorCode } from './errors';
import type { HostStats, OpenResult } from './host';
import type { LocalArchiveLimits } from './limits';

/**
 * Messages between the page and the archive worker (decision 0058). Every request carries an operation id; the
 * answer carries the same id, and the page ignores any answer to an operation it no longer waits for.
 */
export type WorkerRequest =
  | { op: number; type: 'configure'; limits: LocalArchiveLimits }
  | {
      op: number;
      type: 'open';
      id: string;
      name: string;
      bytes?: ArrayBuffer;
      parent?: { id: string; entryIndex: number };
      pinned: string[];
    }
  | { op: number; type: 'details'; id: string; entryIndex: number }
  | {
      op: number;
      type: 'read';
      id: string;
      entryIndex: number;
      kind: 'text' | 'pdf' | 'hex';
      offset: number;
    }
  | { op: number; type: 'image'; id: string; entryIndex: number }
  | { op: number; type: 'download'; id: string; entryIndex: number }
  | { op: number; type: 'release'; ids: string[] }
  | { op: number; type: 'stats' }
  | { op: number; type: 'cancel'; target: number };

export type WorkerResult =
  | { type: 'configure' }
  | { type: 'open'; result: OpenResult }
  | { type: 'details'; result: LocalDetails }
  | { type: 'read'; result: LocalRead }
  | { type: 'image'; result: LocalImageRead }
  | { type: 'download'; result: { data: Uint8Array; integrity: 'verified' | 'complete' } }
  | { type: 'release'; released: string[] }
  | { type: 'stats'; result: HostStats }
  | { type: 'cancel' };

export type WorkerResponse =
  | { op: number; ok: true; value: WorkerResult }
  | { op: number; ok: false; code: LocalArchiveErrorCode; message: string };
