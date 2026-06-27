//! Document ingestion: text extraction (PDF, DOCX, TXT) and PDF page rendering.
//!
//! PDF page rendering / per-page text use the `poppler` CLI tools (`pdftoppm`,
//! `pdftotext`, `pdfinfo`). macOS GUI apps launched from Finder get a minimal
//! PATH that excludes Homebrew, so we resolve those binaries by probing known
//! install locations as well as PATH (see `poppler_bin`).

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Render at most this many PDF pages (safety guard against runaway documents).
pub const MAX_PAGES: usize = 100;

// ---- poppler binary resolution ----

/// Locate a poppler binary (`pdftoppm`, `pdftotext`, `pdfinfo`). Probes common
/// install dirs first, then falls back to the bare name (PATH lookup).
pub fn poppler_bin(name: &str) -> Option<PathBuf> {
    let candidates = [
        "/opt/homebrew/bin",  // Apple Silicon Homebrew
        "/usr/local/bin",     // Intel Homebrew / manual installs
        "/opt/local/bin",     // MacPorts
        "/usr/bin",
    ];
    for dir in candidates {
        let p = Path::new(dir).join(name);
        if p.exists() {
            return Some(p);
        }
    }
    // Last resort: trust PATH (works in dev shells).
    if Command::new(name).arg("-h").output().is_ok() {
        return Some(PathBuf::from(name));
    }
    None
}

/// True if poppler's rendering/text tools are available.
pub fn has_poppler() -> bool {
    poppler_bin("pdftoppm").is_some() && poppler_bin("pdftotext").is_some()
}

// ---- text extraction ----

pub fn extract_pdf_text(path: &Path) -> Result<String, String> {
    pdf_extract::extract_text(path).map_err(|e| format!("PDF extraction failed: {e}"))
}

/// Extract body text from a DOCX file by reading word/document.xml from the ZIP.
pub fn extract_docx_text(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Not a valid DOCX: {e}"))?;
    let xml = {
        let mut entry = archive
            .by_name("word/document.xml")
            .map_err(|_| "word/document.xml not found in archive".to_string())?;
        let mut s = String::new();
        std::io::Read::read_to_string(&mut entry, &mut s).map_err(|e| e.to_string())?;
        s
    };

    // Walk XML events, collecting <w:t> text and inserting paragraph breaks on </w:p>.
    use quick_xml::events::Event;
    use quick_xml::Reader;
    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(false);
    let mut buf = Vec::new();
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_t = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                if e.local_name().as_ref() == b"t" {
                    in_t = true;
                }
            }
            Ok(Event::End(ref e)) => {
                let name = e.local_name();
                if name.as_ref() == b"t" {
                    in_t = false;
                } else if name.as_ref() == b"p" {
                    let para = current.trim().to_string();
                    if !para.is_empty() {
                        paragraphs.push(para);
                    }
                    current.clear();
                }
            }
            Ok(Event::Text(e)) => {
                if in_t {
                    if let Ok(text) = e.unescape() {
                        current.push_str(&text);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    Ok(paragraphs.join("\n\n"))
}

/// Dispatcher: choose extraction method by file extension.
pub fn extract_text(path: &Path) -> Result<String, String> {
    match ext_of(path).as_str() {
        "pdf" => extract_pdf_text(path),
        "docx" => extract_docx_text(path),
        "doc" => Err("Old .doc format is not supported — please re-save the file as .docx".into()),
        "txt" | "md" | "markdown" => std::fs::read_to_string(path).map_err(|e| e.to_string()),
        other => Err(format!("Unsupported file format: .{other}")),
    }
}

/// Lowercased file extension (without the dot).
pub fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
}

// ---- chunking ----

/// Split text into chunks no larger than `max` chars, breaking on blank lines so
/// paragraphs stay intact. Never truncates — every part of the input is kept.
pub fn chunk_text(text: &str, max: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for para in text.split("\n\n") {
        if !current.is_empty() && current.len() + para.len() + 2 > max {
            chunks.push(std::mem::take(&mut current));
        }
        if para.len() > max {
            // A single huge paragraph: hard-split on char boundaries.
            for piece in para.as_bytes().chunks(max) {
                let s = String::from_utf8_lossy(piece).to_string();
                chunks.push(s);
            }
            continue;
        }
        if !current.is_empty() {
            current.push_str("\n\n");
        }
        current.push_str(para);
    }
    if !current.trim().is_empty() {
        chunks.push(current);
    }
    if chunks.is_empty() {
        chunks.push(String::new());
    }
    chunks
}

// ---- PDF page rendering / per-page text ----

/// Render EVERY page of a PDF to base64-encoded PNGs (page order). Returns an
/// empty Vec if poppler's `pdftoppm` is not available or rendering fails.
pub fn render_pdf_pages(path: &Path) -> Vec<String> {
    let Some(bin) = poppler_bin("pdftoppm") else {
        return vec![];
    };

    let tmp_dir = std::env::temp_dir();
    let prefix = format!(
        "onyx_import_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let tmp_prefix = tmp_dir.join(&prefix);

    match Command::new(bin)
        .args([
            "-r",
            "150",
            "-png",
            "-l",
            &MAX_PAGES.to_string(),
            &path.to_string_lossy(),
            &tmp_prefix.to_string_lossy(),
        ])
        .status()
    {
        Err(_) => return vec![],
        Ok(s) if !s.success() => return vec![],
        Ok(_) => {}
    }

    // Collect generated files: pdftoppm names them {prefix}-N.png (zero-padded
    // by total page count). Read in numeric page order.
    let mut pages: Vec<String> = Vec::new();
    for i in 1..=MAX_PAGES {
        let candidates = [
            tmp_dir.join(format!("{prefix}-{i}.png")),
            tmp_dir.join(format!("{prefix}-{i:02}.png")),
            tmp_dir.join(format!("{prefix}-{i:03}.png")),
        ];
        if let Some(p) = candidates.iter().find(|p| p.exists()) {
            if let Ok(bytes) = std::fs::read(p) {
                pages.push(B64.encode(&bytes));
                let _ = std::fs::remove_file(p);
            }
        } else {
            break;
        }
    }
    pages
}

/// Extract the plain text of a single PDF page (1-based) via `pdftotext`.
/// Returns None if pdftotext is unavailable.
pub fn extract_pdf_page_text(path: &Path, page: usize) -> Option<String> {
    let bin = poppler_bin("pdftotext")?;
    let out = Command::new(bin)
        .args([
            "-f",
            &page.to_string(),
            "-l",
            &page.to_string(),
            &path.to_string_lossy(),
            "-", // write to stdout
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}
