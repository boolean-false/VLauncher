use crate::{TransferControl, TransferEvent, ensure_stopped, profile_store};
use serde::Deserialize;
use std::{
    collections::HashSet,
    io::Write,
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tauri::Emitter;
use vlauncher_core::prepare_package;

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
    if project_id == 0
        || version_id == 0
        || slug.is_empty()
        || slug.len() > 255
        || !slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err("Некорректная версия VoxelWorld".into());
    }
    let id = profile_id
        .parse()
        .map_err(|_| "invalid profile id".to_owned())?;
    let store = profile_store(&app)?;
    let profile = store
        .list()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|profile| profile.id == id)
        .ok_or_else(|| "profile does not exist".to_string())?;
    let engine = profile
        .main_build
        .as_ref()
        .and_then(|build| build.engine_version.as_deref())
        .or(profile.voxelcore_version.as_deref())
        .ok_or_else(|| "profile has no VoxelCore version".to_string())?
        .to_owned();
    control.cancelled.store(false, Ordering::SeqCst);
    let cancelled = control.cancelled.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let client = voxelworld_client()?;
        let root = voxelworld_version(&client, &slug, version_id)?;
        if root.id != version_id || root.project.id != project_id {
            return Err("VoxelWorld вернул другую версию проекта".to_string());
        }
        let mut pending = vec![(root, slug.clone())];
        let mut versions = Vec::new();
        let mut visited = HashSet::new();
        while let Some((version, version_slug)) = pending.pop() {
            if !visited.insert((version.project.id, version.id)) {
                continue;
            }
            if visited.len() > 50 {
                return Err("У проекта слишком много зависимостей".into());
            }
            if !allow_incompatible
                && !version.engine.is_empty()
                && !version
                    .engine
                    .iter()
                    .any(|item| voxelworld_engine_supports(&engine, &item.version_number))
            {
                return Err(format!(
                    "Версия {} проекта {} не поддерживает VoxelCore {}",
                    version.version_number, version.project.title, engine
                ));
            }
            for dependency in &version.dependencies {
                let dependency_slug = dependency
                    .project
                    .slug
                    .as_deref()
                    .ok_or_else(|| "У зависимости VoxelWorld нет идентификатора".to_string())?;
                let detail = voxelworld_version(&client, dependency_slug, dependency.id)?;
                if detail.id != dependency.id || detail.project.id != dependency.project.id {
                    return Err("VoxelWorld вернул другую версию зависимости".into());
                }
                pending.push((detail, dependency_slug.to_owned()));
            }
            versions.push((version, version_slug));
        }

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
            let artifact = prepare_package(&archive_path, prepared.path())
                .map_err(|error| error.to_string())?;
            packages.push(vlauncher_core::ExternalInstallPackage {
                package: vlauncher_core::ExternalPackage {
                    id: artifact.manifest.id.clone(),
                    source: "voxelworld".into(),
                    project_id: version.project.id,
                    slug: version.project.slug.unwrap_or(version_slug),
                    version_id: version.id,
                    version: version.version_number,
                    title: version.project.title,
                    artifact_sha256: artifact.sha256.clone(),
                },
                artifact,
            });
        }
        store
            .install_external_packages(id, packages)
            .map_err(|error| error.to_string())
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
    use super::{VoxelWorldEnvelope, VoxelWorldVersion, voxelworld_engine_supports};

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
}
