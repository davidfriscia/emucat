-- Screenshot uploads. See docs/media.md and decision 0019.
--
-- An upload keeps the file as it arrived, next to the JPEG and the thumbnail the server makes from it.
-- Both columns are NULL only for rows that predate uploads. An upload always sets both, and the check
-- makes one without the other impossible.
ALTER TABLE vm_media
  ADD COLUMN original_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL
    COMMENT 'Relative to STORAGE_PATH, like jpeg_key' AFTER original_size_bytes,
  ADD COLUMN original_mime VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL
    COMMENT 'Worked out from the bytes, not told by the agent' AFTER original_key,
  ADD CONSTRAINT ck_vm_media_original CHECK (
    (original_key IS NULL AND original_mime IS NULL)
    OR (original_key IS NOT NULL AND original_mime IS NOT NULL)
  );
