-- Restoring a registered master onto an agent. See docs/protocol.md and decision 0021.
--
-- One row per restore, kept after it ends. The archive columns are copied from the immutable version when
-- the operation is created, so the operation is bound to those exact bytes. The reported columns are what
-- the agent says it verified: the server never reads an archive.
--
-- active_marker makes the guarantee that survives any application bug: an agent runs one restore at a
-- time. Registration has its own table with its own marker, and creating either kind of operation takes
-- the agent's row lock first, so the two cannot start together on one agent.
CREATE TABLE restore_operations (
  id UUID NOT NULL,
  agent_id UUID NOT NULL,
  repository_id UUID NOT NULL,
  requested_by_user_id UUID NULL,
  emulator_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  vm_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  version_id UUID NOT NULL,
  state VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'queued',
  archive_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  archive_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  archive_size_bytes BIGINT UNSIGNED NOT NULL,
  expected_manifest_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL
    COMMENT 'From the registration, when it is known',
  expected_uncompressed_bytes BIGINT UNSIGNED NULL COMMENT 'From the registration, when it is known',
  progress_done_bytes BIGINT UNSIGNED NULL,
  progress_total_bytes BIGINT UNSIGNED NULL,
  manifest_version INT UNSIGNED NULL COMMENT 'As verified by the agent',
  manifest_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT 'As verified by the agent',
  file_count BIGINT UNSIGNED NULL,
  total_uncompressed_bytes BIGINT UNSIGNED NULL,
  local_directory VARCHAR(1024) NULL COMMENT 'As derived by the agent. Administrators only',
  cache_hit BOOLEAN NULL,
  downloaded_bytes BIGINT UNSIGNED NULL,
  archive_cached BOOLEAN NULL,
  cache_total_bytes BIGINT UNSIGNED NULL,
  error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_message VARCHAR(1024) NULL,
  cancel_requested_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  active_marker TINYINT AS (CASE WHEN state IN (
    'queued', 'validating', 'downloading', 'verifying', 'extracting', 'publishing_local', 'committing'
  ) THEN 1 END) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_restore_active_agent (agent_id, active_marker),
  KEY ix_restore_vm (emulator_type, vm_name, created_at),
  KEY ix_restore_version (version_id, emulator_type, vm_name),
  KEY ix_restore_repository (repository_id),
  KEY ix_restore_requested_by (requested_by_user_id),
  -- RESTRICT: this row is the history of where a local copy came from.
  CONSTRAINT fk_restore_agent FOREIGN KEY (agent_id) REFERENCES agents (id),
  CONSTRAINT fk_restore_repository FOREIGN KEY (repository_id) REFERENCES repositories (id),
  CONSTRAINT fk_restore_user FOREIGN KEY (requested_by_user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  -- Composite, so that an operation can only restore a version of the VM it names.
  CONSTRAINT fk_restore_version FOREIGN KEY (version_id, emulator_type, vm_name)
    REFERENCES vm_versions (id, emulator_type, vm_name),
  CONSTRAINT ck_restore_state CHECK (state IN (
    'queued', 'validating', 'downloading', 'verifying', 'extracting', 'publishing_local', 'committing',
    'succeeded', 'failed', 'cancelled', 'partial_success'
  )),
  CONSTRAINT ck_restore_sha256 CHECK (archive_sha256 REGEXP '^[0-9a-f]{64}$'),
  -- Nothing can claim a verified local copy without saying what was verified.
  CONSTRAINT ck_restore_succeeded CHECK (
    state <> 'succeeded' OR (manifest_sha256 IS NOT NULL AND local_directory IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
