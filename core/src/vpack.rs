//! Portable profiles. Catalog artifacts are fetched only from the configured registry
//! and must have a trusted release attestation. Embedded files are local user content.
use super::*;
use std::collections::BTreeMap;

const FORMAT: &str = "vlauncher-vpack";
const MAX_MANIFEST: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VpackFile {
    pub sha256: String,
    pub size: u64,
    #[serde(default)]
    pub executable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VpackPackage {
    pub id: String,
    pub kind: PackageKind,
    pub version: String,
    pub artifact_sha256: String,
    pub artifact_size: u64,
    pub embedded: Option<String>,
    #[serde(default)]
    pub dependencies: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VpackManifest {
    pub format: String,
    pub schema_version: u32,
    pub name: String,
    pub icon: Option<String>,
    pub voxelcore_version: String,
    pub main_build: Option<crate::mainline::MainBuild>,
    pub roots: Vec<String>,
    pub root_requirements: HashMap<String, String>,
    pub packages: Vec<VpackPackage>,
    pub worlds: bool,
    pub settings: bool,
    pub local_project: bool,
    pub local_runtime: Option<RuntimeManifest>,
    pub files: BTreeMap<String, VpackFile>,
}

#[derive(Debug, Serialize)]
pub struct VpackPreview {
    pub manifest: VpackManifest,
    pub archive_sha256: String,
    pub download_size: u64,
    pub embedded_size: u64,
    pub local_mods: usize,
}

fn json_error(error: impl std::fmt::Display) -> PackageProblem {
    PackageProblem::Invalid(error.to_string())
}
fn copy_checked<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    progress: &dyn Fn(&str, u64, u64) -> bool,
    label: &str,
) -> Result<u64, PackageProblem> {
    let mut buffer = [0u8; 128 * 1024];
    let mut copied = 0;
    loop {
        check_cancel(progress, label)?;
        let read = reader.read(&mut buffer).map_err(json_error)?;
        if read == 0 {
            return Ok(copied);
        }
        writer.write_all(&buffer[..read]).map_err(json_error)?;
        copied += read as u64;
    }
}
fn digest(path: &Path) -> Result<String, PackageProblem> {
    digest_with_progress(path, &|_, _, _| true)
}
fn digest_with_progress(
    path: &Path,
    progress: &dyn Fn(&str, u64, u64) -> bool,
) -> Result<String, PackageProblem> {
    let mut source = fs::File::open(path).map_err(|e| io_error(path, e))?;
    let mut hash = Sha256::new();
    copy_checked(&mut source, &mut hash, progress, "Проверяем файлы…")?;
    Ok(hex::encode(hash.finalize()))
}
fn is_executable(path: &Path) -> Result<bool, PackageProblem> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return Ok(fs::metadata(path)
            .map_err(|e| io_error(path, e))?
            .permissions()
            .mode()
            & 0o111
            != 0);
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(false)
    }
}
fn set_executable(path: &Path, executable: bool) -> Result<(), PackageProblem> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if executable { 0o755 } else { 0o644 }),
        )
        .map_err(|e| io_error(path, e))?;
    }
    #[cfg(not(unix))]
    let _ = (path, executable);
    Ok(())
}
fn portable_path(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 1024
        && !name.contains('\\')
        && name.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part.ends_with(['.', ' '])
                && !part
                    .chars()
                    .any(|c| c.is_control() || "<>:\"|?*".contains(c))
                && !matches!(
                    part.split('.')
                        .next()
                        .unwrap_or("")
                        .to_ascii_uppercase()
                        .as_str(),
                    "CON"
                        | "PRN"
                        | "AUX"
                        | "NUL"
                        | "COM1"
                        | "COM2"
                        | "COM3"
                        | "COM4"
                        | "COM5"
                        | "COM6"
                        | "COM7"
                        | "COM8"
                        | "COM9"
                        | "LPT1"
                        | "LPT2"
                        | "LPT3"
                        | "LPT4"
                        | "LPT5"
                        | "LPT6"
                        | "LPT7"
                        | "LPT8"
                        | "LPT9"
                )
        })
        && name.split('/').count() <= 32
}
fn check_cancel(
    progress: &dyn Fn(&str, u64, u64) -> bool,
    label: &str,
) -> Result<(), PackageProblem> {
    if !progress(label, 0, 0) {
        return invalid("download paused by user");
    }
    Ok(())
}
fn file_inventory_with_progress(
    root: &Path,
    progress: &dyn Fn(&str, u64, u64) -> bool,
) -> Result<BTreeMap<String, VpackFile>, PackageProblem> {
    let mut files = BTreeMap::new();
    if !root.exists() {
        return Ok(files);
    }
    let mut names = HashSet::new();
    let mut total = 0u64;
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(json_error)?;
        if entry.file_type().is_symlink() {
            return invalid(format!(
                "Для экспорта замените символическую ссылку обычными файлами: {}",
                entry.path().display()
            ));
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry
            .path()
            .strip_prefix(root)
            .map_err(json_error)?
            .to_str()
            .ok_or_else(|| json_error("Имя файла не является UTF-8"))?
            .replace('\\', "/");
        if !portable_path(&name) || !names.insert(name.to_lowercase()) {
            return invalid(format!("Непереносимое или повторяющееся имя файла: {name}"));
        }
        let size = entry.metadata().map_err(json_error)?.len();
        total = total.saturating_add(size);
        if files.len() >= MAX_FILES || total > MAX_UNPACKED_SIZE {
            return invalid("vpack превышает лимит: 100 000 файлов или 2 ГиБ данных");
        }
        files.insert(
            name,
            VpackFile {
                size,
                sha256: digest_with_progress(entry.path(), progress)?,
                executable: is_executable(entry.path())?,
            },
        );
    }
    Ok(files)
}
#[derive(Clone, Copy)]
enum CopyPolicy {
    Verified,
    Content,
    Project,
    Runtime,
}

fn copy_shareable_tree(
    source: &Path,
    destination: &Path,
    progress: &dyn Fn(&str, u64, u64) -> bool,
) -> Result<(), PackageProblem> {
    copy_vpack_tree(source, destination, progress, CopyPolicy::Project)
}
fn copy_vpack_tree(
    source: &Path,
    destination: &Path,
    progress: &dyn Fn(&str, u64, u64) -> bool,
    policy: CopyPolicy,
) -> Result<(), PackageProblem> {
    copy_vpack_tree_excluding(source, destination, progress, policy, &[])
}
fn copy_vpack_tree_excluding(
    source: &Path,
    destination: &Path,
    progress: &dyn Fn(&str, u64, u64) -> bool,
    policy: CopyPolicy,
    excluded: &[PathBuf],
) -> Result<(), PackageProblem> {
    for entry in WalkDir::new(source)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            if excluded.iter().any(|path| entry.path().starts_with(path)) {
                return false;
            }
            if entry.depth() == 0 || matches!(policy, CopyPolicy::Verified) {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            if matches!(name.as_ref(), ".git" | ".DS_Store") {
                return false;
            }
            match policy {
                CopyPolicy::Verified | CopyPolicy::Content => true,
                CopyPolicy::Runtime => !matches!(name.as_ref(), "logs" | ".cache"),
                CopyPolicy::Project => {
                    !matches!(name.as_ref(), "logs" | ".cache" | "node_modules" | "target")
                        && !name.starts_with(".env")
                        && !name.ends_with(".pem")
                        && !name.ends_with(".key")
                }
            }
        })
    {
        check_cancel(progress, "Копируем файлы…")?;
        let entry = entry.map_err(json_error)?;
        if entry.file_type().is_symlink() {
            return invalid("Для экспорта замените символические ссылки обычными файлами");
        }
        let relative = entry.path().strip_prefix(source).map_err(json_error)?;
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target).map_err(json_error)?;
        } else if entry.file_type().is_file() {
            let mut input = fs::File::open(entry.path()).map_err(json_error)?;
            let mut output = fs::File::create(&target).map_err(json_error)?;
            copy_checked(&mut input, &mut output, progress, "Копируем файлы…")?;
            set_executable(&target, is_executable(entry.path())?)?;
        }
    }
    Ok(())
}
fn copy_runtime_tree(
    runtime: &ExternalRuntime,
    game: &Path,
    destination: &Path,
    progress: &dyn Fn(&str, u64, u64) -> bool,
) -> Result<(), PackageProblem> {
    let source = dunce::canonicalize(&runtime.path).map_err(|e| io_error(&runtime.path, e))?;
    let game = dunce::canonicalize(game).map_err(|e| io_error(game, e))?;
    let excluded = if game == source {
        [
            "content",
            "worlds",
            "config",
            "controls.toml",
            "settings.toml",
            ".vlauncher-revision",
            ".vlauncher-external.json",
        ]
        .iter()
        .map(|name| source.join(name))
        .collect()
    } else if game.starts_with(&source) {
        vec![game]
    } else {
        Vec::new()
    };
    copy_vpack_tree_excluding(
        &source,
        destination,
        progress,
        CopyPolicy::Runtime,
        &excluded,
    )?;
    if !destination.join(&runtime.executable).is_file()
        || !destination.join(&runtime.resources).is_dir()
    {
        return invalid(
            "Не удалось отделить движок от данных игры. Выберите отдельную папку движка для экспорта.",
        );
    }
    Ok(())
}

fn same_tree(
    a: &Path,
    b: &Path,
    progress: &dyn Fn(&str, u64, u64) -> bool,
) -> Result<bool, PackageProblem> {
    let a = file_inventory_with_progress(a, progress)?;
    let b = file_inventory_with_progress(b, progress)?;
    Ok(a.len() == b.len()
        && a.iter().all(|(name, file)| {
            b.get(name).is_some_and(|other| {
                file.sha256 == other.sha256
                    && file.size == other.size
                    && file.executable == other.executable
            })
        }))
}
fn write_zip(
    root: &Path,
    destination: &Path,
    progress: &dyn Fn(&str, u64, u64) -> bool,
) -> Result<(), PackageProblem> {
    let files = file_inventory_with_progress(root, progress)?;
    let file = fs::File::create(destination).map_err(|e| io_error(destination, e))?;
    let mut zip = ZipWriter::new(file);
    for (name, info) in &files {
        check_cancel(progress, "Упаковка файлов…")?;
        zip.start_file(
            name,
            SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .unix_permissions(if info.executable { 0o755 } else { 0o644 }),
        )
        .map_err(json_error)?;
        let source = root.join(name);
        let mut file = fs::File::open(&source).map_err(|e| io_error(&source, e))?;
        copy_checked(&mut file, &mut zip, progress, "Упаковываем файлы…")?;
    }
    zip.finish().map_err(json_error)?;
    Ok(())
}

// Verify the signed payload, never the untrusted assertion beside it.
fn verify_attestation(value: &serde_json::Value) -> Result<serde_json::Value, PackageProblem> {
    verify_attestation_with_keys(value, &trusted_signing_public_keys())
}
fn verify_attestation_with_keys(
    value: &serde_json::Value,
    keys: &[&str],
) -> Result<serde_json::Value, PackageProblem> {
    if value["algorithm"] != "Ed25519" {
        return invalid("Неподдерживаемая подпись релиза");
    }
    let key_id = value["key_id"]
        .as_str()
        .ok_or_else(|| json_error("Нет ключа подписи"))?;
    if option_env!("VLAUNCHER_REVOKED_SIGNING_KEY_IDS")
        .unwrap_or("")
        .split(',')
        .any(|id| id.trim() == key_id)
    {
        return invalid("Ключ подписи релиза отозван");
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value["payload"].as_str().unwrap_or(""))
        .map_err(json_error)?;
    let signature = URL_SAFE_NO_PAD
        .decode(value["signature"].as_str().unwrap_or(""))
        .map_err(json_error)?;
    let signature = Signature::from_slice(&signature).map_err(json_error)?;
    for encoded in keys {
        let key = URL_SAFE_NO_PAD.decode(encoded).map_err(json_error)?;
        if hex::encode(Sha256::digest(&key))[..16] != *key_id {
            continue;
        }
        let raw: [u8; 32] = key
            .try_into()
            .map_err(|_| json_error("Некорректный ключ"))?;
        VerifyingKey::from_bytes(&raw)
            .map_err(json_error)?
            .verify(&bytes, &signature)
            .map_err(json_error)?;
        return serde_json::from_slice(&bytes).map_err(json_error);
    }
    invalid("Релиз подписан неизвестным ключом")
}
fn registry_client() -> Result<Client, PackageProblem> {
    Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30 * 60))
        .user_agent(concat!("VLauncher/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(json_error)
}
fn registry_artifact(
    client: &Client,
    registry: &str,
    expected: &VpackPackage,
) -> Result<RemoteInstallPackage, PackageProblem> {
    registry_artifact_verified(client, registry, expected, &verify_attestation)
}
fn registry_artifact_verified(
    client: &Client,
    registry: &str,
    expected: &VpackPackage,
    verifier: &dyn Fn(&serde_json::Value) -> Result<serde_json::Value, PackageProblem>,
) -> Result<RemoteInstallPackage, PackageProblem> {
    let base =
        reqwest::Url::parse(&format!("{}/", registry.trim_end_matches('/'))).map_err(json_error)?;
    if base.scheme() != "https"
        && !(base.scheme() == "http"
            && matches!(base.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
    {
        return invalid("Реестр должен использовать HTTPS");
    }
    // Only locally configured registry URLs are used; the archive cannot supply a host.
    let project: serde_json::Value = client
        .get(
            base.join(&format!("projects/{}", expected.id))
                .map_err(json_error)?,
        )
        .timeout(Duration::from_secs(30))
        .send()
        .map_err(json_error)?
        .error_for_status()
        .map_err(json_error)?
        .json()
        .map_err(json_error)?;
    let releases: Vec<serde_json::Value> = client
        .get(
            base.join(&format!("projects/{}/releases", expected.id))
                .map_err(json_error)?,
        )
        .timeout(Duration::from_secs(30))
        .send()
        .map_err(json_error)?
        .error_for_status()
        .map_err(json_error)?
        .json()
        .map_err(json_error)?;
    let release = releases
        .iter()
        .find(|r| {
            r["version"] == expected.version && r["artifact_sha256"] == expected.artifact_sha256
        })
        .ok_or_else(|| {
            json_error(format!(
                "Версия {} {} недоступна для скачивания.",
                expected.id, expected.version
            ))
        })?;
    let assertion = verifier(&release["attestation"])?;
    if assertion["schema_version"] != 1
        || assertion["project"] != project["id"]
        || assertion["version"] != expected.version
        || assertion["artifact_sha256"] != expected.artifact_sha256
        || assertion["artifact_size"].as_u64() != Some(expected.artifact_size)
        || assertion["manifest"]["type"]
            != serde_json::to_value(&expected.kind).map_err(json_error)?
        || (matches!(expected.kind, PackageKind::Mod | PackageKind::Library)
            && assertion["manifest"]["id"] != expected.id)
    {
        return invalid(format!(
            "Подписанные сведения не соответствуют пакету {}",
            expected.id
        ));
    }
    Ok(RemoteInstallPackage {
        id: expected.id.clone(),
        title: None,
        kind: expected.kind.clone(),
        version: expected.version.clone(),
        artifact_sha256: expected.artifact_sha256.clone(),
        artifact_size: expected.artifact_size,
        download_url: base
            .join(&format!("artifacts/{}", expected.artifact_sha256))
            .map_err(json_error)?
            .to_string(),
        dependencies: expected.dependencies.clone(),
    })
}

fn validate_manifest(m: &VpackManifest) -> Result<(), PackageProblem> {
    if m.format != FORMAT || m.schema_version != 1 {
        return invalid("Эта версия формата vpack не поддерживается");
    }
    if m.name.trim().is_empty()
        || m.name.chars().count() > 80
        || m.packages.len() > 512
        || m.roots.len() > 512
        || m.files.len() > MAX_FILES
    {
        return invalid("Некорректное описание vpack");
    }
    semver::Version::parse(&m.voxelcore_version).map_err(json_error)?;
    if let Some(build) = &m.main_build {
        build.validate().map_err(json_error)?;
        if build.engine_version.as_deref() != Some(&m.voxelcore_version)
            || build.platform != std::env::consts::OS
            || build.architecture != std::env::consts::ARCH
        {
            return invalid("DEV-сборка vpack несовместима с этой системой или версией игры");
        }
    }
    if m.local_project && !m.packages.is_empty() {
        return invalid("Локальный проект не может содержать управляемые пакеты");
    }
    if m.local_runtime.is_some() && m.main_build.is_some() {
        return invalid("Локальный движок не может одновременно быть DEV-сборкой");
    }
    let mut ids = HashSet::new();
    for p in &m.packages {
        if !portable_path(&p.id)
            || !p
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || !ids.insert(p.id.to_lowercase())
            || p.kind == PackageKind::Runtime
            || !valid_digest_name(&p.artifact_sha256)
            || p.artifact_size > MAX_UNPACKED_SIZE
        {
            return invalid("Некорректный пакет vpack");
        }
        semver::Version::parse(&p.version).map_err(json_error)?;
        if let Some(path) = &p.embedded {
            if !path.starts_with("packages/")
                || !portable_path(path)
                || !m
                    .files
                    .get(path)
                    .is_some_and(|f| f.sha256 == p.artifact_sha256 && f.size == p.artifact_size)
            {
                return invalid("В vpack отсутствует вложенный пакет");
            }
        }
    }
    let mut paths = HashSet::new();
    let mut size = 0u64;
    for (path, file) in &m.files {
        if !portable_path(path)
            || !paths.insert(path.to_lowercase())
            || !valid_digest_name(&file.sha256)
            || !(path.starts_with("packages/")
                || path.starts_with("game/content/")
                || (m.worlds && path.starts_with("game/worlds/"))
                || (m.settings && path.starts_with("game/config/"))
                || (m.settings
                    && matches!(path.as_str(), "game/settings.toml" | "game/controls.toml"))
                || (m.local_project && path.starts_with("project/"))
                || (m.local_runtime.is_some() && path.starts_with("runtime/")))
        {
            return invalid(format!("Недопустимый файл vpack: {path}"));
        }
        size = size.saturating_add(file.size);
    }
    if size > MAX_UNPACKED_SIZE {
        return invalid("vpack превышает 2 ГиБ");
    }
    if let Some(runtime) = &m.local_runtime {
        safe_relative(&runtime.executable)?;
        safe_relative(&runtime.resources)?;
        if runtime.platform != std::env::consts::OS
            || runtime.architecture != std::env::consts::ARCH
            || runtime.version != m.voxelcore_version
        {
            return invalid("Вложенный движок предназначен для другой системы");
        }
    }
    Ok(())
}

fn unpack_vpack(
    path: &Path,
    destination: &Path,
    progress: &dyn Fn(&str, u64, u64) -> bool,
) -> Result<(), PackageProblem> {
    let source = fs::File::open(path).map_err(json_error)?;
    let mut zip = ZipArchive::new(source).map_err(json_error)?;
    let mut names = HashSet::new();
    let mut total = 0u64;
    for index in 0..zip.len() {
        check_cancel(progress, "Проверяем файлы архива…")?;
        let mut file = zip.by_index(index).map_err(json_error)?;
        let name = file.name().to_owned();
        if !portable_path(&name)
            || !names.insert(name.to_lowercase())
            || file.is_dir()
            || file
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return invalid("В vpack найден небезопасный или повторяющийся путь");
        }
        total = total.saturating_add(file.size());
        if total > MAX_UNPACKED_SIZE {
            return invalid("vpack превышает 2 ГиБ");
        }
        let output = destination.join(&name);
        fs::create_dir_all(output.parent().unwrap()).map_err(json_error)?;
        let mut target = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(json_error)?;
        let expected = file.size();
        let executable = file.unix_mode().is_some_and(|mode| mode & 0o111 != 0);
        let copied = copy_checked(
            &mut file.by_ref().take(expected.saturating_add(1)),
            &mut target,
            progress,
            "Проверяем файлы архива…",
        )?;
        set_executable(&output, executable)?;
        if copied != expected {
            return invalid("Неверный размер файла vpack");
        }
    }
    Ok(())
}

fn validate_unpacked_budget(
    files: &BTreeMap<String, VpackFile>,
    archives: &[PathBuf],
) -> Result<(), PackageProblem> {
    let mut size = files
        .iter()
        .filter(|(name, _)| !name.starts_with("packages/"))
        .map(|(_, file)| file.size)
        .sum::<u64>();
    let mut count = files
        .keys()
        .filter(|name| !name.starts_with("packages/"))
        .count();
    for path in archives {
        let mut archive =
            ZipArchive::new(fs::File::open(path).map_err(json_error)?).map_err(json_error)?;
        count = count.saturating_add(archive.len());
        for index in 0..archive.len() {
            size = size.saturating_add(archive.by_index(index).map_err(json_error)?.size());
            if size > MAX_UNPACKED_SIZE {
                return invalid(
                    "Сборка превышает 2 ГиБ распакованных данных, включая вложенные пакеты",
                );
            }
        }
        if count > MAX_FILES {
            return invalid("В сборке больше 100 000 файлов, включая вложенные пакеты");
        }
    }
    Ok(())
}

fn read_manifest(path: &Path) -> Result<VpackManifest, PackageProblem> {
    let source = fs::File::open(path).map_err(|e| io_error(path, e))?;
    let mut archive = ZipArchive::new(source).map_err(json_error)?;
    if archive.len() > MAX_FILES + 1 {
        return invalid("В vpack слишком много файлов");
    }
    let mut file = archive.by_name("vpack.json").map_err(json_error)?;
    if file.size() > MAX_MANIFEST {
        return invalid("Слишком большое описание vpack");
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_MANIFEST + 1)
        .read_to_end(&mut bytes)
        .map_err(json_error)?;
    let m = serde_json::from_slice(&bytes).map_err(json_error)?;
    validate_manifest(&m)?;
    Ok(m)
}

impl ProfileStore {
    fn matches_vspace_copy(
        &self,
        source: &Path,
        client: &Client,
        remote: &RemoteInstallPackage,
        progress: &dyn Fn(&str, u64, u64) -> bool,
    ) -> Result<bool, PackageProblem> {
        let original = self.fetch_artifact_with_progress(client, remote, progress)?;
        let comparison = tempfile::tempdir().map_err(json_error)?;
        extract_archive(
            fs::File::open(original).map_err(json_error)?,
            comparison.path(),
        )?;
        same_tree(source, comparison.path(), progress)
    }

    fn local_vspace_reference(
        &self,
        source: &Path,
        client: &Client,
        registry: &str,
        progress: &dyn Fn(&str, u64, u64) -> bool,
    ) -> Result<Option<VpackPackage>, PackageProblem> {
        let manifest = PackageManifest::read(source)?;
        if !matches!(manifest.kind, PackageKind::Mod | PackageKind::Library)
            || source.file_name().and_then(|n| n.to_str()) != Some(&manifest.id)
        {
            return Ok(None);
        }
        let url = reqwest::Url::parse(&format!(
            "{}/projects/{}/releases",
            registry.trim_end_matches('/'),
            manifest.id
        ))
        .map_err(json_error)?;
        let releases: Vec<serde_json::Value> = client
            .get(url)
            .timeout(Duration::from_secs(30))
            .send()
            .map_err(json_error)?
            .error_for_status()
            .map_err(json_error)?
            .json()
            .map_err(json_error)?;
        let Some(release) = releases.iter().find(|r| r["version"] == manifest.version) else {
            return Ok(None);
        };
        let package = VpackPackage {
            id: manifest.id,
            kind: manifest.kind,
            version: manifest.version,
            artifact_sha256: release["artifact_sha256"]
                .as_str()
                .ok_or_else(|| json_error("Нет хеша релиза"))?
                .into(),
            artifact_size: release["artifact_size"]
                .as_u64()
                .ok_or_else(|| json_error("Нет размера релиза"))?,
            embedded: None,
            dependencies: manifest.dependencies.iter().map(|d| d.id.clone()).collect(),
        };
        let remote = registry_artifact(client, registry, &package)?;
        if self.matches_vspace_copy(source, client, &remote, progress)? {
            Ok(Some(package))
        } else {
            Ok(None)
        }
    }
}

impl ProfileStore {
    /// Save exactly the archive reviewed in the export preview, using an atomic replacement.
    pub fn save_vpack_copy(
        source: &Path,
        expected_hash: &str,
        expected_size: u64,
        destination: &Path,
    ) -> Result<(), PackageProblem> {
        let parent = destination.parent().unwrap_or(Path::new("."));
        let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(json_error)?;
        let mut original = fs::File::open(source).map_err(|e| io_error(source, e))?;
        std::io::copy(&mut original, &mut staged).map_err(json_error)?;
        if !verify_file(staged.path(), expected_hash, expected_size)? {
            return invalid("Подготовленный архив изменился. Подготовьте экспорт заново.");
        }
        staged.as_file().sync_all().map_err(json_error)?;
        staged.persist(destination).map_err(json_error)?;
        Ok(())
    }

    pub fn inspect_vpack(path: impl AsRef<Path>) -> Result<VpackPreview, PackageProblem> {
        let path = path.as_ref();
        let manifest = read_manifest(path)?;
        let download_size = manifest
            .packages
            .iter()
            .filter(|p| p.embedded.is_none())
            .map(|p| p.artifact_size)
            .sum();
        let embedded_size = manifest.files.values().map(|f| f.size).sum();
        let local_mods = manifest
            .files
            .keys()
            .filter_map(|p| {
                p.strip_prefix("game/content/")
                    .and_then(|p| p.split('/').next())
            })
            .collect::<HashSet<_>>()
            .len();
        Ok(VpackPreview {
            manifest,
            archive_sha256: digest(path)?,
            download_size,
            embedded_size,
            local_mods,
        })
    }

    pub fn export_vpack(
        &self,
        id: Uuid,
        destination: &Path,
        registry: &str,
        worlds: bool,
        settings: bool,
        progress: &dyn Fn(&str, u64, u64) -> bool,
    ) -> Result<(), PackageProblem> {
        let _lock = self.lock_profile(id)?;
        let profile = self.profile(id)?;
        let game = self.game_directory(id)?;
        let parent = destination.parent().unwrap_or(Path::new("."));
        let parent = dunce::canonicalize(parent).map_err(|e| io_error(parent, e))?;
        for source in [
            Some(self.profile_path(id)),
            Some(game.clone()),
            profile.external_project_path.clone(),
            profile.external_runtime.as_ref().map(|r| r.path.clone()),
        ]
        .into_iter()
        .flatten()
        {
            if let Ok(source) = dunce::canonicalize(&source) {
                if parent.starts_with(source) {
                    return invalid(
                        "Сохраните vpack за пределами папки экспортируемой игры или проекта",
                    );
                }
            }
        }
        let temporary = tempfile::tempdir().map_err(json_error)?;
        let payload = temporary.path().join("payload");
        fs::create_dir_all(payload.join("packages")).map_err(json_error)?;
        let version = profile
            .voxelcore_version
            .clone()
            .ok_or_else(|| json_error("Выберите версию VoxelCore перед экспортом"))?;
        let mut manifest = VpackManifest {
            format: FORMAT.into(),
            schema_version: 1,
            name: profile.name.clone(),
            icon: profile.icon.clone(),
            voxelcore_version: version,
            main_build: profile.main_build.clone(),
            roots: profile.roots.clone(),
            root_requirements: profile.root_requirements.clone(),
            packages: Vec::new(),
            worlds,
            settings,
            local_project: profile.external_project_path.is_some(),
            local_runtime: None,
            files: BTreeMap::new(),
        };
        let snapshot = self.active_snapshot(id)?;
        let lock: Option<InstallPlan> = snapshot
            .as_ref()
            .map(|s| {
                let path = s.join("vlauncher.lock.json");
                serde_json::from_slice(&fs::read(&path).map_err(|e| io_error(&path, e))?)
                    .map_err(json_error)
            })
            .transpose()?;
        let client = registry_client()?;
        let mut managed = HashSet::new();
        for (index, package) in lock.iter().flat_map(|p| &p.packages).enumerate() {
            check_cancel(progress, &format!("Проверяем {}…", package.id))?;
            let source = match package.kind {
                PackageKind::Mod | PackageKind::Library => {
                    managed.insert(package.id.clone());
                    game.join("content").join(&package.id)
                }
                PackageKind::Project => snapshot
                    .as_ref()
                    .unwrap()
                    .join("projects")
                    .join(&package.id),
                PackageKind::Modpack => snapshot
                    .as_ref()
                    .unwrap()
                    .join("modpacks")
                    .join(&package.id),
                PackageKind::World => snapshot
                    .as_ref()
                    .unwrap()
                    .join("world-templates")
                    .join(&package.id),
                PackageKind::Runtime => return invalid("Неожиданный движок среди пакетов профиля"),
            };
            if !source.is_dir() {
                return invalid(format!(
                    "Не найдены файлы {}. Восстановите пакет перед экспортом.",
                    package.id
                ));
            }
            let mut entry = VpackPackage {
                id: package.id.clone(),
                kind: package.kind.clone(),
                version: package.version.clone(),
                artifact_sha256: package.artifact_sha256.clone(),
                artifact_size: package.artifact_size,
                embedded: None,
                dependencies: package.dependencies.clone(),
            };
            let reference = registry_artifact(&client, registry, &entry)
                .ok()
                .and_then(|remote| {
                    self.matches_vspace_copy(&source, &client, &remote, progress)
                        .ok()
                })
                .unwrap_or(false);
            check_cancel(progress, "Проверяем состав сборки…")?;
            if !reference {
                let path = format!("packages/{index}.zip");
                if package.kind == PackageKind::Project {
                    VoxelCoreProject::read(&source)?;
                } else {
                    let current = PackageManifest::read(&source)?;
                    if current.kind != package.kind
                        || (matches!(package.kind, PackageKind::Mod | PackageKind::Library)
                            && current.id != package.id)
                    {
                        return invalid(format!(
                            "Изменён идентификатор или тип пака «{}». Исправьте описание перед экспортом.",
                            package.id
                        ));
                    }
                }
                write_zip(&source, &payload.join(&path), progress)?;
                entry.artifact_sha256 = digest_with_progress(&payload.join(&path), progress)?;
                entry.artifact_size = fs::metadata(payload.join(&path)).map_err(json_error)?.len();
                if package.kind != PackageKind::Project {
                    entry.version = PackageManifest::read(&source)?.version;
                }
                entry.embedded = Some(path);
            }
            manifest.packages.push(entry);
        }
        if game.join("content").is_dir() {
            for entry in fs::read_dir(game.join("content")).map_err(json_error)? {
                let entry = entry.map_err(json_error)?;
                if managed.contains(&entry.file_name().to_string_lossy().to_string()) {
                    continue;
                }
                if entry.file_name() == ".DS_Store" {
                    continue;
                }
                check_cancel(progress, "Проверяем локальные моды…")?;
                if !entry.file_type().map_err(json_error)?.is_dir() {
                    return invalid("В content ожидаются обычные папки модов");
                }
                let reference = self
                    .local_vspace_reference(&entry.path(), &client, registry, progress)
                    .ok()
                    .flatten();
                check_cancel(progress, "Копируем локальные моды…")?;
                if let Some(reference) = reference {
                    if !manifest.roots.contains(&reference.id) {
                        manifest.roots.push(reference.id.clone());
                    }
                    manifest.packages.push(reference);
                } else {
                    copy_vpack_tree(
                        &entry.path(),
                        &payload.join("game/content").join(entry.file_name()),
                        progress,
                        CopyPolicy::Content,
                    )?;
                }
            }
        }
        if worlds && game.join("worlds").exists() {
            check_cancel(progress, "Копируем миры…")?;
            copy_vpack_tree(
                &game.join("worlds"),
                &payload.join("game/worlds"),
                progress,
                CopyPolicy::Content,
            )?;
        }
        if settings {
            fs::create_dir_all(payload.join("game")).map_err(json_error)?;
            if game.join("config").is_dir() {
                copy_shareable_tree(&game.join("config"), &payload.join("game/config"), progress)?;
            }
            for name in ["settings.toml", "controls.toml"] {
                if let Some(bytes) = settings_transfer::read_settings_file(&game.join(name))? {
                    write_atomic(&payload.join("game").join(name), &bytes)?;
                }
            }
        }
        if let Some(project) = &profile.external_project_path {
            copy_shareable_tree(project, &payload.join("project"), progress)?;
        }
        if let Some(runtime) = &profile.external_runtime {
            // Keep custom engines inside the imported profile; never overwrite a shared runtime.
            copy_runtime_tree(runtime, &game, &payload.join("runtime"), progress)?;
            manifest.local_runtime = Some(RuntimeManifest {
                schema_version: 1,
                version: manifest.voxelcore_version.clone(),
                platform: std::env::consts::OS.into(),
                architecture: std::env::consts::ARCH.into(),
                executable: runtime.executable.clone(),
                resources: runtime.resources.clone(),
            });
        }
        manifest.files = file_inventory_with_progress(&payload, progress)?;
        validate_manifest(&manifest)?;
        let archives = manifest
            .packages
            .iter()
            .map(|p| {
                p.embedded
                    .as_ref()
                    .map(|path| payload.join(path))
                    .unwrap_or_else(|| self.root.join("cache/blobs").join(&p.artifact_sha256))
            })
            .collect::<Vec<_>>();
        validate_unpacked_budget(&manifest.files, &archives)?;
        let bytes = serde_json::to_vec_pretty(&manifest).map_err(json_error)?;
        if bytes.len() as u64 > MAX_MANIFEST {
            return invalid("Описание vpack превышает 4 МиБ");
        }
        fs::write(payload.join("vpack.json"), bytes).map_err(json_error)?;
        let parent = destination.parent().unwrap_or(Path::new("."));
        let staged = tempfile::NamedTempFile::new_in(parent).map_err(json_error)?;
        write_zip(&payload, staged.path(), progress)?;
        check_cancel(progress, "Завершаем экспорт…")?;
        staged.persist(destination).map_err(json_error)?;
        Ok(())
    }

    pub fn import_vpack(
        &self,
        path: &Path,
        expected_hash: &str,
        registry: &str,
        progress: &dyn Fn(&str, u64, u64) -> bool,
    ) -> Result<Profile, PackageProblem> {
        let preview = Self::inspect_vpack(path)?;
        if preview.archive_sha256 != expected_hash {
            return invalid("Файл vpack изменился после предпросмотра. Откройте его заново.");
        }
        let m = preview.manifest;
        let temporary = tempfile::tempdir().map_err(json_error)?;
        // Extract into an isolated directory, then verify the complete file inventory.
        unpack_vpack(path, temporary.path(), progress)?;
        let actual = file_inventory_with_progress(temporary.path(), progress)?;
        if actual.len() != m.files.len() + 1
            || m.files.iter().any(|(name, expected)| {
                !actual.get(name).is_some_and(|f| {
                    f.size == expected.size
                        && f.sha256 == expected.sha256
                        && (!cfg!(unix) || f.executable == expected.executable)
                })
            })
        {
            return invalid("Содержимое vpack не соответствует описанию или повреждено");
        }
        let client = registry_client()?;
        let mut packages = Vec::new();
        for package in &m.packages {
            check_cancel(progress, &format!("Подготовка {}…", package.id))?;
            let archive_path = if let Some(embedded) = &package.embedded {
                temporary.path().join(embedded)
            } else {
                let remote = registry_artifact(&client, registry, package)?;
                self.fetch_artifact_with_progress(&client, &remote, progress)?
            };
            packages.push(InstallPackage {
                id: package.id.clone(),
                kind: package.kind.clone(),
                version: package.version.clone(),
                artifact_sha256: package.artifact_sha256.clone(),
                artifact_size: package.artifact_size,
                archive_path,
                dependencies: package.dependencies.clone(),
            });
        }
        validate_unpacked_budget(
            &m.files,
            &packages
                .iter()
                .map(|p| p.archive_path.clone())
                .collect::<Vec<_>>(),
        )?;
        check_cancel(progress, "Создание профиля…")?;
        let profile = self.create(&m.name)?;
        let result = (|| {
            self.apply_with_metadata(
                profile.id,
                &InstallPlan {
                    revision: format!("vpack-{}", Uuid::new_v4()),
                    packages,
                },
                &ProfileSnapshotMetadata {
                    main_build: m.main_build.clone(),
                    voxelcore_version: Some(m.voxelcore_version.clone()),
                    roots: m.roots.clone(),
                    root_requirements: m.root_requirements.clone(),
                },
            )?;
            let root = self.profile_path(profile.id);
            let game = self.game_directory(profile.id)?;
            let incoming = temporary.path().join("game");
            if incoming.exists() {
                // Manual content must never shadow a managed package.
                if incoming.join("content").exists() {
                    for entry in fs::read_dir(incoming.join("content")).map_err(json_error)? {
                        let entry = entry.map_err(json_error)?;
                        if m.packages.iter().any(|p| {
                            matches!(p.kind, PackageKind::Mod | PackageKind::Library)
                                && p.id
                                    .eq_ignore_ascii_case(&entry.file_name().to_string_lossy())
                        }) || game.join("content").join(entry.file_name()).exists()
                        {
                            return invalid("Локальный мод конфликтует с пакетом сборки");
                        }
                    }
                }
                if m.worlds && game.join("worlds").exists() {
                    fs::remove_dir_all(game.join("worlds")).map_err(json_error)?;
                }
                copy_vpack_tree(&incoming, &game, progress, CopyPolicy::Verified)?;
            }
            if m.local_project {
                let destination = root.join("project");
                copy_vpack_tree(
                    &temporary.path().join("project"),
                    &destination,
                    progress,
                    CopyPolicy::Verified,
                )?;
                VoxelCoreProject::read(&destination)?;
                self.with_database(|db| {
                    db.execute(
                        "UPDATE profiles SET external_project_path = ?1 WHERE id = ?2",
                        params![destination.to_string_lossy(), profile.id.to_string()],
                    )?;
                    Ok(())
                })?;
            }
            if let Some(runtime) = &m.local_runtime {
                let destination = root.join("runtime");
                copy_vpack_tree(
                    &temporary.path().join("runtime"),
                    &destination,
                    progress,
                    CopyPolicy::Verified,
                )?;
                // The format omits empty directories; this required one is declared by runtime metadata.
                fs::create_dir_all(destination.join(&runtime.resources)).map_err(json_error)?;
                if !destination.join(&runtime.executable).is_file()
                    || !destination.join(&runtime.resources).is_dir()
                {
                    return invalid("В vpack отсутствуют файлы локального движка");
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(
                        destination.join(&runtime.executable),
                        fs::Permissions::from_mode(0o755),
                    )
                    .map_err(json_error)?;
                }
                let external = ExternalRuntime {
                    path: destination,
                    executable: runtime.executable.clone(),
                    resources: runtime.resources.clone(),
                };
                let json = serde_json::to_string(&external).map_err(json_error)?;
                self.with_database(|db| {
                    db.execute(
                        "UPDATE profiles SET external_runtime_json = ?1 WHERE id = ?2",
                        params![json, profile.id.to_string()],
                    )?;
                    Ok(())
                })?;
            }
            check_cancel(progress, "Завершаем импорт…")?;
            self.set_icon(profile.id, m.icon.as_deref())?;
            self.profile(profile.id)
        })();
        if result.is_err() {
            let _ = self.delete_profile(profile.id);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn fixture() -> (tempfile::TempDir, ProfileStore, Profile) {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("library")).unwrap();
        let profile = store.create_initialized("Моя сборка", "0.32.7").unwrap();
        let game = store.game_directory(profile.id).unwrap();
        fs::create_dir_all(game.join("content/local_mod/scripts")).unwrap();
        fs::write(game.join("content/local_mod/scripts/main.lua"), "return 42").unwrap();
        fs::create_dir_all(game.join("worlds/home")).unwrap();
        fs::write(game.join("worlds/home/world.json"), "saved world").unwrap();
        fs::write(game.join("settings.toml"), "volume = 0.5\n").unwrap();
        fs::write(game.join("controls.toml"), "jump = 'space'\n").unwrap();
        fs::create_dir_all(game.join("config")).unwrap();
        fs::write(game.join("config/mod.toml"), "enabled = true\n").unwrap();
        fs::create_dir_all(game.join("logs")).unwrap();
        fs::write(game.join("logs/private.log"), "do not share").unwrap();
        (temp, store, profile)
    }
    fn always(_: &str, _: u64, _: u64) -> bool {
        true
    }
    fn registry() -> &'static str {
        "http://127.0.0.1:1/api/v1"
    }

    #[test]
    fn round_trip_local_mods_worlds_and_settings_creates_independent_profile() {
        let (temp, store, profile) = fixture();
        let path = temp.path().join("test.vpack");
        store
            .export_vpack(profile.id, &path, registry(), true, true, &always)
            .unwrap();
        let preview = ProfileStore::inspect_vpack(&path).unwrap();
        assert_eq!(preview.local_mods, 1);
        assert_eq!(preview.download_size, 0);
        assert!(
            !preview
                .manifest
                .files
                .keys()
                .any(|p| p.contains("private.log"))
        );
        let imported = store
            .import_vpack(&path, &preview.archive_sha256, registry(), &always)
            .unwrap();
        assert_ne!(imported.id, profile.id);
        assert_eq!(imported.name, profile.name);
        let game = store.game_directory(imported.id).unwrap();
        assert_eq!(
            fs::read_to_string(game.join("content/local_mod/scripts/main.lua")).unwrap(),
            "return 42"
        );
        assert_eq!(
            fs::read_to_string(game.join("worlds/home/world.json")).unwrap(),
            "saved world"
        );
        assert_eq!(
            fs::read_to_string(game.join("settings.toml")).unwrap(),
            "volume = 0.5\n"
        );
        assert_eq!(
            fs::read_to_string(game.join("config/mod.toml")).unwrap(),
            "enabled = true\n"
        );
        fs::write(game.join("content/local_mod/scripts/main.lua"), "edited").unwrap();
        assert_eq!(
            fs::read_to_string(
                store
                    .game_directory(profile.id)
                    .unwrap()
                    .join("content/local_mod/scripts/main.lua")
            )
            .unwrap(),
            "return 42"
        );
    }
    #[test]
    fn excludes_worlds_and_settings_by_default() {
        let (temp, store, profile) = fixture();
        let path = temp.path().join("test.vpack");
        store
            .export_vpack(profile.id, &path, registry(), false, false, &always)
            .unwrap();
        let preview = ProfileStore::inspect_vpack(&path).unwrap();
        assert!(
            !preview
                .manifest
                .files
                .keys()
                .any(|p| p.starts_with("game/worlds/")
                    || p.ends_with("settings.toml")
                    || p.ends_with("controls.toml"))
        );
    }
    #[test]
    fn modified_managed_mod_is_embedded_and_survives_round_trip() {
        let (temp, store, profile) = fixture();
        let source = temp.path().join("package");
        fs::create_dir_all(source.join("scripts")).unwrap();
        fs::write(source.join("package.json"), serde_json::to_vec(&serde_json::json!({
            "schema_version": 1, "id": "demo_mod", "type": "mod", "title": "Demo", "version": "1.0.0",
            "creators": ["Test"], "description": "Demo", "license": "MIT"
        })).unwrap()).unwrap();
        fs::write(source.join("scripts/main.lua"), "original").unwrap();
        let archive = temp.path().join("mod.zip");
        write_zip(&source, &archive, &always).unwrap();
        store
            .apply_with_metadata(
                profile.id,
                &InstallPlan {
                    revision: "catalog".into(),
                    packages: vec![InstallPackage {
                        id: "demo_mod".into(),
                        kind: PackageKind::Mod,
                        version: "1.0.0".into(),
                        artifact_sha256: digest(&archive).unwrap(),
                        artifact_size: fs::metadata(&archive).unwrap().len(),
                        archive_path: archive,
                        dependencies: vec![],
                    }],
                },
                &ProfileSnapshotMetadata {
                    main_build: None,
                    voxelcore_version: Some("0.32.7".into()),
                    roots: vec!["demo_mod".into()],
                    root_requirements: HashMap::new(),
                },
            )
            .unwrap();
        let game = store.game_directory(profile.id).unwrap();
        fs::write(
            game.join("content/demo_mod/scripts/main.lua"),
            "user changes",
        )
        .unwrap();
        let path = temp.path().join("test.vpack");
        store
            .export_vpack(profile.id, &path, registry(), false, false, &always)
            .unwrap();
        let preview = ProfileStore::inspect_vpack(&path).unwrap();
        assert!(preview.manifest.packages[0].embedded.is_some());
        let imported = store
            .import_vpack(&path, &preview.archive_sha256, registry(), &always)
            .unwrap();
        assert_eq!(
            fs::read_to_string(
                store
                    .game_directory(imported.id)
                    .unwrap()
                    .join("content/demo_mod/scripts/main.lua")
            )
            .unwrap(),
            "user changes"
        );
        let manifest_path = game.join("content/demo_mod/package.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest["id"] = serde_json::json!("renamed_mod");
        fs::write(manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let rejected = temp.path().join("invalid.vpack");
        assert!(
            store
                .export_vpack(profile.id, &rejected, registry(), false, false, &always)
                .is_err()
        );
        assert!(!rejected.exists());
    }
    #[test]
    fn cancelling_inside_a_large_world_copy_preserves_the_previous_archive() {
        use std::cell::Cell;
        let (temp, store, profile) = fixture();
        let game = store.game_directory(profile.id).unwrap();
        fs::remove_dir_all(game.join("content/local_mod")).unwrap();
        fs::remove_file(game.join("worlds/home/world.json")).unwrap();
        fs::write(game.join("worlds/home/large.bin"), vec![0; 1024 * 1024]).unwrap();
        let target = temp.path().join("export.vpack");
        fs::write(&target, "previous export").unwrap();
        let calls = Cell::new(0);
        let result = store.export_vpack(
            profile.id,
            &target,
            registry(),
            true,
            false,
            &|label, _, _| {
                if label == "Копируем файлы…" {
                    calls.set(calls.get() + 1);
                }
                calls.get() < 4
            },
        );
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "previous export");
    }

    #[test]
    fn nested_zip_cannot_write_more_than_its_declared_size() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("forged.zip");
        let mut writer = ZipWriter::new(fs::File::create(&path).unwrap());
        writer
            .start_file(
                "large.bin",
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        writer.write_all(&vec![b'x'; 1024 * 1024]).unwrap();
        writer.finish().unwrap();
        let mut bytes = fs::read(&path).unwrap();
        let central = bytes
            .windows(4)
            .position(|part| part == b"PK\x01\x02")
            .unwrap();
        bytes[central + 24..central + 28].copy_from_slice(&1u32.to_le_bytes());
        fs::write(&path, bytes).unwrap();
        let output = temp.path().join("unpacked");
        assert!(extract_archive(fs::File::open(path).unwrap(), &output).is_err());
        if output.join("large.bin").exists() {
            assert!(fs::metadata(output.join("large.bin")).unwrap().len() <= 2);
        }
    }

    #[cfg(unix)]
    #[test]
    fn embedded_package_preserves_executable_helpers_without_special_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("helper.zip");
        let mut zip = ZipWriter::new(fs::File::create(&path).unwrap());
        zip.start_file(
            "bin/helper",
            SimpleFileOptions::default().unix_permissions(0o4755),
        )
        .unwrap();
        zip.write_all(b"#!/bin/sh\nexit 0\n").unwrap();
        zip.finish().unwrap();
        let output = temp.path().join("unpacked");
        extract_archive(fs::File::open(path).unwrap(), &output).unwrap();
        assert_eq!(
            fs::metadata(output.join("bin/helper"))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777,
            0o755
        );
    }

    #[test]
    fn cancellation_preserves_existing_export_and_creates_no_imported_profile() {
        let (temp, store, profile) = fixture();
        let path = temp.path().join("test.vpack");
        fs::write(&path, "previous archive").unwrap();
        assert!(
            store
                .export_vpack(profile.id, &path, registry(), true, true, &|_, _, _| false)
                .is_err()
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "previous archive");
        store
            .export_vpack(profile.id, &path, registry(), false, false, &always)
            .unwrap();
        let preview = ProfileStore::inspect_vpack(&path).unwrap();
        assert!(
            store
                .import_vpack(&path, &preview.archive_sha256, registry(), &|_, _, _| false)
                .is_err()
        );
        assert_eq!(store.list().unwrap().len(), 1);
    }
    #[test]
    fn changed_archive_and_payload_corruption_are_rejected_without_profile() {
        let (temp, store, profile) = fixture();
        let path = temp.path().join("test.vpack");
        store
            .export_vpack(profile.id, &path, registry(), false, false, &always)
            .unwrap();
        let preview = ProfileStore::inspect_vpack(&path).unwrap();
        assert!(
            store
                .import_vpack(&path, &"0".repeat(64), registry(), &always)
                .is_err()
        );
        let unpacked = temp.path().join("unpacked");
        unpack_vpack(&path, &unpacked, &always).unwrap();
        fs::write(
            unpacked.join("game/content/local_mod/scripts/main.lua"),
            "tampered",
        )
        .unwrap();
        write_zip(&unpacked, &path, &always).unwrap();
        assert!(
            store
                .import_vpack(&path, &digest(&path).unwrap(), registry(), &always)
                .is_err()
        );
        assert_eq!(store.list().unwrap().len(), 1);
        assert_ne!(digest(&path).unwrap(), preview.archive_sha256);
    }
    #[test]
    fn zip_traversal_and_duplicate_names_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        for names in [["../escape", "safe"], ["file", "FILE"]] {
            let path = temp.path().join("bad.zip");
            let mut zip = ZipWriter::new(fs::File::create(&path).unwrap());
            for name in names {
                zip.start_file(name, SimpleFileOptions::default()).unwrap();
                zip.write_all(b"data").unwrap();
            }
            zip.finish().unwrap();
            assert!(
                unpack_vpack(
                    &path,
                    &temp.path().join(Uuid::new_v4().to_string()),
                    &always
                )
                .is_err()
            );
        }
        assert!(!temp.path().join("escape").exists());
    }
    #[test]
    fn trusted_release_signature_covers_actual_payload_and_rejects_unknown_key() {
        let key = SigningKey::from_bytes(&[7; 32]);
        let public = URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes());
        let payload = serde_json::to_vec(
            &serde_json::json!({ "version": "1.0.0", "artifact_sha256": "a".repeat(64) }),
        )
        .unwrap();
        let mut attestation = serde_json::json!({ "algorithm": "Ed25519", "key_id": &hex::encode(Sha256::digest(key.verifying_key().as_bytes()))[..16],
            "payload": URL_SAFE_NO_PAD.encode(&payload), "signature": URL_SAFE_NO_PAD.encode(key.sign(&payload).to_bytes()),
            "assertion": { "version": "fake" } });
        assert_eq!(
            verify_attestation_with_keys(&attestation, &[&public]).unwrap()["version"],
            "1.0.0"
        );
        assert!(verify_attestation_with_keys(&attestation, &[]).is_err());
        attestation["payload"] = serde_json::json!(URL_SAFE_NO_PAD.encode(b"{}"));
        assert!(verify_attestation_with_keys(&attestation, &[&public]).is_err());
    }
    #[test]
    fn missing_and_broken_runtimes_have_different_health_states() {
        let (temp, store, profile) = fixture();
        let issues = store.check_health(profile.id, "0.32.7").unwrap();
        assert!(issues.iter().any(|i| i.kind == "runtime_missing"));
        let runtime = temp.path().join("runtime");
        fs::create_dir_all(runtime.join("res")).unwrap();
        fs::write(runtime.join("game"), "executable").unwrap();
        fs::write(
            runtime.join("runtime.json"),
            serde_json::to_vec(&RuntimeManifest {
                schema_version: 1,
                version: "0.32.7".into(),
                platform: std::env::consts::OS.into(),
                architecture: std::env::consts::ARCH.into(),
                executable: "game".into(),
                resources: "res".into(),
            })
            .unwrap(),
        )
        .unwrap();
        let installed = store.import_runtime(&runtime).unwrap();
        assert!(store.check_health(profile.id, "0.32.7").unwrap().is_empty());
        fs::remove_file(installed.path.join("game")).unwrap();
        let issues = store.check_health(profile.id, "0.32.7").unwrap();
        assert!(issues.iter().any(|i| i.kind == "runtime"));
        assert!(!issues.iter().any(|i| i.kind == "runtime_missing"));
    }
    #[test]
    fn catalog_reference_uses_exact_attested_artifact_and_downloads_verified_bytes() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let registry = format!("http://{}/api/v1", listener.local_addr().unwrap());
        let bytes = b"an exact immutable artifact".to_vec();
        let hash = hex::encode(Sha256::digest(&bytes));
        let expected = VpackPackage {
            id: "demo_mod".into(),
            kind: PackageKind::Mod,
            version: "1.0.0".into(),
            artifact_sha256: hash.clone(),
            artifact_size: bytes.len() as u64,
            embedded: None,
            dependencies: vec![],
        };
        let key = SigningKey::from_bytes(&[7; 32]);
        let public = URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes());
        let assertion = serde_json::json!({ "schema_version": 1, "project": "project-id", "version": "1.0.0",
            "artifact_sha256": hash, "artifact_size": bytes.len(), "manifest": { "id": "demo_mod", "type": "mod" } });
        let payload = serde_json::to_vec(&assertion).unwrap();
        let release = serde_json::json!({ "version": "1.0.0", "artifact_sha256": hash,
            "attestation": { "algorithm": "Ed25519", "key_id": &hex::encode(Sha256::digest(key.verifying_key().as_bytes()))[..16],
                "payload": URL_SAFE_NO_PAD.encode(&payload), "signature": URL_SAFE_NO_PAD.encode(key.sign(&payload).to_bytes()) } });
        let server_bytes = bytes.clone();
        let server = std::thread::spawn(move || {
            let responses = [
                serde_json::to_vec(&serde_json::json!({ "id": "project-id" })).unwrap(),
                serde_json::to_vec(&vec![release]).unwrap(),
                server_bytes,
            ];
            for (index, body) in responses.into_iter().enumerate() {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = [0; 4096];
                let length = socket.read(&mut request).unwrap();
                let request = std::str::from_utf8(&request[..length]).unwrap();
                assert!(request.starts_with(match index {
                    0 => "GET /api/v1/projects/demo_mod ",
                    1 => "GET /api/v1/projects/demo_mod/releases ",
                    _ => "GET /api/v1/artifacts/",
                }));
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                socket.write_all(&body).unwrap();
            }
        });
        let client = registry_client().unwrap();
        let remote = registry_artifact_verified(&client, &registry, &expected, &|value| {
            verify_attestation_with_keys(value, &[&public])
        })
        .unwrap();
        assert_eq!(remote.version, "1.0.0");
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path()).unwrap();
        let fetched = store
            .fetch_artifact_with_progress(&client, &remote, &always)
            .unwrap();
        assert_eq!(fs::read(fetched).unwrap(), bytes);
        server.join().unwrap();
    }

    #[test]
    fn failed_profile_commit_is_cleaned_up_and_external_project_can_be_reconnected() {
        let (temp, store, profile) = fixture();
        let path = temp.path().join("test.vpack");
        store
            .export_vpack(profile.id, &path, registry(), false, false, &always)
            .unwrap();
        let unpacked = temp.path().join("unpacked");
        unpack_vpack(&path, &unpacked, &always).unwrap();
        let mut m = read_manifest(&path).unwrap();
        m.icon = Some("invalid icon".into());
        fs::write(unpacked.join("vpack.json"), serde_json::to_vec(&m).unwrap()).unwrap();
        write_zip(&unpacked, &path, &always).unwrap();
        assert!(
            store
                .import_vpack(&path, &digest(&path).unwrap(), registry(), &always)
                .is_err()
        );
        assert_eq!(store.list().unwrap().len(), 1);
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        fs::write(
            project.join("project.toml"),
            "name = 'demo'\ntitle = 'Demo'\n",
        )
        .unwrap();
        let local = store
            .create_local_project("Local", &project, "0.32.7", None)
            .unwrap();
        let moved = temp.path().join("moved");
        fs::rename(&project, &moved).unwrap();
        let updated = store
            .reconnect_profile_source(local.id, &moved, true)
            .unwrap();
        assert_eq!(
            updated.external_project_path.as_deref(),
            Some(dunce::canonicalize(&moved).unwrap().as_path())
        );
    }
    #[test]
    fn local_project_and_custom_runtime_are_copied_and_remain_independent() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("library")).unwrap();
        let source = temp.path().join("target");
        fs::create_dir_all(source.join(".git")).unwrap();
        fs::write(
            source.join("project.toml"),
            "name = 'demo'\ntitle = 'Demo'\n",
        )
        .unwrap();
        fs::write(source.join(".env"), "SECRET=value").unwrap();
        fs::write(source.join(".git/config"), "private metadata").unwrap();
        fs::create_dir_all(source.join("bin")).unwrap();
        fs::write(source.join("bin/helper"), "project helper").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(source.join("bin/helper"), fs::Permissions::from_mode(0o755))
                .unwrap();
        }
        let profile = store
            .create_local_project("Local", &source, "0.32.7", None)
            .unwrap();
        let runtime = temp.path().join("engine");
        fs::create_dir_all(runtime.join("res")).unwrap();
        fs::write(runtime.join("game"), "custom engine").unwrap();
        fs::write(runtime.join("res/asset.txt"), "resources").unwrap();
        fs::write(runtime.join(".env"), "APPDIR_LIBC_VERSION=2.35\n").unwrap();
        let external = ExternalRuntime {
            path: runtime,
            executable: "game".into(),
            resources: "res".into(),
        };
        store
            .with_database(|db| {
                db.execute(
                    "UPDATE profiles SET external_runtime_json = ?1 WHERE id = ?2",
                    params![
                        serde_json::to_string(&external).unwrap(),
                        profile.id.to_string()
                    ],
                )?;
                Ok(())
            })
            .unwrap();
        let path = temp.path().join("local.vpack");
        store
            .export_vpack(profile.id, &path, registry(), false, false, &always)
            .unwrap();
        let preview = ProfileStore::inspect_vpack(&path).unwrap();
        assert!(preview.manifest.local_project);
        assert!(preview.manifest.local_runtime.is_some());
        assert!(preview.manifest.files.contains_key("runtime/.env"));
        assert!(
            !preview
                .manifest
                .files
                .keys()
                .any(|p| p.starts_with("project/.env") || p.contains(".git"))
        );
        let imported = store
            .import_vpack(&path, &preview.archive_sha256, registry(), &always)
            .unwrap();
        assert_ne!(
            imported.external_project_path,
            profile.external_project_path
        );
        let spec = store.launch_spec(imported.id, "0.32.7").unwrap();
        assert_eq!(
            fs::read_to_string(&spec.executable).unwrap(),
            "custom engine"
        );
        assert!(spec.arguments.iter().any(|a| a == "--project"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(
                    imported
                        .external_project_path
                        .as_ref()
                        .unwrap()
                        .join("bin/helper")
                )
                .unwrap()
                .permissions()
                .mode()
                    & 0o111,
                0o111
            );
        }
        assert!(
            imported
                .external_runtime
                .as_ref()
                .unwrap()
                .path
                .join(".env")
                .is_file()
        );
        fs::remove_dir_all(source).unwrap();
        assert!(store.launch_spec(imported.id, "0.32.7").is_ok());
    }

    #[test]
    fn late_cancellation_rolls_back_profile_and_export_cannot_include_itself() {
        let (temp, store, profile) = fixture();
        let inside = store
            .game_directory(profile.id)
            .unwrap()
            .join("share.vpack");
        assert!(
            store
                .export_vpack(profile.id, &inside, registry(), false, false, &always)
                .is_err()
        );
        let path = temp.path().join("test.vpack");
        store
            .export_vpack(profile.id, &path, registry(), false, false, &always)
            .unwrap();
        let preview = ProfileStore::inspect_vpack(&path).unwrap();
        assert!(
            store
                .import_vpack(
                    &path,
                    &preview.archive_sha256,
                    registry(),
                    &|label, _, _| label != "Завершаем импорт…"
                )
                .is_err()
        );
        assert_eq!(store.list().unwrap().len(), 1);
    }
    #[test]
    fn catalog_identity_is_not_enough_when_local_files_have_changed() {
        let (temp, store, _) = fixture();
        let source = temp.path().join("mod");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("main.lua"), "original").unwrap();
        let archive = temp.path().join("mod.zip");
        write_zip(&source, &archive, &always).unwrap();
        let hash = digest(&archive).unwrap();
        let remote = RemoteInstallPackage {
            id: "demo_mod".into(),
            title: None,
            kind: PackageKind::Mod,
            version: "1.0.0".into(),
            artifact_sha256: hash.clone(),
            artifact_size: fs::metadata(&archive).unwrap().len(),
            download_url: "http://127.0.0.1:1/unavailable".into(),
            dependencies: vec![],
        };
        fs::copy(&archive, store.root.join("cache/blobs").join(hash)).unwrap();
        let client = registry_client().unwrap();
        assert!(
            store
                .matches_vspace_copy(&source, &client, &remote, &always)
                .unwrap()
        );
        fs::write(source.join("main.lua"), "user changes").unwrap();
        assert!(
            !store
                .matches_vspace_copy(&source, &client, &remote, &always)
                .unwrap()
        );
        fs::write(source.join("main.lua"), "original").unwrap();
        fs::write(source.join("extra.lua"), "new file").unwrap();
        assert!(
            !store
                .matches_vspace_copy(&source, &client, &remote, &always)
                .unwrap()
        );
    }
    #[test]
    fn previewed_export_is_saved_exactly_and_failed_verification_preserves_destination() {
        let (temp, store, profile) = fixture();
        let prepared = temp.path().join("prepared.vpack");
        store
            .export_vpack(profile.id, &prepared, registry(), false, false, &always)
            .unwrap();
        let preview = ProfileStore::inspect_vpack(&prepared).unwrap();
        let size = fs::metadata(&prepared).unwrap().len();
        let target = temp.path().join("saved.vpack");
        fs::write(&target, "previous").unwrap();
        assert!(ProfileStore::save_vpack_copy(&prepared, &"0".repeat(64), size, &target).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "previous");
        ProfileStore::save_vpack_copy(&prepared, &preview.archive_sha256, size, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), fs::read(prepared).unwrap());
    }
    #[test]
    fn attached_runtime_cannot_smuggle_unselected_worlds_or_settings() {
        for nested in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let store = ProfileStore::open(temp.path().join("library")).unwrap();
            let profile = store.create_initialized("Attached", "0.32.7").unwrap();
            let runtime = temp.path().join("engine");
            fs::create_dir_all(runtime.join("res")).unwrap();
            fs::write(runtime.join("engine"), "executable").unwrap();
            if nested {
                fs::write(runtime.join("res/asset"), "engine asset").unwrap();
            }
            let game = if nested {
                runtime.join("user")
            } else {
                runtime.clone()
            };
            fs::create_dir_all(game.join("worlds/private")).unwrap();
            fs::create_dir_all(game.join("config")).unwrap();
            fs::write(game.join("worlds/private/save.bin"), "private save").unwrap();
            fs::write(game.join("settings.toml"), "private settings").unwrap();
            fs::write(game.join("config/mod.toml"), "private mod settings").unwrap();
            let external = ExternalRuntime {
                path: runtime.clone(),
                executable: "engine".into(),
                resources: "res".into(),
            };
            store.with_database(|db| {
                db.execute("UPDATE profiles SET external_game_path = ?1, external_runtime_json = ?2 WHERE id = ?3",
                    params![game.to_string_lossy(), serde_json::to_string(&external).unwrap(), profile.id.to_string()])?;
                Ok(())
            }).unwrap();
            let output = temp.path().join("export.vpack");
            store
                .export_vpack(profile.id, &output, registry(), false, false, &always)
                .unwrap();
            let preview = ProfileStore::inspect_vpack(&output).unwrap();
            if nested {
                assert!(preview.manifest.files.contains_key("runtime/res/asset"));
            }
            let imported = store
                .import_vpack(&output, &preview.archive_sha256, registry(), &always)
                .unwrap();
            let imported_runtime = imported.external_runtime.unwrap();
            assert!(imported_runtime.path.join("res").is_dir());
            assert!(
                !store
                    .game_directory(imported.id)
                    .unwrap()
                    .join("worlds/private/save.bin")
                    .exists()
            );
            assert!(preview.manifest.files.contains_key("runtime/engine"));
            assert!(
                !preview
                    .manifest
                    .files
                    .keys()
                    .any(|path| path.contains("private")
                        || path.contains("settings.toml")
                        || path.ends_with("mod.toml"))
            );
        }
    }
}
