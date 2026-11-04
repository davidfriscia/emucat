# 0002: VM names are a conservative, case-insensitive ASCII subset

**Status:** Accepted

A VM name is at once an identity, a directory on three operating systems, and part of remote object
keys. The [rules](../domain-model.md#vm-names) are the intersection of what is safe in all of those
places, and existing directories that break them cannot be registered without being renamed.

**Allowed characters are an allowlist.** A denylist of dangerous characters is how path traversal bugs
happen.

**ASCII only.** macOS normalizes Unicode differently from Windows and Linux, so `café` can be two
different byte sequences that look the same, and look-alike letters allow impersonation. The cost is
that names in other scripts must be transliterated. A future display name field (`display_name` already
exists in the schema) carries the human-friendly title.

**Spaces are allowed, singly.** This is the one concession to usability, because names like
`Windows 98 SE` are common for VM directories. Remote keys must be URL-encoded correctly, which any
competent client does.

**Case-insensitive identity.** A case-sensitive catalog could register `Win98` and `win98`, which then
collide on Windows and macOS. Treating them as one VM everywhere is the only behavior consistent across
hosts.

**Names ending in `_` and twelve digits are rejected,** so that any string has one reading: a snapshot
name can always be split into a VM name and a timestamp.
