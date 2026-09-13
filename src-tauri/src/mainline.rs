use serde::{Deserialize, Serialize};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use vlauncher_core::{
    InstalledRuntime,
    mainline::{MainBuild, MainCatalog},
};

const CLIENT_ID: &str = "Ov23liMXw0BOJ2RKfKFg";
const SERVICE: &str = "space.vlauncher.github-actions";
const SCOPE: &str = "read:user public_repo";

#[derive(Default)]
pub struct GithubState(Mutex<Session>);
#[derive(Default)]
struct Session {
    token: Option<String>,
    persisted: bool,
    pending: Option<Pending>,
    generation: u64,
}
#[derive(Clone)]
struct Pending {
    device_code: String,
    expires: Instant,
    next_poll: Instant,
    interval: u64,
}
#[derive(Serialize)]
pub struct Status {
    enabled: bool,
    authenticated: bool,
}
#[derive(Serialize)]
pub struct Device {
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}
#[derive(Serialize)]
pub struct Poll {
    complete: bool,
    interval: u64,
    persisted: bool,
}
#[derive(Deserialize)]
struct DeviceResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}
#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    scope: Option<String>,
    error: Option<String>,
}

fn credentials() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, CLIENT_ID)
        .map_err(|_| "Системное хранилище паролей недоступно".into())
}
fn enabled(app: &tauri::AppHandle) -> Result<bool, String> {
    let path = super::application_config_dir(app)?.join("mainline-enabled");
    match std::fs::read_to_string(path) {
        Ok(value) => Ok(value.trim() == "true"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("Не удалось прочитать настройку сборок main".into()),
    }
}
pub(super) fn require_enabled(app: &tauri::AppHandle) -> Result<(), String> {
    if !enabled(app)? {
        return Err("Включите экспериментальные сборки в настройках".into());
    }
    Ok(())
}
fn token(app: &tauri::AppHandle) -> Result<String, String> {
    require_enabled(app)?;
    let state = app.state::<GithubState>();
    let mut session = state.0.lock().map_err(|_| "GitHub session lock failed")?;
    if session.token.is_none() {
        session.token = credentials()
            .ok()
            .and_then(|entry| entry.get_password().ok());
        session.persisted = session.token.is_some();
    }
    session
        .token
        .clone()
        .ok_or_else(|| "Войдите в GitHub в настройках сборок main".into())
}
fn http() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(concat!("VLauncher/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Не удалось создать GitHub-клиент".into())
}

#[tauri::command]
pub fn mainline_status(app: tauri::AppHandle) -> Result<Status, String> {
    let enabled = enabled(&app)?;
    Ok(Status {
        enabled,
        authenticated: enabled && token(&app).is_ok(),
    })
}
#[tauri::command]
pub fn set_mainline_enabled(app: tauri::AppHandle, value: bool) -> Result<Status, String> {
    let folder = super::application_config_dir(&app)?;
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    std::fs::write(
        folder.join("mainline-enabled"),
        if value { "true" } else { "false" },
    )
    .map_err(|e| e.to_string())?;
    if !value {
        github_logout(app.clone())?;
    }
    mainline_status(app)
}
#[tauri::command]
pub fn github_logout(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<GithubState>();
    let mut session = state.0.lock().map_err(|_| "GitHub session lock failed")?;
    let persisted = session.persisted;
    session.token = None;
    session.persisted = false;
    session.pending = None;
    session.generation += 1;
    if let Ok(entry) = credentials() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => (),
            Err(_) if !persisted => (),
            Err(_) => return Err("Режим отключён, но не удалось удалить сохранённый GitHub-токен из системного хранилища".into()),
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn github_device_start(app: tauri::AppHandle) -> Result<Device, String> {
    require_enabled(&app)?;
    let generation = {
        let state = app.state::<GithubState>();
        let mut session = state.0.lock().map_err(|_| "GitHub session lock failed")?;
        session.generation += 1;
        session.pending = None;
        session.generation
    };
    tauri::async_runtime::spawn_blocking(move || {
        let response: DeviceResponse = http()?
            .post("https://github.com/login/device/code")
            .header("Accept", "application/json")
            .form(&[("client_id", CLIENT_ID), ("scope", SCOPE)])
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|_| "GitHub не выдал код входа")?
            .json()
            .map_err(|_| "Некорректный ответ GitHub")?;
        if response.verification_uri != "https://github.com/login/device" {
            return Err("Неожиданный адрес входа GitHub".into());
        }
        let interval = response.interval.max(5);
        let expires_in = response.expires_in.min(900);
        let state = app.state::<GithubState>();
        let mut session = state.0.lock().map_err(|_| "GitHub session lock failed")?;
        if session.generation != generation {
            return Err("Вход отменён".into());
        }
        session.pending = Some(Pending {
            device_code: response.device_code,
            expires: Instant::now() + Duration::from_secs(expires_in),
            next_poll: Instant::now() + Duration::from_secs(interval),
            interval,
        });
        Ok(Device {
            user_code: response.user_code,
            verification_uri: response.verification_uri,
            expires_in,
            interval,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn github_device_poll(app: tauri::AppHandle) -> Result<Poll, String> {
    require_enabled(&app)?;
    let (pending, generation) = {
        let state = app.state::<GithubState>();
        let mut session = state.0.lock().map_err(|_| "GitHub session lock failed")?;
        let generation = session.generation;
        let pending = session
            .pending
            .as_mut()
            .ok_or("Начните вход через GitHub")?;
        if Instant::now() >= pending.expires {
            session.pending = None;
            return Err("Срок действия кода GitHub истёк".into());
        }
        if Instant::now() < pending.next_poll {
            return Ok(Poll {
                complete: false,
                interval: pending.interval,
                persisted: false,
            });
        }
        pending.next_poll = Instant::now() + Duration::from_secs(pending.interval);
        (pending.clone(), generation)
    };
    tauri::async_runtime::spawn_blocking(move || {
        let response: TokenResponse = http()?
            .post("https://github.com/login/oauth/access_token")
            .header("Accept", "application/json")
            .form(&[
                ("client_id", CLIENT_ID),
                ("device_code", &pending.device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|_| "Не удалось проверить вход GitHub")?
            .json()
            .map_err(|_| "Некорректный ответ GitHub")?;
        let state = app.state::<GithubState>();
        let mut session = state.0.lock().map_err(|_| "GitHub session lock failed")?;
        if session.generation != generation {
            return Err("Вход отменён".into());
        }
        if let Some(error) = response.error {
            if error == "authorization_pending" || error == "slow_down" {
                let interval = pending.interval + if error == "slow_down" { 5 } else { 0 };
                if let Some(p) = &mut session.pending {
                    p.interval = interval;
                    p.next_poll = Instant::now() + Duration::from_secs(interval);
                }
                return Ok(Poll {
                    complete: false,
                    interval,
                    persisted: false,
                });
            }
            session.pending = None;
            return Err("GitHub отклонил вход или код истёк. Начните вход заново".into());
        }
        let token = response.access_token.ok_or("GitHub не вернул токен")?;
        if !response
            .scope
            .unwrap_or_default()
            .split([',', ' '])
            .any(|scope| scope == "public_repo" || scope == "repo")
        {
            session.pending = None;
            return Err("Не предоставлено право public_repo для скачивания артефактов".into());
        }
        let persisted = credentials()
            .and_then(|entry| {
                entry
                    .set_password(&token)
                    .map_err(|_| "Не удалось сохранить токен".into())
            })
            .is_ok();
        session.token = Some(token);
        session.persisted = persisted;
        session.pending = None;
        Ok(Poll {
            complete: true,
            interval: pending.interval,
            persisted,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn list_mainline_builds(app: tauri::AppHandle) -> Result<MainCatalog, String> {
    let token = token(&app)?;
    tauri::async_runtime::spawn_blocking(move || vlauncher_core::mainline::list(&token))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn install_mainline_build(
    app: tauri::AppHandle,
    control: tauri::State<'_, super::TransferControl>,
    build: MainBuild,
) -> Result<InstalledRuntime, String> {
    let token = token(&app)?;
    let store = super::profile_store(&app)?;
    control
        .cancelled
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let cancelled = control.cancelled.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        vlauncher_core::mainline::install(&store, &build, &token, |completed, total| {
            let speed = (completed as f64 / started.elapsed().as_secs_f64().max(0.001)) as u64;
            let _ = app.emit(
                "transfer-progress",
                super::TransferEvent {
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
            !cancelled.load(std::sync::atomic::Ordering::SeqCst)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn resolve_mainline_version(build: MainBuild) -> Result<MainBuild, String> {
    tauri::async_runtime::spawn_blocking(move || vlauncher_core::mainline::resolve_version(build))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn select_mainline_build(
    app: tauri::AppHandle,
    processes: tauri::State<super::GameProcesses>,
    profile_id: String,
    build: Option<MainBuild>,
) -> Result<(), String> {
    if build.is_some() {
        require_enabled(&app)?;
    }
    let children = processes
        .children
        .lock()
        .map_err(|_| "process lock failed")?;
    if children.contains_key(&profile_id) {
        return Err("Сначала завершите игру".into());
    }
    let id = profile_id.parse().map_err(|_| "invalid profile id")?;
    super::profile_store(&app)?
        .select_main_build(id, build)
        .map_err(|e| e.to_string())
}
