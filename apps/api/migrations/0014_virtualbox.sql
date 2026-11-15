-- VirtualBox machines as catalog VMs: registered as an OVA master, and run in place. See decision 0045.
-- Forward only and additive: existing rows keep every guarantee they had, and 86Box and QEMU rows are
-- unaffected by every new check.

-- A third catalog type. Its VMs have no directory: the machine is VirtualBox's, named by its UUID.
ALTER TABLE virtual_machines
  DROP CONSTRAINT ck_virtual_machines_emulator,
  ADD CONSTRAINT ck_virtual_machines_emulator CHECK (emulator_type IN ('86box', 'qemu', 'virtualbox'));

-- A VirtualBox registration names the machine it exports, and nothing else does. It is always a copy: the
-- original machine stays in VirtualBox, so nothing could ever be transferred.
ALTER TABLE registration_operations
  ADD COLUMN virtualbox_uuid UUID NULL
    COMMENT 'The VirtualBox machine this operation exports, for a virtualbox VM only' AFTER vm_name,
  DROP CONSTRAINT ck_registration_emulator,
  ADD CONSTRAINT ck_registration_emulator CHECK (emulator_type IN ('86box', 'qemu', 'virtualbox')),
  ADD CONSTRAINT ck_registration_virtualbox CHECK (
    (emulator_type = 'virtualbox') = (virtualbox_uuid IS NOT NULL)
    AND (emulator_type <> 'virtualbox' OR mode IN ('copy', 'snapshot'))
  );

-- Where a registered VirtualBox VM really is: one machine, on one agent, for as long as the VM exists.
-- UNIQUE (agent_id, machine_uuid) is what makes two masters of one machine impossible. The display name and
-- the state are the agent's latest observation, kept so that a page can say what it last saw; present goes
-- FALSE when VBoxManage no longer lists the machine, which deletes and re-points nothing.
CREATE TABLE virtualbox_sources (
  emulator_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'virtualbox',
  vm_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  agent_id UUID NOT NULL,
  machine_uuid UUID NOT NULL,
  display_name VARCHAR(256) NOT NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT 'As last observed by the agent',
  raw_state VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  state_changed_at DATETIME(3) NULL COMMENT 'As VirtualBox reported it',
  present BOOLEAN NULL,
  is_accessible BOOLEAN NULL COMMENT 'ACCESSIBLE is a reserved word in MariaDB',
  observed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (emulator_type, vm_name),
  UNIQUE KEY uq_virtualbox_sources_machine (agent_id, machine_uuid),
  -- RESTRICT: this row is how the catalog VM finds its machine, and the agent's history depends on it.
  CONSTRAINT fk_virtualbox_sources_vm FOREIGN KEY (emulator_type, vm_name)
    REFERENCES virtual_machines (emulator_type, vm_name),
  CONSTRAINT fk_virtualbox_sources_agent FOREIGN KEY (agent_id) REFERENCES agents (id),
  CONSTRAINT ck_virtualbox_sources_type CHECK (emulator_type = 'virtualbox'),
  CONSTRAINT ck_virtualbox_sources_state CHECK (state IS NULL OR state IN (
    'powered_off', 'running', 'paused', 'saved', 'starting', 'stopping', 'aborted', 'stuck', 'busy',
    'inaccessible', 'unknown'
  ))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
