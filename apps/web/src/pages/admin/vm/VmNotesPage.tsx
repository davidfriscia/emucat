import { VmNotesSection } from '../../../components/VmNotes';
import { useVmManage } from './VmManageLayout';

/** Notes: the VM's Markdown notes (decision 0053). Opening the section reads them; it never creates the file. */
export function VmNotesPage() {
  const { identity, title } = useVmManage();
  return (
    <>
      <title>{`${title} · Notes · Manage · EmuCat`}</title>
      <VmNotesSection vm={identity} title={title} />
    </>
  );
}
