import { VmRestoreSection } from '../../../components/Restore';
import { VirtualBoxSourceSection } from '../../../components/VirtualBoxSource';
import { useVmManage } from './VmManageLayout';

/**
 * Local copies and restore: the copies the agents hold of this VM, their state, restoring or replacing one and
 * removing one. Choosing a version to restore uses the restore dialog's own list; the full history stays under
 * Version History. A VirtualBox VM is never restored (decision 0045): its copy is the machine the agent links.
 */
export function VmCopiesPage() {
  const { identity, title } = useVmManage();
  return (
    <>
      <title>{`${title} · Local copies and restore · Manage · EmuCat`}</title>
      <div className="vm-admin-panels">
        {identity.emulatorType === 'virtualbox' ? (
          <VirtualBoxSourceSection vm={identity} />
        ) : (
          <VmRestoreSection vm={identity} />
        )}
      </div>
    </>
  );
}
