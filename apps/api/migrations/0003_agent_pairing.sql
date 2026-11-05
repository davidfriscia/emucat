-- Device-style agent pairing. See docs/protocol.md and decision 0009.
--
-- A request is short-lived and holds no usable secret: the pairing code and the polling secret are
-- stored only as SHA-256 digests. `expires_at` is what authorization checks; a row that has passed it
-- grants nothing, whether or not cleanup has removed it yet.
--
-- The status records decisions only, and moves one way:
--   pending -> approved -> completed
--   pending -> rejected
-- "expired" is not a stored state. It is pending or approved with `expires_at` in the past.
--
-- The agent row and its credential are created together, in the transaction that moves a request to
-- `completed`, so a request that is approved and never collected leaves no agent behind. The UNIQUE
-- key on `agent_id` means that one request can never produce two agents.
CREATE TABLE agent_pairing_requests (
  id UUID NOT NULL,
  code_hash BINARY(32) NOT NULL,
  polling_secret_hash BINARY(32) NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'pending',
  name VARCHAR(128) NOT NULL,
  platform VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  architecture VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  agent_version VARCHAR(64) NOT NULL,
  protocol_version INT UNSIGNED NOT NULL,
  requested_from VARCHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  decided_at DATETIME(3) NULL,
  decided_by_user_id UUID NULL,
  completed_at DATETIME(3) NULL,
  agent_id UUID NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_agent_pairing_code (code_hash),
  UNIQUE KEY uq_agent_pairing_secret (polling_secret_hash),
  UNIQUE KEY uq_agent_pairing_agent (agent_id),
  KEY ix_agent_pairing_status_expiry (status, expires_at),
  KEY ix_agent_pairing_decided_by (decided_by_user_id),
  CONSTRAINT fk_agent_pairing_user FOREIGN KEY (decided_by_user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_agent_pairing_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE SET NULL,
  CONSTRAINT ck_agent_pairing_status CHECK (status IN ('pending', 'approved', 'rejected', 'completed')),
  CONSTRAINT ck_agent_pairing_platform CHECK (platform IN ('windows', 'macos', 'linux')),
  CONSTRAINT ck_agent_pairing_decided CHECK (status = 'pending' OR decided_at IS NOT NULL),
  CONSTRAINT ck_agent_pairing_completed CHECK (status <> 'completed' OR completed_at IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
