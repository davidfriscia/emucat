-- Publication is decided by the VM alone. See decision 0036 and docs/media.md.
--
-- A public VM's screenshots are public, and a private VM's are not. vm_media.visibility no longer decides
-- anything. It is kept, with its values and its CHECK, rather than dropped: the history of what an
-- administrator once chose stays in the database, nothing is lost if this needs to be looked at again,
-- and no data is rewritten. No application code reads or writes it from this migration on. New rows
-- take its default, which means nothing.
--
-- Only the view changes meaning. It still requires a public VM and the main flag, so a private VM's
-- media can never appear through it, and nothing is ever promoted in place of a cleared main image.
CREATE OR REPLACE VIEW public_catalog_card_media AS
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
  WHERE vm.visibility = 'public' AND media.is_main;

ALTER TABLE vm_media
  MODIFY visibility VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'private'
    COMMENT 'Legacy, ignored since 0008: media are public exactly while their VM is';
