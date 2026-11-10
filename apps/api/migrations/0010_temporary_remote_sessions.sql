-- Remote Volatile and Remote Snapshot as temporary sessions, and replacing a persistent local copy.
-- See decision 0040. Forward only: no row is deleted, and every existing working copy keeps its meaning.

-- A working copy now has a purpose. Every row that exists already was prepared by hand in Milestone 7,
-- so it becomes 'manual' and keeps that lifecycle: nothing is ever advanced or removed on its own.
-- New rows say which remote mode they run, and the server drives them from preparation to cleanup.
ALTER TABLE vm_workspaces
  ADD COLUMN purpose VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'manual'
    COMMENT 'manual: Milestone 7 working copy. Otherwise the remote mode it runs' AFTER vm_name,
  ADD COLUMN session_id UUID NULL COMMENT 'The session that ran it, for remote sessions' AFTER source_version_id,
  ADD COLUMN snapshot_operation_id UUID NULL
    COMMENT 'The current publication attempt, for Remote Snapshot' AFTER session_id,
  ADD COLUMN publish_attempts INT UNSIGNED NOT NULL DEFAULT 0 AFTER snapshot_operation_id,
  ADD COLUMN next_retry_at DATETIME(3) NULL COMMENT 'When an automatic step is due again' AFTER publish_attempts,
  ADD COLUMN abandoned_at DATETIME(3) NULL
    COMMENT 'An administrator gave up an uncommitted snapshot' AFTER discard_requested_at,
  DROP CONSTRAINT ck_vm_workspaces_state,
  DROP CONSTRAINT ck_vm_workspaces_finished,
  ADD CONSTRAINT ck_vm_workspaces_purpose CHECK (
    purpose IN ('manual', 'remote_volatile', 'remote_snapshot')
  ),
  ADD CONSTRAINT ck_vm_workspaces_state CHECK (state IN (
    'preparing', 'ready', 'running', 'held', 'publishing', 'publish_failed', 'discarding',
    'discarded', 'failed', 'lost'
  )),
  -- The new states belong to remote sessions only; a manual working copy keeps its old ones.
  ADD CONSTRAINT ck_vm_workspaces_lifecycle CHECK (
    purpose <> 'manual' OR state IN ('preparing', 'ready', 'discarding', 'discarded', 'failed', 'lost')
  ),
  ADD CONSTRAINT ck_vm_workspaces_publication CHECK (
    purpose = 'remote_snapshot' OR state NOT IN ('publishing', 'publish_failed')
  ),
  ADD CONSTRAINT ck_vm_workspaces_finished CHECK (
    (finished_at IS NULL) = (state IN (
      'preparing', 'ready', 'running', 'held', 'publishing', 'publish_failed', 'discarding'
    ))
  ),
  ADD KEY ix_vm_workspaces_session (session_id),
  ADD KEY ix_vm_workspaces_snapshot (snapshot_operation_id),
  ADD KEY ix_vm_workspaces_due (purpose, state, next_retry_at);

-- Still one active working copy of a VM per agent, with the new active states. The unique key also
-- serves the agent's foreign key, so it is replaced in the same statement.
ALTER TABLE vm_workspaces
  DROP KEY uq_vm_workspaces_active,
  MODIFY active_marker TINYINT AS (CASE WHEN state IN (
    'preparing', 'ready', 'running', 'held', 'publishing', 'publish_failed', 'discarding'
  ) THEN 1 END) STORED,
  ADD UNIQUE KEY uq_vm_workspaces_active (agent_id, emulator_type, vm_name, active_marker);

-- Every remote session runs a working copy, and only remote sessions do. Existing rows already satisfy
-- this: Milestone 7 never recorded a remote_volatile session, and every remote_snapshot one named one.
ALTER TABLE vm_sessions
  DROP CONSTRAINT ck_vm_sessions_workspace,
  ADD CONSTRAINT ck_vm_sessions_workspace CHECK ((mode = 'local') = (workspace_id IS NULL));

-- A restore that replaces the agent's persistent copy, rather than creating one. Existing rows created
-- copies, which is what the defaults say.
ALTER TABLE restore_operations
  ADD COLUMN replace_existing BOOLEAN NOT NULL DEFAULT FALSE AFTER workspace_id,
  ADD COLUMN replaced_version_id UUID NULL
    COMMENT 'The version the replaced copy was recorded as, when it was known' AFTER replace_existing,
  ADD COLUMN discard_local_changes BOOLEAN NOT NULL DEFAULT FALSE
    COMMENT 'The administrator acknowledged that local changes are lost' AFTER replaced_version_id,
  ADD KEY ix_restore_replaced (replaced_version_id, emulator_type, vm_name),
  ADD CONSTRAINT fk_restore_replaced FOREIGN KEY (replaced_version_id, emulator_type, vm_name)
    REFERENCES vm_versions (id, emulator_type, vm_name),
  ADD CONSTRAINT ck_restore_replace CHECK (
    (replace_existing OR (replaced_version_id IS NULL AND NOT discard_local_changes))
    AND NOT (replace_existing AND workspace_id IS NOT NULL)
  );
