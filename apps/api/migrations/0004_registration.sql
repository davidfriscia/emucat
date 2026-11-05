-- VM registration: repository metadata, which agent may use which repository, and durable operations.
-- See docs/protocol.md and decisions 0012 and 0015.
--
-- A repository row holds connection details only. A private key never reaches this database.

-- One active SSH repository for now. The marker is 1 or NULL, as everywhere else in this schema.
ALTER TABLE repositories
  ADD COLUMN active_sftp_marker TINYINT AS (CASE WHEN enabled AND kind = 'sftp' THEN 1 END) STORED,
  ADD UNIQUE KEY uq_repositories_one_active_sftp (active_sftp_marker);

-- Which agents may use which repository. The agent has its own local settings for the same UUID, so a
-- row here authorizes, and the agent's configuration is what makes it possible.
CREATE TABLE agent_repositories (
  agent_id UUID NOT NULL,
  repository_id UUID NOT NULL,
  last_checked_at DATETIME(3) NULL,
  last_success_at DATETIME(3) NULL,
  last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  last_error_message VARCHAR(1024) NULL,
  host_key_fingerprint VARCHAR(128) NULL,
  free_bytes BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (agent_id, repository_id),
  KEY ix_agent_repositories_repository (repository_id),
  CONSTRAINT fk_agent_repositories_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE,
  CONSTRAINT fk_agent_repositories_repository FOREIGN KEY (repository_id) REFERENCES repositories (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- One row per registration, kept after it ends, so that terminal errors stay visible. The state moves
-- only as decision 0015 describes.
--
-- The version UUID and archive key are issued here, before anything happens, so that a retry or a
-- repeated report can never produce a second identity. The archive columns are what the agent reported
-- having verified. The server has not read the archive, and the column comments say so.
--
-- active_marker makes two guarantees that survive any application bug: no two operations are ever
-- active on one VM, whichever agents they are on, and an agent runs one operation at a time.
CREATE TABLE registration_operations (
  id UUID NOT NULL,
  agent_id UUID NOT NULL,
  repository_id UUID NOT NULL,
  requested_by_user_id UUID NULL,
  emulator_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  vm_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  mode VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'queued',
  version_id UUID NOT NULL,
  archive_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  progress_done_bytes BIGINT UNSIGNED NULL,
  progress_total_bytes BIGINT UNSIGNED NULL,
  archive_size_bytes BIGINT UNSIGNED NULL COMMENT 'As reported by the agent',
  archive_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT 'As verified by the agent',
  manifest_version INT UNSIGNED NULL,
  manifest_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  file_count BIGINT UNSIGNED NULL,
  total_uncompressed_bytes BIGINT UNSIGNED NULL,
  local_copy VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_message VARCHAR(1024) NULL,
  cancel_requested_at DATETIME(3) NULL,
  committed_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  active_marker TINYINT AS (CASE WHEN state IN (
    'queued', 'validating', 'archiving', 'uploading', 'verifying', 'committing', 'cleaning_local'
  ) THEN 1 END) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_registration_version (version_id),
  UNIQUE KEY uq_registration_active_vm (emulator_type, vm_name, active_marker),
  UNIQUE KEY uq_registration_active_agent (agent_id, active_marker),
  KEY ix_registration_vm (emulator_type, vm_name),
  KEY ix_registration_repository (repository_id),
  KEY ix_registration_requested_by (requested_by_user_id),
  KEY ix_registration_created (created_at),
  -- RESTRICT: this row is the history of a master, and of where its archive went.
  CONSTRAINT fk_registration_agent FOREIGN KEY (agent_id) REFERENCES agents (id),
  CONSTRAINT fk_registration_repository FOREIGN KEY (repository_id) REFERENCES repositories (id),
  CONSTRAINT fk_registration_user FOREIGN KEY (requested_by_user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_registration_emulator CHECK (emulator_type IN ('86box', 'qemu')),
  CONSTRAINT ck_registration_mode CHECK (mode IN ('copy', 'transfer')),
  CONSTRAINT ck_registration_state CHECK (state IN (
    'queued', 'validating', 'archiving', 'uploading', 'verifying', 'committing', 'cleaning_local',
    'succeeded', 'failed', 'cancelled', 'partial_success'
  )),
  CONSTRAINT ck_registration_local_copy CHECK (
    local_copy IS NULL OR local_copy IN ('preserved', 'removed', 'cleanup_failed', 'unknown')
  ),
  -- Nothing can claim a master without what makes it one.
  CONSTRAINT ck_registration_committed CHECK (
    state NOT IN ('cleaning_local', 'succeeded', 'partial_success')
    OR (committed_at IS NOT NULL AND archive_sha256 IS NOT NULL AND archive_size_bytes IS NOT NULL)
  ),
  CONSTRAINT ck_registration_sha256 CHECK (archive_sha256 IS NULL OR archive_sha256 REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
