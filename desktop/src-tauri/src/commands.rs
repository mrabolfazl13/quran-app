//! Native commands exposed to the webview.
//!
//! Least-privilege rules enforced here, on the Rust side, rather than trusted
//! to the JS layer:
//!
//! * Every path argument is a *relative* component string. Absolute paths,
//!   drive letters, empty segments and any `..` are rejected before touching
//!   the filesystem, and the canonicalised result must still sit inside the
//!   resolved root.
//! * Content reads are restricted to `index.json`, `*.json` and
//!   `*.jsonl` inside the bundled content directory.
//! * Backup writes are restricted to a filename matching `^[A-Za-z0-9._-]+\.
//!   quranbak$` inside the app-data backup directory, with a size cap.
//! * Checksums are computed over the raw bytes on disk by Rust; the webview
//!   never supplies a digest it computed elsewhere.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use tauri::Manager;

/// Refuse to stream absurd payloads into the webview (content packs are a few
/// MB each; this is a guard against a mispointed content root).
const MAX_TEXT_BYTES: u64 = 128 * 1024 * 1024;
const MAX_BACKUP_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Paths {
    pub app_data: String,
    pub backups: String,
    pub content_root: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentStatus {
    /// Resolved content directory, or `None` when no packs are shipped yet.
    pub root: Option<String>,
    pub has_index: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub bytes: u64,
    /// sha256 hex over the raw file bytes.
    pub sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
}

/// Reject anything that is not a plain `a/b/c.jsonl`-style relative path.
fn validate_rel(rel: &str) -> Result<(), String> {
    if rel.is_empty() || rel.len() > 512 {
        return Err("path rejected: empty or too long".into());
    }
    if rel.contains(':') || rel.contains('\\') {
        return Err("path rejected: absolute or backslash form not allowed".into());
    }
    let path = Path::new(rel);
    for c in path.components() {
        match c {
            Component::Normal(_) => {}
            _ => return Err(format!("path rejected: unsafe component {c:?}")),
        }
    }
    Ok(())
}

/// `true` when the (already validated) relative path names a content file type.
fn has_allowed_content_ext(rel: &str) -> bool {
    let Some(last) = rel.rsplit('/').next() else { return false };
    if last.is_empty() || last.starts_with('.') {
        return false;
    }
    last.ends_with(".json") || last.ends_with(".jsonl")
}

fn has_allowed_backup_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".quranbak") else {
        return false;
    };
    !stem.is_empty()
        && stem
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Resolve the directory that holds `index.json` + pack folders.
///
/// Priority: `QURAN_CONTENT_DIR` (packaging/CI override) → the bundled
/// resource dir (`content/`) →, for `tauri dev`, the repository `content/`
/// folder found by walking up from the executable and the current directory.
fn resolve_content_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    let usable = |p: PathBuf| -> Option<PathBuf> { p.is_dir().then_some(p) };

    if let Ok(dir) = std::env::var("QURAN_CONTENT_DIR") {
        if let Some(p) = usable(PathBuf::from(dir)) {
            return Some(p);
        }
    }

    if let Ok(res) = app.path().resolve("content", tauri::path::BaseDirectory::Resource) {
        if let Some(p) = usable(res) {
            return Some(p);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors().skip(1).take(8) {
            let candidate = ancestor.join("content");
            if let Some(p) = usable(candidate) {
                return Some(p);
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors().take(8) {
            let candidate = ancestor.join("content");
            if let Some(p) = usable(candidate) {
                return Some(p);
            }
        }
    }
    None
}

fn ensure_inside(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("content root unreadable: {e}"))?;
    let resolved = if candidate.exists() {
        candidate
            .canonicalize()
            .map_err(|e| format!("canonicalize failed: {e}"))?
    } else {
        // The file need not exist yet for the check to be meaningful. Comparing a
        // raw candidate against a canonicalised root is not one: on Windows
        // `canonicalize` returns a verbatim path (`\\?\C:\…`) and a verbatim prefix
        // is a single component, so `starts_with` would reject every missing path
        // inside the root — fail-closed, but wrong. Canonicalise the closest
        // existing ancestor instead and hang the remaining components off it, which
        // also resolves any `..` segments away before they can escape.
        let mut tail = vec![];
        let mut existing = candidate;
        while !existing.exists() {
            if let Some(name) = existing.file_name() {
                tail.push(name.to_os_string());
            }
            existing = existing
                .parent()
                .ok_or_else(|| "path rejected: no ancestor to resolve".to_string())?;
        }
        let mut resolved = existing
            .canonicalize()
            .map_err(|e| format!("canonicalize failed: {e}"))?;
        for name in tail.iter().rev() {
            resolved.push(name);
        }
        resolved
    };
    if resolved.starts_with(&root_canon) {
        Ok(resolved)
    } else {
        Err("path rejected: escapes the content root".into())
    }
}

/// The string a human is shown. Windows hands back verbatim paths (`\\?\C:\…`)
/// from `canonicalize` and from Tauri's resource resolution — meaningful to the
/// Win32 API, noise in a Persian settings screen. Filesystem decisions above
/// this still run on the `PathBuf`; only the display form is shortened.
fn display_path(path: &Path) -> String {
    let raw = path.display().to_string();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = raw.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    raw
}

fn backups_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .resolve("backups", tauri::path::BaseDirectory::AppData)
        .map_err(|e| format!("app data unavailable: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create backups dir: {e}"))?;
    Ok(dir)
}

/// sha256 in 64 KiB chunks; never loads a whole file into memory.
fn sha256_of(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|e| format!("open failed: {e}"))?;
    let mut reader = std::io::BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("read failed: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn app_paths(app: tauri::AppHandle) -> Result<Paths, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data unavailable: {e}"))?;
    Ok(Paths {
        app_data: display_path(&app_data),
        backups: display_path(backups_dir(&app)?.as_path()),
        content_root: resolve_content_root(&app).map(|p| display_path(&p)),
    })
}

#[tauri::command]
pub fn content_status(app: tauri::AppHandle) -> Result<ContentStatus, String> {
    let root = resolve_content_root(&app);
    let has_index = root
        .as_ref()
        .map(|r| r.join("index.json").is_file())
        .unwrap_or(false);
    Ok(ContentStatus {
        root: root.map(|p| display_path(&p)),
        has_index,
    })
}

/// Read a JSON / JSONL pack file below the content root.
#[tauri::command]
pub fn content_read_text(app: tauri::AppHandle, rel: String) -> Result<String, String> {
    let root = resolve_content_root(&app).ok_or("no content directory is available")?;
    validate_rel(&rel)?;
    if !has_allowed_content_ext(&rel) {
        return Err("path rejected: only .json / .jsonl pack files may be read".into());
    }
    let path = ensure_inside(&root, &root.join(&rel))?;
    let meta = fs::metadata(&path).map_err(|e| format!("stat failed: {e}"))?;
    if meta.len() > MAX_TEXT_BYTES {
        return Err(format!("file too large: {} bytes", meta.len()));
    }
    fs::read_to_string(&path).map_err(|e| format!("read failed: {e}"))
}

/// Byte length + sha256 of a pack file, as stored on disk.
#[tauri::command]
pub fn content_pack_stat(app: tauri::AppHandle, rel: String) -> Result<FileStat, String> {
    let root = resolve_content_root(&app).ok_or("no content directory is available")?;
    validate_rel(&rel)?;
    if !has_allowed_content_ext(&rel) {
        return Err("path rejected: only .json / .jsonl pack files may be hashed".into());
    }
    let path = ensure_inside(&root, &root.join(&rel))?;
    let meta = fs::metadata(&path).map_err(|e| format!("stat failed: {e}"))?;
    Ok(FileStat {
        bytes: meta.len(),
        sha256: sha256_of(&path)?,
    })
}

/// Write a backup envelope into the scoped app-data backup directory.
#[tauri::command]
pub fn backup_write(app: tauri::AppHandle, name: String, contents: String) -> Result<String, String> {
    if !has_allowed_backup_name(&name) {
        return Err("backup name rejected: expected <safe-name>.quranbak".into());
    }
    if contents.len() as u64 > MAX_BACKUP_BYTES {
        return Err("backup too large".into());
    }
    let dir = backups_dir(&app)?;
    let path = dir.join(&name);
    let tmp = dir.join(format!("{name}.partial"));
    fs::write(&tmp, contents.as_bytes()).map_err(|e| format!("backup write failed: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("backup publish failed: {e}"))?;
    Ok(display_path(&path))
}

#[tauri::command]
pub fn backup_read(app: tauri::AppHandle, name: String) -> Result<String, String> {
    if !has_allowed_backup_name(&name) {
        return Err("backup name rejected: expected <safe-name>.quranbak".into());
    }
    let dir = backups_dir(&app)?;
    let path = dir.join(&name);
    let meta = fs::metadata(&path).map_err(|e| format!("backup not found: {e}"))?;
    if meta.len() > MAX_BACKUP_BYTES {
        return Err("backup too large".into());
    }
    fs::read_to_string(&path).map_err(|e| format!("backup read failed: {e}"))
}

#[tauri::command]
pub fn backup_list(app: tauri::AppHandle) -> Result<Vec<BackupEntry>, String> {
    let dir = backups_dir(&app)?;
    let mut out = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("backup dir unreadable: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("backup dir entry failed: {e}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !has_allowed_backup_name(&name) {
            continue;
        }
        let path = entry.path();
        let meta = fs::metadata(&path).map_err(|e| format!("stat failed: {e}"))?;
        out.push(BackupEntry {
            bytes: meta.len(),
            sha256: sha256_of(&path)?,
            name,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

// ------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_paths_accept_plain_pack_layout() {
        assert!(validate_rel("index.json").is_ok());
        assert!(validate_rel("quran-core/payload.jsonl").is_ok());
        assert!(validate_rel("tr-en-85/pack.json").is_ok());
    }

    #[test]
    fn rel_paths_reject_traversal_and_absolute() {
        assert!(validate_rel("..").is_err());
        assert!(validate_rel("../etc/passwd").is_err());
        assert!(validate_rel("a/../../b").is_err());
        assert!(validate_rel("/abs/path.json").is_err());
        assert!(validate_rel("C:/Windows/x.json").is_err());
        assert!(validate_rel(r"src-tauri\tauri.conf.json").is_err());
        assert!(validate_rel("").is_err());
    }

    #[test]
    fn only_pack_extensions_are_readable() {
        assert!(has_allowed_content_ext("quran-core/payload.jsonl"));
        assert!(has_allowed_content_ext("index.json"));
        assert!(!has_allowed_content_ext("index.exe"));
        assert!(!has_allowed_content_ext("Cargo.toml"));
        assert!(!has_allowed_content_ext("dir/.env.json"));
        assert!(!has_allowed_content_ext("a/b.C"));
    }

    #[test]
    fn backup_names_are_strict() {
        assert!(has_allowed_backup_name("my-backup_2.quranbak"));
        assert!(!has_allowed_backup_name("backup.txt"));
        assert!(!has_allowed_backup_name("..quranbak.extra"));
        assert!(!has_allowed_backup_name(".quranbak"));
        assert!(!has_allowed_backup_name("a/b.quranbak"));
        assert!(!has_allowed_backup_name(""));
    }

    #[test]
    fn displayed_paths_drop_the_verbatim_prefix() {
        assert_eq!(
            display_path(Path::new(r"\\?\C:\Users\Alex\AppData\Local\Quran Platform\content")),
            r"C:\Users\Alex\AppData\Local\Quran Platform\content"
        );
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\server\share\content")),
            r"\\server\share\content"
        );
        assert_eq!(display_path(Path::new("/home/alex/content")), "/home/alex/content");
        assert_eq!(display_path(Path::new(r"D:\x\content")), r"D:\x\content");
    }

    #[test]
    fn sha256_matches_known_vector() {
        let dir = std::env::temp_dir().join(format!("quran-sha-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("empty.json");
        fs::write(&f, "").unwrap();
        assert_eq!(
            sha256_of(&f).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        fs::write(&f, "abc").unwrap();
        assert_eq!(
            sha256_of(&f).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn containment_rejects_escape() {
        let dir = std::env::temp_dir().join(format!("quran-root-{}", std::process::id()));
        let inner = dir.join("pack");
        fs::create_dir_all(&inner).unwrap();
        fs::write(dir.join("secret.json"), "x").unwrap();
        let outside = dir.join("secret.json");
        assert!(ensure_inside(&inner, &outside).is_err());
        assert!(ensure_inside(&inner, &inner.join("payload.jsonl")).is_ok());
        // Two directions the missing-file branch can fail: a `..` spelled into a
        // path that does not exist yet must still be refused, and a genuinely deep
        // path below the root must not be refused just because nothing exists there.
        assert!(ensure_inside(&inner, &inner.join("../secret.json")).is_err());
        assert!(ensure_inside(&inner, &inner.join("a/b/c.jsonl")).is_ok());
        fs::remove_dir_all(&dir).ok();
    }
}
