use calamine::{open_workbook_auto, Reader};
use quick_xml::{events::Event, Reader as XmlReader};
use savvy_domain::{DocumentKind, SourceLocator};
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};
use thiserror::Error;
use zip::ZipArchive;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedSection {
    pub text: String,
    pub locator: SourceLocator,
}

#[derive(Debug, Error)]
pub enum ExtractionError {
    #[error("could not read {path}: {message}")]
    Read { path: PathBuf, message: String },
    #[error("document is encrypted or malformed: {0}")]
    Malformed(PathBuf),
    #[error("document contains no extractable text: {0}")]
    Empty(PathBuf),
}

pub fn extract_document(
    path: &Path,
    kind: DocumentKind,
) -> Result<Vec<ExtractedSection>, ExtractionError> {
    let sections = match kind {
        DocumentKind::Text | DocumentKind::Markdown => extract_plain_text(path)?,
        DocumentKind::Csv => extract_csv(path)?,
        DocumentKind::Xlsx => extract_xlsx(path)?,
        DocumentKind::Pdf => extract_pdf(path)?,
        DocumentKind::Docx => extract_docx(path)?,
        DocumentKind::Pptx => extract_pptx(path)?,
        DocumentKind::Epub => extract_epub(path)?,
    };
    let sections: Vec<_> = sections
        .into_iter()
        .filter(|section| !section.text.trim().is_empty())
        .collect();
    if sections.is_empty() {
        return Err(ExtractionError::Empty(path.to_path_buf()));
    }
    Ok(sections)
}

fn extract_plain_text(path: &Path) -> Result<Vec<ExtractedSection>, ExtractionError> {
    let text = fs::read_to_string(path).map_err(|error| read_error(path, error))?;
    let line_count = text.lines().count().max(1) as u32;
    let mut locator = SourceLocator::document("Document");
    locator.line_start = Some(1);
    locator.line_end = Some(line_count);
    Ok(vec![ExtractedSection { text, locator }])
}

fn extract_csv(path: &Path) -> Result<Vec<ExtractedSection>, ExtractionError> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .from_path(path)
        .map_err(|error| ExtractionError::Read {
            path: path.to_path_buf(),
            message: error.to_string(),
        })?;
    let headers = reader
        .headers()
        .map_err(|error| ExtractionError::Read {
            path: path.to_path_buf(),
            message: error.to_string(),
        })?
        .iter()
        .collect::<Vec<_>>()
        .join(" | ");
    let mut sections = Vec::new();
    let mut rows = Vec::new();
    let mut row_start = 2_u32;
    for (index, record) in reader.records().enumerate() {
        let record = record.map_err(|error| ExtractionError::Read {
            path: path.to_path_buf(),
            message: error.to_string(),
        })?;
        rows.push(record.iter().collect::<Vec<_>>().join(" | "));
        if rows.len() == 50 {
            sections.push(tabular_section(
                "CSV",
                &headers,
                &rows,
                row_start,
                index as u32 + 2,
            ));
            row_start = index as u32 + 3;
            rows.clear();
        }
    }
    if !rows.is_empty() || sections.is_empty() {
        let row_end = row_start + rows.len().saturating_sub(1) as u32;
        sections.push(tabular_section("CSV", &headers, &rows, row_start, row_end));
    }
    Ok(sections)
}

fn tabular_section(
    sheet: &str,
    headers: &str,
    rows: &[String],
    row_start: u32,
    row_end: u32,
) -> ExtractedSection {
    let mut locator = SourceLocator::document(format!("{sheet}, rows {row_start}-{row_end}"));
    locator.sheet = Some(sheet.to_owned());
    locator.row_start = Some(row_start);
    locator.row_end = Some(row_end);
    ExtractedSection {
        text: std::iter::once(headers)
            .chain(rows.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        locator,
    }
}

fn extract_xlsx(path: &Path) -> Result<Vec<ExtractedSection>, ExtractionError> {
    let mut workbook = open_workbook_auto(path).map_err(|error| ExtractionError::Read {
        path: path.to_path_buf(),
        message: error.to_string(),
    })?;
    let mut sections = Vec::new();
    for sheet_name in workbook.sheet_names().to_vec() {
        let range =
            workbook
                .worksheet_range(&sheet_name)
                .map_err(|error| ExtractionError::Read {
                    path: path.to_path_buf(),
                    message: error.to_string(),
                })?;
        for (batch, rows) in range.rows().collect::<Vec<_>>().chunks(50).enumerate() {
            let row_start = (batch * 50 + 1) as u32;
            let rendered: Vec<String> = rows
                .iter()
                .map(|row| {
                    row.iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join(" | ")
                })
                .collect();
            sections.push(tabular_section(
                &sheet_name,
                "",
                &rendered,
                row_start,
                row_start + rendered.len().saturating_sub(1) as u32,
            ));
        }
    }
    Ok(sections)
}

fn extract_pdf(path: &Path) -> Result<Vec<ExtractedSection>, ExtractionError> {
    let document = lopdf::Document::load(path).map_err(|error| ExtractionError::Read {
        path: path.to_path_buf(),
        message: error.to_string(),
    })?;
    let mut sections = Vec::new();
    for page in document.get_pages().keys().copied() {
        let text = document.extract_text(&[page]).unwrap_or_default();
        if text.trim().is_empty() {
            continue;
        }
        let mut locator = SourceLocator::document(format!("Page {page}"));
        locator.page = Some(page);
        sections.push(ExtractedSection { text, locator });
    }
    Ok(sections)
}

fn extract_docx(path: &Path) -> Result<Vec<ExtractedSection>, ExtractionError> {
    let mut archive = open_zip(path)?;
    let xml = read_zip_entry(path, &mut archive, "word/document.xml")?;
    Ok(vec![ExtractedSection {
        text: extract_markup_text(&xml),
        locator: SourceLocator::document("Document body"),
    }])
}

fn extract_pptx(path: &Path) -> Result<Vec<ExtractedSection>, ExtractionError> {
    let mut archive = open_zip(path)?;
    let mut slides: Vec<(u32, String)> = (0..archive.len())
        .filter_map(|index| archive.name_for_index(index).map(str::to_owned))
        .filter_map(|name| slide_number(&name).map(|number| (number, name)))
        .collect();
    slides.sort_by_key(|(number, _)| *number);
    let mut sections = Vec::new();
    for (number, entry) in slides {
        let xml = read_zip_entry(path, &mut archive, &entry)?;
        let mut locator = SourceLocator::document(format!("Slide {number}"));
        locator.slide = Some(number);
        sections.push(ExtractedSection {
            text: extract_markup_text(&xml),
            locator,
        });
    }
    Ok(sections)
}

fn slide_number(name: &str) -> Option<u32> {
    let stem = name
        .strip_prefix("ppt/slides/slide")?
        .strip_suffix(".xml")?;
    stem.parse().ok()
}

fn extract_epub(path: &Path) -> Result<Vec<ExtractedSection>, ExtractionError> {
    let mut archive = open_zip(path)?;
    let mut chapters: Vec<String> = (0..archive.len())
        .filter_map(|index| archive.name_for_index(index).map(str::to_owned))
        .filter(|name| {
            let lower = name.to_ascii_lowercase();
            lower.ends_with(".xhtml") || lower.ends_with(".html") || lower.ends_with(".htm")
        })
        .collect();
    chapters.sort();
    let mut sections = Vec::new();
    for chapter in chapters {
        let markup = read_zip_entry(path, &mut archive, &chapter)?;
        let mut locator = SourceLocator::document(chapter.clone());
        locator.chapter = Some(chapter.clone());
        sections.push(ExtractedSection {
            text: extract_markup_text(&markup),
            locator,
        });
    }
    Ok(sections)
}

fn open_zip(path: &Path) -> Result<ZipArchive<File>, ExtractionError> {
    let file = File::open(path).map_err(|error| read_error(path, error))?;
    ZipArchive::new(file).map_err(|_| ExtractionError::Malformed(path.to_path_buf()))
}

fn read_zip_entry(
    path: &Path,
    archive: &mut ZipArchive<File>,
    name: &str,
) -> Result<String, ExtractionError> {
    let mut file = archive
        .by_name(name)
        .map_err(|_| ExtractionError::Malformed(path.to_path_buf()))?;
    let mut content = String::new();
    file.read_to_string(&mut content)
        .map_err(|error| read_error(path, error))?;
    Ok(content)
}

fn extract_markup_text(markup: &str) -> String {
    let mut reader = XmlReader::from_str(markup);
    reader.config_mut().trim_text(true);
    let mut pieces = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Text(text)) => {
                if let Ok(decoded) = text.decode() {
                    let value = decoded.trim();
                    if !value.is_empty() {
                        pieces.push(value.to_owned());
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    pieces.join(" ")
}

fn read_error(path: &Path, error: impl ToString) -> ExtractionError {
    ExtractionError::Read {
        path: path.to_path_buf(),
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    #[test]
    fn markdown_retains_line_locator() {
        let root = tempfile::tempdir().expect("temp directory");
        let path = root.path().join("strategy.md");
        fs::write(&path, "# Strategy\nProtect margin\nAsk why").expect("write markdown");
        let sections = extract_document(&path, DocumentKind::Markdown).expect("extract markdown");
        assert_eq!(sections[0].locator.line_start, Some(1));
        assert_eq!(sections[0].locator.line_end, Some(3));
    }

    #[test]
    fn epub_chapters_receive_chapter_locators() {
        let root = tempfile::tempdir().expect("temp directory");
        let path = root.path().join("playbook.epub");
        let file = File::create(&path).expect("create epub");
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("OEBPS/chapter-1.xhtml", SimpleFileOptions::default())
            .expect("start chapter");
        archive
            .write_all(b"<html><body><h1>Opening</h1><p>Ask about outcomes.</p></body></html>")
            .expect("write chapter");
        archive.finish().expect("finish epub");

        let sections = extract_document(&path, DocumentKind::Epub).expect("extract epub");
        assert_eq!(sections.len(), 1);
        assert_eq!(
            sections[0].locator.chapter.as_deref(),
            Some("OEBPS/chapter-1.xhtml")
        );
        assert!(sections[0].text.contains("Ask about outcomes"));
    }
}
