use savvy_domain::{DocumentKind, EntityId, SourceDocument, SourceLocator};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read},
    path::{Component, Path, PathBuf},
};
use thiserror::Error;
use uuid::Uuid;
use walkdir::{DirEntry, WalkDir};

mod extract;
pub use extract::{
    extract_document, extract_verified, extraction_worker, ExtractedSection, ExtractionError,
};

const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_SCAN_BYTES: u64 = 256 * 1024 * 1024;
const MAX_DOCUMENTS: usize = 100;
const MAX_ENTRIES: usize = 2000;
const MAX_DEPTH: usize = 16;

#[derive(Debug, Error)]
pub enum DossierError {
    #[error("folder scan limit exceeded; select a smaller folder")]
    Limit,
    #[error("client folder is unavailable: {0}")]
    FolderUnavailable(PathBuf),
    #[error("document cannot be read: {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("document is larger than 100 MiB: {0}")]
    TooLarge(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanReport {
    pub documents: Vec<SourceDocument>,
    pub ignored: Vec<PathBuf>,
}

pub fn scan_folder(client_id: EntityId, root: &Path) -> Result<ScanReport, DossierError> {
    let canonical_root = root
        .canonicalize()
        .map_err(|_| DossierError::FolderUnavailable(root.to_path_buf()))?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut remaining = MAX_SCAN_BYTES;
    let mut documents = Vec::new();
    let mut ignored = Vec::new();

    for (index, entry) in WalkDir::new(&canonical_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(is_visible_entry)
        .enumerate()
    {
        let entry = entry.map_err(|error| DossierError::Read {
            path: error.path().unwrap_or(root).to_path_buf(),
            source: io::Error::other(error),
        })?;
        if index >= MAX_ENTRIES
            || entry.depth() > MAX_DEPTH
            || std::time::Instant::now() >= deadline
        {
            return Err(DossierError::Limit);
        }
        if !entry.file_type().is_file() || entry.path_is_symlink() {
            continue;
        }
        let relative_path = match entry.path().strip_prefix(&canonical_root) {
            Ok(path) if safe_relative_path(path) => path.to_path_buf(),
            _ => {
                ignored.push(entry.path().to_path_buf());
                continue;
            }
        };
        let Some(kind) = document_kind(entry.path()) else {
            ignored.push(relative_path);
            continue;
        };
        let metadata = entry.metadata().map_err(|error| DossierError::Read {
            path: entry.path().to_path_buf(),
            source: io::Error::other(error),
        })?;
        if metadata.len() > MAX_FILE_BYTES {
            return Err(DossierError::TooLarge(relative_path));
        }
        if documents.len() >= MAX_DOCUMENTS || metadata.len() > remaining {
            return Err(DossierError::Limit);
        }
        let (content_hash, byte_size) = hash_file(entry.path(), &mut remaining, deadline)?;
        documents.push(SourceDocument {
            id: stable_id(&[
                client_id.as_bytes(),
                relative_path.to_string_lossy().as_bytes(),
                content_hash.as_bytes(),
            ]),
            client_id,
            relative_path,
            kind,
            content_hash,
            byte_size,
        });
    }
    documents.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(ScanReport { documents, ignored })
}

fn is_visible_entry(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    entry
        .file_name()
        .to_str()
        .is_none_or(|name| !name.starts_with('.') && name != "node_modules")
}

fn safe_relative_path(path: &Path) -> bool {
    path.components()
        .all(|component| matches!(component, Component::Normal(_)))
}

pub fn document_kind(path: &Path) -> Option<DocumentKind> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "pdf" => Some(DocumentKind::Pdf),
        "docx" => Some(DocumentKind::Docx),
        "pptx" => Some(DocumentKind::Pptx),
        "xlsx" => Some(DocumentKind::Xlsx),
        "csv" => Some(DocumentKind::Csv),
        "md" | "mdx" => Some(DocumentKind::Markdown),
        "txt" => Some(DocumentKind::Text),
        "epub" => Some(DocumentKind::Epub),
        _ => None,
    }
}

/// Open every path component through a no-follow directory descriptor.
#[cfg(unix)]
pub fn open_verified(path: &Path) -> io::Result<File> {
    use std::os::{
        fd::{AsRawFd, FromRawFd},
        unix::ffi::OsStrExt,
    };
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    // macOS exposes its system temp root through /var -> /private/var.
    #[cfg(target_os = "macos")]
    let absolute = absolute
        .strip_prefix("/var")
        .map(|p| Path::new("/private/var").join(p))
        .unwrap_or(absolute.clone());
    let parts: Vec<_> = absolute
        .components()
        .filter(|c| !matches!(c, Component::RootDir))
        .collect();
    let mut file = File::open("/")?;
    for (index, part) in parts.iter().enumerate() {
        let Component::Normal(name) = part else {
            return Err(io::Error::other("invalid document path"));
        };
        let name = std::ffi::CString::new(name.as_bytes()).map_err(io::Error::other)?;
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | libc::O_NONBLOCK
            | if index + 1 < parts.len() {
                libc::O_DIRECTORY
            } else {
                0
            };
        // Each lookup is relative to the already-open parent, never a re-resolved path.
        let descriptor = unsafe { libc::openat(file.as_raw_fd(), name.as_ptr(), flags) };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        file = unsafe { File::from_raw_fd(descriptor) };
    }
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("document must be a regular file"));
    }
    Ok(file)
}
#[cfg(not(unix))]
pub fn open_verified(_path: &Path) -> io::Result<File> {
    Err(io::Error::other(
        "verified document opening requires a supported platform",
    ))
}

fn hash_file(
    path: &Path,
    remaining: &mut u64,
    deadline: std::time::Instant,
) -> Result<(String, u64), DossierError> {
    let mut file = open_verified(path).map_err(|source| DossierError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    let mut hasher = Sha256::new();
    let mut total = 0;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|source| DossierError::Read {
                path: path.to_path_buf(),
                source,
            })?;
        if read == 0 {
            break;
        }
        if std::time::Instant::now() >= deadline || read as u64 > *remaining {
            return Err(DossierError::Limit);
        }
        *remaining -= read as u64;
        total += read as u64;
        if total > MAX_FILE_BYTES {
            return Err(DossierError::TooLarge(path.into()));
        }
        hasher.update(&buffer[..read]);
    }
    Ok((hex::encode(hasher.finalize()), total))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextChunk {
    pub id: EntityId,
    pub text: String,
    pub locator: SourceLocator,
}

pub fn chunk_text(
    document_id: EntityId,
    text: &str,
    locator: SourceLocator,
    size: usize,
    overlap: usize,
) -> Vec<TextChunk> {
    assert!(size > 0, "chunk size must be non-zero");
    assert!(overlap < size, "overlap must be smaller than chunk size");
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() {
        return Vec::new();
    }

    let mut chunks = Vec::new();
    let mut start = 0;
    while start < words.len() {
        let end = (start + size).min(words.len());
        let chunk = words[start..end].join(" ");
        let locator_json = serde_json::to_vec(&locator).expect("source locator serializes");
        chunks.push(TextChunk {
            id: stable_id(&[document_id.as_bytes(), &locator_json, chunk.as_bytes()]),
            text: chunk,
            locator: locator.clone(),
        });
        if end == words.len() {
            break;
        }
        start = end - overlap;
    }
    chunks
}

fn stable_id(parts: &[&[u8]]) -> Uuid {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part);
    }
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn scans_only_supported_visible_documents() {
        let root = tempfile::tempdir().expect("temp directory");
        fs::write(root.path().join("brief.md"), "margin and timeline").expect("write markdown");
        fs::write(root.path().join("ignore.exe"), "no").expect("write ignored");
        fs::write(root.path().join(".secret.txt"), "no").expect("write hidden");

        let report = scan_folder(Uuid::new_v4(), root.path()).expect("scan dossier");
        assert_eq!(report.documents.len(), 1);
        assert_eq!(report.documents[0].relative_path, PathBuf::from("brief.md"));
        assert_eq!(report.ignored, vec![PathBuf::from("ignore.exe")]);
    }

    #[test]
    fn folder_limits_fail_instead_of_returning_a_partial_scan() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..=MAX_DOCUMENTS {
            fs::write(root.path().join(format!("{index}.txt")), "text").unwrap();
        }
        assert!(matches!(
            scan_folder(Uuid::nil(), root.path()),
            Err(DossierError::Limit)
        ));
        let nested = tempfile::tempdir().unwrap();
        let mut path = nested.path().to_path_buf();
        for _ in 0..=MAX_DEPTH {
            path.push("nested");
        }
        fs::create_dir_all(&path).unwrap();
        assert!(matches!(
            scan_folder(Uuid::nil(), nested.path()),
            Err(DossierError::Limit)
        ));
    }

    #[test]
    fn chunks_with_stable_overlap() {
        let chunks = chunk_text(
            Uuid::nil(),
            "one two three four five six seven",
            SourceLocator::document("notes"),
            4,
            1,
        );
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].text, "one two three four");
        assert_eq!(chunks[1].text, "four five six seven");
    }

    #[test]
    fn source_identifiers_are_stable() {
        let root = tempfile::tempdir().expect("temp directory");
        fs::write(root.path().join("notes.md"), "same source").expect("write markdown");
        let scope = Uuid::new_v4();
        let first = scan_folder(scope, root.path()).expect("first scan");
        let second = scan_folder(scope, root.path()).expect("second scan");
        assert_eq!(first.documents[0].id, second.documents[0].id);

        let locator = SourceLocator::document("notes");
        let first = chunk_text(first.documents[0].id, "same words", locator.clone(), 10, 1);
        let second = chunk_text(second.documents[0].id, "same words", locator, 10, 1);
        assert_eq!(first[0].id, second[0].id);
    }
}

#[cfg(all(test, unix))]
mod security_tests {
    use super::*;
    #[test]
    fn unreadable_subtree_fails_the_whole_scan() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let blocked = root.path().join("blocked");
        std::fs::create_dir(&blocked).unwrap();
        std::fs::write(root.path().join("good.md"), "complete").unwrap();
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o0)).unwrap();
        let result = scan_folder(Uuid::nil(), root.path());
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o700)).unwrap();
        // Root can bypass permission bits; ordinary desktop users cannot.
        if unsafe { libc::geteuid() } != 0 {
            assert!(matches!(result, Err(DossierError::Read { .. })));
        }
    }

    #[test]
    fn rejects_symlinks_and_document_replacement() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("notes.md");
        std::fs::write(&path, "original").unwrap();
        let scanned = scan_folder(Uuid::nil(), root.path()).unwrap();
        std::fs::write(&path, "replacement").unwrap();
        assert!(extract_verified(
            &path,
            DocumentKind::Markdown,
            Some(&scanned.documents[0].content_hash)
        )
        .is_err());
        let alias = root.path().join("alias.md");
        std::os::unix::fs::symlink(&path, &alias).unwrap();
        assert!(open_verified(&alias).is_err());
        let directory_alias = root.path().join("linked");
        std::os::unix::fs::symlink(root.path(), &directory_alias).unwrap();
        assert!(open_verified(&directory_alias.join("notes.md")).is_err());
    }
}
