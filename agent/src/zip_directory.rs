//! Reads a ZIP's central directory as it is written, entry by entry.
//!
//! The `zip` crate's reader is what decompresses, but it keeps entries in a map keyed by name, so a second
//! entry with the same name simply disappears from its view. Whoever crafted such an archive can make
//! different tools see different contents. This reader exists to see what the file really says before
//! anything else looks at it: duplicates, link attributes, encryption and the number of entries, all
//! bounded before any large allocation.

use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom};

const EOCD_SIGNATURE: u32 = 0x0605_4b50;
const EOCD_SIZE: u64 = 22;
const ZIP64_LOCATOR_SIGNATURE: u32 = 0x0706_4b50;
const ZIP64_LOCATOR_SIZE: u64 = 20;
const ZIP64_EOCD_SIGNATURE: u32 = 0x0606_4b50;
const HEADER_SIGNATURE: u32 = 0x0201_4b50;
const HEADER_SIZE: usize = 46;
const MAX_COMMENT: u64 = 65_535;
const ZIP64_EXTRA_ID: u16 = 0x0001;
/// The "made by" system that gives the external attributes Unix meaning.
const HOST_UNIX: u8 = 3;

/// Why a central directory cannot be used.
#[derive(Debug)]
pub enum DirectoryError {
    /// It is not a well-formed ZIP.
    Malformed(String),
    /// It is well-formed, and larger than this agent accepts.
    TooLarge(String),
    Io(io::Error),
}

impl From<io::Error> for DirectoryError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// One entry, exactly as the central directory states it. None of it has been checked against anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawEntry {
    pub name: String,
    pub method: u16,
    pub flags: u16,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub made_by_host: u8,
    pub external_attributes: u32,
}

impl RawEntry {
    pub fn is_directory_name(&self) -> bool {
        self.name.ends_with('/')
    }

    /// The Unix file mode, when the archive was made somewhere that has one.
    pub fn unix_mode(&self) -> Option<u32> {
        (self.made_by_host == HOST_UNIX).then_some(self.external_attributes >> 16)
    }
}

/// How much of a central directory to accept. Both are checked before anything is allocated for them.
#[derive(Debug, Clone, Copy)]
pub struct DirectoryLimits {
    pub max_entries: u64,
    pub max_directory_bytes: u64,
}

fn le16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn le32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn le64(bytes: &[u8], at: usize) -> u64 {
    let mut buffer = [0u8; 8];
    buffer.copy_from_slice(&bytes[at..at + 8]);
    u64::from_le_bytes(buffer)
}

fn malformed(message: impl Into<String>) -> DirectoryError {
    DirectoryError::Malformed(message.into())
}

/// Where the directory is. Scans back from the end, since a comment may follow the end record, and only
/// accepts a record whose comment ends exactly at the end of the file.
fn locate(file: &mut File, length: u64) -> Result<(u64, u64, u64), DirectoryError> {
    if length < EOCD_SIZE {
        return Err(malformed("The file is too short to be a ZIP"));
    }
    let window = (EOCD_SIZE + MAX_COMMENT).min(length);
    let start = length - window;
    file.seek(SeekFrom::Start(start))?;
    let mut tail = vec![0u8; window as usize];
    file.read_exact(&mut tail)?;

    let mut found = None;
    for at in (0..=tail.len() - EOCD_SIZE as usize).rev() {
        if le32(&tail, at) == EOCD_SIGNATURE {
            let comment = u64::from(le16(&tail, at + 20));
            if start + at as u64 + EOCD_SIZE + comment == length {
                found = Some(at);
                break;
            }
        }
    }
    let at = found.ok_or_else(|| malformed("The end of the central directory is missing"))?;
    let eocd_position = start + at as u64;
    if le16(&tail, at + 4) != 0 || le16(&tail, at + 6) != 0 {
        return Err(malformed(
            "Archives split across several disks are not supported",
        ));
    }
    let entries = u64::from(le16(&tail, at + 10));
    let size = u64::from(le32(&tail, at + 12));
    let offset = u64::from(le32(&tail, at + 16));

    if entries == 0xFFFF || size == 0xFFFF_FFFF || offset == 0xFFFF_FFFF {
        return locate_zip64(file, eocd_position);
    }
    if offset.checked_add(size) != Some(eocd_position) {
        return Err(malformed(
            "The central directory is not where the archive says",
        ));
    }
    Ok((entries, size, offset))
}

fn locate_zip64(file: &mut File, eocd_position: u64) -> Result<(u64, u64, u64), DirectoryError> {
    let locator_position = eocd_position
        .checked_sub(ZIP64_LOCATOR_SIZE)
        .ok_or_else(|| malformed("The ZIP64 locator is missing"))?;
    file.seek(SeekFrom::Start(locator_position))?;
    let mut locator = [0u8; ZIP64_LOCATOR_SIZE as usize];
    file.read_exact(&mut locator)?;
    if le32(&locator, 0) != ZIP64_LOCATOR_SIGNATURE {
        return Err(malformed("The ZIP64 locator is missing"));
    }
    if le32(&locator, 4) != 0 || le32(&locator, 16) > 1 {
        return Err(malformed(
            "Archives split across several disks are not supported",
        ));
    }
    let record_position = le64(&locator, 8);
    file.seek(SeekFrom::Start(record_position))?;
    let mut record = [0u8; 56];
    file.read_exact(&mut record)
        .map_err(|_| malformed("The ZIP64 end record is truncated"))?;
    if le32(&record, 0) != ZIP64_EOCD_SIGNATURE {
        return Err(malformed("The ZIP64 end record is missing"));
    }
    if le32(&record, 16) != 0 || le32(&record, 20) != 0 {
        return Err(malformed(
            "Archives split across several disks are not supported",
        ));
    }
    let entries = le64(&record, 32);
    if entries != le64(&record, 24) {
        return Err(malformed("The ZIP64 end record contradicts itself"));
    }
    let size = le64(&record, 40);
    let offset = le64(&record, 48);
    if offset.checked_add(size) != Some(record_position) {
        return Err(malformed(
            "The central directory is not where the archive says",
        ));
    }
    Ok((entries, size, offset))
}

/// Takes real sizes from the ZIP64 extra field, for the values the fixed header marks as too large.
fn apply_zip64_extra(
    extra: &[u8],
    compressed: &mut u64,
    uncompressed: &mut u64,
) -> Result<(), DirectoryError> {
    let mut at = 0;
    while at + 4 <= extra.len() {
        let id = le16(extra, at);
        let size = usize::from(le16(extra, at + 2));
        let end = at + 4 + size;
        if end > extra.len() {
            return Err(malformed("An extra field runs past its end"));
        }
        if id == ZIP64_EXTRA_ID {
            let mut position = at + 4;
            for value in [&mut *uncompressed, &mut *compressed] {
                if *value == 0xFFFF_FFFF {
                    if position + 8 > end {
                        return Err(malformed("The ZIP64 extra field is too short"));
                    }
                    *value = le64(extra, position);
                    position += 8;
                }
            }
        }
        at = end;
    }
    Ok(())
}

/// Every entry, in the order the central directory lists them.
pub fn read_central_directory(
    file: &mut File,
    limits: DirectoryLimits,
) -> Result<Vec<RawEntry>, DirectoryError> {
    let length = file.seek(SeekFrom::End(0))?;
    let (count, size, offset) = locate(file, length)?;
    if count > limits.max_entries {
        return Err(DirectoryError::TooLarge(format!(
            "The archive has {count} entries, and the limit is {}",
            limits.max_entries
        )));
    }
    if size > limits.max_directory_bytes {
        return Err(DirectoryError::TooLarge(format!(
            "The archive's central directory is {size} bytes, and the limit is {}",
            limits.max_directory_bytes
        )));
    }
    // A header takes at least this much, so a count this large cannot be true of a directory this small.
    if count.saturating_mul(HEADER_SIZE as u64) > size {
        return Err(malformed(
            "The central directory is smaller than its entries",
        ));
    }

    file.seek(SeekFrom::Start(offset))?;
    let mut reader = BufReader::with_capacity(1024 * 1024, Read::by_ref(file).take(size));
    let mut entries = Vec::with_capacity(count as usize);
    let mut header = [0u8; HEADER_SIZE];
    for _ in 0..count {
        reader
            .read_exact(&mut header)
            .map_err(|_| malformed("The central directory ends early"))?;
        if le32(&header, 0) != HEADER_SIGNATURE {
            return Err(malformed("A central directory header is damaged"));
        }
        let name_length = usize::from(le16(&header, 28));
        let extra_length = usize::from(le16(&header, 30));
        let comment_length = usize::from(le16(&header, 32));
        let mut name = vec![0u8; name_length];
        reader
            .read_exact(&mut name)
            .map_err(|_| malformed("The central directory ends early"))?;
        let mut extra = vec![0u8; extra_length];
        reader
            .read_exact(&mut extra)
            .map_err(|_| malformed("The central directory ends early"))?;
        io::copy(
            &mut Read::by_ref(&mut reader).take(comment_length as u64),
            &mut io::sink(),
        )?;

        let mut compressed_size = u64::from(le32(&header, 20));
        let mut uncompressed_size = u64::from(le32(&header, 24));
        apply_zip64_extra(&extra, &mut compressed_size, &mut uncompressed_size)?;
        let name =
            String::from_utf8(name).map_err(|_| malformed("An entry's name is not valid UTF-8"))?;
        entries.push(RawEntry {
            name,
            method: le16(&header, 10),
            flags: le16(&header, 8),
            compressed_size,
            uncompressed_size,
            made_by_host: header[5],
            external_attributes: le32(&header, 38),
        });
    }
    let mut rest = [0u8; 1];
    if reader.read(&mut rest)? != 0 {
        return Err(malformed(
            "The central directory holds more than it declares",
        ));
    }
    Ok(entries)
}
