-- Registration operations as a durable history that stays usable at any size. See decision 0043.
-- Forward only and additive: no row is deleted or rewritten, and no foreign key or check is weakened.

-- An administrator can acknowledge a partial success: the version was committed, and the local copy was
-- left in a state that only a person can deal with (kept after a failed removal, or unknown after the agent
-- lost track of it). Acknowledging records who decided that EmuCat need do nothing more, and when; it
-- changes nothing else. Retrying a removal clears it, since that starts the cleanup again.
ALTER TABLE registration_operations
  ADD COLUMN acknowledged_at DATETIME(3) NULL
    COMMENT 'When an administrator acknowledged this partial success' AFTER finished_at,
  ADD COLUMN acknowledged_by_user_id UUID NULL AFTER acknowledged_at,
  ADD KEY ix_registration_acknowledged_by (acknowledged_by_user_id),
  ADD CONSTRAINT fk_registration_acknowledged_by FOREIGN KEY (acknowledged_by_user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  -- acknowledged_by_user_id has no check of its own: deleting the user sets it to NULL, as for
  -- requested_by_user_id, and the acknowledgement stays.
  ADD CONSTRAINT ck_registration_acknowledged CHECK (
    acknowledged_at IS NULL OR state = 'partial_success'
  );

-- attention_marker is 1 exactly while an operation needs an administrator to see it: while it runs, and
-- for a partial success nobody has acknowledged. It is registrationNeedsAttention() in @emucat/contracts.
-- A failure or cancellation committed nothing and left the local VM unchanged, so it is history only.
--
-- The indexes serve the listings, newest first with the ID as tie-breaker for keyset pagination:
--   ix_registration_agent_created   one agent's history;
--   ix_registration_vm_created      one VM's history, which supersedes ix_registration_vm (its prefix);
--   ix_registration_attention       what needs attention, overall or for one agent.
-- The whole history uses the existing ix_registration_created, which InnoDB already extends with the
-- primary key.
ALTER TABLE registration_operations
  ADD COLUMN attention_marker TINYINT AS (CASE
    WHEN state IN (
      'queued', 'validating', 'archiving', 'uploading', 'verifying', 'committing', 'cleaning_local'
    ) THEN 1
    WHEN state = 'partial_success' AND acknowledged_at IS NULL THEN 1
  END) STORED,
  ADD KEY ix_registration_agent_created (agent_id, created_at, id),
  ADD KEY ix_registration_vm_created (emulator_type, vm_name, created_at, id),
  ADD KEY ix_registration_attention (attention_marker, agent_id, created_at, id),
  DROP KEY ix_registration_vm;
