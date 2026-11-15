-- VirtualBox snapshots, screenshots, imports, deletions and source links. See decision 0046.
-- Forward only and additive: 86Box and QEMU rows keep every guarantee they had.

-- A screenshot of a running VirtualBox machine goes through the same capture rows as a QEMU one. It names the
-- machine it was taken from, for the record; the screenshot itself belongs to the catalog VM, not the UUID.
ALTER TABLE qemu_captures
  ADD COLUMN machine_uuid UUID NULL
    COMMENT 'The VirtualBox machine captured, for a virtualbox VM only' AFTER vm_name,
  DROP CONSTRAINT ck_capture_qemu,
  ADD CONSTRAINT ck_capture_emulator CHECK (
    (emulator_type = 'qemu' AND machine_uuid IS NULL)
    OR (emulator_type = 'virtualbox' AND machine_uuid IS NOT NULL)
  );

-- What an administrator asked of VirtualBox on an agent, and what came of it: imports of an OVA, deletions of a
-- machine, and the link, relink and unlink of a catalog VM to a machine. Links finish in the request that
-- makes them, and are kept here as history only. An import or a deletion runs on the agent; at most one of
-- them is active per agent. Rows are never deleted: they are the record of what was imported and removed.
CREATE TABLE virtualbox_operations (
  id UUID NOT NULL PRIMARY KEY,
  request_id UUID NOT NULL,
  kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  stage VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  agent_id UUID NOT NULL,
  requested_by_user_id UUID NULL,
  emulator_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'virtualbox',
  vm_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  -- No foreign key: a version is never deleted while it has history, and this row is only a record of it.
  version_id UUID NULL COMMENT 'The version an import came from',
  repository_id UUID NULL,
  archive_key VARCHAR(1024) NULL,
  archive_size_bytes BIGINT UNSIGNED NULL,
  archive_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  target_name VARCHAR(128) NULL COMMENT 'The name an import asked VirtualBox to give the new machine',
  machine_uuid UUID NULL COMMENT 'The machine imported, deleted, linked or unlinked',
  machine_name VARCHAR(256) NULL,
  machine_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  previous_machine_uuid UUID NULL COMMENT 'For a relink: the machine the VM was linked to before',
  stray_machines JSON NULL COMMENT 'Machines that appeared during an import but could not be attributed to it',
  files_removed BOOLEAN NULL COMMENT 'For a deletion: whether VirtualBox reported removing the files',
  progress_bytes BIGINT UNSIGNED NULL,
  progress_total_bytes BIGINT UNSIGNED NULL,
  error_code VARCHAR(64) NULL,
  error_message VARCHAR(1024) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  active_marker TINYINT AS (CASE WHEN state IN ('queued', 'running') THEN 1 ELSE NULL END) PERSISTENT,
  UNIQUE KEY uq_virtualbox_operation_request (request_id),
  UNIQUE KEY uq_virtualbox_operation_active (agent_id, active_marker),
  KEY ix_virtualbox_operation_vm (emulator_type, vm_name, created_at),
  CONSTRAINT fk_virtualbox_operation_vm FOREIGN KEY (emulator_type, vm_name)
    REFERENCES virtual_machines (emulator_type, vm_name),
  CONSTRAINT fk_virtualbox_operation_agent FOREIGN KEY (agent_id) REFERENCES agents (id),
  CONSTRAINT fk_virtualbox_operation_user FOREIGN KEY (requested_by_user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_virtualbox_operation_type CHECK (emulator_type = 'virtualbox'),
  CONSTRAINT ck_virtualbox_operation_kind CHECK (kind IN ('import', 'delete', 'link', 'relink', 'unlink')),
  CONSTRAINT ck_virtualbox_operation_state CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'uncertain')),
  CONSTRAINT ck_virtualbox_operation_stage CHECK (stage IS NULL OR stage IN (
    'checking', 'downloading', 'verifying', 'dry_run', 'importing', 'discovering', 'deleting'
  )),
  -- A link is never queued or running: it finishes in the request that makes it.
  CONSTRAINT ck_virtualbox_operation_link CHECK (kind IN ('import', 'delete') OR state IN ('succeeded', 'failed')),
  CONSTRAINT ck_virtualbox_operation_import CHECK (kind <> 'import' OR (
    version_id IS NOT NULL AND repository_id IS NOT NULL AND archive_key IS NOT NULL
    AND archive_size_bytes IS NOT NULL AND archive_sha256 IS NOT NULL AND target_name IS NOT NULL
  )),
  CONSTRAINT ck_virtualbox_operation_machine CHECK (kind = 'import' OR machine_uuid IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
