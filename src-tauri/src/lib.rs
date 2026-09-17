#[cfg(target_os = "linux")]
mod linux_desktop;
mod mainline;
mod presence;
#[cfg(unix)]
mod presence_ipc;
mod registry_auth;
mod voxelworld;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Serialize;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Write},
    path::{Component, Path},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use vlauncher_core::{
    CacheStatus, DeliveryManifest, ExistingGameAnalysis, InstallPlan, InstalledRuntime,
    PackageKind, PackageManifest, PreparedArtifact, Profile, ProfileDefinition, ProfileStorage,
    ProfileStore, RemoteInstallPlan, SignedRemoteInstallPlan, UploadReceipt, prepare_package,
    upload_package_with_progress,
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Default)]
struct GameProcesses {
    children: Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>,
    expected_stops: Arc<Mutex<HashSet<String>>>,
}

#[derive(Clone, Default)]
struct TransferControl {
    cancelled: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
struct TransferEvent {
    kind: &'static str,
    completed: u64,
    total: u64,
    bytes_per_second: u64,
    eta_seconds: u64,
}

fn plan_modpack(plan: &RemoteInstallPlan) -> Result<Option<&str>, String> {
    let mut modpacks = plan
        .packages
        .iter()
        .filter(|package| package.kind == PackageKind::Modpack);
    let first = modpacks.next().map(|package| package.id.as_str());
    if modpacks.next().is_some() {
        return Err("a profile cannot contain multiple modpacks".into());
    }
    if let Some(id) = first
        && !plan.roots.iter().any(|root| root == id)
    {
        return Err("a modpack must be a profile root".into());
    }
    Ok(first)
}

fn ensure_profile_modpack_unchanged(
    store: &ProfileStore,
    profile_id: uuid::Uuid,
    plan: &RemoteInstallPlan,
) -> Result<(), String> {
    let next = plan_modpack(plan)?;
    let profile = store
        .list()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "profile does not exist".to_owned())?;
    let current = profile
        .packages
        .iter()
        .find(|package| package.kind == PackageKind::Modpack)
        .map(|package| package.id.as_str());
    ensure_modpack_transition(current, next)
}

fn ensure_modpack_transition(current: Option<&str>, next: Option<&str>) -> Result<(), String> {
    if current == next || (current.is_none() && next.is_none()) {
        Ok(())
    } else {
        Err("a modpack must be installed as a separate profile".into())
    }
}

#[derive(Clone, Serialize)]
struct GameEvent {
    profile_id: String,
    stream: &'static str,
    message: String,
    success: Option<bool>,
}

#[derive(Serialize)]
struct LauncherInfo {
    version: &'static str,
    platform: &'static str,
    architecture: &'static str,
}

#[tauri::command]
fn launcher_info() -> LauncherInfo {
    LauncherInfo {
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
    }
}

#[tauri::command]
fn write_theme_config(path: String, contents: String) -> Result<(), String> {
    if contents.len() > 128 * 1024 {
        return Err("theme configuration is too large".into());
    }
    std::fs::write(&path, contents)
        .map_err(|error| format!("could not write theme config: {error}"))
}

#[tauri::command]
async fn download_review_file(
    kind: String,
    id: String,
    path: String,
    token: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !matches!(kind.as_str(), "release" | "launcher")
            || id.len() != 36
            || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
        {
            return Err("Некорректный файл проверки".to_string());
        }
        let url = format!(
            "{}/management/files/{}/{}",
            registry_url().trim_end_matches('/'),
            kind,
            id
        );
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(600))
            .build()
            .map_err(|e| e.to_string())?;
        let response = client
            .get(url)
            .bearer_auth(token)
            .send()
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err("Сервер не вернул файл".into());
        }
        let expected = response.content_length();
        let limit = 2 * 1024 * 1024 * 1024u64;
        if expected.is_some_and(|size| size > limit) {
            return Err("Файл превышает 2 ГиБ".into());
        }
        let destination = std::path::Path::new(&path);
        let parent = destination.parent().ok_or("Не выбрана папка сохранения")?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        let mut source = std::io::Read::take(response, limit + 1);
        let copied =
            std::io::copy(&mut source, temporary.as_file_mut()).map_err(|e| e.to_string())?;
        if copied > limit || expected.is_some_and(|size| size != copied) {
            return Err("Файл загружен не полностью".into());
        }
        temporary.as_file().sync_all().map_err(|e| e.to_string())?;
        temporary.persist(destination).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn read_theme_config(path: String) -> Result<String, String> {
    let metadata = std::fs::metadata(&path)
        .map_err(|error| format!("could not inspect theme config: {error}"))?;
    if metadata.len() > 128 * 1024 {
        return Err("theme configuration is too large".into());
    }
    std::fs::read_to_string(&path).map_err(|error| format!("could not read theme config: {error}"))
}

#[tauri::command]
fn validate_package(path: String) -> Result<PackageManifest, String> {
    PackageManifest::read(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn preview_delivery(path: String) -> Result<DeliveryManifest, String> {
    DeliveryManifest::build(path).map_err(|error| error.to_string())
}

fn registry_url() -> &'static str {
    option_env!("VLAUNCHER_REGISTRY_URL")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("https://example.invalid/api/v1")
}

const KEYRING_SERVICE: &str = "vlauncher";

fn application_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .data_dir()
        .map_err(|error| format!("could not locate application data: {error}"))?
        .join("vlauncher"))
}

fn application_config_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .config_dir()
        .map_err(|error| format!("could not locate application config: {error}"))?
        .join("vlauncher"))
}

fn application_cache_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .cache_dir()
        .map_err(|error| format!("could not locate application cache: {error}"))?
        .join("vlauncher"))
}

fn token_scope() -> String {
    use base64::Engine;
    format!(
        "registry-access-token-{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(registry_url().trim_end_matches('/'))
    )
}

fn token_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &token_scope())
        .map_err(|error| format!("system credential store is unavailable: {error}"))
}

fn fallback_token_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(application_config_dir(app)?.join(token_scope()))
}

fn save_fallback_token(path: &std::path::Path, token: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "access token path has no parent directory".to_owned())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("could not create application config: {error}"))?;
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("could not create access token file: {error}"))?;
    file.write_all(token.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("could not write access token file: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("could not secure access token file: {error}"))?;
    }
    std::fs::rename(&temporary, path)
        .map_err(|error| format!("could not commit access token file: {error}"))
}

fn load_fallback_token(path: &std::path::Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(token) if token.trim().is_empty() => Ok(None),
        Ok(token) => Ok(Some(token)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("could not read access token file: {error}")),
    }
}

#[tauri::command]
fn save_access_token(app: tauri::AppHandle, token: String) -> Result<(), String> {
    if token.trim().is_empty() {
        return Err("access token is empty".into());
    }
    let saved_in_keyring = token_entry()
        .and_then(|entry| {
            entry
                .set_password(&token)
                .map_err(|error| format!("could not save access token: {error}"))
        })
        .is_ok();
    let fallback = fallback_token_path(&app)?;
    if saved_in_keyring {
        let _ = std::fs::remove_file(fallback);
        Ok(())
    } else {
        save_fallback_token(&fallback, &token)
    }
}

#[tauri::command]
fn load_access_token(app: tauri::AppHandle) -> Result<Option<String>, String> {
    if let Ok(entry) = token_entry()
        && let Ok(token) = entry.get_password()
    {
        return Ok(Some(token));
    }
    let fallback = fallback_token_path(&app)?;
    let token = load_fallback_token(&fallback)?;
    if let Some(token) = token.as_ref()
        && let Ok(entry) = token_entry()
        && entry.set_password(token).is_ok()
    {
        let _ = std::fs::remove_file(fallback);
    }
    Ok(token)
}

#[tauri::command]
fn delete_access_token(app: tauri::AppHandle) -> Result<(), String> {
    if let Ok(entry) = token_entry() {
        let _ = entry.delete_credential();
    }
    let fallback = fallback_token_path(&app)?;
    match std::fs::remove_file(fallback) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not delete access token file: {error}")),
    }
}

#[tauri::command]
fn export_diagnostics(path: String, contents: String) -> Result<(), String> {
    if contents.len() > 5 * 1024 * 1024 {
        return Err("diagnostic report is too large".into());
    }
    std::fs::write(&path, contents).map_err(|error| format!("could not write {path}: {error}"))
}

#[tauri::command]
async fn prepare_release(app: tauri::AppHandle, path: String) -> Result<PreparedArtifact, String> {
    let output = application_cache_dir(&app)?.join("prepared-uploads");
    tauri::async_runtime::spawn_blocking(move || {
        prepare_package(path, output).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn prepare_profile_modpack(
    app: tauri::AppHandle,
    profile_id: String,
    slug: String,
    title: String,
    version: String,
    creator: String,
    license: String,
    worlds: Vec<String>,
) -> Result<PreparedArtifact, String> {
    let id = profile_id
        .parse()
        .map_err(|_| "invalid profile id".to_owned())?;
    let output = application_cache_dir(&app)?.join("prepared-uploads");
    profile_store(&app)?
        .prepare_modpack(
            id, &slug, &title, &version, &creator, &license, &worlds, output,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn prepare_profile_world(
    app: tauri::AppHandle,
    profile_id: String,
    folder: String,
    slug: String,
    title: String,
    version: String,
    creator: String,
    license: String,
) -> Result<PreparedArtifact, String> {
    let id = profile_id
        .parse()
        .map_err(|_| "invalid profile id".to_owned())?;
    let output = application_cache_dir(&app)?.join("prepared-uploads");
    profile_store(&app)?
        .prepare_world_package(
            id, &folder, &slug, &title, &version, &creator, &license, output,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn publish_release(
    app: tauri::AppHandle,
    control: tauri::State<'_, TransferControl>,
    token: String,
    project_id: String,
    artifact: PreparedArtifact,
    channel: String,
    changelog: String,
) -> Result<UploadReceipt, String> {
    control.cancelled.store(false, Ordering::SeqCst);
    let cancelled = control.cancelled.clone();
    let started = Instant::now();
    tauri::async_runtime::spawn_blocking(move || {
        upload_package_with_progress(
            registry_url(),
            &token,
            &project_id,
            &artifact,
            &channel,
            &changelog,
            move |completed, total| {
                let elapsed = started.elapsed().as_secs_f64().max(0.001);
                let bytes_per_second = (completed as f64 / elapsed) as u64;
                let eta_seconds = if bytes_per_second > 0 {
                    total.saturating_sub(completed) / bytes_per_second
                } else {
                    0
                };
                let _ = app.emit(
                    "transfer-progress",
                    TransferEvent {
                        kind: "upload",
                        completed,
                        total,
                        bytes_per_second,
                        eta_seconds,
                    },
                );
                !cancelled.load(Ordering::SeqCst)
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn cancel_transfer(control: tauri::State<TransferControl>) {
    control.cancelled.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn exit_launcher(app: tauri::AppHandle) {
    app.exit(0);
}

fn profile_store(app: &tauri::AppHandle) -> Result<ProfileStore, String> {
    let default_path = application_data_dir(app)?;
    let pointer = application_config_dir(app)?.join("library-location");
    let path = match std::fs::read_to_string(&pointer) {
        Ok(value) => {
            let configured = std::path::PathBuf::from(value.trim());
            if !configured.is_dir() {
                return Err(format!(
                    "Настроенная библиотека недоступна: {}",
                    configured.display()
                ));
            }
            configured
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => default_path,
        Err(error) => return Err(format!("could not read library location: {error}")),
    };
    ProfileStore::open(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn library_location(app: tauri::AppHandle) -> Result<String, String> {
    Ok(profile_store(&app)?
        .root_path()
        .to_string_lossy()
        .into_owned())
}

#[tauri::command]
fn move_library(
    app: tauri::AppHandle,
    processes: tauri::State<GameProcesses>,
    parent: String,
) -> Result<String, String> {
    if !processes
        .children
        .lock()
        .map_err(|_| "process lock failed")?
        .is_empty()
    {
        return Err("Сначала завершите все запущенные игры".into());
    }
    let store = profile_store(&app)?;
    let source = store.root_path().to_owned();
    let destination = std::path::PathBuf::from(parent).join("VLauncherLibrary");
    store
        .copy_library_to(&destination)
        .map_err(|error| error.to_string())?;
    let config = application_config_dir(&app)?;
    std::fs::create_dir_all(&config).map_err(|error| error.to_string())?;
    let pointer = config.join("library-location");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = config.join(format!("library-location-{nonce}.tmp"));
    let previous = config.join(format!("library-location-{nonce}.previous"));
    std::fs::write(&temporary, destination.to_string_lossy().as_bytes())
        .map_err(|error| error.to_string())?;
    if pointer.exists() {
        std::fs::rename(&pointer, &previous).map_err(|error| error.to_string())?;
    }
    if let Err(error) = std::fs::rename(&temporary, &pointer) {
        if previous.exists() {
            let _ = std::fs::rename(&previous, &pointer);
        }
        let _ = std::fs::remove_dir_all(&destination);
        return Err(error.to_string());
    }
    if previous.exists() {
        let _ = std::fs::remove_file(previous);
    }
    if source != destination {
        let _ = std::fs::remove_dir_all(source);
    }
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
fn list_profiles(app: tauri::AppHandle) -> Result<Vec<Profile>, String> {
    profile_store(&app)?
        .list()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn create_profile(app: tauri::AppHandle, name: String) -> Result<Profile, String> {
    profile_store(&app)?
        .create(&name)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn create_initialized_profile(
    app: tauri::AppHandle,
    name: String,
    version: String,
    main_build: Option<vlauncher_core::mainline::MainBuild>,
) -> Result<Profile, String> {
    if main_build.is_some() {
        mainline::require_enabled(&app)?;
    }
    profile_store(&app)?
        .create_initialized_with_main(&name, &version, main_build)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn create_profile_from_plan(
    app: tauri::AppHandle,
    control: tauri::State<'_, TransferControl>,
    name: String,
    plan: SignedRemoteInstallPlan,
) -> Result<Profile, String> {
    let store = profile_store(&app)?;
    control.cancelled.store(false, Ordering::SeqCst);
    let cancelled = control.cancelled.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let verified = plan
            .verify_trusted(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64,
            )
            .map_err(|error| error.to_string())?;
        plan_modpack(&verified)?;
        let profile = store.create(&name).map_err(|error| error.to_string())?;
        let result = (|| {
            store
                .apply_remote(profile.id, &verified)
                .map_err(|error| error.to_string())?;
            if let Some(packages) = verified.external_packages {
                voxelworld::install_locked_packages(
                    &app, &store, profile.id, packages, &cancelled,
                )?;
            }
            store
                .list()
                .map_err(|error| error.to_string())?
                .into_iter()
                .find(|item| item.id == profile.id)
                .ok_or_else(|| "profile does not exist".to_owned())
        })();
        if result.is_err() {
            let _ = store.delete_profile(profile.id);
        }
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn initialize_vanilla(
    app: tauri::AppHandle,
    profile_id: String,
    version: String,
) -> Result<(), String> {
    let id = profile_id.parse().map_err(|_| "invalid profile id")?;
    profile_store(&app)?
        .initialize_vanilla(id, &version)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn change_vanilla_runtime(
    app: tauri::AppHandle,
    profile_id: String,
    version: String,
) -> Result<(), String> {
    ensure_stopped(&app, &profile_id)?;
    let id = profile_id.parse().map_err(|_| "invalid profile id")?;
    profile_store(&app)?
        .change_vanilla_runtime(id, &version)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_profile_icon(
    app: tauri::AppHandle,
    profile_id: String,
    icon: Option<String>,
) -> Result<(), String> {
    let id = profile_id.parse().map_err(|_| "invalid profile id")?;
    profile_store(&app)?
        .set_icon(id, icon.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_profile(app: tauri::AppHandle, profile_id: String, name: String) -> Result<(), String> {
    ensure_stopped(&app, &profile_id)?;
    let id = profile_id.parse().map_err(|_| "invalid profile id")?;
    profile_store(&app)?
        .rename(id, &name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_profile_folder(
    app: tauri::AppHandle,
    profile_id: String,
    section: String,
) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    use tauri_plugin_opener::OpenerExt;
    let id = profile_id.parse().map_err(|_| "invalid profile id")?;
    let store = profile_store(&app)?;
    let external = store
        .list()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|profile| profile.id == id)
        .ok_or("profile does not exist")?
        .external_game_path
        .is_some();
    let mut path = store.game_directory(id).map_err(|e| e.to_string())?;
    if external && !path.is_dir() {
        return Err("Подключённая папка игры недоступна. Выберите её новое расположение в управлении профилем.".into());
    }
    match section.as_str() {
        "game" => {}
        "worlds" => path.push("worlds"),
        "content" => path.push("content"),
        _ => return Err("invalid folder".into()),
    }
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    return tauri::async_runtime::spawn_blocking(move || linux_desktop::open_folder(&path))
        .await
        .map_err(|error| error.to_string())?;
    #[cfg(not(target_os = "linux"))]
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

fn package_icon_data(package: &Path) -> Option<String> {
    let (path, mime) = [
        ("icon.png", "image/png"),
        ("icon.webp", "image/webp"),
        ("icon.jpg", "image/jpeg"),
        ("icon.jpeg", "image/jpeg"),
    ]
    .into_iter()
    .map(|(name, mime)| (package.join(name), mime))
    .find(|(candidate, _)| {
        std::fs::symlink_metadata(candidate).is_ok_and(|metadata| {
            metadata.file_type().is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() <= 2 * 1024 * 1024
        })
    })?;
    let bytes = std::fs::read(path).ok()?;
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[tauri::command]
fn read_content_icon(
    app: tauri::AppHandle,
    profile_id: String,
    package_id: String,
) -> Result<Option<String>, String> {
    let id = profile_id.parse().map_err(|_| "invalid profile id")?;
    let mut components = Path::new(&package_id).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err("invalid package id".into());
    }
    let store = profile_store(&app)?;
    let profile = store
        .list()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|profile| profile.id == id)
        .ok_or_else(|| "profile does not exist".to_owned())?;
    let installed = profile
        .packages
        .iter()
        .any(|package| package.id == package_id)
        || profile
            .external_packages
            .iter()
            .any(|package| package.id == package_id)
        || profile
            .manual_packages
            .iter()
            .any(|package| package == &package_id);
    if !installed {
        return Err("package is not installed".into());
    }
    let package = store
        .game_directory(id)
        .map_err(|error| error.to_string())?
        .join("content")
        .join(package_id);
    Ok(package_icon_data(&package))
}

#[derive(Serialize)]
struct LocalWorld {
    folder: String,
    name: String,
    origin_title: Option<String>,
    origin_version: Option<String>,
    bundled: bool,
    modified: u64,
    voxelcore_version: Option<String>,
    compatible: Option<bool>,
    dependencies: Vec<String>,
    missing_dependencies: Vec<String>,
    preview_data: Option<String>,
}

#[tauri::command]
fn list_worlds(app: tauri::AppHandle, profile_id: String) -> Result<Vec<LocalWorld>, String> {
    let id = profile_id.parse().map_err(|_| "invalid profile id")?;
    let store = profile_store(&app)?;
    let profile = store
        .list()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|profile| profile.id == id)
        .ok_or_else(|| "profile does not exist".to_owned())?;
    let installed = profile
        .packages
        .iter()
        .map(|package| package.id.clone())
        .chain(
            profile
                .external_packages
                .iter()
                .map(|package| package.id.clone()),
        )
        .chain(profile.manual_packages.iter().cloned())
        .chain(["base".to_owned()])
        .collect::<HashSet<_>>();
    let path = store
        .game_directory(id)
        .map_err(|e| e.to_string())?
        .join("worlds");
    if !path.exists() {
        return Ok(vec![]);
    }
    let mut worlds = Vec::new();
    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let folder = entry.file_name().to_string_lossy().into_owned();
        let metadata_path = entry.path().join("world.json");
        let metadata = std::fs::read(&metadata_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        let name = metadata
            .as_ref()
            .and_then(|value| value.get("name"))
            .and_then(|value| value.as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| folder.clone());
        let origin = std::fs::read(entry.path().join(".vlauncher-world.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        let origin_title = origin
            .as_ref()
            .and_then(|value| value.get("title"))
            .and_then(|value| value.as_str())
            .map(str::to_owned);
        let origin_version = origin
            .as_ref()
            .and_then(|value| value.get("package_version"))
            .and_then(|value| value.as_str())
            .map(str::to_owned);
        let bundled = origin
            .as_ref()
            .and_then(|value| value.get("bundled"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let voxelcore_version = metadata
            .as_ref()
            .and_then(|value| value.get("version"))
            .and_then(|version| {
                Some(format!(
                    "{}.{}",
                    version.get("major")?.as_i64()?,
                    version.get("minor")?.as_i64()?
                ))
            });
        let compatible = voxelcore_version.as_ref().map(|version| {
            profile
                .voxelcore_version
                .as_ref()
                .is_none_or(|profile_version| {
                    profile_version == version
                        || profile_version.strip_prefix(version).is_some_and(|suffix| {
                            suffix.starts_with('.')
                                || suffix.starts_with('-')
                                || suffix.starts_with('+')
                        })
                })
        });
        let dependencies = std::fs::read_to_string(entry.path().join("packs.list"))
            .map(|contents| {
                let mut seen = HashSet::new();
                contents
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty() && !line.starts_with('#'))
                    .filter(|line| seen.insert((*line).to_owned()))
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let missing_dependencies = dependencies
            .iter()
            .filter(|dependency| !installed.contains(*dependency))
            .cloned()
            .collect();
        let preview_path = [
            "preview.png",
            "icon.png",
            "preview.webp",
            "icon.webp",
            "preview.jpg",
            "icon.jpg",
            "preview.jpeg",
            "icon.jpeg",
        ]
        .into_iter()
        .map(|name| entry.path().join(name))
        .find(|candidate| candidate.is_file());
        let preview_data = preview_path.and_then(|candidate| {
            let metadata = std::fs::metadata(&candidate).ok()?;
            if metadata.len() > 2 * 1024 * 1024 {
                return None;
            }
            let mime = match candidate
                .extension()
                .and_then(|extension| extension.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase()
                .as_str()
            {
                "png" => "image/png",
                "webp" => "image/webp",
                "jpg" | "jpeg" => "image/jpeg",
                _ => return None,
            };
            let bytes = std::fs::read(candidate).ok()?;
            Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
        });
        let modified = std::fs::metadata(&metadata_path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        worlds.push(LocalWorld {
            folder,
            name,
            origin_title,
            origin_version,
            bundled,
            modified,
            voxelcore_version,
            compatible,
            dependencies,
            missing_dependencies,
            preview_data,
        });
    }
    worlds.sort_by(|a, b| b.modified.cmp(&a.modified).then(a.name.cmp(&b.name)));
    Ok(worlds)
}

#[tauri::command]
fn import_world(app: tauri::AppHandle, profile_id: String, path: String) -> Result<String, String> {
    ensure_stopped(&app, &profile_id)?;
    let id = profile_id.parse().map_err(|_| "invalid profile id")?;
    profile_store(&app)?
        .import_world(id, path)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn export_world(
    app: tauri::AppHandle,
    profile_id: String,
    folder: String,
    path: String,
) -> Result<String, String> {
    ensure_stopped(&app, &profile_id)?;
    let id = profile_id.parse().map_err(|_| "invalid profile id")?;
    profile_store(&app)?
        .export_world(id, &folder, path)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn running_profiles(processes: tauri::State<GameProcesses>) -> Result<Vec<String>, String> {
    Ok(processes
        .children
        .lock()
        .map_err(|_| "process lock failed")?
        .keys()
        .cloned()
        .collect())
}

fn ensure_stopped(app: &tauri::AppHandle, profile_id: &str) -> Result<(), String> {
    let processes = app.state::<GameProcesses>();
    if processes
        .children
        .lock()
        .map_err(|_| "process lock failed")?
        .contains_key(profile_id)
    {
        return Err("Сначала завершите игру в этом профиле".into());
    }
    Ok(())
}

#[tauri::command]
fn clone_profile(
    app: tauri::AppHandle,
    profile_id: String,
    name: String,
) -> Result<Profile, String> {
    ensure_stopped(&app, &profile_id)?;
    let id = profile_id
        .parse()
        .map_err(|_| "invalid profile id".to_owned())?;
    profile_store(&app)?
        .clone_profile(id, &name)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_profile(app: tauri::AppHandle, profile_id: String) -> Result<(), String> {
    ensure_stopped(&app, &profile_id)?;
    let id = profile_id
        .parse()
        .map_err(|_| "invalid profile id".to_owned())?;
    profile_store(&app)?
        .delete_profile(id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_profile(app: tauri::AppHandle, profile_id: String) -> Result<(), String> {
    ensure_stopped(&app, &profile_id)?;
    let id = profile_id
        .parse()
        .map_err(|_| "invalid profile id".to_owned())?;
    profile_store(&app)?
        .clear_profile(id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn profile_storage(app: tauri::AppHandle, profile_id: String) -> Result<ProfileStorage, String> {
    let id = profile_id
        .parse()
        .map_err(|_| "invalid profile id".to_owned())?;
    profile_store(&app)?
        .profile_storage(id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn clean_profile_snapshots(
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<ProfileStorage, String> {
    ensure_stopped(&app, &profile_id)?;
    let id = profile_id
        .parse()
        .map_err(|_| "invalid profile id".to_owned())?;
    profile_store(&app)?
        .clean_profile_snapshots(id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn export_profile(
    app: tauri::AppHandle,
    profile_id: String,
    path: String,
) -> Result<String, String> {
    let id = profile_id
        .parse()
        .map_err(|_| "invalid profile id".to_owned())?;
    profile_store(&app)?
        .export_profile(id, path)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn read_profile_definition(path: String) -> Result<ProfileDefinition, String> {
    ProfileStore::read_profile_definition(path).map_err(|error| error.to_string())
}

#[tauri::command]
async fn popup_menu_position(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
) -> Result<(f64, f64), String> {
    if !x.is_finite() || !y.is_finite() {
        return Err("invalid popup coordinates".into());
    }
    #[cfg(target_os = "linux")]
    {
        // DOM считает координаты от WebView, GTK - от всего окна.
        tauri::async_runtime::spawn_blocking(move || {
            let (send, receive) = std::sync::mpsc::sync_channel(1);
            window
                .with_webview(move |webview| {
                    use gtk::prelude::WidgetExt;
                    use webkit2gtk::WebViewExt;
                    let view = webview.inner();
                    let zoom = view.zoom_level();
                    let translated = view
                        .toplevel()
                        .and_then(|parent| {
                            view.translate_coordinates(
                                &parent,
                                (x * zoom).round() as i32,
                                (y * zoom).round() as i32,
                            )
                        })
                        .map(|(x, y)| (x as f64, y as f64))
                        .ok_or_else(|| "popup parent is not mapped".to_owned());
                    let _ = send.send(translated);
                })
                .map_err(|error| error.to_string())?;
            receive
                .recv_timeout(std::time::Duration::from_secs(5))
                .map_err(|error| error.to_string())?
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window;
        Ok((x, y))
    }
}

#[tauri::command]
fn edit_text(window: tauri::WebviewWindow, command: String) -> Result<(), String> {
    if !["Copy", "Cut", "Paste", "Undo", "Redo", "SelectAll"].contains(&command.as_str()) {
        return Err("unknown editing command".into());
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window;
        return Err("use native editing menu items on this platform".into());
    }
    #[cfg(target_os = "linux")]
    window
        .with_webview(move |webview| {
            use webkit2gtk::WebViewExt;
            webview.inner().execute_editing_command(&command);
        })
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "linux")]
    Ok(())
}

#[tauri::command]
fn list_runtimes(app: tauri::AppHandle) -> Result<Vec<InstalledRuntime>, String> {
    profile_store(&app)?
        .list_runtimes()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn remove_runtime(app: tauri::AppHandle, version: String) -> Result<(), String> {
    profile_store(&app)?
        .remove_runtime(&version)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn import_runtime(app: tauri::AppHandle, path: String) -> Result<InstalledRuntime, String> {
    profile_store(&app)?
        .import_runtime(path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn analyze_existing_game(
    app: tauri::AppHandle,
    path: String,
) -> Result<ExistingGameAnalysis, String> {
    let store = profile_store(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        store
            .analyze_existing_game(path)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn attach_existing_game(
    app: tauri::AppHandle,
    path: String,
    name: String,
    version: String,
) -> Result<Profile, String> {
    let store = profile_store(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        store
            .attach_existing_game(path, &name, &version)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn reconnect_existing_game(
    app: tauri::AppHandle,
    profile_id: String,
    path: String,
) -> Result<Profile, String> {
    ensure_stopped(&app, &profile_id)?;
    let id = profile_id.parse().map_err(|_| "invalid profile id")?;
    let store = profile_store(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        store
            .reconnect_existing_game(id, path)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn cache_status(app: tauri::AppHandle) -> Result<CacheStatus, String> {
    profile_store(&app)?
        .cache_status()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_cache(app: tauri::AppHandle) -> Result<CacheStatus, String> {
    profile_store(&app)?
        .clear_cache()
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_official_runtimes() -> Result<Vec<vlauncher_core::official::OfficialRelease>, String>
{
    tauri::async_runtime::spawn_blocking(vlauncher_core::official::list_official_releases)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn install_official_runtime(
    app: tauri::AppHandle,
    control: tauri::State<'_, TransferControl>,
    version: String,
) -> Result<InstalledRuntime, String> {
    let store = profile_store(&app)?;
    control.cancelled.store(false, Ordering::SeqCst);
    let cancelled = control.cancelled.clone();
    let started = Instant::now();
    tauri::async_runtime::spawn_blocking(move || {
        vlauncher_core::official::install_official_runtime(&store, &version, |completed, total| {
            let speed = (completed as f64 / started.elapsed().as_secs_f64().max(0.001)) as u64;
            let _ = app.emit(
                "transfer-progress",
                TransferEvent {
                    kind: "download",
                    completed,
                    total,
                    bytes_per_second: speed,
                    eta_seconds: if speed > 0 {
                        total.saturating_sub(completed) / speed
                    } else {
                        0
                    },
                },
            );
            !cancelled.load(Ordering::SeqCst)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn install_runtime(
    app: tauri::AppHandle,
    control: tauri::State<'_, TransferControl>,
    plan: SignedRemoteInstallPlan,
) -> Result<InstalledRuntime, String> {
    let store = profile_store(&app)?;
    control.cancelled.store(false, Ordering::SeqCst);
    let cancelled = control.cancelled.clone();
    let total = plan
        .plan
        .packages
        .iter()
        .map(|package| package.artifact_size)
        .sum();
    let progress = Arc::new(Mutex::new(HashMap::<String, u64>::new()));
    let started = Instant::now();
    tauri::async_runtime::spawn_blocking(move || {
        store.install_signed_runtime_with_progress(&plan, |id, completed, _| {
            let aggregate = if let Ok(mut values) = progress.lock() {
                values.insert(id.to_owned(), completed);
                values.values().copied().sum()
            } else {
                completed
            };
            let speed = (aggregate as f64 / started.elapsed().as_secs_f64().max(0.001)) as u64;
            let _ = app.emit(
                "transfer-progress",
                TransferEvent {
                    kind: "download",
                    completed: aggregate,
                    total,
                    bytes_per_second: speed,
                    eta_seconds: if speed > 0 {
                        total.saturating_sub(aggregate) / speed
                    } else {
                        0
                    },
                },
            );
            !cancelled.load(Ordering::SeqCst)
        })
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

fn stream_output(
    app: tauri::AppHandle,
    profile_id: String,
    stream: &'static str,
    reader: impl std::io::Read + Send + 'static,
) {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let _ = app.emit(
                "game-log",
                GameEvent {
                    profile_id: profile_id.clone(),
                    stream,
                    message: line,
                    success: None,
                },
            );
        }
    });
}

#[cfg(target_os = "linux")]
fn system_interpreter_from_maps(maps: &str) -> Option<std::path::PathBuf> {
    maps.lines()
        .filter_map(|line| line.split_whitespace().nth(5))
        .map(std::path::PathBuf::from)
        .find(|path| {
            path.is_absolute()
                && path
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("ld-linux"))
        })
}

#[cfg(target_os = "linux")]
fn system_interpreter() -> Result<std::path::PathBuf, String> {
    let maps = std::fs::read_to_string("/proc/self/maps")
        .map_err(|error| format!("could not read the system dynamic linker: {error}"))?;
    let path = system_interpreter_from_maps(&maps)
        .ok_or_else(|| "could not find the system dynamic linker".to_owned())?;
    path.canonicalize()
        .map_err(|error| format!("could not resolve the system dynamic linker: {error}"))
}

#[tauri::command]
fn launch_profile(
    app: tauri::AppHandle,
    processes: tauri::State<GameProcesses>,
    profile_id: String,
    runtime_version: String,
) -> Result<u32, String> {
    let id = profile_id
        .parse()
        .map_err(|_| "invalid profile id".to_owned())?;
    let mut children = processes
        .children
        .lock()
        .map_err(|_| "process lock failed")?;
    if children.contains_key(&profile_id) {
        return Err("profile is already running".into());
    }
    processes
        .expected_stops
        .lock()
        .map_err(|_| "process lock failed")?
        .remove(&profile_id);
    let spec = profile_store(&app)?
        .launch_spec(id, &runtime_version)
        .map_err(|error| error.to_string())?;
    let mut command = Command::new(&spec.executable);
    command
        .args(&spec.arguments)
        .current_dir(&spec.working_directory)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "linux")]
    if spec
        .executable
        .file_name()
        .is_some_and(|name| name == "AppRun")
    {
        let launcher_appdir = std::env::var_os("APPDIR").map(std::path::PathBuf::from);
        linux_desktop::prepare_game_appimage(
            &mut command,
            launcher_appdir.as_deref(),
            spec.executable
                .parent()
                .ok_or("AppRun has no parent directory")?,
        );
        command.env("SYSTEM_INTERP", system_interpreter()?);
    }
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start VoxelCore: {error}"))?;
    let process_id = child.id();
    if let Some(stdout) = child.stdout.take() {
        stream_output(app.clone(), profile_id.clone(), "stdout", stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        stream_output(app.clone(), profile_id.clone(), "stderr", stderr);
    }
    let child = Arc::new(Mutex::new(child));
    children.insert(profile_id.clone(), child.clone());
    drop(children);
    let process_map = processes.children.clone();
    let expected_stops = processes.expected_stops.clone();
    std::thread::spawn(move || {
        loop {
            let status = child
                .lock()
                .ok()
                .and_then(|mut child| child.try_wait().ok().flatten());
            if let Some(status) = status {
                if let Ok(mut children) = process_map.lock() {
                    children.remove(&profile_id);
                }
                let stopped_by_user = expected_stops
                    .lock()
                    .map(|mut profile_ids| profile_ids.remove(&profile_id))
                    .unwrap_or(false);
                let _ = app.emit(
                    "game-exit",
                    finished_game_event(
                        profile_id,
                        status.to_string(),
                        status.success(),
                        stopped_by_user,
                    ),
                );
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    });
    Ok(process_id)
}

#[tauri::command]
fn stop_profile(processes: tauri::State<GameProcesses>, profile_id: String) -> Result<(), String> {
    let child = processes
        .children
        .lock()
        .map_err(|_| "process lock failed")?
        .get(&profile_id)
        .cloned()
        .ok_or_else(|| "profile is not running".to_owned())?;
    processes
        .expected_stops
        .lock()
        .map_err(|_| "process lock failed")?
        .insert(profile_id.clone());
    let result = child
        .lock()
        .map_err(|_| "process lock failed".to_owned())
        .and_then(|mut child| {
            child
                .kill()
                .map_err(|error| format!("could not stop VoxelCore: {error}"))
        });
    if result.is_err() {
        let _ = processes
            .expected_stops
            .lock()
            .map(|mut profile_ids| profile_ids.remove(&profile_id));
    }
    result
}

fn finished_game_event(
    profile_id: String,
    status_message: String,
    status_success: bool,
    stopped_by_user: bool,
) -> GameEvent {
    GameEvent {
        profile_id,
        stream: "process",
        message: if stopped_by_user {
            "Остановлена пользователем".to_owned()
        } else {
            status_message
        },
        success: Some(stopped_by_user || status_success),
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "linux")]
    use super::system_interpreter_from_maps;
    use super::{
        ensure_modpack_transition, finished_game_event, load_fallback_token, package_icon_data,
        save_fallback_token,
    };

    #[test]
    fn a_profile_can_only_update_its_own_modpack() {
        assert!(ensure_modpack_transition(Some("pack"), Some("pack")).is_ok());
        assert!(ensure_modpack_transition(None, None).is_ok());
        assert!(ensure_modpack_transition(None, Some("pack")).is_err());
        assert!(ensure_modpack_transition(Some("pack"), Some("other_pack")).is_err());
        assert!(ensure_modpack_transition(Some("pack"), None).is_err());
    }

    #[test]
    fn a_requested_stop_is_reported_as_success() {
        let event = finished_game_event(
            "profile-1".to_owned(),
            "signal: 9 (SIGKILL)".to_owned(),
            false,
            true,
        );

        assert_eq!(event.message, "Остановлена пользователем");
        assert_eq!(event.success, Some(true));
    }

    #[test]
    fn an_unexpected_signal_is_reported_as_failure() {
        let event = finished_game_event(
            "profile-1".to_owned(),
            "signal: 9 (SIGKILL)".to_owned(),
            false,
            false,
        );

        assert_eq!(event.message, "signal: 9 (SIGKILL)");
        assert_eq!(event.success, Some(false));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn finds_the_dynamic_linker_in_proc_maps() {
        let maps = concat!(
            "7f20f91de000-7f20f9202000 r--p 00000000 00:00 0 [vvar]\n",
            "7f20f9202000-7f20f9204000 r-xp 00000000 08:01 123 /usr/lib/ld-linux-x86-64.so.2\n",
        );

        assert_eq!(
            system_interpreter_from_maps(maps),
            Some("/usr/lib/ld-linux-x86-64.so.2".into())
        );
    }

    #[test]
    fn fallback_token_file_is_private_and_round_trips() {
        let directory = std::env::temp_dir().join(format!(
            "vlauncher-token-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = directory.join("registry-access-token");
        save_fallback_token(&path, "test-token").unwrap();

        assert_eq!(
            load_fallback_token(&path).unwrap().as_deref(),
            Some("test-token")
        );
        save_fallback_token(&path, "replacement-token").unwrap();
        assert_eq!(
            load_fallback_token(&path).unwrap().as_deref(),
            Some("replacement-token")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn package_icon_prefers_png_and_returns_a_data_url() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("icon.jpg"), b"jpeg").unwrap();
        assert_eq!(
            package_icon_data(directory.path()).as_deref(),
            Some("data:image/jpeg;base64,anBlZw==")
        );

        std::fs::write(directory.path().join("icon.png"), b"png").unwrap();
        assert_eq!(
            package_icon_data(directory.path()).as_deref(),
            Some("data:image/png;base64,cG5n")
        );
    }
}

#[tauri::command]
fn apply_install_plan(
    app: tauri::AppHandle,
    profile_id: String,
    plan: InstallPlan,
) -> Result<(), String> {
    ensure_stopped(&app, &profile_id)?;
    let id = profile_id
        .parse()
        .map_err(|_| "invalid profile id".to_owned())?;
    profile_store(&app)?
        .apply(id, &plan)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn rollback_profile(app: tauri::AppHandle, profile_id: String) -> Result<String, String> {
    ensure_stopped(&app, &profile_id)?;
    let id = profile_id
        .parse()
        .map_err(|_| "invalid profile id".to_owned())?;
    profile_store(&app)?
        .rollback(id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn apply_remote_install_plan(
    app: tauri::AppHandle,
    control: tauri::State<'_, TransferControl>,
    profile_id: String,
    plan: SignedRemoteInstallPlan,
) -> Result<(), String> {
    ensure_stopped(&app, &profile_id)?;
    let id = profile_id
        .parse()
        .map_err(|_| "invalid profile id".to_owned())?;
    let store = profile_store(&app)?;
    control.cancelled.store(false, Ordering::SeqCst);
    let cancelled = control.cancelled.clone();
    let verified = plan
        .verify_trusted(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64,
        )
        .map_err(|error| error.to_string())?;
    ensure_profile_modpack_unchanged(&store, id, &verified)?;
    let total = verified
        .packages
        .iter()
        .map(|package| package.artifact_size)
        .sum::<u64>()
        + verified
            .external_packages
            .iter()
            .flatten()
            .map(|package| package.artifact_size)
            .sum::<u64>();
    let progress = Arc::new(Mutex::new(HashMap::<String, u64>::new()));
    let started = Instant::now();
    tauri::async_runtime::spawn_blocking(move || {
        store
            .apply_remote_with_progress(id, &verified, |package, completed, _| {
                let aggregate = if let Ok(mut values) = progress.lock() {
                    values.insert(package.to_owned(), completed);
                    values.values().copied().sum()
                } else {
                    completed
                };
                let speed = (aggregate as f64 / started.elapsed().as_secs_f64().max(0.001)) as u64;
                let _ = app.emit(
                    "transfer-progress",
                    TransferEvent {
                        kind: "download",
                        completed: aggregate,
                        total,
                        bytes_per_second: speed,
                        eta_seconds: if speed > 0 {
                            total.saturating_sub(aggregate) / speed
                        } else {
                            0
                        },
                    },
                );
                !cancelled.load(Ordering::SeqCst)
            })
            .map_err(|error| error.to_string())?;
        if let Some(packages) = verified.external_packages {
            if let Err(error) =
                voxelworld::install_locked_packages(&app, &store, id, packages, &cancelled)
            {
                let _ = store.rollback(id);
                return Err(error);
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // DMABUF иногда даёт пустое окно или ошибку Wayland.
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let running = window
                    .app_handle()
                    .state::<GameProcesses>()
                    .children
                    .lock()
                    .is_ok_and(|children| !children.is_empty());
                if running {
                    api.prevent_close();
                    let _ = window.emit("close-requested-with-game", ());
                }
            }
        })
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            },
        ))
        .manage(presence::Presence::new())
        .manage(GameProcesses::default())
        .manage(mainline::GithubState::default())
        .manage(TransferControl::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                window.with_webview(|webview| {
                    use webkit2gtk::{SettingsExt, WebViewExt};
                    if let Some(settings) = webview.inner().settings() {
                        settings.set_enable_spatial_navigation(false);
                        settings.set_enable_caret_browsing(false);
                    }
                })?;
            }
            #[cfg(windows)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }
            #[cfg(target_os = "linux")]
            if let Err(error) = linux_desktop::register_desktop_integration(app.handle()) {
                eprintln!("desktop integration unavailable: {error}");
            }
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mainline::mainline_status,
            mainline::set_mainline_enabled,
            mainline::github_logout,
            mainline::github_device_start,
            mainline::github_device_poll,
            mainline::list_mainline_builds,
            mainline::install_mainline_build,
            mainline::select_mainline_build,
            mainline::resolve_mainline_version,
            registry_auth::registry_device_start,
            registry_auth::registry_device_poll,
            launcher_info,
            voxelworld::voxelworld_request,
            voxelworld::preview_voxelworld_install,
            voxelworld::install_voxelworld_mod,
            voxelworld::remove_voxelworld_mod,
            write_theme_config,
            download_review_file,
            read_theme_config,
            presence::update_discord_presence,
            presence::discord_presence_status,
            library_location,
            move_library,
            save_access_token,
            load_access_token,
            delete_access_token,
            export_diagnostics,
            validate_package,
            preview_delivery,
            prepare_release,
            prepare_profile_modpack,
            prepare_profile_world,
            publish_release,
            cancel_transfer,
            exit_launcher,
            list_profiles,
            create_profile,
            create_initialized_profile,
            create_profile_from_plan,
            initialize_vanilla,
            change_vanilla_runtime,
            rename_profile,
            set_profile_icon,
            open_profile_folder,
            read_content_icon,
            list_worlds,
            import_world,
            export_world,
            running_profiles,
            clone_profile,
            delete_profile,
            clear_profile,
            profile_storage,
            clean_profile_snapshots,
            export_profile,
            read_profile_definition,
            list_runtimes,
            edit_text,
            popup_menu_position,
            list_official_runtimes,
            install_official_runtime,
            import_runtime,
            analyze_existing_game,
            attach_existing_game,
            reconnect_existing_game,
            remove_runtime,
            cache_status,
            clear_cache,
            install_runtime,
            launch_profile,
            stop_profile,
            apply_install_plan,
            apply_remote_install_plan,
            rollback_profile
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
