-- An import links the machine it creates (decision 0047). Forward only and additive: existing imports keep their
-- meaning, which is that nothing was linked by itself.

-- What an import does with its machine once VirtualBox has it: `link` it to a VM that had none, or `relink` the VM
-- from the machine named in previous_machine_uuid, which an administrator explicitly agreed to replace. The link is
-- a separate step, recorded here, so an import that succeeded stays a success when its link is refused. It is
-- `pending` from the request until it is made (`linked`) or refused (`failed`), and cleared when the import itself
-- does not succeed. A pending link left by a restart is made, or refused, when the agent next says hello.
ALTER TABLE virtualbox_operations
  ADD COLUMN link_intent VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NULL
    COMMENT 'For an import: link or relink its machine once it exists' AFTER previous_machine_uuid,
  ADD COLUMN link_state VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER link_intent,
  ADD COLUMN link_operation_id UUID NULL COMMENT 'The link or relink the import made' AFTER link_state,
  ADD COLUMN link_error_code VARCHAR(64) NULL AFTER link_operation_id,
  ADD COLUMN link_error_message VARCHAR(1024) NULL AFTER link_error_code,
  ADD CONSTRAINT ck_virtualbox_operation_link_intent CHECK (
    link_intent IS NULL OR (kind = 'import' AND link_intent IN ('link', 'relink'))
  ),
  ADD CONSTRAINT ck_virtualbox_operation_link_state CHECK (
    link_state IS NULL OR (link_intent IS NOT NULL AND link_state IN ('pending', 'linked', 'failed'))
  ),
  -- A relink names the machine it replaces; a link replaces none.
  ADD CONSTRAINT ck_virtualbox_operation_link_previous CHECK (
    kind <> 'import' OR link_intent IS NULL
    OR (link_intent = 'link' AND previous_machine_uuid IS NULL)
    OR (link_intent = 'relink' AND previous_machine_uuid IS NOT NULL)
  ),
  ADD KEY ix_virtualbox_operation_link (agent_id, link_state);
