-- Importing an existing OVA into the repository from the agent's command line. See decision 0049. Forward only and
-- additive: every existing row keeps its meaning and every guarantee it had.
--
-- An import is a registration operation, mode 'import': the same identities issued up front, the same active
-- markers (one per VM, one per agent), the same states and the same commit transaction. What differs is that no
-- VirtualBox machine is named: the agent uploads a file it was given, and the new VM is linked to nothing.
--
-- The size and SHA-256 the agent declared when it reserved the name are kept, and its report of what it published
-- and verified must match them. request_id (decision 0037) is chosen by the agent, so a repeated request finds the
-- operation it already created.
ALTER TABLE registration_operations
  ADD COLUMN import_description TEXT NULL
    COMMENT 'The new VM''s description, from the agent''s command line. Plain text' AFTER snapshot_description,
  ADD COLUMN import_source_name VARCHAR(255) NULL
    COMMENT 'The imported file''s name, as a label. Never used as a path' AFTER import_description,
  ADD COLUMN import_size_bytes BIGINT UNSIGNED NULL
    COMMENT 'As declared by the agent before uploading' AFTER import_source_name,
  ADD COLUMN import_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL
    COMMENT 'As declared by the agent before uploading' AFTER import_size_bytes,
  DROP CONSTRAINT ck_registration_mode,
  ADD CONSTRAINT ck_registration_mode CHECK (
    mode IN ('copy', 'transfer', 'snapshot', 'remaster', 'import')
  ),
  DROP CONSTRAINT ck_registration_virtualbox,
  ADD CONSTRAINT ck_registration_virtualbox CHECK (
    (mode = 'import' AND emulator_type = 'virtualbox' AND virtualbox_uuid IS NULL)
    OR (mode <> 'import'
        AND (emulator_type = 'virtualbox') = (virtualbox_uuid IS NOT NULL)
        AND (emulator_type <> 'virtualbox' OR mode IN ('copy', 'snapshot', 'remaster')))
  ),
  -- An import always says what it will upload, and how to find it again; nothing else does.
  ADD CONSTRAINT ck_registration_import CHECK (
    (mode = 'import') = (import_size_bytes IS NOT NULL AND import_sha256 IS NOT NULL
                         AND import_source_name IS NOT NULL AND request_id IS NOT NULL)
    AND (import_description IS NULL OR mode = 'import')
  ),
  ADD CONSTRAINT ck_registration_import_sha256 CHECK (
    import_sha256 IS NULL OR import_sha256 REGEXP '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT ck_registration_import_size CHECK (import_size_bytes IS NULL OR import_size_bytes > 0),
  ADD CONSTRAINT ck_registration_import_description CHECK (
    import_description IS NULL OR CHAR_LENGTH(import_description) BETWEEN 1 AND 10000
  ),
  -- What the agent verified is what it declared: a different file can never become the master.
  ADD CONSTRAINT ck_registration_import_verified CHECK (
    mode <> 'import' OR archive_sha256 IS NULL
    OR (archive_sha256 = import_sha256 AND archive_size_bytes = import_size_bytes)
  );
