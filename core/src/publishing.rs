use std::{
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use walkdir::WalkDir;
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

use crate::{Capability, PackageKind, PackageManifest, PackageProblem, VoxelCoreProject};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparedArtifact {
    pub path: PathBuf,
    pub sha256: String,
    pub size: u64,
    pub manifest: PackageManifest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadReceipt {
    pub id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VoxelCoreMainRequirement {
    pub target_version: String,
    pub min_commit: String,
}

#[derive(Deserialize)]
struct UploadSession {
    id: String,
    #[serde(default)]
    part_size: usize,
    #[serde(default)]
    status: String,
    #[serde(default)]
    parts: Vec<UploadedPart>,
}

#[derive(Deserialize)]
struct UploadedPart {
    number: usize,
}

#[derive(Serialize, Deserialize)]
struct SavedUpload {
    id: String,
    registry_url: String,
    project_id: String,
    artifact_sha256: String,
    part_size: usize,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    changelog: Option<String>,
    voxelcore: String,
    #[serde(default)]
    voxelcore_main: Option<VoxelCoreMainRequirement>,
}

fn problem(message: impl Into<String>) -> PackageProblem {
    PackageProblem::Invalid(message.into())
}

pub fn prepare_package(
    folder: impl AsRef<Path>,
    output_folder: impl AsRef<Path>,
) -> Result<PreparedArtifact, PackageProblem> {
    let folder = folder.as_ref();
    if folder.is_file() {
        return prepare_zip_package(folder, output_folder.as_ref());
    }
    let root = package_root(folder)?;
    let folder = root.as_path();
    let manifest = PackageManifest::read(folder).map_err(|error| problem(format!(
        "Не удалось проверить package.json: {error}. Проверьте ID, версию, авторов и зависимости пака."
    )))?;
    fs::create_dir_all(output_folder.as_ref()).map_err(|source| PackageProblem::Io {
        path: output_folder.as_ref().to_owned(),
        source,
    })?;
    let source_root = fs::canonicalize(folder).map_err(|error| problem(error.to_string()))?;
    let output_root =
        fs::canonicalize(output_folder.as_ref()).map_err(|error| problem(error.to_string()))?;
    if output_root.starts_with(&source_root) {
        return Err(problem(
            "Папка для подготовленных архивов не должна находиться внутри пака",
        ));
    }
    let target = output_folder.as_ref().join(format!(
        "{}-{}-{}.zip",
        manifest.id,
        manifest.version,
        Uuid::new_v4()
    ));
    let temporary = tempfile::NamedTempFile::new_in(output_folder.as_ref())
        .map_err(|error| problem(error.to_string()))?;
    let file = temporary
        .reopen()
        .map_err(|error| problem(error.to_string()))?;
    let mut archive = ZipWriter::new(file);
    let mut paths = std::collections::HashSet::new();
    let mut total = 0_u64;
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    for entry in WalkDir::new(folder)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| {
            !ignored_package_path(entry.path().strip_prefix(folder).unwrap_or(entry.path()))
        })
    {
        let entry = entry.map_err(|error| problem(error.to_string()))?;
        if entry.file_type().is_symlink() {
            return Err(problem(format!(
                "symbolic links are forbidden: {}",
                entry.path().display()
            )));
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(folder)
            .map_err(|error| problem(error.to_string()))?
            .to_string_lossy()
            .replace('\\', "/");
        if relative.split('/').next() == Some(".git") {
            continue;
        }
        if relative.contains(':') || !paths.insert(relative.to_lowercase()) {
            return Err(problem(format!(
                "Путь не переносим между системами или повторяется: {relative}"
            )));
        }
        total = total.saturating_add(
            entry
                .metadata()
                .map_err(|error| problem(error.to_string()))?
                .len(),
        );
        if paths.len() > 100_000 || total > 2 * 1024 * 1024 * 1024 {
            return Err(problem(
                "Пак превышает лимит: 100 000 файлов или 2 ГБ после распаковки",
            ));
        }
        archive
            .start_file(&relative, options)
            .map_err(|error| problem(error.to_string()))?;
        let mut input = fs::File::open(entry.path()).map_err(|source| PackageProblem::Io {
            path: entry.path().to_owned(),
            source,
        })?;
        std::io::copy(&mut input, &mut archive).map_err(|source| PackageProblem::Io {
            path: target.clone(),
            source,
        })?;
    }
    archive
        .finish()
        .map_err(|error| problem(error.to_string()))?;
    let (sha256, size) = hash_file(temporary.path())?;
    temporary
        .persist(&target)
        .map_err(|error| problem(error.to_string()))?;
    Ok(PreparedArtifact {
        path: target,
        sha256,
        size,
        manifest,
    })
}

pub fn prepare_project(
    folder: impl AsRef<Path>,
    output_folder: impl AsRef<Path>,
    version: &str,
    creator: &str,
    license: &str,
) -> Result<PreparedArtifact, PackageProblem> {
    let folder = folder.as_ref();
    if !folder.is_dir() {
        return Err(problem("Для проекта выберите папку с project.toml"));
    }
    let project = VoxelCoreProject::read(folder)?;
    let version = crate::manifest::normalize_version(version)?;
    let capabilities = project
        .permissions
        .iter()
        .flat_map(|permission| match permission.as_str() {
            "debugging" => vec![Capability::Debugging],
            "network" => vec![Capability::NetworkClient, Capability::NetworkServer],
            "record-audio" => vec![Capability::Microphone],
            "write-to-user" => vec![Capability::WriteUserFiles],
            "sub-instances" => vec![Capability::Subprocess],
            _ => Vec::new(),
        })
        .collect();
    let manifest = PackageManifest {
        schema_version: 1,
        id: project.name.clone(),
        kind: PackageKind::Project,
        title: project.title,
        version,
        creators: vec![creator.trim().to_owned()],
        description: String::new(),
        license: if license.trim().is_empty() {
            "LicenseRef-Proprietary".into()
        } else {
            license.trim().into()
        },
        source: None,
        dependencies: Vec::new(),
        conflicts: Vec::new(),
        provides: Vec::new(),
        capabilities,
        environments: vec![crate::PackageEnvironment::Client],
        external_packages: Vec::new(),
        components: Vec::new(),
    };
    manifest.validate()?;
    fs::create_dir_all(output_folder.as_ref()).map_err(|source| PackageProblem::Io {
        path: output_folder.as_ref().to_owned(),
        source,
    })?;
    let target = output_folder.as_ref().join(format!(
        "{}-{}-{}.zip",
        manifest.id,
        manifest.version,
        Uuid::new_v4()
    ));
    write_project_archive(folder, &target)?;
    let (sha256, size) = hash_file(&target)?;
    Ok(PreparedArtifact {
        path: target,
        sha256,
        size,
        manifest,
    })
}

fn write_project_archive(folder: &Path, target: &Path) -> Result<(), PackageProblem> {
    let file = fs::File::create(target).map_err(|source| PackageProblem::Io {
        path: target.to_owned(),
        source,
    })?;
    let mut archive = ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    for entry in WalkDir::new(folder).follow_links(false).sort_by_file_name() {
        let entry = entry.map_err(|error| problem(error.to_string()))?;
        if entry.file_type().is_symlink() {
            return Err(problem(format!(
                "symbolic links are forbidden: {}",
                entry.path().display()
            )));
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(folder)
            .map_err(|error| problem(error.to_string()))?
            .to_string_lossy()
            .replace('\\', "/");
        if matches!(relative.split('/').next(), Some(".git" | "user")) {
            continue;
        }
        archive
            .start_file(&relative, options)
            .map_err(|error| problem(error.to_string()))?;
        let mut input = fs::File::open(entry.path()).map_err(|source| PackageProblem::Io {
            path: entry.path().to_owned(),
            source,
        })?;
        std::io::copy(&mut input, &mut archive).map_err(|source| PackageProblem::Io {
            path: target.to_owned(),
            source,
        })?;
    }
    archive
        .finish()
        .map_err(|error| problem(error.to_string()))?;
    Ok(())
}

fn ignored_package_path(path: &Path) -> bool {
    path.components().any(|part| {
        matches!(
            part.as_os_str().to_str(),
            Some(".git" | "__MACOSX" | ".DS_Store")
        )
    })
}

/// Stop below a package root: bundled dependencies belong to that package.
fn package_root(folder: &Path) -> Result<PathBuf, PackageProblem> {
    let mut roots = Vec::new();
    let mut walk = WalkDir::new(folder)
        .follow_links(false)
        .max_depth(32)
        .sort_by_file_name()
        .into_iter();
    while let Some(entry) = walk.next() {
        let entry =
            entry.map_err(|error| problem(format!("Не удалось прочитать папку пака: {error}")))?;
        if ignored_package_path(entry.path().strip_prefix(folder).unwrap_or(entry.path())) {
            if entry.file_type().is_dir() {
                walk.skip_current_dir();
            }
            continue;
        }
        if entry.file_type().is_dir() && entry.path().join("package.json").is_file() {
            roots.push(entry.path().to_owned());
            walk.skip_current_dir();
        }
    }
    match roots.len() {
        0 => Err(problem(
            "Пак не найден: нужен файл package.json. Если в репозитории только исходники, выберите готовый ZIP пака из Assets релиза.",
        )),
        1 => Ok(roots.remove(0)),
        _ => Err(problem(format!(
            "Найдено несколько паков: {}. Выберите папку нужного пака или ZIP, содержащий только его.",
            roots
                .iter()
                .map(|root| root
                    .strip_prefix(folder)
                    .unwrap_or(root)
                    .display()
                    .to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ))),
    }
}

fn prepare_zip_package(source: &Path, output: &Path) -> Result<PreparedArtifact, PackageProblem> {
    const MAX_UNPACKED: u64 = 2 * 1024 * 1024 * 1024;
    let temporary = tempfile::tempdir().map_err(|error| problem(error.to_string()))?;
    let input = fs::File::open(source).map_err(|error| problem(error.to_string()))?;
    let mut zip = ZipArchive::new(input)
        .map_err(|error| problem(format!("Не удалось открыть ZIP-архив: {error}")))?;
    if zip.len() > 100_000 {
        return Err(problem("В ZIP-архиве слишком много файлов"));
    }
    let mut names = std::collections::HashSet::new();
    let mut total = 0_u64;
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|error| problem(error.to_string()))?;
        let name = entry
            .name()
            .trim_start_matches("./")
            .trim_end_matches('/')
            .to_owned();
        if name.is_empty() && entry.is_dir() {
            continue;
        }
        if name.is_empty()
            || name.contains(['\\', ':'])
            || name.starts_with('/')
            || name
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            || name.split('/').count() > 32
        {
            return Err(problem(format!("Недопустимый путь в ZIP: {name}")));
        }
        if !names.insert(name.to_lowercase()) {
            return Err(problem(format!("Повторяющийся путь в ZIP: {name}")));
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(problem("Символические ссылки в ZIP запрещены"));
        }
        if entry.size() > MAX_UNPACKED.saturating_sub(total) {
            return Err(problem("Распакованный ZIP превышает 2 ГБ"));
        }
        if ignored_package_path(Path::new(&name)) {
            continue;
        }
        let destination = temporary.path().join(&name);
        if entry.is_dir() {
            fs::create_dir_all(&destination).map_err(|error| problem(error.to_string()))?;
            continue;
        }
        fs::create_dir_all(destination.parent().unwrap())
            .map_err(|error| problem(error.to_string()))?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .map_err(|error| problem(error.to_string()))?;
        let copied = std::io::copy(&mut (&mut entry).take(MAX_UNPACKED - total + 1), &mut file)
            .map_err(|error| problem(format!("Ошибка чтения ZIP: {error}")))?;
        total += copied;
        if total > MAX_UNPACKED {
            return Err(problem("Распакованный ZIP превышает 2 ГБ"));
        }
    }
    let root = package_root(temporary.path())?;
    if fs::metadata(root.join("package.json"))
        .map_err(|error| problem(error.to_string()))?
        .len()
        > 1024 * 1024
    {
        return Err(problem("package.json превышает 1 МБ"));
    }
    prepare_package(root, output)
}

fn response_error(response: reqwest::blocking::Response) -> PackageProblem {
    let status = response.status();
    let body = response.text().unwrap_or_default();
    PackageProblem::Remote(format!("registry returned {status}: {body}"))
}

fn transfer_error(error: reqwest::Error) -> PackageProblem {
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source {
        if cause.to_string().contains("upload paused by user") {
            return problem("upload paused by user");
        }
        source = cause.source();
    }
    if error.is_timeout() {
        PackageProblem::Remote(
            "Сервер не ответил вовремя. Повторите отправку: принятые части архива сохранены."
                .into(),
        )
    } else if error.is_connect() {
        PackageProblem::Remote(
            "Не удалось подключиться к VSpace. Проверьте соединение и повторите отправку.".into(),
        )
    } else {
        PackageProblem::Remote(format!(
            "Не удалось передать архив: {error}. Можно повторить отправку."
        ))
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "Publication metadata remains explicit in the existing desktop API."
)]
pub fn upload_package(
    registry_url: &str,
    token: &str,
    project_id: &str,
    artifact: &PreparedArtifact,
    channel: &str,
    changelog: &str,
    voxelcore: &str,
    voxelcore_main: Option<&VoxelCoreMainRequirement>,
) -> Result<UploadReceipt, PackageProblem> {
    upload_package_with_progress(
        registry_url,
        token,
        project_id,
        artifact,
        channel,
        changelog,
        voxelcore,
        voxelcore_main,
        |_, _| true,
    )
}

struct UploadReader<F> {
    inner: Cursor<Vec<u8>>,
    completed: u64,
    total: u64,
    progress: Arc<F>,
}
impl<F: Fn(u64, u64) -> bool> Read for UploadReader<F> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if !(self.progress)(self.completed + self.inner.position(), self.total) {
            return Err(std::io::Error::other("upload paused by user"));
        }
        let limit = buffer.len().min(64 * 1024);
        self.inner.read(&mut buffer[..limit])
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "Publication metadata remains explicit in the existing desktop API."
)]
pub fn upload_package_with_progress(
    registry_url: &str,
    token: &str,
    project_id: &str,
    artifact: &PreparedArtifact,
    channel: &str,
    changelog: &str,
    voxelcore: &str,
    voxelcore_main: Option<&VoxelCoreMainRequirement>,
    progress: impl Fn(u64, u64) -> bool + Send + Sync + 'static,
) -> Result<UploadReceipt, PackageProblem> {
    let (actual_hash, actual_size) = hash_file(&artifact.path)?;
    if actual_hash != artifact.sha256 || actual_size != artifact.size {
        return Err(problem("prepared archive changed after preview"));
    }
    let progress = Arc::new(progress);
    if !progress(0, artifact.size) {
        return Err(problem("upload paused by user"));
    }
    let client = Client::builder()
        .user_agent(concat!("VLauncher/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| problem(error.to_string()))?;
    let state_path = artifact
        .path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!(
            ".upload-{}-{}-{}.json",
            project_id, artifact.manifest.version, artifact.sha256
        ));
    let saved = fs::read(&state_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<SavedUpload>(&bytes).ok())
        .filter(|saved| {
            saved.registry_url == registry_url
                && saved.project_id == project_id
                && saved.artifact_sha256 == artifact.sha256
        });
    let mut session = if let Some(saved) = saved {
        let response = client
            .get(format!("{registry_url}/uploads/{}", saved.id))
            .bearer_auth(token)
            .send()
            .map_err(transfer_error)?;
        if response.status().is_success() {
            let mut session: UploadSession = response
                .json()
                .map_err(|error| problem(error.to_string()))?;
            session.part_size = saved.part_size;
            let metadata_matches = saved.voxelcore == voxelcore
                && saved.voxelcore_main.as_ref() == voxelcore_main
                && saved.channel.as_deref() == Some(channel)
                && saved.changelog.as_deref() == Some(changelog);
            if !metadata_matches && session.status == "uploading" {
                let response = client
                    .delete(format!("{registry_url}/uploads/{}", session.id))
                    .bearer_auth(token)
                    .send()
                    .map_err(transfer_error)?;
                if !response.status().is_success() {
                    return Err(response_error(response));
                }
                None
            } else if !metadata_matches
                && matches!(
                    session.status.as_str(),
                    "queued" | "processing" | "published" | "awaiting_moderation"
                )
            {
                return Err(problem(
                    "Этот архив уже отправлен на обработку или опубликован. Изменённые параметры не применены. Проверьте версию в списке публикаций.",
                ));
            } else {
                Some(session)
            }
        } else if matches!(response.status().as_u16(), 404 | 410) {
            None
        } else {
            return Err(response_error(response));
        }
    } else {
        None
    };
    if session.as_ref().is_some_and(|value| {
        !matches!(
            value.status.as_str(),
            "uploading" | "queued" | "processing" | "published" | "awaiting_moderation"
        )
    }) {
        session = None;
    }
    if let Some(existing) = &session
        && matches!(
            existing.status.as_str(),
            "queued" | "processing" | "published" | "awaiting_moderation"
        )
    {
        return Ok(UploadReceipt {
            id: existing.id.clone(),
            status: existing.status.clone(),
        });
    }
    let session = match session {
        Some(session) => session,
        None => {
            let response = client
                .post(format!("{registry_url}/uploads"))
                .bearer_auth(token)
                .json(&serde_json::json!({
                    "project_id": project_id,
                    "version": artifact.manifest.version,
                    "channel": channel,
                    "changelog": changelog,
                    "voxelcore": voxelcore,
                    "sha256": artifact.sha256,
                    "size": artifact.size,
                    "voxelcore_main": voxelcore_main,
                }))
                .send()
                .map_err(transfer_error)?;
            if !response.status().is_success() {
                return Err(response_error(response));
            }
            let session: UploadSession = response
                .json()
                .map_err(|error| problem(error.to_string()))?;
            fs::write(
                &state_path,
                serde_json::to_vec(&SavedUpload {
                    id: session.id.clone(),
                    registry_url: registry_url.into(),
                    project_id: project_id.into(),
                    artifact_sha256: artifact.sha256.clone(),
                    part_size: session.part_size,
                    channel: Some(channel.into()),
                    changelog: Some(changelog.into()),
                    voxelcore: voxelcore.into(),
                    voxelcore_main: voxelcore_main.cloned(),
                })
                .map_err(|error| problem(error.to_string()))?,
            )
            .map_err(|source| PackageProblem::Io {
                path: state_path.clone(),
                source,
            })?;
            session
        }
    };
    if session.part_size == 0 || session.part_size > 64 * 1024 * 1024 {
        return Err(problem("invalid upload part size"));
    }
    let completed: std::collections::HashSet<_> =
        session.parts.iter().map(|part| part.number).collect();
    let mut file = fs::File::open(&artifact.path).map_err(|source| PackageProblem::Io {
        path: artifact.path.clone(),
        source,
    })?;
    let mut number = 1;
    let mut uploaded = 0u64;
    loop {
        let mut part = vec![0; session.part_size];
        let read = file.read(&mut part).map_err(|source| PackageProblem::Io {
            path: artifact.path.clone(),
            source,
        })?;
        if read == 0 {
            break;
        }
        part.truncate(read);
        if completed.contains(&number) {
            uploaded = uploaded.saturating_add(read as u64);
            if !progress(uploaded, artifact.size) {
                return Err(problem("upload paused by user"));
            }
            number += 1;
            continue;
        }
        let response = client
            .put(format!(
                "{registry_url}/uploads/{}/parts/{number}",
                session.id
            ))
            .bearer_auth(token)
            .header("Content-Type", "application/zip")
            .timeout(Duration::from_secs(300))
            .body(reqwest::blocking::Body::sized(
                UploadReader {
                    inner: Cursor::new(part),
                    completed: uploaded,
                    total: artifact.size,
                    progress: progress.clone(),
                },
                read as u64,
            ))
            .send()
            .map_err(transfer_error)?;
        if !response.status().is_success() {
            return Err(response_error(response));
        }
        uploaded = uploaded.saturating_add(read as u64);
        if !progress(uploaded, artifact.size) {
            return Err(problem("upload paused by user"));
        }
        number += 1;
    }
    let response = client
        .post(format!("{registry_url}/uploads/{}/complete", session.id))
        .bearer_auth(token)
        .json(&serde_json::json!({}))
        .send()
        .map_err(transfer_error)?;
    if !response.status().is_success() {
        return Err(response_error(response));
    }
    let receipt = response
        .json()
        .map_err(|error| problem(error.to_string()))?;
    // Retain the receipt until the next attempt can confirm the server state.
    // A lost completion response or interrupted moderation polling must be resumable.
    Ok(receipt)
}

fn hash_file(path: &Path) -> Result<(String, u64), PackageProblem> {
    let mut file = fs::File::open(path).map_err(|source| PackageProblem::Io {
        path: path.to_owned(),
        source,
    })?;
    let size = file
        .metadata()
        .map_err(|source| PackageProblem::Io {
            path: path.to_owned(),
            source,
        })?
        .len();
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|source| PackageProblem::Io {
        path: path.to_owned(),
        source,
    })?;
    Ok((hex::encode(hasher.finalize()), size))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepared_archives_are_deterministic_in_content() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir_all(source.join("scripts")).unwrap();
        fs::write(source.join("scripts/main.lua"), "return true").unwrap();
        fs::write(
            source.join("package.json"),
            serde_json::to_vec(&serde_json::json!({
                "schema_version": 1, "id": "publish_test", "type": "mod",
                "title": "Publish test", "version": "1.0.0", "creators": ["Tester"],
                "description": "Test", "license": "MIT",
                "dependencies": [{"id": "base", "requirement": ">=0.31.4", "kind": "required"}]
            }))
            .unwrap(),
        )
        .unwrap();
        let first = prepare_package(&source, temp.path()).unwrap();
        let second = prepare_package(&source, temp.path()).unwrap();
        assert_eq!(first.sha256, second.sha256);
        assert_eq!(first.size, second.size);
    }

    fn zip_fixture(path: &Path, entries: &[(&str, &[u8])]) {
        use std::io::Write;
        let mut writer = ZipWriter::new(fs::File::create(path).unwrap());
        for (name, bytes) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
    }

    fn manifest_fixture() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 1, "id": "publish_test", "type": "mod",
            "title": "Publish test", "version": "1.0.0", "creators": ["Tester"],
            "description": "Test", "license": "MIT",
            "dependencies": [{"id": "base", "requirement": ">=0.31.4", "kind": "required"}]
        }))
        .unwrap()
    }

    #[test]
    fn zip_and_wrapped_zip_prepare_the_same_package_without_modifying_source() {
        let temp = tempfile::tempdir().unwrap();
        let manifest = manifest_fixture();
        let folder = temp.path().join("source");
        fs::create_dir_all(folder.join("scripts")).unwrap();
        fs::write(folder.join("package.json"), &manifest).unwrap();
        fs::write(folder.join("scripts/main.lua"), b"return true").unwrap();
        let expected = prepare_package(&folder, temp.path().join("out")).unwrap();
        for prefix in ["", "publish_test/"] {
            let source = temp.path().join("input.zip");
            zip_fixture(
                &source,
                &[
                    (&format!("{prefix}package.json"), &manifest),
                    (&format!("{prefix}scripts/main.lua"), b"return true"),
                ],
            );
            let before = fs::read(&source).unwrap();
            let prepared = prepare_package(&source, temp.path().join("out")).unwrap();
            assert_eq!(prepared.manifest.id, "publish_test");
            assert_eq!(prepared.sha256, expected.sha256);
            assert_eq!(fs::read(&source).unwrap(), before);
            assert_ne!(prepared.path, source);
        }
    }

    #[test]
    fn zip_rejects_unsafe_paths_collisions_and_missing_or_invalid_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("input.zip");
        let manifest = manifest_fixture();
        for name in [
            "../escape",
            "/absolute",
            "C:/escape",
            "dir\\escape",
            "dir/../escape",
        ] {
            zip_fixture(&source, &[("package.json", &manifest), (name, b"bad")]);
            assert!(
                prepare_package(&source, temp.path().join("out")).is_err(),
                "{name}"
            );
        }
        zip_fixture(
            &source,
            &[("package.json", &manifest), ("PACKAGE.JSON", &manifest)],
        );
        assert!(
            prepare_package(&source, temp.path().join("out"))
                .unwrap_err()
                .to_string()
                .contains("Повторяющийся")
        );
        zip_fixture(&source, &[("readme.txt", b"No manifest")]);
        assert!(
            prepare_package(&source, temp.path().join("out"))
                .unwrap_err()
                .to_string()
                .contains("package.json")
        );
        zip_fixture(&source, &[("package.json", b"not json")]);
        assert!(prepare_package(&source, temp.path().join("out")).is_err());
        zip_fixture(
            &source,
            &[
                ("first/package.json", &manifest),
                ("second/package.json", &manifest),
            ],
        );
        assert!(prepare_package(&source, temp.path().join("out")).is_err());
        fs::write(&source, b"not zip").unwrap();
        assert!(prepare_package(&source, temp.path().join("out")).is_err());
    }

    #[test]
    fn upload_rejects_archive_changed_after_preview_before_network() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("package.json"),
            serde_json::to_vec(&serde_json::json!({
                "schema_version": 1, "id": "publish_test", "type": "mod",
                "title": "Publish test", "version": "1.0.0", "creators": ["Tester"],
                "description": "Test", "license": "MIT",
                "dependencies": [{"id": "base", "requirement": ">=0.31.4", "kind": "required"}]
            }))
            .unwrap(),
        )
        .unwrap();
        let artifact = prepare_package(&source, temp.path()).unwrap();
        fs::write(&artifact.path, b"changed").unwrap();
        let error = upload_package(
            "http://127.0.0.1:1/api/v1",
            "token",
            "publish_test",
            &artifact,
            "stable",
            "",
            ">=0.31.4",
            None,
        )
        .unwrap_err();
        assert!(error.to_string().contains("changed after preview"));
    }

    #[test]
    fn project_archive_uses_project_toml_and_excludes_user_data() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("project");
        fs::create_dir_all(source.join("modules")).unwrap();
        fs::create_dir_all(source.join("user/worlds")).unwrap();
        fs::write(
            source.join("project.toml"),
            "name = \"demo-project\"\ntitle = \"Demo\"\npermissions = [\"network\"]\n",
        )
        .unwrap();
        fs::write(source.join("modules/main.lua"), "print('hello')").unwrap();
        fs::write(source.join("user/worlds/private.dat"), "private").unwrap();
        let artifact =
            prepare_project(&source, temp.path().join("out"), "1.2", "Tester", "MIT").unwrap();
        assert_eq!(artifact.manifest.kind, PackageKind::Project);
        assert_eq!(artifact.manifest.version, "1.2.0");
        let archive = fs::File::open(artifact.path).unwrap();
        let mut zip = ZipArchive::new(archive).unwrap();
        assert!(zip.by_name("project.toml").is_ok());
        assert!(zip.by_name("modules/main.lua").is_ok());
        assert!(zip.by_name("user/worlds/private.dat").is_err());
    }
    fn upload_fixture(temp: &Path) -> PreparedArtifact {
        let source = temp.join("source.zip");
        zip_fixture(&source, &[("package.json", &manifest_fixture())]);
        prepare_package(source, temp.join("out")).unwrap()
    }

    fn save_upload(artifact: &PreparedArtifact, registry: &str, channel: &str) -> PathBuf {
        let path = artifact.path.parent().unwrap().join(format!(
            ".upload-project-{}-{}.json",
            artifact.manifest.version, artifact.sha256
        ));
        fs::write(
            &path,
            serde_json::to_vec(&SavedUpload {
                id: "existing".into(),
                registry_url: registry.into(),
                project_id: "project".into(),
                artifact_sha256: artifact.sha256.clone(),
                part_size: 8 * 1024 * 1024,
                channel: Some(channel.into()),
                changelog: Some("notes".into()),
                voxelcore: ">=0.31.4".into(),
                voxelcore_main: None,
            })
            .unwrap(),
        )
        .unwrap();
        path
    }

    // A closed listener makes unexpected duplicate POSTs fail rather than hang the test.
    fn upload_server(
        steps: Vec<(&'static str, Option<&'static str>)>,
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::Write;
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            let mut bodies = Vec::new();
            for (expected, response) in steps {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    header.push(byte[0]);
                }
                let header = String::from_utf8(header).unwrap();
                assert!(header.starts_with(expected), "{header}");
                let length: usize = header
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap_or(0);
                let mut body = vec![0; length];
                stream.read_exact(&mut body).unwrap();
                bodies.push(String::from_utf8_lossy(&body).into_owned());
                if let Some(response) = response {
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
                }
            }
            bodies
        });
        (url, thread)
    }

    #[test]
    fn resume_returns_existing_terminal_publication_without_reupload() {
        for status in ["published", "awaiting_moderation", "queued", "processing"] {
            let body: &'static str = match status {
                "published" => r#"{"id":"existing","status":"published"}"#,
                "awaiting_moderation" => r#"{"id":"existing","status":"awaiting_moderation"}"#,
                "queued" => r#"{"id":"existing","status":"queued"}"#,
                _ => r#"{"id":"existing","status":"processing"}"#,
            };
            let (url, server) = upload_server(vec![("GET /uploads/existing ", Some(body))]);
            let temp = tempfile::tempdir().unwrap();
            let artifact = upload_fixture(temp.path());
            let saved = save_upload(&artifact, &url, "stable");
            let receipt = upload_package_with_progress(
                &url,
                "token",
                "project",
                &artifact,
                "stable",
                "notes",
                ">=0.31.4",
                None,
                |_, _| true,
            )
            .unwrap();
            assert_eq!(receipt.status, status);
            assert!(saved.is_file());
            server.join().unwrap();
        }
    }

    #[test]
    fn changed_upload_metadata_replaces_open_session_and_persists_completion() {
        let (url, server) = upload_server(vec![
            (
                "GET /uploads/existing ",
                Some(r#"{"id":"existing","status":"uploading"}"#),
            ),
            ("DELETE /uploads/existing ", Some("{}")),
            (
                "POST /uploads ",
                Some(r#"{"id":"new","status":"uploading","part_size":8388608}"#),
            ),
            ("PUT /uploads/new/parts/1 ", Some("{}")),
            (
                "POST /uploads/new/complete ",
                Some(r#"{"id":"new","status":"queued"}"#),
            ),
            (
                "GET /uploads/new ",
                Some(r#"{"id":"new","status":"published"}"#),
            ),
        ]);
        let temp = tempfile::tempdir().unwrap();
        let artifact = upload_fixture(temp.path());
        let saved = save_upload(&artifact, &url, "alpha");
        let receipt = upload_package_with_progress(
            &url,
            "token",
            "project",
            &artifact,
            "stable",
            "new notes",
            ">=0.31.4",
            None,
            |_, _| true,
        )
        .unwrap();
        assert_eq!(receipt.status, "queued");
        assert!(saved.is_file());
        let receipt = upload_package_with_progress(
            &url,
            "token",
            "project",
            &artifact,
            "stable",
            "new notes",
            ">=0.31.4",
            None,
            |_, _| true,
        )
        .unwrap();
        assert_eq!(receipt.status, "published");
        let requests = server.join().unwrap();
        let sent: serde_json::Value = serde_json::from_str(&requests[2]).unwrap();
        assert_eq!(sent["channel"], "stable");
        assert_eq!(sent["changelog"], "new notes");
    }

    #[test]
    fn lost_completion_response_resumes_accepted_upload() {
        let (url, server) = upload_server(vec![
            (
                "POST /uploads ",
                Some(r#"{"id":"new","status":"uploading","part_size":8388608}"#),
            ),
            ("PUT /uploads/new/parts/1 ", Some("{}")),
            ("POST /uploads/new/complete ", None),
            (
                "GET /uploads/new ",
                Some(r#"{"id":"new","status":"awaiting_moderation"}"#),
            ),
        ]);
        let temp = tempfile::tempdir().unwrap();
        let artifact = upload_fixture(temp.path());
        assert!(
            upload_package_with_progress(
                &url,
                "token",
                "project",
                &artifact,
                "stable",
                "notes",
                ">=0.31.4",
                None,
                |_, _| true
            )
            .is_err()
        );
        let receipt = upload_package_with_progress(
            &url,
            "token",
            "project",
            &artifact,
            "stable",
            "notes",
            ">=0.31.4",
            None,
            |_, _| true,
        )
        .unwrap();
        assert_eq!(receipt.status, "awaiting_moderation");
        server.join().unwrap();
    }

    #[test]
    fn changed_metadata_after_completion_is_reported() {
        let (url, server) = upload_server(vec![(
            "GET /uploads/existing ",
            Some(r#"{"id":"existing","status":"published"}"#),
        )]);
        let temp = tempfile::tempdir().unwrap();
        let artifact = upload_fixture(temp.path());
        save_upload(&artifact, &url, "stable");
        let error = upload_package_with_progress(
            &url,
            "token",
            "project",
            &artifact,
            "beta",
            "notes",
            ">=0.31.4",
            None,
            |_, _| true,
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Изменённые параметры не применены")
        );
        server.join().unwrap();
    }
    #[test]
    fn imports_nested_pack_with_macos_metadata_and_bom() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("input.zip");
        let mut manifest = b"\xef\xbb\xbf".to_vec();
        manifest.extend(manifest_fixture());
        zip_fixture(
            &source,
            &[
                ("./repository/content/my_pack/package.json", &manifest),
                (
                    "./repository/content/my_pack/scripts/main.lua",
                    b"return true",
                ),
                ("./repository/README.md", b"repo docs"),
                ("__MACOSX/._repository", b"metadata"),
                (".DS_Store", b"metadata"),
            ],
        );
        let prepared = prepare_package(&source, temp.path().join("out")).unwrap();
        assert_eq!(prepared.manifest.id, "publish_test");
        let mut archive = ZipArchive::new(fs::File::open(&prepared.path).unwrap()).unwrap();
        assert!(archive.by_name("package.json").is_ok());
        assert!(archive.by_name("scripts/main.lua").is_ok());
        assert_eq!(archive.len(), 2);
    }

    #[test]
    fn ambiguous_archives_list_packages_and_root_pack_keeps_bundled_packages() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("input.zip");
        let manifest = manifest_fixture();
        zip_fixture(
            &source,
            &[
                ("one/package.json", &manifest),
                ("two/package.json", &manifest),
            ],
        );
        let error = prepare_package(&source, temp.path().join("out"))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("несколько паков") && error.contains("one") && error.contains("two")
        );
        zip_fixture(
            &source,
            &[
                ("package.json", &manifest),
                ("bundled/package.json", &manifest),
            ],
        );
        let prepared = prepare_package(&source, temp.path().join("out")).unwrap();
        let mut archive = ZipArchive::new(fs::File::open(prepared.path).unwrap()).unwrap();
        assert!(archive.by_name("bundled/package.json").is_ok());
    }

    #[test]
    fn local_pack_refuses_output_inside_source_and_cleans_failed_archives() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("package.json"), manifest_fixture()).unwrap();
        assert!(
            prepare_package(&source, source.join("out"))
                .unwrap_err()
                .to_string()
                .contains("внутри пака")
        );
        #[cfg(unix)]
        {
            fs::write(source.join("bad:name"), b"data").unwrap();
            let output = temp.path().join("out");
            assert!(prepare_package(&source, &output).is_err());
            assert_eq!(fs::read_dir(output).unwrap().count(), 0);
        }
    }
}
