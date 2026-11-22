-- Cloning a VM from one of its versions. See decision 0052 and docs/domain-model.md#clones. Forward only and
-- additive: every existing row keeps its meaning and every guarantee it had.
--
-- A clone is a registration operation, mode 'clone', of the NEW VM: the same identities issued up front, the same
-- active markers (so the destination name is reserved, ignoring case, for as long as it runs, and its agent runs
-- one operation at a time), the same states and the same commit transaction. An agent downloads the source
-- version's archive, writes it again under the new identity, verifies it and publishes it at the new VM's own key.
--
-- What the source was is copied onto the operation when it is created, as values. Nothing here is a foreign key to
-- the source VM or its versions: the clone must survive the source, and the source's lifecycle must never be held
-- back or cascaded into by a clone. While a clone runs, its source version is protected the way every other
-- reference is (decision 0041): through lockUsableVersion and the in-use checks of deletions and remasters, which
-- now look at clone_source_version_id too.
ALTER TABLE registration_operations
  ADD COLUMN clone_source_vm_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NULL
    COMMENT 'The VM cloned from, as it was spelled then. Not a foreign key' AFTER import_sha256,
  ADD COLUMN clone_source_version_id UUID NULL
    COMMENT 'The version cloned from. Not a foreign key' AFTER clone_source_vm_name,
  ADD COLUMN clone_source_archive_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL
    AFTER clone_source_version_id,
  ADD COLUMN clone_source_archive_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL
    AFTER clone_source_archive_key,
  ADD COLUMN clone_source_archive_size_bytes BIGINT UNSIGNED NULL AFTER clone_source_archive_sha256,
  ADD COLUMN clone_source_manifest_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL
    COMMENT 'What the source''s registration verified, when known' AFTER clone_source_archive_size_bytes,
  ADD KEY ix_registration_clone_source (clone_source_version_id, active_marker),
  DROP CONSTRAINT ck_registration_mode,
  ADD CONSTRAINT ck_registration_mode CHECK (
    mode IN ('copy', 'transfer', 'snapshot', 'remaster', 'import', 'clone')
  ),
  -- A clone, like an import, names no VirtualBox machine: the new VM is linked to nothing.
  DROP CONSTRAINT ck_registration_virtualbox,
  ADD CONSTRAINT ck_registration_virtualbox CHECK (
    (mode = 'import' AND emulator_type = 'virtualbox' AND virtualbox_uuid IS NULL)
    OR (mode = 'clone' AND virtualbox_uuid IS NULL)
    OR (mode NOT IN ('import', 'clone')
        AND (emulator_type = 'virtualbox') = (virtualbox_uuid IS NOT NULL)
        AND (emulator_type <> 'virtualbox' OR mode IN ('copy', 'snapshot', 'remaster')))
  ),
  -- A clone always says exactly what it copies, and how to find the request again; nothing else does.
  ADD CONSTRAINT ck_registration_clone CHECK (
    (mode = 'clone') = (clone_source_vm_name IS NOT NULL AND clone_source_version_id IS NOT NULL
                        AND clone_source_archive_key IS NOT NULL
                        AND clone_source_archive_sha256 IS NOT NULL
                        AND clone_source_archive_size_bytes IS NOT NULL AND request_id IS NOT NULL)
    AND (mode = 'clone' OR (clone_source_vm_name IS NULL AND clone_source_version_id IS NULL
                            AND clone_source_archive_key IS NULL AND clone_source_archive_sha256 IS NULL
                            AND clone_source_archive_size_bytes IS NULL
                            AND clone_source_manifest_sha256 IS NULL))
    AND (mode <> 'clone' OR (parent_version_id IS NULL AND workspace_id IS NULL))
  ),
  ADD CONSTRAINT ck_registration_clone_sha256 CHECK (
    (clone_source_archive_sha256 IS NULL OR clone_source_archive_sha256 REGEXP '^[0-9a-f]{64}$')
    AND (clone_source_manifest_sha256 IS NULL OR clone_source_manifest_sha256 REGEXP '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT ck_registration_clone_not_itself CHECK (
    clone_source_vm_name IS NULL OR clone_source_vm_name <> vm_name
  );

-- Where a cloned VM came from: informational provenance only. One row per clone, written in the clone's commit
-- transaction. It is text and identifiers, never a foreign key to the source, so deleting the source VM or any of
-- its versions changes nothing here and the clone stays fully usable. Only the clone's own row is referenced:
-- the provenance goes when the clone does, and with nothing else.
CREATE TABLE vm_clone_provenance (
  emulator_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  vm_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  source_vm_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL
    COMMENT 'The source VM, as it was spelled when cloned',
  source_display_name VARCHAR(255) NULL COMMENT 'The source''s catalog title when cloned',
  source_version_id UUID NOT NULL,
  source_version_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_snapshot_name VARCHAR(77) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
  source_version_title VARCHAR(120) NULL,
  operation_id UUID NOT NULL,
  cloned_by_user_id UUID NULL,
  cloned_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (emulator_type, vm_name),
  UNIQUE KEY uq_vm_clone_provenance_operation (operation_id),
  KEY ix_vm_clone_provenance_source (emulator_type, source_vm_name),
  KEY ix_vm_clone_provenance_user (cloned_by_user_id),
  CONSTRAINT fk_vm_clone_provenance_vm FOREIGN KEY (emulator_type, vm_name)
    REFERENCES virtual_machines (emulator_type, vm_name) ON DELETE CASCADE,
  CONSTRAINT fk_vm_clone_provenance_user FOREIGN KEY (cloned_by_user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_vm_clone_provenance_kind CHECK (source_version_kind IN ('master', 'snapshot')),
  CONSTRAINT ck_vm_clone_provenance_not_itself CHECK (source_vm_name <> vm_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
