use crate::{TransferControl, TransferEvent, ensure_stopped, profile_store};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use tauri::Emitter;
use uuid::Uuid;
use vlauncher_core::prepare_package;
use vlauncher_core::{ExternalPackageLock, ProfileStore};
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

#[tauri::command]
pub(crate) async fn voxelworld_request(
    path: String,
    query: String,
) -> Result<serde_json::Value, String> {
    let parts = path.split('/').collect::<Vec<_>>();
    let valid_slug = |slug: &str| {
        !slug.is_empty()
            && slug.len() <= 255
            && slug
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    };
    let valid_path = path == "mods"
        || path == "tags"
        || matches!(parts.as_slice(), ["mods", slug] if valid_slug(slug))
        || matches!(parts.as_slice(), ["mods", slug, "versions"] if valid_slug(slug))
        || matches!(parts.as_slice(), ["mods", slug, "versions", version]
            if valid_slug(slug) && version.parse::<u64>().is_ok());
    if !valid_path || query.len() > 4096 || query.contains(['#', '?']) {
        return Err("Некорректный запрос к VoxelWorld".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut url = format!("https://api.voxelworld.ru/v2/{path}");
        if !query.is_empty() {
            url.push('?');
            url.push_str(&query);
        }
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| "Не удалось подготовить подключение к VoxelWorld".to_string())?;
        let response = client
            .get(url)
            .header(
                reqwest::header::USER_AGENT,
                concat!(
                    "VLauncher/",
                    env!("CARGO_PKG_VERSION"),
                    " (+https://vlauncher.space)"
                ),
            )
            .send()
            .map_err(|_| "VoxelWorld сейчас недоступен".to_string())?;
        if !response.status().is_success() {
            return Err(format!(
                "VoxelWorld вернул ошибку {}",
                response.status().as_u16()
            ));
        }
        response
            .json()
            .map_err(|_| "VoxelWorld вернул некорректный ответ".to_string())
    })
    .await
    .map_err(|_| "Запрос к VoxelWorld был прерван".to_string())?
}

#[derive(Clone, Deserialize)]
struct VoxelWorldProjectRef {
    id: u64,
    slug: Option<String>,
    title: String,
}

#[derive(Clone, Deserialize)]
struct VoxelWorldEngine {
    version_number: String,
}

#[derive(Clone, Deserialize)]
struct VoxelWorldVersion {
    id: u64,
    project: VoxelWorldProjectRef,
    version_number: String,
    #[serde(default)]
    dependencies: Vec<VoxelWorldVersion>,
    #[serde(default)]
    engine: Vec<VoxelWorldEngine>,
}

#[derive(Deserialize)]
struct VoxelWorldEnvelope<T> {
    data: T,
}

#[derive(Clone, Serialize)]
pub(crate) struct VoxelWorldCompatibilityIssue {
    title: String,
    version: String,
    supported_voxelcore: Vec<String>,
    chain: Vec<String>,
}

#[derive(Serialize)]
pub(crate) struct VoxelWorldInstallPreviewItem {
    title: String,
    version: String,
    selected: bool,
}

#[derive(Serialize)]
pub(crate) struct VoxelWorldInstallPreview {
    packages: Vec<VoxelWorldInstallPreviewItem>,
    incompatibilities: Vec<VoxelWorldCompatibilityIssue>,
}

struct VoxelWorldInstallPlan {
    versions: Vec<(VoxelWorldVersion, String)>,
    incompatibilities: Vec<VoxelWorldCompatibilityIssue>,
}

fn voxelworld_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30 * 60))
        .user_agent(concat!(
            "VLauncher/",
            env!("CARGO_PKG_VERSION"),
            " (+https://vlauncher.space)"
        ))
        .build()
        .map_err(|_| "Не удалось подготовить подключение к VoxelWorld".to_string())
}

fn voxelworld_version(
    client: &reqwest::blocking::Client,
    slug: &str,
    version_id: u64,
) -> Result<VoxelWorldVersion, String> {
    let url = format!("https://api.voxelworld.ru/v2/mods/{slug}/versions/{version_id}");
    let response = client
        .get(url)
        .send()
        .map_err(|_| "VoxelWorld сейчас недоступен".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "VoxelWorld вернул ошибку {}",
            response.status().as_u16()
        ));
    }
    response
        .json::<VoxelWorldEnvelope<VoxelWorldVersion>>()
        .map(|response| response.data)
        .map_err(|_| "VoxelWorld вернул некорректную версию".to_string())
}

fn numeric_voxelcore_version(value: &str) -> Option<Vec<u64>> {
    let value = value.trim().trim_start_matches(['v', 'V']);
    let core = value.split(['-', '+']).next()?;
    let parts = core
        .split('.')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    (parts.len() == 2 || parts.len() == 3).then_some(parts)
}

fn voxelworld_engine_supports(current: &str, supported: &str) -> bool {
    let Some(current_parts) = numeric_voxelcore_version(current) else {
        return current.trim().trim_start_matches(['v', 'V'])
            == supported.trim().trim_start_matches(['v', 'V']);
    };
    let Some(supported_parts) = numeric_voxelcore_version(supported) else {
        return current.trim().trim_start_matches(['v', 'V'])
            == supported.trim().trim_start_matches(['v', 'V']);
    };
    if supported_parts.len() == 2 {
        return current_parts.first() == supported_parts.first()
            && current_parts.get(1) == supported_parts.get(1);
    }
    supported_parts
        .iter()
        .enumerate()
        .all(|(index, part)| current_parts.get(index).copied().unwrap_or(0) == *part)
}

fn collect_install_plan(
    client: &reqwest::blocking::Client,
    root: VoxelWorldVersion,
    root_slug: String,
    engine: &str,
) -> Result<VoxelWorldInstallPlan, String> {
    let mut pending = vec![(root, root_slug, Vec::<String>::new())];
    let mut versions = Vec::new();
    let mut incompatibilities = Vec::new();
    let mut visited = HashSet::new();
    while let Some((version, version_slug, parent_chain)) = pending.pop() {
        if !visited.insert((version.project.id, version.id)) {
            continue;
        }
        if visited.len() > 50 {
            return Err("У проекта слишком много зависимостей".into());
        }
        let mut chain = parent_chain;
        chain.push(version.project.title.clone());
        if !version.engine.is_empty()
            && !version
                .engine
                .iter()
                .any(|item| voxelworld_engine_supports(engine, &item.version_number))
        {
            incompatibilities.push(VoxelWorldCompatibilityIssue {
                title: version.project.title.clone(),
                version: version.version_number.clone(),
                supported_voxelcore: version
                    .engine
                    .iter()
                    .map(|item| item.version_number.clone())
                    .collect(),
                chain: chain.clone(),
            });
        }
        for dependency in &version.dependencies {
            let dependency_slug = dependency
                .project
                .slug
                .as_deref()
                .ok_or_else(|| "У зависимости VoxelWorld нет идентификатора".to_string())?;
            let detail = voxelworld_version(client, dependency_slug, dependency.id)?;
            if detail.id != dependency.id || detail.project.id != dependency.project.id {
                return Err("VoxelWorld вернул другую версию зависимости".into());
            }
            pending.push((detail, dependency_slug.to_owned(), chain.clone()));
        }
        versions.push((version, version_slug));
    }
    Ok(VoxelWorldInstallPlan {
        versions,
        incompatibilities,
    })
}

fn validate_project_reference(project_id: u64, slug: &str, version_id: u64) -> Result<(), String> {
    if project_id == 0
        || version_id == 0
        || slug.is_empty()
        || slug.len() > 255
        || !slug
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Некорректная версия VoxelWorld".into());
    }
    Ok(())
}

fn profile_engine(store: &ProfileStore, profile_id: Uuid) -> Result<String, String> {
    let profile = store
        .list()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "profile does not exist".to_string())?;
    profile
        .main_build
        .as_ref()
        .and_then(|build| build.engine_version.as_deref())
        .or(profile.voxelcore_version.as_deref())
        .map(str::to_owned)
        .ok_or_else(|| "profile has no VoxelCore version".to_string())
}

fn is_voxelworld_typings_link(name: &str) -> bool {
    name.trim_end_matches('/')
        .split('/')
        .any(|part| part == "typings")
}

fn normalize_voxelworld_manifest(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut manifest: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|_| "Архив VoxelWorld содержит некорректный package.json".to_string())?;
    let legacy = manifest.get("schema_version").is_none();
    if let Some(version) = manifest.get_mut("version")
        && version.as_str().is_some_and(|value| {
            let normalized = if legacy && value.matches('.').count() == 1 {
                format!("{value}.0")
            } else {
                value.to_owned()
            };
            semver::Version::parse(&normalized).is_err()
        })
    {
        *version = serde_json::Value::String("0.0.0".into());
    }
    serde_json::to_vec(&manifest)
        .map_err(|_| "Не удалось исправить package.json из VoxelWorld".to_string())
}

fn normalize_voxelworld_archive(source: &Path, target: &Path) -> Result<PathBuf, String> {
    const MAX_UNPACKED: u64 = 2 * 1024 * 1024 * 1024;
    let input = std::fs::File::open(source).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(input)
        .map_err(|error| format!("VoxelWorld вернул некорректный ZIP: {error}"))?;
    if archive.len() > 100_000 {
        return Err("В архиве VoxelWorld слишком много файлов".into());
    }
    let names = (0..archive.len())
        .map(|index| {
            archive
                .by_index(index)
                .map(|entry| entry.name().trim_end_matches('/').to_owned())
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let manifest_name = names
        .iter()
        .find(|name| name.as_str() == "package.json")
        .cloned()
        .or_else(|| {
            let candidates = names
                .iter()
                .filter(|name| {
                    let mut parts = name.split('/');
                    parts.next().is_some()
                        && parts.next() == Some("package.json")
                        && parts.next().is_none()
                })
                .collect::<Vec<_>>();
            (candidates.len() == 1).then(|| candidates[0].clone())
        });
    let output_path = target.join(format!("normalized-{}.zip", Uuid::new_v4()));
    let output = std::fs::File::create(&output_path).map_err(|error| error.to_string())?;
    let mut normalized = ZipWriter::new(output);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let symlink = entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000);
        if symlink {
            if is_voxelworld_typings_link(entry.name()) {
                continue;
            }
            return Err(format!(
                "Архив VoxelWorld содержит неподдерживаемую символическую ссылку: {}",
                entry.name()
            ));
        }
        if entry.size() > MAX_UNPACKED.saturating_sub(total) {
            return Err("Распакованный архив VoxelWorld превышает 2 ГБ".into());
        }
        let entry_name = entry.name().to_owned();
        normalized
            .start_file(&entry_name, options)
            .map_err(|error| error.to_string())?;
        let copied = if manifest_name.as_deref() == Some(entry_name.as_str()) {
            if entry.size() > 1024 * 1024 {
                return Err("package.json из VoxelWorld превышает 1 МБ".into());
            }
            let mut bytes = Vec::with_capacity(entry.size() as usize);
            entry
                .read_to_end(&mut bytes)
                .map_err(|error| error.to_string())?;
            let bytes = normalize_voxelworld_manifest(&bytes)?;
            normalized
                .write_all(&bytes)
                .map_err(|error| error.to_string())?;
            bytes.len() as u64
        } else {
            std::io::copy(
                &mut (&mut entry).take(MAX_UNPACKED.saturating_sub(total) + 1),
                &mut normalized,
            )
            .map_err(|error| error.to_string())?
        };
        total = total.saturating_add(copied);
        if total > MAX_UNPACKED {
            return Err("Распакованный архив VoxelWorld превышает 2 ГБ".into());
        }
    }
    normalized.finish().map_err(|error| error.to_string())?;
    Ok(output_path)
}

fn install_versions(
    app: &tauri::AppHandle,
    store: &ProfileStore,
    profile_id: Uuid,
    client: &reqwest::blocking::Client,
    versions: Vec<(VoxelWorldVersion, String)>,
    cancelled: &AtomicBool,
    locked: &HashMap<(u64, u64), ExternalPackageLock>,
) -> Result<Vec<vlauncher_core::ExternalPackage>, String> {
    let downloads = tempfile::tempdir().map_err(|error| error.to_string())?;
    let prepared = tempfile::tempdir().map_err(|error| error.to_string())?;
    let mut packages = Vec::new();
    for (version, version_slug) in versions.into_iter().rev() {
        if cancelled.load(Ordering::SeqCst) {
            return Err("download paused by user".into());
        }
        let url = format!(
            "https://api.voxelworld.ru/v2/mods/{}/versions/{}/download",
            version.project.id, version.id
        );
        let mut response = client
            .get(url)
            .send()
            .map_err(|_| "Не удалось скачать архив VoxelWorld".to_string())?;
        if !response.status().is_success() {
            return Err(format!(
                "VoxelWorld не вернул архив: {}",
                response.status().as_u16()
            ));
        }
        let expected = response.content_length().unwrap_or(0);
        let limit = 512 * 1024 * 1024_u64;
        if expected > limit {
            return Err("Архив VoxelWorld превышает 512 МБ".into());
        }
        let archive_path = downloads.path().join(format!("{}.zip", version.id));
        let mut archive =
            std::fs::File::create(&archive_path).map_err(|error| error.to_string())?;
        let mut completed = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        let started = Instant::now();
        loop {
            let read = std::io::Read::read(&mut response, &mut buffer)
                .map_err(|_| "Архив VoxelWorld загрузился не полностью".to_string())?;
            if read == 0 {
                break;
            }
            completed = completed.saturating_add(read as u64);
            if completed > limit || expected > 0 && completed > expected {
                return Err("VoxelWorld прислал слишком большой архив".into());
            }
            archive
                .write_all(&buffer[..read])
                .map_err(|error| error.to_string())?;
            let speed = (completed as f64 / started.elapsed().as_secs_f64().max(0.001)) as u64;
            let _ = app.emit(
                "transfer-progress",
                TransferEvent {
                    kind: "download",
                    completed,
                    total: expected.max(completed),
                    bytes_per_second: speed,
                    eta_seconds: if speed > 0 {
                        expected.saturating_sub(completed) / speed
                    } else {
                        0
                    },
                },
            );
            if cancelled.load(Ordering::SeqCst) {
                return Err("download paused by user".into());
            }
        }
        archive.sync_all().map_err(|error| error.to_string())?;
        if expected > 0 && completed != expected {
            return Err("Архив VoxelWorld загрузился не полностью".into());
        }
        let normalized_archive = normalize_voxelworld_archive(&archive_path, downloads.path())?;
        let artifact = prepare_package(&normalized_archive, prepared.path())
            .map_err(|error| error.to_string())?;
        let lock = locked.get(&(version.project.id, version.id));
        if lock.is_some_and(|item| {
            item.id != artifact.manifest.id
                || item.version != artifact.manifest.version
                || item.artifact_sha256 != artifact.sha256
                || item.artifact_size != artifact.size
        }) {
            return Err(format!(
                "Зафиксированный пакет {} изменился на VoxelWorld",
                version.project.title
            ));
        }
        packages.push(vlauncher_core::ExternalInstallPackage {
            package: vlauncher_core::ExternalPackage {
                id: artifact.manifest.id.clone(),
                source: "voxelworld".into(),
                project_id: version.project.id,
                slug: version.project.slug.unwrap_or(version_slug),
                version_id: version.id,
                version: artifact.manifest.version.clone(),
                title: version.project.title,
                artifact_sha256: artifact.sha256.clone(),
                artifact_size: artifact.size,
            },
            artifact,
        });
    }
    if locked.is_empty() {
        store.install_external_packages(profile_id, packages)
    } else {
        store.replace_external_packages(profile_id, packages)
    }
    .map_err(|error| error.to_string())
}

pub(crate) fn install_locked_packages(
    app: &tauri::AppHandle,
    store: &ProfileStore,
    profile_id: Uuid,
    packages: Vec<ExternalPackageLock>,
    cancelled: &AtomicBool,
) -> Result<Vec<vlauncher_core::ExternalPackage>, String> {
    if packages.is_empty() {
        return store
            .replace_external_packages(profile_id, Vec::new())
            .map_err(|error| error.to_string());
    }
    let client = voxelworld_client()?;
    let mut locked = HashMap::new();
    let mut versions = Vec::new();
    for package in packages {
        if package.source != "voxelworld"
            || locked
                .insert((package.project_id, package.version_id), package.clone())
                .is_some()
        {
            return Err("Сборка содержит некорректный список VoxelWorld".into());
        }
        let version = voxelworld_version(&client, &package.slug, package.version_id)?;
        if version.id != package.version_id || version.project.id != package.project_id {
            return Err("VoxelWorld вернул другую версию зафиксированного пакета".into());
        }
        versions.push((version, package.slug));
    }
    install_versions(
        app, store, profile_id, &client, versions, cancelled, &locked,
    )
}

#[tauri::command]
pub(crate) async fn preview_voxelworld_install(
    app: tauri::AppHandle,
    profile_id: String,
    project_id: u64,
    slug: String,
    version_id: u64,
) -> Result<VoxelWorldInstallPreview, String> {
    validate_project_reference(project_id, &slug, version_id)?;
    let id = profile_id
        .parse()
        .map_err(|_| "invalid profile id".to_owned())?;
    let store = profile_store(&app)?;
    let engine = profile_engine(&store, id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let client = voxelworld_client()?;
        let root = voxelworld_version(&client, &slug, version_id)?;
        if root.id != version_id || root.project.id != project_id {
            return Err("VoxelWorld вернул другую версию проекта".to_string());
        }
        let plan = collect_install_plan(&client, root, slug, &engine)?;
        let packages = plan
            .versions
            .iter()
            .map(|(version, _)| VoxelWorldInstallPreviewItem {
                title: version.project.title.clone(),
                version: version.version_number.clone(),
                selected: version.project.id == project_id && version.id == version_id,
            })
            .collect();
        Ok(VoxelWorldInstallPreview {
            packages,
            incompatibilities: plan.incompatibilities,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn install_voxelworld_mod(
    app: tauri::AppHandle,
    control: tauri::State<'_, TransferControl>,
    profile_id: String,
    project_id: u64,
    slug: String,
    version_id: u64,
    allow_incompatible: bool,
) -> Result<Vec<vlauncher_core::ExternalPackage>, String> {
    ensure_stopped(&app, &profile_id)?;
    validate_project_reference(project_id, &slug, version_id)?;
    let id = profile_id
        .parse()
        .map_err(|_| "invalid profile id".to_owned())?;
    let store = profile_store(&app)?;
    let engine = profile_engine(&store, id)?;
    control.cancelled.store(false, Ordering::SeqCst);
    let cancelled = control.cancelled.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let client = voxelworld_client()?;
        let root = voxelworld_version(&client, &slug, version_id)?;
        if root.id != version_id || root.project.id != project_id {
            return Err("VoxelWorld вернул другую версию проекта".to_string());
        }
        let plan = collect_install_plan(&client, root, slug, &engine)?;
        if !allow_incompatible && !plan.incompatibilities.is_empty() {
            let issue = &plan.incompatibilities[0];
            return Err(format!(
                "Версия {} проекта {} не поддерживает VoxelCore {}",
                issue.version, issue.title, engine
            ));
        }

        install_versions(
            &app,
            &store,
            id,
            &client,
            plan.versions,
            &cancelled,
            &HashMap::new(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn remove_voxelworld_mod(
    app: tauri::AppHandle,
    profile_id: String,
    id: String,
) -> Result<(), String> {
    ensure_stopped(&app, &profile_id)?;
    let profile_id = profile_id
        .parse()
        .map_err(|_| "invalid profile id".to_owned())?;
    profile_store(&app)?
        .remove_external_package(profile_id, &id)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        VoxelWorldEnvelope, VoxelWorldVersion, normalize_voxelworld_archive,
        normalize_voxelworld_manifest, voxelworld_engine_supports,
    };
    use std::io::Write;
    use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

    fn archive_with_link(path: &std::path::Path, link: &str) {
        let file = std::fs::File::create(path).unwrap();
        let mut archive = ZipWriter::new(file);
        archive
            .start_file("project/package.json", SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"{}").unwrap();
        archive
            .add_symlink(
                link,
                "../../dependency/typings",
                SimpleFileOptions::default(),
            )
            .unwrap();
        archive.finish().unwrap();
    }

    #[test]
    fn reads_dependencies_and_compares_engine_versions() {
        let response: VoxelWorldEnvelope<VoxelWorldVersion> = serde_json::from_value(
            serde_json::json!({
                "data": {
                    "id": 466,
                    "project": {"id": 170, "title": "Interactive Commons", "type": "mods"},
                    "version_number": "1.0.2",
                    "engine": [{"id": 19, "version_number": "0.32"}],
                    "dependencies": [{
                        "id": 451,
                        "project": {"id": 169, "slug": "rideable-api", "title": "RideableAPI", "type": "mods"},
                        "version_number": "1.0.0",
                        "engine": [{"id": 19, "version_number": "0.32"}]
                    }]
                }
            }),
        )
        .unwrap();
        assert_eq!(response.data.dependencies[0].id, 451);
        assert_eq!(
            response.data.dependencies[0].project.slug.as_deref(),
            Some("rideable-api")
        );
        assert!(voxelworld_engine_supports("0.31.4", "0.31"));
        assert!(voxelworld_engine_supports("0.32.9", "0.32"));
        assert!(!voxelworld_engine_supports("0.33.0", "0.32"));
        assert!(voxelworld_engine_supports("0.31.2", "0.31.2"));
        assert!(!voxelworld_engine_supports("0.31.4", "0.31.2"));
    }

    #[test]
    fn voxelworld_adapter_strips_typings_links_only() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.zip");
        archive_with_link(&source, "project/typings/dependency");
        let normalized = normalize_voxelworld_archive(&source, directory.path()).unwrap();
        let mut archive = ZipArchive::new(std::fs::File::open(normalized).unwrap()).unwrap();
        assert_eq!(archive.len(), 1);
        assert_eq!(archive.by_index(0).unwrap().name(), "project/package.json");

        archive_with_link(&source, "project/modules/dependency");
        assert!(
            normalize_voxelworld_archive(&source, directory.path())
                .unwrap_err()
                .contains("неподдерживаемую символическую ссылку")
        );
    }

    #[test]
    fn voxelworld_adapter_replaces_only_invalid_manifest_versions() {
        let invalid =
            normalize_voxelworld_manifest(br#"{"id":"example","version":"0.0.0ALPHA"}"#).unwrap();
        let invalid: serde_json::Value = serde_json::from_slice(&invalid).unwrap();
        assert_eq!(invalid["version"], "0.0.0");

        let valid = normalize_voxelworld_manifest(br#"{"id":"example","version":"1.2.3-alpha.1"}"#)
            .unwrap();
        let valid: serde_json::Value = serde_json::from_slice(&valid).unwrap();
        assert_eq!(valid["version"], "1.2.3-alpha.1");

        let legacy = normalize_voxelworld_manifest(br#"{"id":"example","version":"1.2"}"#).unwrap();
        let legacy: serde_json::Value = serde_json::from_slice(&legacy).unwrap();
        assert_eq!(legacy["version"], "1.2");
    }
}
