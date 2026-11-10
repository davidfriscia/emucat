-- Snapshots, the version tree and Remote Snapshot working copies. See decisions 0037 to 0039.
--
-- vm_versions already holds snapshots: kind, a non-null parent, a composite foreign key that keeps the
-- parent inside the same VM, and a trigger that makes every row immutable. Nothing about it changes, and no
-- existing row is rewritten. What is new is how a snapshot is produced, and where a Remote Snapshot runs.

-- A working copy of one version, on one agent, outside every emulator's base path. Its own row, so that
-- the persistent copy's agent_vm_state is never touched by anything a working copy does.
--
-- source_version_id is the version the directory currently corresponds to: the restored one at first,
-- then each snapshot preserved from it. It is the only column whose meaning is "now"; base_version_id
-- stays what was first restored.
CREATE TABLE vm_workspaces (
  id UUID NOT NULL,
  agent_id UUID NOT NULL,
  requested_by_user_id UUID NULL,
  request_id UUID NULL COMMENT 'Chosen by the browser, so that a repeated request prepares one working copy',
  emulator_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  vm_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  base_version_id UUID NOT NULL,
  source_version_id UUID NOT NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'preparing',
  launch_on_ready BOOLEAN NOT NULL DEFAULT FALSE,
  may_have_changes BOOLEAN NOT NULL DEFAULT FALSE
    COMMENT 'Set when a session is created for it, cleared when a snapshot of it commits',
  local_directory VARCHAR(1024) NULL COMMENT 'As derived by the agent. Administrators only',
  error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_message VARCHAR(1024) NULL,
  discard_requested_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  active_marker TINYINT AS (CASE WHEN state IN ('preparing', 'ready', 'discarding') THEN 1 END) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_vm_workspaces_request (request_id),
  -- One working copy of a VM per agent at a time.
  UNIQUE KEY uq_vm_workspaces_active (agent_id, emulator_type, vm_name, active_marker),
  -- So that operations and sessions can name a working copy of their own VM only.
  UNIQUE KEY uq_vm_workspaces_id_vm (id, emulator_type, vm_name),
  KEY ix_vm_workspaces_vm (emulator_type, vm_name, created_at),
  KEY ix_vm_workspaces_base (base_version_id, emulator_type, vm_name),
  KEY ix_vm_workspaces_source (source_version_id, emulator_type, vm_name),
  KEY ix_vm_workspaces_user (requested_by_user_id),
  CONSTRAINT fk_vm_workspaces_agent FOREIGN KEY (agent_id) REFERENCES agents (id),
  CONSTRAINT fk_vm_workspaces_user FOREIGN KEY (requested_by_user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_vm_workspaces_base FOREIGN KEY (base_version_id, emulator_type, vm_name)
    REFERENCES vm_versions (id, emulator_type, vm_name),
  CONSTRAINT fk_vm_workspaces_source FOREIGN KEY (source_version_id, emulator_type, vm_name)
    REFERENCES vm_versions (id, emulator_type, vm_name),
  CONSTRAINT ck_vm_workspaces_state CHECK (state IN (
    'preparing', 'ready', 'discarding', 'discarded', 'failed', 'lost'
  )),
  CONSTRAINT ck_vm_workspaces_finished CHECK (
    (finished_at IS NULL) = (state IN ('preparing', 'ready', 'discarding'))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- A snapshot is a registration of a further version of a registered VM (decision 0037). It names its
-- parent, which the composite key keeps inside the same VM, and its human-readable name, both issued with
-- the operation. request_id makes a repeated request find the same operation. workspace_id says that the
-- source is a working copy rather than the persistent local VM.
ALTER TABLE registration_operations
  ADD COLUMN request_id UUID NULL
    COMMENT 'Chosen by the browser, so that a repeated request creates one snapshot' AFTER requested_by_user_id,
  ADD COLUMN parent_version_id UUID NULL AFTER version_id,
  ADD COLUMN snapshot_name VARCHAR(77) CHARACTER SET ascii COLLATE ascii_general_ci NULL AFTER parent_version_id,
  ADD COLUMN workspace_id UUID NULL AFTER snapshot_name,
  ADD UNIQUE KEY uq_registration_request (request_id),
  ADD KEY ix_registration_parent (parent_version_id, emulator_type, vm_name),
  ADD KEY ix_registration_workspace (workspace_id, emulator_type, vm_name),
  ADD CONSTRAINT fk_registration_parent FOREIGN KEY (parent_version_id, emulator_type, vm_name)
    REFERENCES vm_versions (id, emulator_type, vm_name),
  ADD CONSTRAINT fk_registration_workspace FOREIGN KEY (workspace_id, emulator_type, vm_name)
    REFERENCES vm_workspaces (id, emulator_type, vm_name),
  DROP CONSTRAINT ck_registration_mode,
  ADD CONSTRAINT ck_registration_mode CHECK (mode IN ('copy', 'transfer', 'snapshot')),
  -- A snapshot has a parent and a name, and nothing else has either. Only a snapshot reads a working copy.
  ADD CONSTRAINT ck_registration_snapshot CHECK (
    (mode = 'snapshot') = (parent_version_id IS NOT NULL AND snapshot_name IS NOT NULL)
    AND (workspace_id IS NULL OR mode = 'snapshot')
  ),
  ADD CONSTRAINT ck_registration_not_own_parent CHECK (
    parent_version_id IS NULL OR parent_version_id <> version_id
  );

-- A restore into a working copy, rather than under the emulator's base path.
ALTER TABLE restore_operations
  ADD COLUMN workspace_id UUID NULL AFTER version_id,
  ADD KEY ix_restore_workspace (workspace_id, emulator_type, vm_name),
  ADD CONSTRAINT fk_restore_workspace FOREIGN KEY (workspace_id, emulator_type, vm_name)
    REFERENCES vm_workspaces (id, emulator_type, vm_name);

-- A session of a working copy. Only remote_snapshot sessions have one, and they always do.
ALTER TABLE vm_sessions
  ADD COLUMN workspace_id UUID NULL AFTER source_version_id,
  ADD KEY ix_vm_sessions_workspace (workspace_id, emulator_type, vm_name),
  ADD CONSTRAINT fk_vm_sessions_workspace FOREIGN KEY (workspace_id, emulator_type, vm_name)
    REFERENCES vm_workspaces (id, emulator_type, vm_name),
  ADD CONSTRAINT ck_vm_sessions_workspace CHECK (
    (mode = 'remote_snapshot') = (workspace_id IS NOT NULL)
  );
