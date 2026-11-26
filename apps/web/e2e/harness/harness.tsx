import 'bootstrap/dist/css/bootstrap.min.css';
import '../../src/styles.css';
import type { VersionNode } from '@emucat/contracts';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LocalArchiveClient } from '../../src/archive-local/client';
import { ArchiveExplorerDialog } from '../../src/components/ArchiveExplorer';

/**
 * Archive Explorer on its own, for the browser tests (decision 0058). `?theme=dark` picks the theme. The page also
 * exposes `window.emucatHarness`, which the performance test uses to drive the production archive worker directly.
 */

const params = new URLSearchParams(location.search);
document.documentElement.setAttribute(
  'data-bs-theme',
  params.get('theme') === 'dark' ? 'dark' : 'light',
);

const VERSION = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e8010';
const SHA = 'a'.repeat(64);
const node = {
  id: VERSION,
  kind: 'master',
  parentVersionId: null,
  childVersionIds: [],
  snapshotName: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  title: null,
  description: null,
  tags: [],
  promotedAt: null,
  archiveSizeBytes: 270_637_465,
  archiveSha256: SHA,
  manifest: { sha256: SHA, fileCount: 8, totalUncompressedBytes: 4096, verifiedBy: 'agent' },
  repositoryName: 'My Storage',
  available: true,
  createdByAgentName: 'Study PC',
  createdByDisplayName: 'Ada Admin',
  holders: [],
  deletion: null,
  deletable: { eligible: false, reason: 'master_cannot_be_deleted' },
} as unknown as VersionNode;

function Harness() {
  const [open, setOpen] = useState(params.get('closed') !== '1');
  return open ? (
    <ArchiveExplorerDialog
      vm={{ emulatorType: '86box', vmName: 'DOS622' }}
      node={node}
      onClose={() => setOpen(false)}
    />
  ) : (
    <button type="button" className="btn btn-primary m-3" onClick={() => setOpen(true)}>
      Open Archive Explorer
    </button>
  );
}

/** Opens an archive from a URL in a fresh production worker, timing each step and the page's own responsiveness. */
async function measure(url: string, entryIndex: number) {
  const fetched = performance.now();
  const bytes = await (await fetch(url)).arrayBuffer();
  const downloaded = performance.now();
  const client = new LocalArchiveClient();
  // The longest gap between two timer ticks on the page while the worker works: a frozen page would show it.
  let last = performance.now();
  let longest = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 10);
  const size = bytes.byteLength;
  const started = performance.now();
  const opened = await client.open({ id: 'perf', name: 'perf.zip', bytes, pinned: [] });
  const indexed = performance.now();
  const read = await client.download('perf', entryIndex);
  const extracted = performance.now();
  const prefix = await client.read('perf', entryIndex, 'text', 0);
  const previewed = performance.now();
  const stats = await client.stats();
  clearInterval(ticker);
  client.dispose();
  return {
    sizeBytes: size,
    entries: opened.index.entries.length,
    downloadMs: downloaded - fetched,
    indexMs: indexed - started,
    extractMs: extracted - indexed,
    extractedBytes: read.data.length,
    textPreviewMs: previewed - extracted,
    textPreviewBytes: prefix.bytes.length,
    retainedBytes: stats.retainedBytes,
    longestMainThreadGapMs: longest,
  };
}

(window as unknown as { emucatHarness: unknown }).emucatHarness = { measure };

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
