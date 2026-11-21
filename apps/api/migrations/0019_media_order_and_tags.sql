-- Screenshot order, durable screenshot deletion, and tags. See decision 0050, docs/media.md and
-- docs/domain-model.md#tags. Forward only and additive: no existing row loses its meaning, and nothing is
-- dropped. The one data change is the initial screenshot order, which reproduces the order every gallery
-- already showed.

-- 1. Screenshot order ------------------------------------------------------------------------------------
--
-- An administrator's order of one VM's screenshots, first to last. Positions are only compared within a VM;
-- gaps (after a deletion) mean nothing, and the ID breaks ties, so the order is always total and stable.
-- A new screenshot takes the VM's largest position plus one, under the VM's row lock, so it comes last.
ALTER TABLE vm_media
  ADD COLUMN sort_order INT UNSIGNED NOT NULL DEFAULT 0
    COMMENT 'Position in the VM''s gallery, ascending, ties broken by id' AFTER is_main,
  ADD KEY ix_vm_media_order (emulator_type, vm_name, sort_order, id),
  -- Lets other rows reference a screenshot *of a given VM*, as vm_versions does for versions.
  ADD UNIQUE KEY uq_vm_media_id_vm (id, emulator_type, vm_name);

-- The order galleries used until now: the main image first, then by capture or upload time. updated_at is
-- set to itself so that this backfill does not look like an edit of every screenshot.
UPDATE vm_media AS media
JOIN (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY emulator_type, vm_name
           ORDER BY is_main DESC, COALESCE(captured_at, created_at), id
         ) AS position
  FROM vm_media
) AS initial ON initial.id = media.id
SET media.sort_order = initial.position, media.updated_at = media.updated_at;

-- 2. Deleted screenshots ---------------------------------------------------------------------------------
--
-- One row for each content hash an administrator deleted from a VM's catalog. Agents find screenshots by
-- scanning the VM's directory, and deleting from EmuCat never touches that file, so without this the next
-- scan, or a rebuilt agent queue, would upload the same bytes and the screenshot would come back.
--
-- While a row exists, an upload of these bytes to this VM stores nothing and succeeds, so the agent marks the
-- file done. Acknowledgements still leave the hash out: a transfer must not delete the local file because the
-- catalog copy was deleted. Different bytes are a different screenshot. An explicitly requested capture of
-- identical bytes is an administrator asking for the image again, and lifts the suppression. media_id and
-- original_filename are the deleted item's, kept for the audit.
CREATE TABLE vm_media_suppressions (
  emulator_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  vm_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  original_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  media_id UUID NOT NULL COMMENT 'The deleted item. No foreign key: the item is gone',
  original_filename VARCHAR(255) NOT NULL,
  deleted_by_user_id UUID NULL,
  deleted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (emulator_type, vm_name, original_sha256),
  KEY ix_vm_media_suppressions_user (deleted_by_user_id),
  CONSTRAINT fk_vm_media_suppressions_vm FOREIGN KEY (emulator_type, vm_name)
    REFERENCES virtual_machines (emulator_type, vm_name),
  CONSTRAINT fk_vm_media_suppressions_user FOREIGN KEY (deleted_by_user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_vm_media_suppressions_sha256 CHECK (original_sha256 REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- 3. Tags ------------------------------------------------------------------------------------------------
--
-- One central catalog. name is the display form, without '#', in the case first typed. normalized_name is
-- what makes a tag unique and what search compares: the API lower-cases it (Unicode, locale-independent), so
-- it is compared byte for byte here. Both are validated by the rules in @emucat/contracts.
CREATE TABLE tags (
  id UUID NOT NULL,
  name VARCHAR(48) NOT NULL,
  normalized_name VARCHAR(96) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL
    COMMENT 'Wider than name: lower-casing can lengthen a few characters',
  created_by_user_id UUID NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_tags_normalized_name (normalized_name),
  KEY ix_tags_created_by (created_by_user_id),
  CONSTRAINT fk_tags_user FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_tags_name CHECK (CHAR_LENGTH(name) BETWEEN 1 AND 48 AND name NOT LIKE '#%'),
  CONSTRAINT ck_tags_normalized_name CHECK (
    CHAR_LENGTH(normalized_name) >= 1 AND normalized_name NOT LIKE '#%'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- Each kind of entity has its own association table with real foreign keys, rather than one table with a
-- loosely typed entity reference: nothing can point at a VM, version or screenshot that does not exist.
-- Tags are never inherited: a screenshot's tag is not its VM's, and a snapshot's is not its parent's.

CREATE TABLE vm_tags (
  emulator_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  vm_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  tag_id UUID NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (emulator_type, vm_name, tag_id),
  KEY ix_vm_tags_tag (tag_id),
  CONSTRAINT fk_vm_tags_vm FOREIGN KEY (emulator_type, vm_name)
    REFERENCES virtual_machines (emulator_type, vm_name),
  CONSTRAINT fk_vm_tags_tag FOREIGN KEY (tag_id) REFERENCES tags (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- Masters and snapshots are both vm_versions rows, so one table serves both. A promoted snapshot is the same
-- version, and keeps its tags. Composite, so that the VM columns always agree with the version's.
CREATE TABLE vm_version_tags (
  version_id UUID NOT NULL,
  emulator_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  vm_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  tag_id UUID NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (version_id, tag_id),
  KEY ix_vm_version_tags_vm (emulator_type, vm_name, tag_id),
  KEY ix_vm_version_tags_tag (tag_id),
  CONSTRAINT fk_vm_version_tags_version FOREIGN KEY (version_id, emulator_type, vm_name)
    REFERENCES vm_versions (id, emulator_type, vm_name) ON DELETE CASCADE,
  CONSTRAINT fk_vm_version_tags_tag FOREIGN KEY (tag_id) REFERENCES tags (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- A deleted screenshot takes its tags with it.
CREATE TABLE vm_media_tags (
  media_id UUID NOT NULL,
  emulator_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  vm_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  tag_id UUID NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (media_id, tag_id),
  KEY ix_vm_media_tags_vm (emulator_type, vm_name, tag_id),
  KEY ix_vm_media_tags_tag (tag_id),
  CONSTRAINT fk_vm_media_tags_media FOREIGN KEY (media_id, emulator_type, vm_name)
    REFERENCES vm_media (id, emulator_type, vm_name) ON DELETE CASCADE,
  CONSTRAINT fk_vm_media_tags_tag FOREIGN KEY (tag_id) REFERENCES tags (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
