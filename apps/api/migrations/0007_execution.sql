-- Running VMs, and verifying local copies. See docs/launcher.md and decisions 0028 to 0033.
--
-- vm_sessions has existed, unused, since the first migration. It becomes the durable record of every
-- launch: one row per session, kept after it ends. A session is active while ended_at is NULL, which the
-- existing unique key turns into the guarantee that one agent runs one session of a VM at a time. The
-- state says more, and a CHECK keeps the two in agreement.
--
-- Times reported by an agent come from the agent's clock. The old CHECK comparing ended_at with
-- started_at is dropped for that reason: a server-side end (an interrupted session) and an agent-side
-- start need not be ordered.
ALTER TABLE vm_sessions
  DROP CONSTRAINT ck_vm_sessions_times,
  MODIFY execution_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'requested',
  MODIFY started_at DATETIME(3) NULL DEFAULT NULL COMMENT 'When the agent started the emulator',
  MODIFY exit_code BIGINT NULL,
  ADD COLUMN request_id UUID NULL COMMENT 'Chosen by the browser, so that a repeated request starts one session'
    AFTER user_id,
  ADD COLUMN mode VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'local'
    AFTER source_version_id,
  ADD COLUMN pid INT UNSIGNED NULL AFTER execution_state,
  ADD COLUMN process_started_at DATETIME(3) NULL
    COMMENT 'The creation time the operating system reported. With the PID, it names the process'
    AFTER pid,
  ADD COLUMN stop_requested_at DATETIME(3) NULL AFTER exit_code,
  ADD COLUMN force_requested_at DATETIME(3) NULL
    COMMENT 'Set only after an administrator confirmed a forced stop' AFTER stop_requested_at,
  ADD COLUMN graceful_stop_available BOOLEAN NOT NULL DEFAULT FALSE AFTER force_requested_at,
  ADD COLUMN error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER graceful_stop_available,
  ADD COLUMN error_message VARCHAR(1024) NULL AFTER error_code,
  ADD UNIQUE KEY uq_vm_sessions_request (request_id),
  ADD KEY ix_vm_sessions_agent_state (agent_id, execution_state),
  ADD CONSTRAINT ck_vm_sessions_state CHECK (execution_state IN (
    'requested', 'starting', 'running', 'stopping', 'stopped', 'exited', 'failed', 'interrupted', 'unknown'
  )),
  ADD CONSTRAINT ck_vm_sessions_mode CHECK (mode IN ('local', 'remote_volatile', 'remote_snapshot')),
  -- Active exactly while an emulator may be running.
  ADD CONSTRAINT ck_vm_sessions_active CHECK (
    (ended_at IS NULL) = (execution_state IN ('requested', 'starting', 'running', 'stopping', 'unknown'))
  );

-- Verifying a local copy against the manifest of its master. The agent hashes the files; nothing is
-- uploaded, and the server never reads a VM. Kept after it ends, as the history of what was checked.
CREATE TABLE vm_verifications (
  id UUID NOT NULL,
  agent_id UUID NOT NULL,
  requested_by_user_id UUID NULL,
  emulator_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  vm_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  version_id UUID NOT NULL,
  repository_id UUID NOT NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'requested',
  status VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT 'As reported by the agent',
  files_verified BIGINT UNSIGNED NULL,
  bytes_hashed BIGINT UNSIGNED NULL,
  duration_ms BIGINT UNSIGNED NULL,
  missing_count BIGINT UNSIGNED NULL,
  modified_count BIGINT UNSIGNED NULL,
  unexpected_count BIGINT UNSIGNED NULL,
  paths JSON NULL COMMENT 'The first few paths of each kind. Administrators only',
  manifest_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  manifest_source VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_message VARCHAR(1024) NULL,
  completed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  active_marker TINYINT AS (CASE WHEN state = 'requested' THEN 1 END) STORED,
  PRIMARY KEY (id),
  -- An agent verifies one VM at a time, as it does all disk work.
  UNIQUE KEY uq_vm_verifications_active_agent (agent_id, active_marker),
  KEY ix_vm_verifications_vm (emulator_type, vm_name, created_at),
  KEY ix_vm_verifications_version (version_id, emulator_type, vm_name),
  KEY ix_vm_verifications_repository (repository_id),
  KEY ix_vm_verifications_requested_by (requested_by_user_id),
  CONSTRAINT fk_vm_verifications_agent FOREIGN KEY (agent_id) REFERENCES agents (id),
  CONSTRAINT fk_vm_verifications_repository FOREIGN KEY (repository_id) REFERENCES repositories (id),
  CONSTRAINT fk_vm_verifications_user FOREIGN KEY (requested_by_user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_vm_verifications_version FOREIGN KEY (version_id, emulator_type, vm_name)
    REFERENCES vm_versions (id, emulator_type, vm_name),
  CONSTRAINT ck_vm_verifications_state CHECK (state IN ('requested', 'completed', 'expired')),
  CONSTRAINT ck_vm_verifications_status CHECK (status IS NULL OR status IN (
    'verified', 'modified', 'missing', 'unavailable', 'verification_failed'
  )),
  CONSTRAINT ck_vm_verifications_completed CHECK (state <> 'completed' OR status IS NOT NULL),
  CONSTRAINT ck_vm_verifications_paths CHECK (paths IS NULL OR JSON_VALID(paths))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
