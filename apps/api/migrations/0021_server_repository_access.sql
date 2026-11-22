-- The server's own repository connection, the HTTPS transfer relay, and clones made by the server. See decision 0055.
-- Forward only and additive: every existing row keeps its meaning and every guarantee it had.

-- 1. A clone is made by the server itself, so its registration operation names no agent. Only a clone may do
--    without one; every other mode still has exactly one agent, as before. The foreign key stays: NULL satisfies it.
--    `uq_registration_active_agent` still allows one active operation per agent (NULLs never collide), and
--    `uq_registration_active_vm` still reserves the destination name for as long as the clone runs.
--    `server_attempts` counts how often the server started this clone, so that a restart retries it a bounded
--    number of times rather than forever.
ALTER TABLE registration_operations
  MODIFY COLUMN agent_id UUID NULL,
  ADD COLUMN server_attempts INT UNSIGNED NOT NULL DEFAULT 0
    COMMENT 'How often the server started its own work on this operation (decision 0055)' AFTER clone_source_manifest_sha256,
  ADD CONSTRAINT ck_registration_agent CHECK (agent_id IS NOT NULL OR mode = 'clone'),
  ADD CONSTRAINT ck_registration_server_attempts CHECK (agent_id IS NULL OR server_attempts = 0);

-- 2. Transfers staged on the server, for agents that cannot reach a repository themselves. One row per staged
--    object: an upload of one agent's file to one staging key, or a download of one object, shared by every agent
--    that asks for it while it is staged. Payload bytes are on the server's disk under TRANSFER_STAGING_PATH, in a
--    directory named by `id` only; nothing here is a path. `reserved_bytes` is what the row counts against the
--    staging quota until its files are removed.
CREATE TABLE repository_transfers (
  id UUID NOT NULL,
  direction VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  repository_id UUID NOT NULL,
  object_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  agent_id UUID NULL COMMENT 'The uploading agent. NULL for a download, which any authorized agent may read',
  size_bytes BIGINT UNSIGNED NULL,
  sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  chunk_bytes INT UNSIGNED NOT NULL,
  done_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  reserved_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  files_present TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Whether the staging directory may still hold files',
  error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_message VARCHAR(1024) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  last_activity_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  active_marker TINYINT AS (CASE WHEN state IN ('receiving', 'received', 'publishing', 'staging', 'ready')
    THEN 1 END) STORED,
  PRIMARY KEY (id),
  -- One unfinished transfer per object: a second upload to the same staging key replaces the first explicitly,
  -- and concurrent downloads of one object share one staged copy.
  UNIQUE KEY uq_repository_transfers_active (direction, repository_id, object_key, active_marker),
  KEY ix_repository_transfers_agent (agent_id, state),
  KEY ix_repository_transfers_state (state, last_activity_at),
  KEY ix_repository_transfers_files (files_present, state),
  CONSTRAINT fk_repository_transfers_repository FOREIGN KEY (repository_id) REFERENCES repositories (id),
  CONSTRAINT fk_repository_transfers_agent FOREIGN KEY (agent_id) REFERENCES agents (id),
  CONSTRAINT ck_repository_transfers_direction CHECK (direction IN ('upload', 'download')),
  CONSTRAINT ck_repository_transfers_state CHECK (state IN (
    'receiving', 'received', 'publishing', 'published', 'staging', 'ready', 'failed', 'cancelled', 'expired'
  )),
  CONSTRAINT ck_repository_transfers_shape CHECK (
    (direction = 'upload' AND agent_id IS NOT NULL AND size_bytes IS NOT NULL AND sha256 IS NOT NULL
      AND object_key LIKE 'archives/.staging/%'
      AND state IN ('receiving', 'received', 'publishing', 'published', 'failed', 'cancelled', 'expired'))
    OR (direction = 'download' AND agent_id IS NULL
      AND state IN ('staging', 'ready', 'failed', 'cancelled', 'expired'))
  ),
  CONSTRAINT ck_repository_transfers_ready CHECK (
    state <> 'ready' OR (size_bytes IS NOT NULL AND sha256 IS NOT NULL)
  ),
  CONSTRAINT ck_repository_transfers_sha256 CHECK (sha256 IS NULL OR sha256 REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT ck_repository_transfers_chunk CHECK (chunk_bytes BETWEEN 262144 AND 67108864)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- The chunks of an upload that arrived and matched their own SHA-256. Inserting one that is already there is a
-- no-op, so a repeated or concurrent chunk is counted once.
CREATE TABLE repository_transfer_chunks (
  transfer_id UUID NOT NULL,
  chunk_index INT UNSIGNED NOT NULL,
  sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (transfer_id, chunk_index),
  CONSTRAINT fk_repository_transfer_chunks_transfer FOREIGN KEY (transfer_id)
    REFERENCES repository_transfers (id) ON DELETE CASCADE,
  CONSTRAINT ck_repository_transfer_chunks_sha256 CHECK (sha256 REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- 3. The most recent Test Server Connection of each repository, as shown on the Repositories page. The result is
--    the step-by-step report the API produced, which never holds a key, a passphrase or a server path.
CREATE TABLE repository_server_checks (
  repository_id UUID NOT NULL,
  tested_at DATETIME(3) NOT NULL,
  ok TINYINT(1) NOT NULL,
  result JSON NOT NULL,
  PRIMARY KEY (repository_id),
  CONSTRAINT fk_repository_server_checks_repository FOREIGN KEY (repository_id)
    REFERENCES repositories (id) ON DELETE CASCADE,
  CONSTRAINT ck_repository_server_checks_result CHECK (JSON_VALID(result))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- 4. How each agent reached the repository in its most recent health check: its own SFTP connection, or the relay.
--    NULL for checks from before decision 0055, and from agents that do not say.
ALTER TABLE agent_repositories
  ADD COLUMN last_transport VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NULL
    COMMENT 'sftp or relay (decision 0055)' AFTER free_bytes,
  ADD CONSTRAINT ck_agent_repositories_transport CHECK (last_transport IS NULL OR last_transport IN ('sftp', 'relay'));
