-- Initial EmuCat schema.
--
-- Conventions:
--   * VM identity is always the pair (emulator_type, vm_name), stored as ASCII with a
--     case-insensitive collation so `Win98` and `win98` are the same VM, matching the rule
--     in @emucat/contracts. Child tables reference it with composite foreign keys.
--   * Timestamps are DATETIME(3) in UTC. The API sets its session time zone to UTC.
--   * "*_marker" columns are generated as 1 or NULL. Because a UNIQUE index allows many NULLs,
--     they express "at most one row per scope where the condition holds".
--   * Hashes are lowercase SHA-256 hex. Tokens are only ever stored as raw SHA-256 digests.

CREATE TABLE users (
  id UUID NOT NULL,
  username VARCHAR(64) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'user',
  disabled_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username),
  CONSTRAINT ck_users_role CHECK (role IN ('admin', 'user'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE user_sessions (
  id UUID NOT NULL,
  user_id UUID NOT NULL,
  token_hash BINARY(32) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_sessions_token_hash (token_hash),
  KEY ix_user_sessions_user (user_id),
  KEY ix_user_sessions_expires (expires_at),
  CONSTRAINT fk_user_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE agents (
  id UUID NOT NULL,
  owner_user_id UUID NULL,
  name VARCHAR(128) NOT NULL,
  platform VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  architecture VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  agent_version VARCHAR(64) NULL,
  protocol_version INT UNSIGNED NULL,
  credential_hash BINARY(32) NULL,
  paired_at DATETIME(3) NULL,
  last_connected_at DATETIME(3) NULL,
  last_seen_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_agents_credential_hash (credential_hash),
  KEY ix_agents_owner (owner_user_id),
  CONSTRAINT fk_agents_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_agents_platform CHECK (platform IS NULL OR platform IN ('windows', 'macos', 'linux'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- Connection details only. Secrets stay outside the database: secret_ref names where to find them.
CREATE TABLE repositories (
  id UUID NOT NULL,
  name VARCHAR(128) NOT NULL,
  kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  config JSON NOT NULL DEFAULT (JSON_OBJECT()),
  secret_ref VARCHAR(255) NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_repositories_name (name),
  CONSTRAINT ck_repositories_config CHECK (JSON_VALID(config))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- A row exists only after an agent discovered the VM and a user registered it. The identity is
-- immutable: it is the local directory name, so renaming a directory creates a different VM.
CREATE TABLE virtual_machines (
  emulator_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  vm_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  display_name VARCHAR(255) NULL,
  description TEXT NULL,
  visibility VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'private',
  registered_by_user_id UUID NULL,
  discovered_by_agent_id UUID NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (emulator_type, vm_name),
  KEY ix_virtual_machines_visibility (visibility),
  KEY ix_virtual_machines_registered_by (registered_by_user_id),
  KEY ix_virtual_machines_discovered_by (discovered_by_agent_id),
  CONSTRAINT fk_virtual_machines_user FOREIGN KEY (registered_by_user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_virtual_machines_agent FOREIGN KEY (discovered_by_agent_id)
    REFERENCES agents (id) ON DELETE SET NULL,
  CONSTRAINT ck_virtual_machines_emulator CHECK (emulator_type IN ('86box', 'qemu')),
  -- Backstop for the full rules in @emucat/contracts; rejects anything path-like outright.
  CONSTRAINT ck_virtual_machines_name CHECK (
    vm_name REGEXP '^[A-Za-z0-9]([A-Za-z0-9._ -]*[A-Za-z0-9])?$' AND vm_name NOT LIKE '%..%'
  ),
  CONSTRAINT ck_virtual_machines_visibility CHECK (visibility IN ('private', 'public'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- Full, standalone archives. Rows are immutable (see the trigger below). The ID is the identity;
-- snapshot_name is a label and may repeat within a minute. The unique key on
-- (id, emulator_type, vm_name) exists so that other rows can reference a version *of a given VM*.
CREATE TABLE vm_versions (
  id UUID NOT NULL,
  emulator_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  vm_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  parent_version_id UUID NULL,
  snapshot_name VARCHAR(77) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
  repository_id UUID NOT NULL,
  archive_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  archive_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  archive_size_bytes BIGINT UNSIGNED NOT NULL,
  created_by_agent_id UUID NULL,
  created_by_user_id UUID NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  master_marker TINYINT AS (CASE WHEN kind = 'master' THEN 1 END) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_vm_versions_id_vm (id, emulator_type, vm_name),
  UNIQUE KEY uq_vm_versions_one_master (emulator_type, vm_name, master_marker),
  UNIQUE KEY uq_vm_versions_archive (repository_id, archive_key),
  KEY ix_vm_versions_vm_created (emulator_type, vm_name, created_at),
  KEY ix_vm_versions_parent (parent_version_id, emulator_type, vm_name),
  KEY ix_vm_versions_snapshot_name (emulator_type, vm_name, snapshot_name),
  KEY ix_vm_versions_created_by_agent (created_by_agent_id),
  KEY ix_vm_versions_created_by_user (created_by_user_id),
  CONSTRAINT fk_vm_versions_vm FOREIGN KEY (emulator_type, vm_name)
    REFERENCES virtual_machines (emulator_type, vm_name),
  -- Composite so that a parent can only be another version of the same VM.
  CONSTRAINT fk_vm_versions_parent FOREIGN KEY (parent_version_id, emulator_type, vm_name)
    REFERENCES vm_versions (id, emulator_type, vm_name),
  CONSTRAINT fk_vm_versions_repository FOREIGN KEY (repository_id) REFERENCES repositories (id),
  CONSTRAINT fk_vm_versions_agent FOREIGN KEY (created_by_agent_id)
    REFERENCES agents (id) ON DELETE SET NULL,
  CONSTRAINT fk_vm_versions_user FOREIGN KEY (created_by_user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_vm_versions_shape CHECK (
    (kind = 'master' AND parent_version_id IS NULL AND snapshot_name IS NULL)
    OR (kind = 'snapshot' AND parent_version_id IS NOT NULL AND snapshot_name IS NOT NULL)
  ),
  CONSTRAINT ck_vm_versions_not_own_parent CHECK (parent_version_id IS NULL OR parent_version_id <> id),
  CONSTRAINT ck_vm_versions_sha256 CHECK (archive_sha256 REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- A version never changes. InnoDB foreign key actions do not fire triggers, so ON DELETE SET NULL on
-- the attribution columns still works when an agent or user is removed.
CREATE TRIGGER trg_vm_versions_immutable BEFORE UPDATE ON vm_versions FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'vm_versions rows are immutable';

-- What each agent last reported about its local copy. A registered VM only: discovery results for
-- unregistered directories are not catalog data. content_status starts as unverified, because a
-- cached VM can change while its agent is offline.
CREATE TABLE agent_vm_state (
  agent_id UUID NOT NULL,
  emulator_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  vm_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  local_source_version_id UUID NULL,
  execution_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'unknown',
  content_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'unverified',
  last_verified_at DATETIME(3) NULL,
  last_verified_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  pending_operations JSON NOT NULL DEFAULT (JSON_ARRAY()),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (agent_id, emulator_type, vm_name),
  KEY ix_agent_vm_state_vm (emulator_type, vm_name),
  KEY ix_agent_vm_state_source (local_source_version_id, emulator_type, vm_name),
  CONSTRAINT fk_agent_vm_state_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE,
  CONSTRAINT fk_agent_vm_state_vm FOREIGN KEY (emulator_type, vm_name)
    REFERENCES virtual_machines (emulator_type, vm_name),
  CONSTRAINT fk_agent_vm_state_source FOREIGN KEY (local_source_version_id, emulator_type, vm_name)
    REFERENCES vm_versions (id, emulator_type, vm_name),
  CONSTRAINT ck_agent_vm_state_execution CHECK (execution_state IN (
    'unknown', 'absent', 'idle', 'downloading', 'extracting', 'verifying', 'starting', 'running',
    'stopping', 'archiving', 'uploading', 'error'
  )),
  CONSTRAINT ck_agent_vm_state_content CHECK (content_status IN ('unverified', 'verified', 'modified')),
  CONSTRAINT ck_agent_vm_state_verified CHECK (content_status <> 'verified' OR last_verified_at IS NOT NULL),
  CONSTRAINT ck_agent_vm_state_pending CHECK (JSON_VALID(pending_operations))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE vm_sessions (
  id UUID NOT NULL,
  agent_id UUID NULL,
  user_id UUID NULL,
  emulator_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  vm_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  source_version_id UUID NULL,
  execution_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'starting',
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ended_at DATETIME(3) NULL,
  exit_code INT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  active_marker TINYINT AS (CASE WHEN ended_at IS NULL THEN 1 END) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_vm_sessions_one_active (agent_id, emulator_type, vm_name, active_marker),
  KEY ix_vm_sessions_vm_started (emulator_type, vm_name, started_at),
  KEY ix_vm_sessions_user (user_id),
  KEY ix_vm_sessions_source (source_version_id, emulator_type, vm_name),
  CONSTRAINT fk_vm_sessions_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE SET NULL,
  CONSTRAINT fk_vm_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_vm_sessions_vm FOREIGN KEY (emulator_type, vm_name)
    REFERENCES virtual_machines (emulator_type, vm_name),
  CONSTRAINT fk_vm_sessions_source FOREIGN KEY (source_version_id, emulator_type, vm_name)
    REFERENCES vm_versions (id, emulator_type, vm_name),
  CONSTRAINT ck_vm_sessions_times CHECK (ended_at IS NULL OR ended_at >= started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- Media are independent of versions: no column here references vm_versions. The main selection is a
-- property of the media row itself rather than a pointer on virtual_machines, so it cannot refer to
-- another VM's media, cannot dangle, and disappears with the row when the media is deleted.
CREATE TABLE vm_media (
  id UUID NOT NULL,
  emulator_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  vm_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  visibility VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'private',
  is_main BOOLEAN NOT NULL DEFAULT FALSE,
  original_filename VARCHAR(255) NOT NULL,
  original_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  original_size_bytes BIGINT UNSIGNED NOT NULL,
  -- Relative to STORAGE_PATH, so the storage root can move without touching the database.
  jpeg_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  thumbnail_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  width_px INT UNSIGNED NOT NULL,
  height_px INT UNSIGNED NOT NULL,
  captured_at DATETIME(3) NULL,
  uploaded_by_agent_id UUID NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  main_marker TINYINT AS (CASE WHEN is_main THEN 1 END) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_vm_media_dedup (emulator_type, vm_name, original_sha256),
  UNIQUE KEY uq_vm_media_one_main (emulator_type, vm_name, main_marker),
  KEY ix_vm_media_uploaded_by (uploaded_by_agent_id),
  CONSTRAINT fk_vm_media_vm FOREIGN KEY (emulator_type, vm_name)
    REFERENCES virtual_machines (emulator_type, vm_name),
  CONSTRAINT fk_vm_media_agent FOREIGN KEY (uploaded_by_agent_id)
    REFERENCES agents (id) ON DELETE SET NULL,
  CONSTRAINT ck_vm_media_visibility CHECK (visibility IN ('private', 'published')),
  CONSTRAINT ck_vm_media_sha256 CHECK (original_sha256 REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- The only way public catalog code should read card images: a public VM's main media, and only
-- while it is published. A VM with no row here gets a placeholder.
CREATE VIEW public_catalog_card_media AS
  SELECT
    vm.emulator_type,
    vm.vm_name,
    media.id AS media_id,
    media.jpeg_key,
    media.thumbnail_key,
    media.width_px,
    media.height_px
  FROM virtual_machines AS vm
  JOIN vm_media AS media
    ON media.emulator_type = vm.emulator_type AND media.vm_name = vm.vm_name
  WHERE vm.visibility = 'public' AND media.is_main AND media.visibility = 'published';
