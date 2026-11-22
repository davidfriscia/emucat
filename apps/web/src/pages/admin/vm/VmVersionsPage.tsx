import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { VmVersionsSection } from '../../../components/Versions';
import { useVmManage } from './VmManageLayout';

const SCROLL_WAIT_MS = 5_000;

/** Brings a linked version (`#version-<id>`) into view once the history has drawn it. */
function useScrollToHash(hash: string) {
  useEffect(() => {
    if (!hash.startsWith('#version-')) return;
    const id = decodeURIComponent(hash.slice(1));
    const reveal = () => {
      const element = document.getElementById(id);
      if (!element) return false;
      element.scrollIntoView?.({ block: 'start' });
      return true;
    };
    if (reveal()) return;
    const observer = new MutationObserver(() => {
      if (reveal()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => observer.disconnect(), SCROLL_WAIT_MS);
    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
    };
  }, [hash]);
}

/**
 * Version History: the masters and snapshots, their details, tags, operations and restores, and cloning a new VM
 * from one of them. Running a version chooses it in the run panel under General, which stays the one place to run.
 */
export function VmVersionsPage() {
  const { identity, title, requestRun } = useVmManage();
  useScrollToHash(useLocation().hash);
  return (
    <>
      <title>{`${title} · Version History · Manage · EmuCat`}</title>
      <VmVersionsSection vm={identity} title={title} onRun={requestRun} />
    </>
  );
}
