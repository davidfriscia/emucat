-- Removing a persistent local copy, and deleting a leaf snapshot. See decision 0041. Forward only: no
-- existing row changes, and no constraint is weakened.

-- One row per removal of an agent's persistent copy of a VM, kept after it ends. The agent finds the
-- directory itself; nothing here is a path the agent acts on. local_directory is what it reported.
--
-- active_marker makes the guarantee that survives any application bug: an agent removes one copy at a
-- time. Every other operation counts an active removal as busy, and creating one takes the agent's row
-- lock exclusively, as a restore does, so none can start alongside it.
CREATE TABLE local_copy_removals (
  id UUID NOT NULL,
  agent_id UUID NOT NULL,
  requested_by_user_id UUID NULL,
  request_id UUID NOT NULL COMMENT 'Chosen by the browser, so that a repeated request removes once',
  emulator_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  vm_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  expected_version_id UUID NULL COMMENT 'The version the page showed as installed',
  discard_local_changes BOOLEAN NOT NULL DEFAULT FALSE
    COMMENT 'The administrator acknowledged that local changes are lost',
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'requested',
  accepted_at DATETIME(3) NULL
    COMMENT 'When the agent was first known to hold the command. It is never sent again after that',
  cleanup_pending BOOLEAN NOT NULL DEFAULT FALSE
    COMMENT 'Removed; leftovers moved aside are still being deleted by the agent',
  local_directory VARCHAR(1024) NULL COMMENT 'As reported by the agent. Administrators only',
  error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_message VARCHAR(1024) NULL,
  finished_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  active_marker TINYINT AS (CASE WHEN state = 'requested' THEN 1 END) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_local_copy_removals_request (request_id),
  UNIQUE KEY uq_local_copy_removals_active_agent (agent_id, active_marker),
  KEY ix_local_copy_removals_vm (emulator_type, vm_name, created_at),
  KEY ix_local_copy_removals_expected (expected_version_id, emulator_type, vm_name),
  KEY ix_local_copy_removals_user (requested_by_user_id),
  -- RESTRICT: this row is the history of what was removed from that agent.
  CONSTRAINT fk_local_copy_removals_agent FOREIGN KEY (agent_id) REFERENCES agents (id),
  CONSTRAINT fk_local_copy_removals_user FOREIGN KEY (requested_by_user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_local_copy_removals_vm FOREIGN KEY (emulator_type, vm_name)
    REFERENCES virtual_machines (emulator_type, vm_name),
  CONSTRAINT fk_local_copy_removals_expected FOREIGN KEY (expected_version_id, emulator_type, vm_name)
    REFERENCES vm_versions (id, emulator_type, vm_name),
  CONSTRAINT ck_local_copy_removals_state CHECK (state IN ('requested', 'succeeded', 'failed')),
  CONSTRAINT ck_local_copy_removals_finished CHECK ((finished_at IS NULL) = (state = 'requested')),
  CONSTRAINT ck_local_copy_removals_cleanup CHECK (NOT cleanup_pending OR state = 'succeeded'),
  CONSTRAINT ck_local_copy_removals_failed CHECK (state <> 'failed' OR error_code IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- A deleted, or deleting, version. vm_versions rows are immutable and history references them with
-- RESTRICT foreign keys, so a version is never removed from that table: this row is its tombstone. From
-- the moment it exists, the version is offered for nothing and every new reference to it is refused.
--
-- The archive columns are copied from the version for the audit, and are what the agent is asked to
-- delete; the agent recomputes the key and refuses one that differs. attempt_id is the current attempt's
-- operation ID, issued anew for each.
CREATE TABLE vm_version_deletions (
  version_id UUID NOT NULL,
  emulator_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  vm_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  request_id UUID NOT NULL COMMENT 'Chosen by the browser, so that a repeated request finds this row',
  requested_by_user_id UUID NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'deleting',
  repository_id UUID NOT NULL,
  archive_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  archive_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  archive_size_bytes BIGINT UNSIGNED NOT NULL,
  attempt_id UUID NULL COMMENT 'The attempt sent last',
  agent_id UUID NULL COMMENT 'The agent the last attempt was sent to',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  dispatched_at DATETIME(3) NULL,
  next_retry_at DATETIME(3) NULL,
  error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_message VARCHAR(1024) NULL,
  archive_outcome VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  requested_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (version_id),
  UNIQUE KEY uq_vm_version_deletions_request (request_id),
  UNIQUE KEY uq_vm_version_deletions_attempt (attempt_id),
  KEY ix_vm_version_deletions_vm (emulator_type, vm_name, requested_at),
  KEY ix_vm_version_deletions_due (state, next_retry_at),
  KEY ix_vm_version_deletions_repository (repository_id),
  KEY ix_vm_version_deletions_agent (agent_id),
  KEY ix_vm_version_deletions_user (requested_by_user_id),
  -- Composite, so that a tombstone can only name a version of the VM it says.
  CONSTRAINT fk_vm_version_deletions_version FOREIGN KEY (version_id, emulator_type, vm_name)
    REFERENCES vm_versions (id, emulator_type, vm_name),
  CONSTRAINT fk_vm_version_deletions_repository FOREIGN KEY (repository_id) REFERENCES repositories (id),
  CONSTRAINT fk_vm_version_deletions_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE SET NULL,
  CONSTRAINT fk_vm_version_deletions_user FOREIGN KEY (requested_by_user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_vm_version_deletions_state CHECK (state IN ('deleting', 'deleted')),
  CONSTRAINT ck_vm_version_deletions_outcome CHECK (
    archive_outcome IS NULL OR archive_outcome IN ('deleted', 'already_absent')
  ),
  -- Deleted exactly when the repository confirmed it, and said how.
  CONSTRAINT ck_vm_version_deletions_completed CHECK (
    (state = 'deleted') = (completed_at IS NOT NULL AND archive_outcome IS NOT NULL)
  ),
  CONSTRAINT ck_vm_version_deletions_sha256 CHECK (archive_sha256 REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- The master is the root of every version and is never deleted, whatever the application does.
CREATE TRIGGER trg_vm_version_deletions_snapshots_only BEFORE INSERT ON vm_version_deletions FOR EACH ROW
  IF (SELECT kind FROM vm_versions WHERE id = NEW.version_id) <> 'snapshot' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'only snapshots can be deleted';
  END IF;

-- A tombstone never goes away and never comes back to life: either would make a version whose archive may
-- be gone selectable again. What it names, and what it was asked to delete, never change.
CREATE TRIGGER trg_vm_version_deletions_final BEFORE UPDATE ON vm_version_deletions FOR EACH ROW
  IF (OLD.state = 'deleted' AND NEW.state <> 'deleted')
     OR NEW.version_id <> OLD.version_id
     OR NEW.emulator_type <> OLD.emulator_type
     OR NEW.vm_name <> OLD.vm_name
     OR NEW.repository_id <> OLD.repository_id
     OR NEW.archive_key <> OLD.archive_key
     OR NEW.archive_sha256 <> OLD.archive_sha256
     OR NEW.archive_size_bytes <> OLD.archive_size_bytes THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a version deletion cannot be undone or redirected';
  END IF;

CREATE TRIGGER trg_vm_version_deletions_kept BEFORE DELETE ON vm_version_deletions FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a version deletion is never removed';
