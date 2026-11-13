-- Typed QEMU capture operations retain provenance independently of deduplicated VM media.
ALTER TABLE vm_sessions ADD COLUMN screenshot_available BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE qemu_captures (
  id UUID NOT NULL PRIMARY KEY,
  request_id UUID NOT NULL,
  session_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  requested_by_user_id UUID NULL,
  emulator_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  vm_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  mode VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_version_id UUID NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'requested',
  sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  media_id UUID NULL,
  uncertain BOOLEAN NOT NULL DEFAULT FALSE,
  error_code VARCHAR(64) NULL,
  error_message VARCHAR(1024) NULL,
  retry_attempts INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  active_marker TINYINT AS (CASE WHEN state IN ('requested', 'capturing', 'uploading') THEN 1 ELSE NULL END) PERSISTENT,
  UNIQUE KEY uq_capture_request (request_id),
  UNIQUE KEY uq_capture_active (session_id, active_marker),
  KEY ix_capture_agent (agent_id, state),
  CONSTRAINT fk_capture_session FOREIGN KEY (session_id) REFERENCES vm_sessions (id),
  CONSTRAINT fk_capture_agent FOREIGN KEY (agent_id) REFERENCES agents (id),
  CONSTRAINT fk_capture_media FOREIGN KEY (media_id) REFERENCES vm_media (id) ON DELETE SET NULL,
  CONSTRAINT ck_capture_qemu CHECK (emulator_type = 'qemu'),
  CONSTRAINT ck_capture_state CHECK (state IN ('requested', 'capturing', 'uploading', 'completed', 'failed')),
  CONSTRAINT ck_capture_retry CHECK (retry_attempts <= 3)
);
