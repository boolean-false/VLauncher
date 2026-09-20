use serde::Serialize;
use std::time::Instant;
use tauri::Emitter;
use vlauncher_core::{
    InstalledRuntime,
    mainline::{MainBuild, MainCatalog},
};

#[derive(Serialize)]
pub struct Status {
    enabled: bool,
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
#[tauri::command]
pub fn mainline_status(app: tauri::AppHandle) -> Result<Status, String> {
    Ok(Status {
        enabled: enabled(&app)?,
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
    mainline_status(app)
}
#[tauri::command]
pub async fn list_mainline_builds(app: tauri::AppHandle) -> Result<MainCatalog, String> {
    require_enabled(&app)?;
    tauri::async_runtime::spawn_blocking(vlauncher_core::mainline::list)
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn install_mainline_build(
    app: tauri::AppHandle,
    control: tauri::State<'_, super::TransferControl>,
    build: MainBuild,
) -> Result<InstalledRuntime, String> {
    require_enabled(&app)?;
    let store = super::profile_store(&app)?;
    control
        .cancelled
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let cancelled = control.cancelled.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        vlauncher_core::mainline::install(&store, &build, |completed, total| {
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
