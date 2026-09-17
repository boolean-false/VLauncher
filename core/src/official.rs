#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos", test))]
use crate::RuntimeManifest;
use crate::{InstalledRuntime, ProfileStore};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
use sha2::{Digest, Sha256};
#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
use std::io::Read;
use std::time::Duration;
#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos", test))]
use std::{fs, io::Write, path::Path};

const REPOSITORY: &str = "https://api.github.com/repos/MihailRis/voxelcore";
const MAX_ARCHIVE: u64 = 512 * 1024 * 1024;
#[derive(Clone, Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    size: u64,
    #[allow(dead_code)]
    digest: Option<String>,
}
#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
    assets: Vec<Asset>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct OfficialRelease {
    pub version: String,
    pub channel: String,
    pub artifact_size: u64,
    pub published_at: String,
}
fn client() -> Result<Client, String> {
    Client::builder()
        .user_agent(concat!("VLauncher/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())
}
fn asset_for(release: &Release, os: &str, arch: &str) -> Option<Asset> {
    if release.draft || semver::Version::parse(release.tag_name.trim_start_matches('v')).is_err() {
        return None;
    }
    release
        .assets
        .iter()
        .find(|a| {
            let name = a.name.to_lowercase();
            let platform = match (os, arch) {
                ("linux", "x86_64") => {
                    name.ends_with(".appimage")
                        && (name.contains("x86-64") || name.contains("x86_64"))
                }
                ("windows", "x86_64") => name.ends_with(".zip") && name.contains("win64"),
                // Сейчас в общем dmg лежит только arm64.
                ("macos", "aarch64") => name.ends_with("_macos.dmg"),
                _ => false,
            };
            platform
                && a.size > 0
                && a.size <= MAX_ARCHIVE
                && a.browser_download_url
                    .starts_with("https://github.com/MihailRis/voxelcore/releases/download/")
        })
        .cloned()
}
pub fn list_official_releases() -> Result<Vec<OfficialRelease>, String> {
    let http = client()?;
    let mut result = Vec::new();
    for page in 1..=10 {
        let releases: Vec<Release> = http
            .get(format!("{REPOSITORY}/releases?per_page=100&page={page}"))
            .timeout(Duration::from_secs(30))
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("Не удалось получить релизы GitHub: {e}"))?
            .json()
            .map_err(|e| e.to_string())?;
        let end = releases.len() < 100;
        for release in releases {
            if let Some(asset) = asset_for(&release, std::env::consts::OS, std::env::consts::ARCH) {
                result.push(OfficialRelease {
                    version: release.tag_name.trim_start_matches('v').into(),
                    channel: if release.prerelease { "beta" } else { "stable" }.into(),
                    artifact_size: asset.size,
                    published_at: release.published_at.unwrap_or_default(),
                });
            }
        }
        if end {
            break;
        }
    }
    result.sort_by(|a, b| {
        semver::Version::parse(&b.version)
            .unwrap()
            .cmp(&semver::Version::parse(&a.version).unwrap())
    });
    result.dedup_by(|a, b| a.version == b.version);
    Ok(result)
}

#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
pub fn install_official_runtime(
    store: &ProfileStore,
    version: &str,
    mut progress: impl FnMut(u64, u64) -> bool,
) -> Result<InstalledRuntime, String> {
    semver::Version::parse(version).map_err(|e| e.to_string())?;
    let http = client()?;
    // Не доверяем ссылке из интерфейса, получаем её заново.
    let release: Release = http
        .get(format!("{REPOSITORY}/releases/tags/v{version}"))
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;
    let asset = asset_for(&release, std::env::consts::OS, std::env::consts::ARCH)
        .ok_or("Для этой системы нет официальной сборки данного релиза")?;
    if release.tag_name.trim_start_matches('v') != version {
        return Err("GitHub вернул другой релиз".into());
    }
    let stage = tempfile::tempdir().map_err(|e| e.to_string())?;
    let archive = stage.path().join("engine-download");
    let mut response = http
        .get(&asset.browser_download_url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?;
    let mut file = fs::File::create(&archive).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut completed = 0;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        if !progress(completed, asset.size) {
            return Err("Загрузка отменена".into());
        }
        let count = response.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        completed += count as u64;
        if completed > asset.size {
            return Err("Размер архива превышает заявленный GitHub".into());
        }
        file.write_all(&buffer[..count])
            .map_err(|e| e.to_string())?;
        hash.update(&buffer[..count]);
    }
    drop(file);
    if completed != asset.size {
        return Err("Архив загружен не полностью".into());
    }
    if let Some(digest) = asset.digest {
        if digest != format!("sha256:{}", hex::encode(hash.finalize())) {
            return Err("Контрольная сумма GitHub не совпадает".into());
        }
    }
    if !progress(completed, asset.size) {
        return Err("Загрузка отменена".into());
    }
    install_archive(store, &archive, version, &stage, None, || {
        progress(completed, asset.size)
    })
}

#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
pub(crate) fn install_archive(
    store: &ProfileStore,
    archive: &Path,
    version: &str,
    stage: &tempfile::TempDir,
    main_build: Option<&crate::mainline::MainBuild>,
    mut keep_going: impl FnMut() -> bool,
) -> Result<InstalledRuntime, String> {
    let prepared = stage.path().join("prepared");
    #[cfg(target_os = "linux")]
    {
        use std::{
            os::unix::fs::PermissionsExt,
            process::{Command, Stdio},
        };
        fs::set_permissions(&archive, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
        let output = Command::new(&archive)
            .arg("--appimage-extract")
            .current_dir(stage.path())
            .env("APPIMAGELAUNCHER_DISABLE", "1")
            .stdout(Stdio::null())
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(format!(
                "Не удалось распаковать AppImage: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        copy_contained(&stage.path().join("squashfs-root"), &prepared)?;
    }
    #[cfg(target_os = "windows")]
    extract_zip(&archive, &prepared)?;
    #[cfg(target_os = "macos")]
    extract_dmg(&archive, &prepared, &stage)?;
    let (executable, resources) = detect_runtime_layout(&prepared)?;
    #[cfg(target_os = "macos")]
    ensure_macos_arm64_executable(&prepared.join(&executable))?;
    let metadata = RuntimeManifest {
        schema_version: 1,
        version: version.into(),
        platform: std::env::consts::OS.into(),
        architecture: std::env::consts::ARCH.into(),
        executable,
        resources,
    };
    fs::write(
        prepared.join("runtime.json"),
        serde_json::to_vec_pretty(&metadata).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if let Some(build) = main_build {
        fs::write(
            prepared.join("main-build.json"),
            serde_json::to_vec_pretty(build).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }
    if !keep_going() {
        return Err("Установка отменена".into());
    }
    store.import_runtime(&prepared).map_err(|e| e.to_string())
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
pub fn install_official_runtime(
    _store: &ProfileStore,
    version: &str,
    _progress: impl FnMut(u64, u64) -> bool,
) -> Result<InstalledRuntime, String> {
    semver::Version::parse(version).map_err(|e| e.to_string())?;
    Err("Установка официальных сборок не поддерживается на этой системе".into())
}

#[cfg(target_os = "macos")]
fn extract_dmg(
    archive: &Path,
    destination: &Path,
    stage: &tempfile::TempDir,
) -> Result<(), String> {
    use std::process::Command;

    let mount = stage.path().join("mounted");
    fs::create_dir(&mount).map_err(|e| e.to_string())?;
    let attached = Command::new("hdiutil")
        .args(["attach", "-readonly", "-nobrowse", "-mountpoint"])
        .arg(&mount)
        .arg(archive)
        .output()
        .map_err(|e| format!("Не удалось запустить hdiutil: {e}"))?;
    if !attached.status.success() {
        return Err(format!(
            "Не удалось смонтировать DMG: {}",
            String::from_utf8_lossy(&attached.stderr).trim()
        ));
    }

    let copied = copy_contained(&mount, destination);
    let detached = Command::new("hdiutil")
        .arg("detach")
        .arg(&mount)
        .output()
        .map_err(|e| format!("Не удалось запустить hdiutil detach: {e}"));

    copied?;
    let detached = detached?;
    if !detached.status.success() {
        return Err(format!(
            "Не удалось отсоединить DMG: {}",
            String::from_utf8_lossy(&detached.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn ensure_macos_arm64_executable(path: &Path) -> Result<(), String> {
    const CPU_TYPE_ARM64: u32 = 0x0100_000c;
    let mut header = [0u8; 8];
    fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .map_err(|e| format!("Не удалось проверить архитектуру VoxelCore: {e}"))?;
    let magic = u32::from_le_bytes(header[..4].try_into().unwrap());
    let cpu_type = u32::from_le_bytes(header[4..].try_into().unwrap());
    if magic != 0xfeed_facf || cpu_type != CPU_TYPE_ARM64 {
        return Err("DMG VoxelCore не содержит исполняемый файл ARM64".into());
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos", all(test, unix)))]
fn copy_contained(source: &Path, destination: &Path) -> Result<(), String> {
    let source = source.canonicalize().map_err(|e| e.to_string())?;
    // В старых AppImage есть битые ссылки на changelog.
    for entry in walkdir::WalkDir::new(&source).follow_links(false) {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().is_symlink()
            && !entry.path().exists()
            && entry
                .path()
                .strip_prefix(&source)
                .unwrap()
                .starts_with("usr/share/doc")
        {
            #[cfg(target_os = "linux")]
            fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
            #[cfg(not(target_os = "linux"))]
            continue;
        }
    }
    let mut size = 0u64;
    for entry in walkdir::WalkDir::new(&source).follow_links(true) {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry
            .path()
            .canonicalize()
            .map_err(|e| e.to_string())?
            .starts_with(&source)
        {
            return Err("Ссылка в архиве выходит за его пределы".into());
        }
        let target = destination.join(
            entry
                .path()
                .strip_prefix(&source)
                .map_err(|e| e.to_string())?,
        );
        if entry.file_type().is_dir() {
            fs::create_dir_all(target).map_err(|e| e.to_string())?;
        } else if entry.file_type().is_file() {
            size += entry.metadata().map_err(|e| e.to_string())?.len();
            if size > 2 * 1024 * 1024 * 1024 {
                return Err("Распакованная сборка слишком велика".into());
            }
            fs::copy(entry.path(), target).map_err(|e| e.to_string())?;
        } else {
            return Err("Недопустимый тип файла в сборке".into());
        }
    }
    Ok(())
}
pub(crate) fn extract_zip(archive: &Path, destination: &Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(fs::File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut total = 0u64;
    if zip.len() > 100_000 {
        return Err("Слишком много файлов в архиве".into());
    }
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        total = total
            .checked_add(entry.size())
            .ok_or("Размер архива некорректен")?;
        if total > 2 * 1024 * 1024 * 1024 || entry.is_symlink() {
            return Err("Недопустимый файл в архиве".into());
        }
        let name = entry.enclosed_name().ok_or("Небезопасный путь в архиве")?;
        let target = destination.join(name);
        if entry.is_dir() {
            fs::create_dir_all(target).map_err(|e| e.to_string())?;
        } else {
            fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
            let mut file = fs::File::create(target).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut file).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos", test))]
pub fn detect_runtime_layout(
    root: &Path,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    if root.join("AppRun").is_file() {
        for res in [
            "usr/share/VoxelCore/res",
            "usr/share/VoxelEngine/res",
            "res",
        ] {
            if root.join(res).is_dir() {
                return Ok(("AppRun".into(), res.into()));
            }
        }
    }
    for executable in ["VoxelCore", "VoxelEngine", "voxelcore", "voxelengine"] {
        if root.join(executable).is_file() && root.join("res").is_dir() {
            return Ok((executable.into(), "res".into()));
        }
    }
    for entry in walkdir::WalkDir::new(root).max_depth(4) {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if entry.file_type().is_file()
            && ["voxelcore.exe", "voxelengine.exe"].contains(&name.as_str())
        {
            let parent = entry.path().parent().unwrap();
            if parent.join("res").is_dir() {
                return Ok((
                    entry.path().strip_prefix(root).unwrap().into(),
                    parent.join("res").strip_prefix(root).unwrap().into(),
                ));
            }
        }
    }
    Err("Не найдены исполняемый файл и ресурсы в официальной сборке".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn assets_are_filtered_by_platform_and_origin() {
        let mut release: Release = serde_json::from_value(serde_json::json!({"tag_name":"v0.31.4","draft":false,"prerelease":false,"published_at":null,"assets":[{"name":"voxelcore_x86-64.AppImage","browser_download_url":"https://github.com/MihailRis/voxelcore/releases/download/v0.31.4/game.AppImage","size":100}]})).unwrap();
        assert!(asset_for(&release, "linux", "x86_64").is_some());
        assert!(asset_for(&release, "linux", "aarch64").is_none());
        assert!(asset_for(&release, "windows", "x86_64").is_none());
        release.assets[0].browser_download_url = "https://example.com/game.AppImage".into();
        assert!(asset_for(&release, "linux", "x86_64").is_none());
    }
    #[test]
    fn macos_fallback_accepts_arm64_dmg_and_validates_its_executable() {
        let release: Release = serde_json::from_value(serde_json::json!({
            "tag_name": "v0.31.4",
            "draft": false,
            "prerelease": false,
            "published_at": null,
            "assets": [{
                "name": "voxelcore-0.31.4_macos.dmg",
                "browser_download_url": "https://github.com/MihailRis/voxelcore/releases/download/v0.31.4/voxelcore-0.31.4_macos.dmg",
                "size": 100
            }]
        }))
        .unwrap();
        assert!(asset_for(&release, "macos", "aarch64").is_some());
        assert!(asset_for(&release, "macos", "x86_64").is_none());

        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("res")).unwrap();
        let executable = directory.path().join("VoxelEngine");
        let mut header = Vec::new();
        header.extend_from_slice(&0xfeed_facfu32.to_le_bytes());
        header.extend_from_slice(&0x0100_000cu32.to_le_bytes());
        fs::write(&executable, &header).unwrap();
        assert_eq!(
            detect_runtime_layout(directory.path()).unwrap(),
            ("VoxelEngine".into(), "res".into())
        );
        ensure_macos_arm64_executable(&executable).unwrap();

        header[4..].copy_from_slice(&0x0100_0007u32.to_le_bytes());
        fs::write(&executable, header).unwrap();
        assert!(ensure_macos_arm64_executable(&executable).is_err());
    }
    #[test]
    fn zip_rejects_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        zip.start_file("../escape", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"bad").unwrap();
        zip.finish().unwrap();
        assert!(extract_zip(&path, &dir.path().join("out")).is_err());
        assert!(!dir.path().join("escape").exists());
    }
    #[test]
    fn windows_zip_preserves_layout_and_imports_from_unicode_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("windows.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        for (name, bytes) in [
            ("VoxelCore win64/voxelcore.exe", b"executable".as_slice()),
            ("VoxelCore win64/glfw3.dll", b"library".as_slice()),
            ("VoxelCore win64/res/texts/ru_RU.txt", "Ресурсы".as_bytes()),
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        drop(zip.finish().unwrap());
        let prepared = dir.path().join("Распакованная игра с пробелами");
        extract_zip(&path, &prepared).unwrap();
        let (executable, resources) = detect_runtime_layout(&prepared).unwrap();
        assert_eq!(executable, Path::new("VoxelCore win64/voxelcore.exe"));
        assert_eq!(resources, Path::new("VoxelCore win64/res"));
        let metadata = RuntimeManifest {
            schema_version: 1,
            version: "0.31.4".into(),
            platform: std::env::consts::OS.into(),
            architecture: std::env::consts::ARCH.into(),
            executable,
            resources,
        };
        fs::write(
            prepared.join("runtime.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        let store = ProfileStore::open(dir.path().join("Библиотека игр")).unwrap();
        let runtime = store.import_runtime(&prepared).unwrap();
        // rename поверх папки на Windows не работает.
        store.import_runtime(&prepared).unwrap();
        assert_eq!(
            fs::read(runtime.path.join("VoxelCore win64/glfw3.dll")).unwrap(),
            b"library"
        );
        assert_eq!(
            fs::read_to_string(runtime.path.join("VoxelCore win64/res/texts/ru_RU.txt")).unwrap(),
            "Ресурсы"
        );
        let profile = store
            .create_initialized("Проверка Windows", "0.31.4")
            .unwrap();
        let spec = store.launch_spec(profile.id, "0.31.4").unwrap();
        assert!(spec.executable.is_file());
        assert_eq!(
            Path::new(&spec.arguments[1]),
            runtime.path.join(&metadata.resources)
        );
        assert!(Path::new(&spec.arguments[3]).is_dir());
    }
    #[cfg(unix)]
    #[test]
    fn extraction_rejects_external_symlink() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("source")).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", dir.path().join("source/link")).unwrap();
        assert!(copy_contained(&dir.path().join("source"), &dir.path().join("out")).is_err());
    }
}
