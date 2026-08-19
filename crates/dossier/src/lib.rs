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
pub use extract::{extract_document, ExtractedSection, ExtractionError};

const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum DossierError {
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
    let mut documents = Vec::new();
    let mut ignored = Vec::new();

    for entry in WalkDir::new(&canonical_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(is_visible_entry)
        .filter_map(Result::ok)
    {
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
        let content_hash = hash_file(entry.path())?;
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
            byte_size: metadata.len(),
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

fn hash_file(path: &Path) -> Result<String, DossierError> {
    let mut file = File::open(path).map_err(|source| DossierError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    let mut hasher = Sha256::new();
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
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
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
