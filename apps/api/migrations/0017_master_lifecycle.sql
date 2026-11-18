-- Master and snapshot lifecycle: snapshot titles and descriptions, promoting a snapshot to master, and replacing
-- a VM's whole history with a new master made from a local copy. See decision 0048. Forward only and additive:
-- every existing version keeps its meaning, and none is rewritten.

-- An administrator's title and description for a version. Both optional, both plain text, neither part of the
-- archive: editing them changes nothing that identifies or verifies the version.
--
-- A version's lineage can now change in exactly two ways, each part of one remaster transaction:
-- * promoted: a snapshot becomes its VM's master. It loses its parent (kept in promoted_from_parent_version_id,
--   for the audit) and keeps its label, archive, hash, size and creation time.
-- * retired: a master is replaced. It stays kind = 'master' for the audit, stops counting as the master, and is
--   tombstoned in the same transaction.
ALTER TABLE vm_versions
  ADD COLUMN title VARCHAR(120) NULL COMMENT 'An administrator''s title. Plain text' AFTER snapshot_name,
  ADD COLUMN description TEXT NULL COMMENT 'An administrator''s description. Plain text' AFTER title,
  ADD COLUMN promoted_at DATETIME(3) NULL COMMENT 'When this snapshot became its VM''s master' AFTER created_at,
  ADD COLUMN promoted_from_parent_version_id UUID NULL
    COMMENT 'The parent it had as a snapshot, kept for the audit' AFTER promoted_at,
  ADD COLUMN retired_at DATETIME(3) NULL COMMENT 'When this master was replaced by a remaster' AFTER promoted_from_parent_version_id,
  ADD KEY ix_vm_versions_promoted_from (promoted_from_parent_version_id, emulator_type, vm_name),
  ADD CONSTRAINT fk_vm_versions_promoted_from FOREIGN KEY (promoted_from_parent_version_id, emulator_type, vm_name)
    REFERENCES vm_versions (id, emulator_type, vm_name),
  DROP CONSTRAINT ck_vm_versions_shape,
  -- A promoted master keeps the label it had as a snapshot. No other master has one.
  ADD CONSTRAINT ck_vm_versions_shape CHECK (
    (kind = 'master' AND parent_version_id IS NULL AND (snapshot_name IS NULL OR promoted_at IS NOT NULL))
    OR (kind = 'snapshot' AND parent_version_id IS NOT NULL AND snapshot_name IS NOT NULL)
  ),
  ADD CONSTRAINT ck_vm_versions_promoted CHECK (
    (promoted_at IS NULL) = (promoted_from_parent_version_id IS NULL)
    AND (promoted_at IS NULL OR kind = 'master')
  ),
  ADD CONSTRAINT ck_vm_versions_retired CHECK (retired_at IS NULL OR kind = 'master'),
  ADD CONSTRAINT ck_vm_versions_title CHECK (title IS NULL OR CHAR_LENGTH(title) BETWEEN 1 AND 120),
  ADD CONSTRAINT ck_vm_versions_description CHECK (
    description IS NULL OR CHAR_LENGTH(description) BETWEEN 1 AND 2000
  ),
  DROP INDEX uq_vm_versions_one_master;

-- One master per VM still, whatever the application does: a retired master no longer counts.
ALTER TABLE vm_versions DROP COLUMN master_marker;
ALTER TABLE vm_versions
  ADD COLUMN master_marker TINYINT AS (CASE WHEN kind = 'master' AND retired_at IS NULL THEN 1 END) STORED,
  ADD UNIQUE KEY uq_vm_versions_one_master (emulator_type, vm_name, master_marker);

-- The archive and identity of a version still never change. Its title and description may. Its lineage changes
-- only through a promotion or a retirement, each once, and never for a version that is deleted or being deleted.
DROP TRIGGER trg_vm_versions_immutable;
CREATE TRIGGER trg_vm_versions_immutable BEFORE UPDATE ON vm_versions FOR EACH ROW
BEGIN
  IF NOT (BINARY NEW.id <=> BINARY OLD.id
          AND BINARY NEW.emulator_type <=> BINARY OLD.emulator_type
          AND BINARY NEW.vm_name <=> BINARY OLD.vm_name
          AND BINARY NEW.snapshot_name <=> BINARY OLD.snapshot_name
          AND NEW.repository_id <=> OLD.repository_id
          AND BINARY NEW.archive_key <=> BINARY OLD.archive_key
          AND BINARY NEW.archive_sha256 <=> BINARY OLD.archive_sha256
          AND NEW.archive_size_bytes <=> OLD.archive_size_bytes
          AND NEW.created_at <=> OLD.created_at
          AND NEW.created_by_agent_id <=> OLD.created_by_agent_id
          AND NEW.created_by_user_id <=> OLD.created_by_user_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'vm_versions rows are immutable';
  END IF;
  IF NOT (NEW.kind <=> OLD.kind
          AND NEW.parent_version_id <=> OLD.parent_version_id
          AND NEW.promoted_at <=> OLD.promoted_at
          AND NEW.promoted_from_parent_version_id <=> OLD.promoted_from_parent_version_id) THEN
    IF NOT (OLD.kind = 'snapshot' AND NEW.kind = 'master'
            AND NEW.parent_version_id IS NULL
            AND OLD.promoted_at IS NULL AND NEW.promoted_at IS NOT NULL
            AND NEW.promoted_from_parent_version_id <=> OLD.parent_version_id
            AND OLD.retired_at IS NULL AND NEW.retired_at IS NULL) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'vm_versions rows are immutable: a lineage changes only when a snapshot is promoted to master';
    END IF;
    IF EXISTS (SELECT 1 FROM vm_version_deletions WHERE version_id = OLD.id) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a deleted version cannot be promoted';
    END IF;
  END IF;
  IF NOT (NEW.retired_at <=> OLD.retired_at) THEN
    IF NOT (OLD.retired_at IS NULL AND OLD.kind = 'master' AND NEW.kind = 'master') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'only a current master is retired, and only once';
    END IF;
  END IF;
END;

-- One remaster of one VM, kept after it ends. `snapshot`: a snapshot was promoted to master, in one transaction,
-- so it is born committed. `local_copy`: an agent exports its local copy as a new master through a registration
-- (registration_operation_id, mode 'remaster'), and nothing changes in the catalog until that registration
-- commits.
--
--   local_copy:  exporting ──commit──▶ cleaning ──every obsolete archive deleted──▶ completed
--                    └──export failed, cancelled or lost──▶ failed           (nothing changed)
--   snapshot:    cleaning ──every obsolete archive deleted──▶ completed
--
-- The deletion manifest is the set of vm_version_deletions rows naming this operation: the exact versions, and
-- archive keys, sizes and hashes, recorded in the commit's transaction. Cleanup never looks anywhere else.
--
-- active_marker allows one export per VM at a time; an export blocks every new reference to the VM's versions.
CREATE TABLE vm_remaster_operations (
  id UUID NOT NULL,
  request_id UUID NOT NULL COMMENT 'Chosen by the browser, so that a repeated request remasters once',
  emulator_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  vm_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  requested_by_user_id UUID NULL,
  expected_revision CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
    COMMENT 'The version history the administrator confirmed',
  previous_master_version_id UUID NOT NULL,
  new_master_version_id UUID NULL COMMENT 'The promoted snapshot, or the committed new master',
  agent_id UUID NULL COMMENT 'The agent whose local copy is exported',
  registration_operation_id UUID NULL,
  retained_count INT UNSIGNED NOT NULL DEFAULT 0,
  removed_count INT UNSIGNED NOT NULL DEFAULT 0,
  removed_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_message VARCHAR(1024) NULL,
  committed_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  active_marker TINYINT AS (CASE WHEN state = 'exporting' THEN 1 END) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_vm_remaster_request (request_id),
  UNIQUE KEY uq_vm_remaster_active (emulator_type, vm_name, active_marker),
  UNIQUE KEY uq_vm_remaster_registration (registration_operation_id),
  KEY ix_vm_remaster_vm (emulator_type, vm_name, created_at),
  KEY ix_vm_remaster_state (state),
  KEY ix_vm_remaster_previous (previous_master_version_id, emulator_type, vm_name),
  KEY ix_vm_remaster_new (new_master_version_id, emulator_type, vm_name),
  KEY ix_vm_remaster_agent (agent_id),
  KEY ix_vm_remaster_user (requested_by_user_id),
  CONSTRAINT fk_vm_remaster_vm FOREIGN KEY (emulator_type, vm_name)
    REFERENCES virtual_machines (emulator_type, vm_name),
  CONSTRAINT fk_vm_remaster_previous FOREIGN KEY (previous_master_version_id, emulator_type, vm_name)
    REFERENCES vm_versions (id, emulator_type, vm_name),
  CONSTRAINT fk_vm_remaster_new FOREIGN KEY (new_master_version_id, emulator_type, vm_name)
    REFERENCES vm_versions (id, emulator_type, vm_name),
  CONSTRAINT fk_vm_remaster_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE SET NULL,
  CONSTRAINT fk_vm_remaster_registration FOREIGN KEY (registration_operation_id)
    REFERENCES registration_operations (id),
  CONSTRAINT fk_vm_remaster_user FOREIGN KEY (requested_by_user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_vm_remaster_kind CHECK (kind IN ('snapshot', 'local_copy')),
  CONSTRAINT ck_vm_remaster_state CHECK (state IN ('exporting', 'cleaning', 'completed', 'failed')),
  CONSTRAINT ck_vm_remaster_revision CHECK (expected_revision REGEXP '^[0-9a-f]{64}$'),
  -- A promotion is committed when it is recorded; only an export can be in progress or fail.
  CONSTRAINT ck_vm_remaster_shape CHECK (
    (kind = 'snapshot' AND state IN ('cleaning', 'completed') AND new_master_version_id IS NOT NULL
      AND registration_operation_id IS NULL)
    OR (kind = 'local_copy' AND registration_operation_id IS NOT NULL)
  ),
  -- Committed exactly when it names its new master; failed exactly when it says why and committed nothing.
  CONSTRAINT ck_vm_remaster_committed CHECK (
    (state IN ('cleaning', 'completed')) = (committed_at IS NOT NULL AND new_master_version_id IS NOT NULL)
  ),
  CONSTRAINT ck_vm_remaster_failed CHECK (
    state <> 'failed' OR (error_code IS NOT NULL AND committed_at IS NULL)
  ),
  CONSTRAINT ck_vm_remaster_finished CHECK ((finished_at IS NULL) = (state IN ('exporting', 'cleaning')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- A remaster's tombstones say which remaster made them: that is its deletion manifest.
ALTER TABLE vm_version_deletions
  ADD COLUMN remaster_operation_id UUID NULL
    COMMENT 'The remaster whose commit made this version obsolete' AFTER request_id,
  ADD KEY ix_vm_version_deletions_remaster (remaster_operation_id, state),
  ADD CONSTRAINT fk_vm_version_deletions_remaster FOREIGN KEY (remaster_operation_id)
    REFERENCES vm_remaster_operations (id);

-- The current master is never deleted. A master retired by a remaster is, like any obsolete version.
DROP TRIGGER trg_vm_version_deletions_snapshots_only;
CREATE TRIGGER trg_vm_version_deletions_snapshots_only BEFORE INSERT ON vm_version_deletions FOR EACH ROW
  IF (SELECT kind = 'master' AND retired_at IS NULL FROM vm_versions WHERE id = NEW.version_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'only snapshots can be deleted, and masters once retired: the current master never is';
  END IF;

-- A snapshot's title and description travel with its registration until the commit makes them the version's.
-- A remaster is a registration that makes a new master of a registered VM.
ALTER TABLE registration_operations
  ADD COLUMN snapshot_title VARCHAR(120) NULL AFTER snapshot_name,
  ADD COLUMN snapshot_description TEXT NULL AFTER snapshot_title,
  DROP CONSTRAINT ck_registration_mode,
  ADD CONSTRAINT ck_registration_mode CHECK (mode IN ('copy', 'transfer', 'snapshot', 'remaster')),
  DROP CONSTRAINT ck_registration_virtualbox,
  ADD CONSTRAINT ck_registration_virtualbox CHECK (
    (emulator_type = 'virtualbox') = (virtualbox_uuid IS NOT NULL)
    AND (emulator_type <> 'virtualbox' OR mode IN ('copy', 'snapshot', 'remaster'))
  ),
  ADD CONSTRAINT ck_registration_snapshot_details CHECK (
    (snapshot_title IS NULL AND snapshot_description IS NULL) OR mode = 'snapshot'
  ),
  ADD CONSTRAINT ck_registration_snapshot_title CHECK (
    snapshot_title IS NULL OR CHAR_LENGTH(snapshot_title) BETWEEN 1 AND 120
  ),
  ADD CONSTRAINT ck_registration_snapshot_description CHECK (
    snapshot_description IS NULL OR CHAR_LENGTH(snapshot_description) BETWEEN 1 AND 2000
  );
