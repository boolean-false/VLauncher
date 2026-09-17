use reqwest::blocking::{Client, Response};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::Emitter;
use vlauncher_core::{PreparedArtifact, prepare_package};

use crate::{TransferEvent, application_cache_dir};

const API: &str = "https://api.github.com";
const MAX_DOWNLOAD: u64 = 2 * 1024 * 1024 * 1024;
const PAGE_SIZE: u32 = 10;

#[derive(Clone, Serialize)]
pub struct GithubReleaseAsset {
    id: u64,
    name: String,
    size: u64,
    download_count: u64,
}

#[derive(Clone, Serialize)]
pub struct GithubRelease {
    id: u64,
    name: String,
    tag_name: String,
    body: String,
    prerelease: bool,
    published_at: String,
    assets: Vec<GithubReleaseAsset>,
}

#[derive(Serialize)]
pub struct GithubReleasePage {
    repository: String,
    releases: Vec<GithubRelease>,
    has_more: bool,
}

#[derive(Deserialize)]
struct ApiAsset {
    id: u64,
    name: String,
    size: u64,
    #[serde(default)]
    download_count: u64,
    state: String,
}

#[derive(Deserialize)]
struct ApiRelease {
    id: u64,
    name: Option<String>,
    tag_name: String,
    body: Option<String>,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<ApiAsset>,
}

fn client() -> Result<Client, String> {
    Client::builder()
        .user_agent(concat!("VLauncher/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| error.to_string())
}

fn parse_repository(value: &str) -> Result<(String, String), String> {
    let value = value.trim();
    let (owner, repo_value) = if value.contains("://") {
        let url = reqwest::Url::parse(value)
            .map_err(|_| "Не удалось распознать ссылку на GitHub".to_owned())?;
        if url.scheme() != "https"
            || !matches!(url.host_str(), Some("github.com" | "www.github.com"))
        {
            return Err("Поддерживаются только HTTPS-ссылки на github.com".into());
        }
        let mut parts = url
            .path_segments()
            .ok_or_else(|| "В ссылке не указан репозиторий GitHub".to_owned())?;
        (
            parts.next().unwrap_or_default().to_owned(),
            parts.next().unwrap_or_default().to_owned(),
        )
    } else {
        let (value, github_path) = value
            .strip_prefix("github.com/")
            .map(|path| (path, true))
            .unwrap_or((value.trim_end_matches('/'), false));
        let mut parts = value.split('/');
        let owner = parts.next().unwrap_or_default().to_owned();
        let repo = parts.next().unwrap_or_default().to_owned();
        if !github_path && parts.next().is_some() {
            return Err("Укажите публичный репозиторий в формате owner/repository".into());
        }
        (owner, repo)
    };
    let owner = owner.as_str();
    let repo_value = repo_value.as_str();
    let repo = repo_value.strip_suffix(".git").unwrap_or(repo_value);
    if owner.is_empty()
        || repo.is_empty()
        || repo == "."
        || repo == ".."
        || owner.len() > 39
        || repo.len() > 100
        || owner.starts_with('-')
        || owner.ends_with('-')
        || !owner
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        || !repo
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("Укажите owner/repository или полную HTTPS-ссылку на страницу GitHub".into());
    }
    Ok((owner.to_owned(), repo.to_owned()))
}

fn api_error(response: Response) -> String {
    match response.status().as_u16() {
        403 | 429 => "GitHub временно ограничил запросы без авторизации. Повторите позже.".into(),
        404 => "Публичный репозиторий или релиз не найден.".into(),
        status => format!("GitHub вернул ошибку {status}"),
    }
}

fn get_json<T: serde::de::DeserializeOwned>(http: &Client, url: &str) -> Result<T, String> {
    let response = http
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .map_err(|_| "Не удалось подключиться к GitHub".to_owned())?;
    if !response.status().is_success() {
        return Err(api_error(response));
    }
    response
        .json()
        .map_err(|_| "GitHub вернул некорректный ответ".into())
}

#[tauri::command]
pub async fn list_github_releases(
    repository: String,
    page: u32,
) -> Result<GithubReleasePage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (owner, repo) = parse_repository(&repository)?;
        let page = page.clamp(1, 100);
        let http = client()?;
        let items: Vec<ApiRelease> = get_json(
            &http,
            &format!("{API}/repos/{owner}/{repo}/releases?per_page={PAGE_SIZE}&page={page}"),
        )?;
        let has_more = items.len() == PAGE_SIZE as usize;
        let releases = items
            .into_iter()
            .filter(|release| !release.draft && release.published_at.is_some())
            .map(|release| GithubRelease {
                id: release.id,
                name: release
                    .name
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or_else(|| release.tag_name.clone()),
                tag_name: release.tag_name,
                body: release.body.unwrap_or_default(),
                prerelease: release.prerelease,
                published_at: release.published_at.unwrap_or_default(),
                assets: release
                    .assets
                    .into_iter()
                    .filter(|asset| {
                        asset.state == "uploaded"
                            && asset.name.to_ascii_lowercase().ends_with(".zip")
                            && asset.size > 0
                            && asset.size <= MAX_DOWNLOAD
                    })
                    .map(|asset| GithubReleaseAsset {
                        id: asset.id,
                        name: asset.name,
                        size: asset.size,
                        download_count: asset.download_count,
                    })
                    .collect(),
            })
            .collect();
        Ok(GithubReleasePage {
            repository: format!("{owner}/{repo}"),
            releases,
            has_more,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn download(
    app: &tauri::AppHandle,
    cancelled: Arc<AtomicBool>,
    response: Response,
    expected_size: Option<u64>,
    target: &mut fs::File,
) -> Result<(), String> {
    if !response.status().is_success() {
        return Err(api_error(response));
    }
    let total = expected_size
        .or_else(|| response.content_length())
        .unwrap_or(0);
    if total > MAX_DOWNLOAD {
        return Err("ZIP из GitHub превышает 2 ГБ".into());
    }
    let started = Instant::now();
    let mut response = response;
    let mut completed = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err("download paused by user".into());
        }
        let read = response
            .read(&mut buffer)
            .map_err(|error| format!("Не удалось скачать ZIP из GitHub: {error}"))?;
        if read == 0 {
            break;
        }
        completed = completed.saturating_add(read as u64);
        if completed > MAX_DOWNLOAD {
            return Err("ZIP из GitHub превышает 2 ГБ".into());
        }
        target
            .write_all(&buffer[..read])
            .map_err(|error| format!("Не удалось сохранить ZIP: {error}"))?;
        let speed = (completed as f64 / started.elapsed().as_secs_f64().max(0.001)) as u64;
        let _ = app.emit(
            "transfer-progress",
            TransferEvent {
                kind: "download",
                completed,
                total: total.max(completed),
                bytes_per_second: speed,
                eta_seconds: if speed > 0 && total > completed {
                    (total - completed) / speed
                } else {
                    0
                },
            },
        );
    }
    if let Some(expected) = expected_size
        && completed != expected
    {
        return Err("GitHub передал ZIP другого размера".into());
    }
    target.sync_all().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn prepare_github_release(
    app: tauri::AppHandle,
    control: tauri::State<'_, crate::TransferControl>,
    repository: String,
    asset_id: Option<u64>,
    tag: Option<String>,
) -> Result<PreparedArtifact, String> {
    let cancelled = control.cancelled.clone();
    cancelled.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        let (owner, repo) = parse_repository(&repository)?;
        if asset_id.is_some() == tag.is_some() {
            return Err("Выберите один ZIP из релиза GitHub".into());
        }
        let http = client()?;
        let (url, expected_size) = if let Some(asset_id) = asset_id {
            let url = format!("{API}/repos/{owner}/{repo}/releases/assets/{asset_id}");
            let asset: ApiAsset = get_json(&http, &url)?;
            if asset.state != "uploaded"
                || !asset.name.to_ascii_lowercase().ends_with(".zip")
                || asset.size == 0
                || asset.size > MAX_DOWNLOAD
            {
                return Err("Выбранный файл GitHub не является доступным ZIP-архивом".into());
            }
            (url, Some(asset.size))
        } else {
            let tag = tag.unwrap();
            let mut release_url =
                reqwest::Url::parse(&format!("{API}/repos/{owner}/{repo}/releases/tags/"))
                    .map_err(|error| error.to_string())?;
            release_url
                .path_segments_mut()
                .map_err(|_| "Некорректный адрес GitHub")?
                .push(&tag);
            let release: ApiRelease = get_json(&http, release_url.as_str())?;
            if release.draft || release.published_at.is_none() || release.tag_name != tag {
                return Err("Релиз GitHub недоступен".into());
            }
            let mut zip_url = reqwest::Url::parse(&format!("{API}/repos/{owner}/{repo}/zipball/"))
                .map_err(|error| error.to_string())?;
            zip_url
                .path_segments_mut()
                .map_err(|_| "Некорректный адрес GitHub")?
                .push(&tag);
            (zip_url.to_string(), None)
        };
        let response = http
            .get(url)
            .header("Accept", "application/octet-stream")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .map_err(|_| "Не удалось скачать ZIP из GitHub".to_owned())?;
        let temporary_dir = application_cache_dir(&app)?.join("github-imports");
        fs::create_dir_all(&temporary_dir).map_err(|error| error.to_string())?;
        let mut temporary = tempfile::Builder::new()
            .prefix("github-release-")
            .suffix(".zip")
            .tempfile_in(temporary_dir)
            .map_err(|error| error.to_string())?;
        download(
            &app,
            cancelled,
            response,
            expected_size,
            temporary.as_file_mut(),
        )?;
        let output = application_cache_dir(&app)?.join("prepared-uploads");
        prepare_package(temporary.path(), output).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::parse_repository;

    #[test]
    fn normalizes_public_repository_names() {
        for value in [
            "https://github.com/DaggerLab/example.git/",
            "https://github.com/DaggerLab/example/releases",
            "https://github.com/DaggerLab/example/releases/tag/v1.0.0",
            "https://github.com/DaggerLab/example/releases/download/v1.0.0/pack.zip",
            "https://github.com/DaggerLab/example?tab=readme-ov-file",
            "github.com/DaggerLab/example/releases",
            "DaggerLab/example",
        ] {
            assert_eq!(
                parse_repository(value).unwrap(),
                ("DaggerLab".into(), "example".into()),
                "{value}"
            );
        }
    }

    #[test]
    fn rejects_non_repository_urls() {
        for value in [
            "",
            "owner",
            "http://github.com/a/b",
            "https://example.com/a/b",
            "a/b/c",
            "a/..",
            "-owner/repo",
        ] {
            assert!(parse_repository(value).is_err(), "{value}");
        }
    }
}
