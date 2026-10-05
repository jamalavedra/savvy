//! Exercise the same parent/child parser boundary used by the native app.
fn main() {
    if std::env::args().nth(1).as_deref() == Some("--savvy-extract")
        && std::env::var_os("SAVVY_TEST_STALLED_EXTRACTOR").is_some()
    {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
    if let Some(code) = savvy_dossier::extraction_worker() {
        std::process::exit(code);
    }
    let path = std::path::PathBuf::from(std::env::args_os().nth(1).expect("document path"));
    let kind = savvy_dossier::document_kind(&path).expect("supported document");
    match savvy_dossier::extract_document(&path, kind) {
        Ok(sections) => println!("{} sections extracted", sections.len()),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
