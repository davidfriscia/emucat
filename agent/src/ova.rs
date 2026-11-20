//! Reads an OVA without extracting it, and decides whether it is plausibly a VirtualBox appliance (decision 0049).
//!
//! An OVA is a TAR archive whose first file is an OVF descriptor (DMTF DSP0243), followed by the disks and other
//! files the descriptor names, and optionally a manifest (`.mf`) of their digests and a certificate. The file is
//! untrusted input. Nothing here writes anything, follows a name anywhere, or runs anything: names are checked as
//! strings, data is skipped by seeking, and only the descriptor and the manifest (both small and bounded) are read
//! into memory. The XML parser never processes a document type declaration, so no entity can be expanded and no
//! external resource can be loaded; a descriptor that declares one is refused.
//!
//! Passing these checks is not a successful VirtualBox import. It only says that the file is a well-formed OVA whose
//! descriptor and parts are where they should be, and, in the hashing pass, that its parts match its manifest.

use std::collections::HashSet;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use quick_xml::events::{BytesStart, Event};
use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::repository::CancelFlag;

const BLOCK: u64 = 512;
/// More parts than any appliance has. A huge count is an archive meant to exhaust something.
pub const MAX_ENTRIES: usize = 4096;
/// Descriptors are a few kilobytes. This is generous, and still small enough to hold in memory.
pub const MAX_DESCRIPTOR_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
/// A PAX or GNU long-name record is a few hundred bytes at most.
const MAX_METADATA_BYTES: u64 = 64 * 1024;
const MAX_XML_DEPTH: usize = 64;
const MAX_XML_ELEMENTS: usize = 200_000;
const READ_BUFFER_BYTES: usize = 1024 * 1024;

const OVF_NAMESPACES: [&str; 2] = [
    "http://schemas.dmtf.org/ovf/envelope/1",
    "http://schemas.dmtf.org/ovf/envelope/2",
];
const VIRTUALBOX_NAMESPACE: &str = "http://www.virtualbox.org/ovf/machine";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OvaErrorKind {
    /// No such file, a directory, or something else that is not a regular file.
    NotAFile,
    Unreadable,
    WrongExtension,
    /// Not a TAR archive, or a damaged one.
    Malformed,
    /// The archive ends before it should.
    Truncated,
    /// A name that could point outside the archive, or a link.
    UnsafeEntry,
    /// A well-formed archive laid out in a way an OVA is not.
    Unsupported,
    MissingDescriptor,
    InvalidDescriptor,
    InvalidManifest,
    /// A part does not have the digest its manifest says.
    ManifestMismatch,
    /// The file changed while it was being read.
    Changed,
    Cancelled,
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
#[error("{message}")]
pub struct OvaError {
    pub kind: OvaErrorKind,
    pub message: String,
}

fn error(kind: OvaErrorKind, message: impl Into<String>) -> OvaError {
    OvaError {
        kind,
        message: message.into(),
    }
}

fn malformed(message: impl Into<String>) -> OvaError {
    error(OvaErrorKind::Malformed, message)
}

fn io_error(source: &io::Error) -> OvaError {
    if source.kind() == io::ErrorKind::UnexpectedEof {
        error(OvaErrorKind::Truncated, "The archive ends unexpectedly")
    } else {
        error(
            OvaErrorKind::Unreadable,
            format!("Cannot read the file: {source}"),
        )
    }
}

/// One file in the archive: where its bytes are, and how many.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OvaEntry {
    pub name: String,
    #[serde(skip)]
    pub data_offset: u64,
    pub size_bytes: u64,
}

/// A digest the manifest gives for one part.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestDigest {
    pub file: String,
    pub algorithm: String,
    pub digest: String,
}

/// What the archive is, as far as reading its structure can tell.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OvaInspection {
    pub size_bytes: u64,
    pub entries: Vec<OvaEntry>,
    pub descriptor: String,
    pub ovf_version: String,
    /// The `ovf:id` of each virtual system, in document order.
    pub virtual_systems: Vec<String>,
    /// The files the descriptor's `References` section names. Every one is in the archive.
    pub referenced_files: Vec<String>,
    /// Whether VirtualBox's own `vbox:Machine` settings are in the descriptor, as in an OVA VirtualBox exported.
    pub virtualbox_machine: bool,
    pub manifest: Option<String>,
    pub manifest_digests: Vec<ManifestDigest>,
}

impl OvaInspection {
    /// The digests checked while hashing: SHA-256 only. Others are listed, and left to VirtualBox.
    pub fn checked_digests(&self) -> impl Iterator<Item = &ManifestDigest> {
        self.manifest_digests
            .iter()
            .filter(|digest| digest.algorithm == "SHA256")
    }
}

/// `.ova`, in any case. A different extension may be a different format, whatever it contains.
pub fn check_extension(path: &Path) -> Result<(), OvaError> {
    let matches = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("ova"));
    if matches {
        Ok(())
    } else {
        Err(error(
            OvaErrorKind::WrongExtension,
            "The file name must end in .ova. An .ovf with separate disk files is not an OVA: export or \
             package it as a single .ova file",
        ))
    }
}

/// Opens a regular file for reading. Anything else (a directory, a device, a missing path) is refused.
pub fn open_regular(path: &Path) -> Result<(File, u64), OvaError> {
    let metadata = std::fs::metadata(path).map_err(|source| match source.kind() {
        io::ErrorKind::NotFound => error(OvaErrorKind::NotAFile, "The file does not exist"),
        _ => error(
            OvaErrorKind::Unreadable,
            format!("Cannot read the file: {source}"),
        ),
    })?;
    if !metadata.is_file() {
        return Err(error(OvaErrorKind::NotAFile, "This is not a regular file"));
    }
    let file = File::open(path).map_err(|source| io_error(&source))?;
    Ok((file, metadata.len()))
}

/// Checks the file's name, type, archive structure, descriptor and manifest, reading only headers, the descriptor
/// and the manifest.
pub fn inspect(path: &Path) -> Result<OvaInspection, OvaError> {
    check_extension(path)?;
    let (mut file, length) = open_regular(path)?;
    inspect_reader(&mut file, length)
}

/// [`inspect`], on any seekable reader of `length` bytes.
pub fn inspect_reader<R: Read + Seek>(
    reader: &mut R,
    length: u64,
) -> Result<OvaInspection, OvaError> {
    if length == 0 {
        return Err(malformed("The file is empty"));
    }
    if length < BLOCK * 2 {
        return Err(malformed(
            "The file is too small to be a TAR archive, so it is not an OVA",
        ));
    }
    let entries = walk(reader, length)?;
    let first = entries
        .first()
        .ok_or_else(|| error(OvaErrorKind::MissingDescriptor, "The archive is empty"))?;
    let descriptors: Vec<&OvaEntry> = entries
        .iter()
        .filter(|entry| has_extension(&entry.name, "ovf"))
        .collect();
    match descriptors.len() {
        0 => {
            return Err(error(
                OvaErrorKind::MissingDescriptor,
                "The archive has no OVF descriptor (.ovf file)",
            ));
        }
        1 => {}
        _ => {
            return Err(error(
                OvaErrorKind::Unsupported,
                "The archive has more than one OVF descriptor",
            ));
        }
    }
    if !has_extension(&first.name, "ovf") {
        return Err(error(
            OvaErrorKind::Unsupported,
            format!(
                "The OVF descriptor must be the first file in an OVA, and here {} comes first",
                first.name
            ),
        ));
    }
    if first.size_bytes > MAX_DESCRIPTOR_BYTES {
        return Err(error(
            OvaErrorKind::InvalidDescriptor,
            "The OVF descriptor is unreasonably large",
        ));
    }
    let descriptor_bytes = read_entry(reader, first)?;
    let descriptor = parse_descriptor(&descriptor_bytes)?;

    let names: HashSet<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
    for href in &descriptor.references {
        if href.contains('/') || href.contains('\\') || href.contains(':') {
            return Err(error(
                OvaErrorKind::Unsupported,
                format!(
                    "The descriptor refers to {href}, which is not a file in the archive. External or nested \
                     references are not supported"
                ),
            ));
        }
        if !names.contains(href.as_str()) {
            return Err(error(
                OvaErrorKind::InvalidDescriptor,
                format!("The descriptor refers to {href}, which is not in the archive"),
            ));
        }
    }

    let manifests: Vec<&OvaEntry> = entries
        .iter()
        .filter(|entry| has_extension(&entry.name, "mf"))
        .collect();
    if manifests.len() > 1 {
        return Err(error(
            OvaErrorKind::Unsupported,
            "The archive has more than one manifest (.mf file)",
        ));
    }
    let mut manifest_digests = Vec::new();
    if let Some(manifest) = manifests.first() {
        if manifest.size_bytes > MAX_MANIFEST_BYTES {
            return Err(error(
                OvaErrorKind::InvalidManifest,
                "The manifest is unreasonably large",
            ));
        }
        manifest_digests = parse_manifest(&read_entry(reader, manifest)?)?;
        for digest in &manifest_digests {
            if !names.contains(digest.file.as_str()) {
                return Err(error(
                    OvaErrorKind::InvalidManifest,
                    format!(
                        "The manifest lists {}, which is not in the archive",
                        digest.file
                    ),
                ));
            }
        }
    }

    Ok(OvaInspection {
        size_bytes: length,
        descriptor: first.name.clone(),
        ovf_version: descriptor.version,
        virtual_systems: descriptor.virtual_systems,
        referenced_files: descriptor.references,
        virtualbox_machine: descriptor.virtualbox_machine,
        manifest: manifests.first().map(|entry| entry.name.clone()),
        manifest_digests,
        entries,
    })
}

fn has_extension(name: &str, extension: &str) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(stem, found)| !stem.is_empty() && found.eq_ignore_ascii_case(extension))
}

fn read_entry<R: Read + Seek>(reader: &mut R, entry: &OvaEntry) -> Result<Vec<u8>, OvaError> {
    reader
        .seek(SeekFrom::Start(entry.data_offset))
        .map_err(|source| io_error(&source))?;
    let mut bytes = vec![0; usize::try_from(entry.size_bytes).unwrap_or(usize::MAX)];
    reader
        .read_exact(&mut bytes)
        .map_err(|source| io_error(&source))?;
    Ok(bytes)
}

// The TAR structure.

/// What a header says. Names and sizes may be replaced by PAX or GNU records that come before it.
struct Header {
    name: String,
    size: u64,
    kind: u8,
}

fn parse_octal(field: &[u8]) -> Option<u64> {
    // Base-256, for sizes over 8 GiB: the first byte's high bit is set, and the rest is big-endian.
    if let Some(&first) = field.first()
        && first & 0x80 != 0
    {
        if first & 0x40 != 0 {
            return None; // Negative.
        }
        let mut value: u64 = u64::from(first & 0x3f);
        for &byte in &field[1..] {
            value = value.checked_mul(256)?.checked_add(u64::from(byte))?;
        }
        return Some(value);
    }
    let text: Vec<u8> = field
        .iter()
        .copied()
        .take_while(|&byte| byte != 0)
        .collect();
    let text = std::str::from_utf8(&text).ok()?.trim_matches(' ');
    if text.is_empty() {
        return Some(0);
    }
    if !text.bytes().all(|byte| (b'0'..=b'7').contains(&byte)) {
        return None;
    }
    u64::from_str_radix(text, 8).ok()
}

fn c_string(field: &[u8]) -> Result<String, OvaError> {
    let end = field
        .iter()
        .position(|&byte| byte == 0)
        .unwrap_or(field.len());
    String::from_utf8(field[..end].to_vec())
        .map_err(|_| error(OvaErrorKind::UnsafeEntry, "A file name is not valid UTF-8"))
}

fn parse_header(block: &[u8; BLOCK as usize]) -> Result<Header, OvaError> {
    let recorded = parse_octal(&block[148..156])
        .ok_or_else(|| malformed("Not a TAR archive: a header checksum is not a number"))?;
    let unsigned: u64 = block
        .iter()
        .enumerate()
        .map(|(index, &byte)| {
            if (148..156).contains(&index) {
                u64::from(b' ')
            } else {
                u64::from(byte)
            }
        })
        .sum();
    let signed: i64 = block
        .iter()
        .enumerate()
        .map(|(index, &byte)| {
            if (148..156).contains(&index) {
                i64::from(b' ')
            } else {
                i64::from(byte as i8)
            }
        })
        .sum();
    if recorded != unsigned && i64::try_from(recorded).ok() != Some(signed) {
        return Err(malformed(
            "Not a TAR archive, or a damaged one: a header checksum does not match",
        ));
    }
    let size = parse_octal(&block[124..136])
        .ok_or_else(|| malformed("A header's size is not a number"))?;
    let mut name = c_string(&block[0..100])?;
    // POSIX ustar: a prefix holds the start of a long name. GNU tar uses those bytes for other things.
    if &block[257..263] == b"ustar\0" {
        let prefix = c_string(&block[345..500])?;
        if !prefix.is_empty() {
            name = format!("{prefix}/{name}");
        }
    }
    Ok(Header {
        name,
        size,
        kind: block[156],
    })
}

/// PAX records: `<length> <key>=<value>\n`, each one counting its own length.
fn parse_pax(bytes: &[u8]) -> Result<(Option<String>, Option<u64>), OvaError> {
    let invalid = || malformed("A PAX extended header is damaged");
    let (mut path, mut size) = (None, None);
    let mut rest = bytes;
    while !rest.is_empty() {
        if rest.iter().all(|&byte| byte == 0) {
            break;
        }
        let space = rest
            .iter()
            .position(|&byte| byte == b' ')
            .ok_or_else(invalid)?;
        let length: usize = std::str::from_utf8(&rest[..space])
            .ok()
            .and_then(|text| text.parse().ok())
            .ok_or_else(invalid)?;
        if length <= space + 1 || length > rest.len() || rest[length - 1] != b'\n' {
            return Err(invalid());
        }
        let record = &rest[space + 1..length - 1];
        let equals = record
            .iter()
            .position(|&byte| byte == b'=')
            .ok_or_else(invalid)?;
        let value = &record[equals + 1..];
        match &record[..equals] {
            b"path" => {
                path = Some(String::from_utf8(value.to_vec()).map_err(|_| {
                    error(OvaErrorKind::UnsafeEntry, "A file name is not valid UTF-8")
                })?);
            }
            b"size" => {
                size = Some(
                    std::str::from_utf8(value)
                        .ok()
                        .and_then(|text| text.parse().ok())
                        .ok_or_else(invalid)?,
                );
            }
            b"linkpath" => {
                return Err(error(
                    OvaErrorKind::UnsafeEntry,
                    "The archive contains a link, which an OVA never does",
                ));
            }
            _ => {}
        }
        rest = &rest[length..];
    }
    Ok((path, size))
}

/// The name an entry may have: a plain file name. An OVA is flat, so a directory is not supported, and anything
/// that could reach outside the archive is unsafe, whether or not anything ever extracts it.
fn checked_name(raw: &str) -> Result<String, OvaError> {
    let unsafe_name = |why: &str| {
        error(
            OvaErrorKind::UnsafeEntry,
            format!("The archive has an unsafe file name ({why}): {:?}", raw),
        )
    };
    if raw.chars().any(char::is_control) {
        return Err(unsafe_name("control characters"));
    }
    let name = raw.strip_prefix("./").unwrap_or(raw);
    if name.is_empty() {
        return Err(unsafe_name("empty"));
    }
    if name.starts_with('/') || name.starts_with('\\') {
        return Err(unsafe_name("absolute path"));
    }
    if name.contains(':') {
        return Err(unsafe_name("drive letter or stream name"));
    }
    if name
        .split(['/', '\\'])
        .any(|part| part == ".." || part == ".")
    {
        return Err(unsafe_name("parent or current directory reference"));
    }
    if name.contains('/') || name.contains('\\') {
        return Err(error(
            OvaErrorKind::Unsupported,
            format!(
                "The archive has a file in a subdirectory ({name}). An OVA keeps every file at its top level"
            ),
        ));
    }
    Ok(name.to_owned())
}

/// Every regular file in the archive, by reading each header and seeking over the data.
fn walk<R: Read + Seek>(reader: &mut R, length: u64) -> Result<Vec<OvaEntry>, OvaError> {
    let mut entries: Vec<OvaEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut position = 0u64;
    let mut long_name: Option<String> = None;
    let mut pax: (Option<String>, Option<u64>) = (None, None);
    let mut block = [0u8; BLOCK as usize];
    loop {
        // The file ends exactly where the previous entry's padding ends, with no end marker. Some exporters write
        // OVAs this way, and every entry has been read whole, so this is a complete archive. Only that exact
        // boundary counts: anything shorter than a header, or an extended header with no entry after it, does not.
        if position == length && !entries.is_empty() {
            if long_name.is_some() || pax != (None, None) {
                return Err(error(
                    OvaErrorKind::Truncated,
                    "The archive ends after an extended header, before the file it describes: it is truncated",
                ));
            }
            break;
        }
        if position
            .checked_add(BLOCK)
            .is_none_or(|header_end| header_end > length)
        {
            return Err(error(
                OvaErrorKind::Truncated,
                "The archive ends in the middle of a header: the file is truncated",
            ));
        }
        reader
            .seek(SeekFrom::Start(position))
            .map_err(|source| io_error(&source))?;
        reader
            .read_exact(&mut block)
            .map_err(|source| io_error(&source))?;
        if block.iter().all(|&byte| byte == 0) {
            // The end: a zero block, normally two. Whatever follows must be zeros too.
            if position + 2 * BLOCK <= length {
                reader
                    .read_exact(&mut block)
                    .map_err(|source| io_error(&source))?;
                if block.iter().any(|&byte| byte != 0) {
                    return Err(malformed(
                        "The archive has data after an empty header: it is damaged",
                    ));
                }
            }
            if long_name.is_some() || pax != (None, None) {
                return Err(malformed("The archive ends inside an extended header"));
            }
            break;
        }
        let header = parse_header(&block)?;
        let data_offset = position + BLOCK;
        let size = match header.kind {
            b'0' | b'\0' | b'7' => pax.1.take().unwrap_or(header.size),
            _ => header.size,
        };
        let padded = size
            .checked_add(BLOCK - 1)
            .map(|value| value / BLOCK * BLOCK)
            .ok_or_else(|| malformed("A size is too large"))?;
        let next = data_offset
            .checked_add(padded)
            .ok_or_else(|| malformed("A size is too large"))?;
        // `next` is at least `data_offset + size`, so it cannot overflow where this would.
        if data_offset + size > length {
            return Err(error(
                OvaErrorKind::Truncated,
                "The archive ends in the middle of a file: it is truncated",
            ));
        }
        if next > length {
            return Err(error(
                OvaErrorKind::Truncated,
                "The archive ends in the padding after a file: it is truncated",
            ));
        }
        match header.kind {
            b'0' | b'\0' | b'7' => {
                let raw = pax
                    .0
                    .take()
                    .or_else(|| long_name.take())
                    .unwrap_or(header.name);
                if raw.ends_with('/') {
                    return Err(error(
                        OvaErrorKind::Unsupported,
                        "The archive contains a directory. An OVA keeps every file at its top level",
                    ));
                }
                let name = checked_name(&raw)?;
                if !seen.insert(name.to_lowercase()) {
                    return Err(malformed(format!(
                        "The archive contains {name} more than once"
                    )));
                }
                if entries.len() >= MAX_ENTRIES {
                    return Err(error(
                        OvaErrorKind::Unsupported,
                        format!("The archive has more than {MAX_ENTRIES} files"),
                    ));
                }
                entries.push(OvaEntry {
                    name,
                    data_offset,
                    size_bytes: size,
                });
            }
            b'x' | b'g' | b'L' => {
                if size > MAX_METADATA_BYTES {
                    return Err(malformed("An extended header is unreasonably large"));
                }
                let mut bytes = vec![0; size as usize];
                reader
                    .read_exact(&mut bytes)
                    .map_err(|source| io_error(&source))?;
                match header.kind {
                    b'x' => pax = parse_pax(&bytes)?,
                    // Global PAX records apply to every later entry. A path or size there makes no sense.
                    b'g' => {
                        if parse_pax(&bytes)? != (None, None) {
                            return Err(error(
                                OvaErrorKind::Unsupported,
                                "The archive has a global PAX header that sets a path or size",
                            ));
                        }
                    }
                    _ => {
                        let end = bytes
                            .iter()
                            .position(|&byte| byte == 0)
                            .unwrap_or(bytes.len());
                        long_name =
                            Some(String::from_utf8(bytes[..end].to_vec()).map_err(|_| {
                                error(OvaErrorKind::UnsafeEntry, "A file name is not valid UTF-8")
                            })?);
                    }
                }
            }
            b'1' | b'2' | b'K' => {
                return Err(error(
                    OvaErrorKind::UnsafeEntry,
                    "The archive contains a link, which an OVA never does",
                ));
            }
            b'5' => {
                return Err(error(
                    OvaErrorKind::Unsupported,
                    "The archive contains a directory. An OVA keeps every file at its top level",
                ));
            }
            other => {
                return Err(error(
                    OvaErrorKind::Unsupported,
                    format!(
                        "The archive contains an entry of an unsupported type ({:?})",
                        other as char
                    ),
                ));
            }
        }
        position = next;
    }
    Ok(entries)
}

// The descriptor.

struct Descriptor {
    version: String,
    virtual_systems: Vec<String>,
    references: Vec<String>,
    virtualbox_machine: bool,
}

fn invalid_descriptor(message: impl Into<String>) -> OvaError {
    error(OvaErrorKind::InvalidDescriptor, message)
}

fn local_name(name: &[u8]) -> &[u8] {
    name.iter()
        .rposition(|&byte| byte == b':')
        .map_or(name, |index| &name[index + 1..])
}

fn attribute(element: &BytesStart<'_>, local: &[u8]) -> Result<Option<String>, OvaError> {
    for attribute in element.attributes() {
        let attribute =
            attribute.map_err(|source| invalid_descriptor(format!("Invalid XML: {source}")))?;
        if local_name(attribute.key.as_ref()) == local
            && !attribute.key.as_ref().starts_with(b"xmlns")
        {
            let value = attribute
                .unescape_value()
                .map_err(|source| invalid_descriptor(format!("Invalid XML: {source}")))?;
            return Ok(Some(value.into_owned()));
        }
    }
    Ok(None)
}

/// The namespace an element's `xmlns` declarations give its own prefix, if it declares it.
fn declared_namespace(element: &BytesStart<'_>, prefix: Option<&[u8]>) -> Option<String> {
    element.attributes().flatten().find_map(|attribute| {
        let key = attribute.key.as_ref();
        let matches = match prefix {
            None => key == b"xmlns",
            Some(prefix) => key.strip_prefix(b"xmlns:") == Some(prefix),
        };
        matches.then(|| String::from_utf8_lossy(&attribute.value).into_owned())
    })
}

fn parse_descriptor(bytes: &[u8]) -> Result<Descriptor, OvaError> {
    let text = std::str::from_utf8(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes))
        .map_err(|_| invalid_descriptor("The OVF descriptor is not UTF-8 text"))?;
    let mut reader = quick_xml::Reader::from_str(text);
    reader.config_mut().check_end_names = true;

    let mut depth = 0usize;
    let mut elements = 0usize;
    let mut root_seen = false;
    let mut in_references = 0usize;
    let mut version: Option<String> = None;
    let mut virtual_systems = Vec::new();
    let mut references = Vec::new();
    let mut virtualbox_machine = false;
    let mut virtualbox_prefixes: Vec<Vec<u8>> = Vec::new();

    loop {
        let event = reader.read_event().map_err(|source| {
            invalid_descriptor(format!(
                "The OVF descriptor is not well-formed XML (at byte {}): {source}",
                reader.buffer_position()
            ))
        })?;
        match event {
            Event::DocType(_) => {
                return Err(invalid_descriptor(
                    "The OVF descriptor declares a document type, which is refused: it could define entities",
                ));
            }
            Event::Start(ref element) | Event::Empty(ref element) => {
                let empty = matches!(event, Event::Empty(_));
                elements += 1;
                if elements > MAX_XML_ELEMENTS {
                    return Err(invalid_descriptor(
                        "The OVF descriptor has too many elements",
                    ));
                }
                let name = element.name();
                let local = local_name(name.as_ref());
                if !root_seen {
                    root_seen = true;
                    if local != b"Envelope" {
                        return Err(invalid_descriptor(
                            "The descriptor is not an OVF document: its root is not an Envelope",
                        ));
                    }
                    let prefix = name
                        .as_ref()
                        .iter()
                        .position(|&byte| byte == b':')
                        .map(|index| &name.as_ref()[..index]);
                    let namespace = declared_namespace(element, prefix).unwrap_or_default();
                    let known = OVF_NAMESPACES.iter().position(|&known| known == namespace);
                    let Some(index) = known else {
                        return Err(invalid_descriptor(
                            "The descriptor's Envelope is not in an OVF namespace (DMTF OVF 1.x or 2.x)",
                        ));
                    };
                    version = Some(
                        attribute(element, b"version")?
                            .unwrap_or_else(|| if index == 0 { "1.0" } else { "2.0" }.to_owned()),
                    );
                    for attribute in element.attributes().flatten() {
                        if let Some(prefix) = attribute.key.as_ref().strip_prefix(b"xmlns:")
                            && attribute.value.as_ref() == VIRTUALBOX_NAMESPACE.as_bytes()
                        {
                            virtualbox_prefixes.push(prefix.to_vec());
                        }
                    }
                } else if depth == 0 {
                    return Err(invalid_descriptor(
                        "The OVF descriptor has more than one root element",
                    ));
                }
                match local {
                    b"References" if depth == 1 => {
                        if !empty {
                            in_references = depth + 1;
                        }
                    }
                    b"File" if in_references != 0 && depth == in_references => {
                        let href = attribute(element, b"href")?.ok_or_else(|| {
                            invalid_descriptor("A File in the descriptor's References has no href")
                        })?;
                        references.push(href);
                    }
                    b"VirtualSystem" => {
                        virtual_systems.push(attribute(element, b"id")?.unwrap_or_default());
                    }
                    b"Machine" => {
                        if let Some(index) = name.as_ref().iter().position(|&byte| byte == b':')
                            && virtualbox_prefixes
                                .iter()
                                .any(|prefix| prefix == &name.as_ref()[..index])
                        {
                            virtualbox_machine = true;
                        }
                    }
                    _ => {}
                }
                if !empty {
                    depth += 1;
                    if depth > MAX_XML_DEPTH {
                        return Err(invalid_descriptor(
                            "The OVF descriptor is nested too deeply",
                        ));
                    }
                }
            }
            Event::End(_) => {
                depth = depth.saturating_sub(1);
                if in_references != 0 && depth < in_references {
                    in_references = 0;
                }
            }
            Event::Text(ref text) if depth == 0 && root_seen => {
                let bytes: &[u8] = text.as_ref();
                if !bytes.iter().all(u8::is_ascii_whitespace) {
                    return Err(invalid_descriptor(
                        "The OVF descriptor has text after its root element",
                    ));
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !root_seen {
        return Err(invalid_descriptor("The OVF descriptor is empty"));
    }
    if depth != 0 {
        return Err(invalid_descriptor(
            "The OVF descriptor ends before its root element is closed",
        ));
    }
    if virtual_systems.is_empty() {
        return Err(invalid_descriptor(
            "The OVF descriptor describes no virtual system, so there is nothing to import",
        ));
    }
    let mut unique = HashSet::new();
    if references.iter().any(|href| !unique.insert(href.as_str())) {
        return Err(invalid_descriptor(
            "The OVF descriptor names one file twice",
        ));
    }
    Ok(Descriptor {
        version: version.unwrap_or_default(),
        virtual_systems,
        references,
        virtualbox_machine,
    })
}

// The manifest.

/// Lines of `SHA256(name)= digest`, as VirtualBox writes them; also SHA1 and SHA512.
fn parse_manifest(bytes: &[u8]) -> Result<Vec<ManifestDigest>, OvaError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| error(OvaErrorKind::InvalidManifest, "The manifest is not text"))?;
    let mut digests = Vec::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let invalid = || {
            error(
                OvaErrorKind::InvalidManifest,
                format!("The manifest has a line that is not a digest: {line:?}"),
            )
        };
        let (left, digest) = line.split_once('=').ok_or_else(invalid)?;
        let (algorithm, rest) = left.split_once('(').ok_or_else(invalid)?;
        let file = rest.trim_end().strip_suffix(')').ok_or_else(invalid)?;
        let algorithm = algorithm.trim().to_ascii_uppercase();
        let digest = digest.trim().to_ascii_lowercase();
        let expected_length = match algorithm.as_str() {
            "SHA1" => 40,
            "SHA256" => 64,
            "SHA512" => 128,
            _ => {
                return Err(error(
                    OvaErrorKind::InvalidManifest,
                    format!("The manifest uses an unknown digest algorithm: {algorithm}"),
                ));
            }
        };
        if digest.len() != expected_length || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(invalid());
        }
        digests.push(ManifestDigest {
            file: checked_name(file)?,
            algorithm,
            digest,
        });
    }
    Ok(digests)
}

// The hashing pass.

/// The whole file's size and SHA-256, read once, in order, with bounded memory. On the way, every part with a
/// SHA-256 in the manifest is hashed too and compared with it. The file must still be exactly what was inspected.
pub fn hash(
    path: &Path,
    inspection: &OvaInspection,
    cancel: &CancelFlag,
    progress: &dyn Fn(u64, u64),
) -> Result<(u64, String), OvaError> {
    let (mut file, length) = open_regular(path)?;
    if length != inspection.size_bytes {
        return Err(error(
            OvaErrorKind::Changed,
            "The file changed size after it was checked. Make sure nothing writes to it, and try again",
        ));
    }
    hash_reader(&mut file, inspection, cancel, progress)
}

/// [`hash`], on any reader.
pub fn hash_reader<R: Read>(
    reader: &mut R,
    inspection: &OvaInspection,
    cancel: &CancelFlag,
    progress: &dyn Fn(u64, u64),
) -> Result<(u64, String), OvaError> {
    struct Part<'a> {
        start: u64,
        end: u64,
        expected: &'a ManifestDigest,
        hasher: Sha256,
    }
    let mut parts: Vec<Part<'_>> = inspection
        .checked_digests()
        .filter_map(|digest| {
            let entry = inspection
                .entries
                .iter()
                .find(|entry| entry.name == digest.file)?;
            Some(Part {
                start: entry.data_offset,
                end: entry.data_offset + entry.size_bytes,
                expected: digest,
                hasher: Sha256::new(),
            })
        })
        .collect();
    let total = inspection.size_bytes;
    let mut whole = Sha256::new();
    let mut buffer = vec![0u8; READ_BUFFER_BYTES];
    let mut position = 0u64;
    loop {
        if cancel.is_cancelled() {
            return Err(error(OvaErrorKind::Cancelled, "Cancelled"));
        }
        let count = match reader.read(&mut buffer) {
            Ok(count) => count,
            Err(source) if source.kind() == io::ErrorKind::Interrupted => continue,
            Err(source) => return Err(io_error(&source)),
        };
        if count == 0 {
            break;
        }
        let chunk = &buffer[..count];
        whole.update(chunk);
        let chunk_end = position + count as u64;
        for part in &mut parts {
            let start = part.start.max(position);
            let end = part.end.min(chunk_end);
            if start < end {
                part.hasher
                    .update(&chunk[(start - position) as usize..(end - position) as usize]);
            }
        }
        position = chunk_end;
        progress(position.min(total), total);
    }
    if position != total {
        return Err(error(
            OvaErrorKind::Changed,
            "The file changed while it was read. Make sure nothing writes to it, and try again",
        ));
    }
    for part in parts {
        let actual = crate::packaging::hex(&part.hasher.finalize());
        if actual != part.expected.digest {
            return Err(error(
                OvaErrorKind::ManifestMismatch,
                format!(
                    "{} does not match the SHA-256 its manifest gives: the OVA is damaged",
                    part.expected.file
                ),
            ));
        }
    }
    Ok((position, crate::packaging::hex(&whole.finalize())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn octal_and_base_256_sizes() {
        assert_eq!(parse_octal(b"00000001750\0"), Some(1000));
        assert_eq!(parse_octal(b"        \0\0\0\0"), Some(0));
        assert_eq!(parse_octal(b"0000000175x\0"), None);
        let mut big = [0u8; 12];
        big[0] = 0x80;
        big[11] = 0x02;
        big[10] = 0x01;
        assert_eq!(parse_octal(&big), Some(0x0102));
    }

    #[test]
    fn names_must_be_plain_file_names() {
        assert_eq!(checked_name("disk.vmdk").unwrap(), "disk.vmdk");
        assert_eq!(checked_name("./disk.vmdk").unwrap(), "disk.vmdk");
        for unsafe_name in [
            "../x.vmdk",
            "/etc/passwd",
            "C:x",
            "a\\..\\b",
            "\u{1}x",
            "",
            "..",
        ] {
            assert_eq!(
                checked_name(unsafe_name).unwrap_err().kind,
                OvaErrorKind::UnsafeEntry,
                "{unsafe_name:?}"
            );
        }
        assert_eq!(
            checked_name("disks/disk.vmdk").unwrap_err().kind,
            OvaErrorKind::Unsupported
        );
    }

    #[test]
    fn manifests_as_virtualbox_writes_them() {
        let digests = parse_manifest(
            format!(
                "SHA256(a.ovf)= {}\nSHA1 (b.vmdk) = {}\n",
                "A".repeat(64),
                "0".repeat(40)
            )
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(digests[0].algorithm, "SHA256");
        assert_eq!(digests[0].digest, "a".repeat(64));
        assert_eq!(digests[1].file, "b.vmdk");
        assert!(parse_manifest(b"MD5(a.ovf)= 00").is_err());
        assert!(parse_manifest(b"SHA256(../a.ovf)= 00").is_err());
    }
}
