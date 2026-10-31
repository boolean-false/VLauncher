use super::*;
use vlauncher_core::profile::VpackPreview;

#[tauri::command]
pub async fn inspect_vpack(path: String) -> Result<VpackPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let preview = ProfileStore::inspect_vpack(path).map_err(|e| e.to_string())?;
        #[cfg(debug_assertions)]
        eprintln!("vpack preview ready");
        Ok(preview)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn import_vpack(
    app: tauri::AppHandle,
    control: tauri::State<'_, TransferControl>,
    path: String,
    expected_hash: String,
) -> Result<Profile, String> {
    let store = profile_store(&app)?;
    control.cancelled.store(false, Ordering::SeqCst);
    let cancelled = control.cancelled.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let progress = Mutex::new(HashMap::<String, u64>::new());
        let totals = Mutex::new(HashMap::<String, u64>::new());
        let stage = Mutex::new((String::new(), Instant::now()));
        let last_transfer = Mutex::new(Instant::now());
        store
            .import_vpack(
                Path::new(&path),
                &expected_hash,
                registry_url(),
                &|label, completed, total| {
                    if total == 0 {
                        if let Ok(mut previous) = stage.lock() {
                            if previous.0 != label
                                || previous.1.elapsed() >= Duration::from_millis(250)
                            {
                                let _ = app.emit("vpack-stage", label);
                                *previous = (label.into(), Instant::now());
                            }
                        }
                    } else if !label.starts_with("__retry__:") {
                        if let (Ok(mut values), Ok(mut sizes)) = (progress.lock(), totals.lock()) {
                            values.insert(label.into(), completed);
                            sizes.insert(label.into(), total);
                            let completed = values.values().sum();
                            let total = sizes.values().sum::<u64>();
                            let emit_progress = if let Ok(mut last) = last_transfer.lock() {
                                if completed == total
                                    || last.elapsed() >= Duration::from_millis(150)
                                {
                                    *last = Instant::now();
                                    true
                                } else {
                                    false
                                }
                            } else {
                                false
                            };
                            if !emit_progress {
                                return !cancelled.load(Ordering::SeqCst);
                            }
                            let speed = (completed as f64
                                / started.elapsed().as_secs_f64().max(0.001))
                                as u64;
                            let _ = app.emit(
                                "transfer-progress",
                                TransferEvent {
                                    kind: "download",
                                    completed,
                                    total,
                                    bytes_per_second: speed,
                                    eta_seconds: total
                                        .saturating_sub(completed)
                                        .checked_div(speed)
                                        .unwrap_or(0),
                                },
                            );
                        }
                    }
                    !cancelled.load(Ordering::SeqCst)
                },
            )
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

struct PreparedExport {
    token: String,
    folder: tempfile::TempDir,
    sha256: String,
    size: u64,
    excluded: Vec<PathBuf>,
}

#[derive(Default)]
pub struct PreparedExports(Mutex<Option<Arc<PreparedExport>>>);

pub fn cleanup_exports(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<PreparedExports>() {
        if let Ok(mut current) = state.0.lock() {
            current.take();
        }
    }
}

#[derive(Serialize)]
pub struct ExportPreview {
    token: String,
    preview: VpackPreview,
    archive_size: u64,
}

#[tauri::command]
pub async fn prepare_vpack_export(
    app: tauri::AppHandle,
    control: tauri::State<'_, TransferControl>,
    profile_id: String,
    worlds: bool,
    settings: bool,
) -> Result<ExportPreview, String> {
    ensure_stopped(&app, &profile_id)?;
    let id = profile_id
        .parse()
        .map_err(|_| "invalid profile id".to_owned())?;
    let store = profile_store(&app)?;
    control.cancelled.store(false, Ordering::SeqCst);
    let cancelled = control.cancelled.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // At most one prepared export is retained, and TempDir cleans it on discard/exit.
        app.state::<PreparedExports>()
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .take();
        let folder = tempfile::tempdir().map_err(|e| e.to_string())?;
        let path = folder.path().join("export.vpack");
        let profiles = store.list().map_err(|e| e.to_string())?;
        let profile = profiles
            .iter()
            .find(|p| p.id == id)
            .ok_or("profile does not exist")?;
        let excluded = [
            Some(store.root_path().to_owned()),
            Some(store.game_directory(id).map_err(|e| e.to_string())?),
            profile.external_project_path.clone(),
            profile.external_runtime.as_ref().map(|r| r.path.clone()),
        ]
        .into_iter()
        .flatten()
        .collect();
        let stage = Mutex::new((String::new(), Instant::now()));
        store
            .export_vpack(
                id,
                &path,
                registry_url(),
                worlds,
                settings,
                &|label, _, _| {
                    if let Ok(mut previous) = stage.lock() {
                        if previous.0 != label || previous.1.elapsed() >= Duration::from_millis(250)
                        {
                            let _ = app.emit("vpack-stage", label);
                            *previous = (label.into(), Instant::now());
                        }
                    }
                    !cancelled.load(Ordering::SeqCst)
                },
            )
            .map_err(|e| e.to_string())?;
        let preview = ProfileStore::inspect_vpack(&path).map_err(|e| e.to_string())?;
        let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
        if cancelled.load(Ordering::SeqCst) {
            return Err("download paused by user".into());
        }
        let token = uuid::Uuid::new_v4().to_string();
        let prepared = PreparedExport {
            token: token.clone(),
            folder,
            sha256: preview.archive_sha256.clone(),
            size,
            excluded,
        };
        *app.state::<PreparedExports>()
            .0
            .lock()
            .map_err(|e| e.to_string())? = Some(Arc::new(prepared));
        Ok(ExportPreview {
            token,
            preview,
            archive_size: size,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn check_destination(destination: &Path, excluded: &[PathBuf]) -> Result<(), String> {
    let parent = destination.parent().unwrap_or(Path::new("."));
    let parent = std::fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if excluded
        .iter()
        .filter_map(|p| std::fs::canonicalize(p).ok())
        .any(|source| parent.starts_with(source))
    {
        return Err("Сохраните vpack за пределами библиотеки, папки игры или проекта".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn save_vpack_export(
    app: tauri::AppHandle,
    token: String,
    path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<PreparedExports>();
        // Keep the snapshot alive without holding a mutex during filesystem I/O.
        let prepared = state
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .filter(|p| p.token == token)
            .cloned()
            .ok_or("Предпросмотр устарел. Подготовьте экспорт заново.")?;
        let destination = Path::new(&path);
        check_destination(destination, &prepared.excluded)?;
        ProfileStore::save_vpack_copy(
            &prepared.folder.path().join("export.vpack"),
            &prepared.sha256,
            prepared.size,
            destination,
        )
        .map_err(|e| e.to_string())?;
        let mut current = state.0.lock().map_err(|e| e.to_string())?;
        if current.as_ref().is_some_and(|p| p.token == token) {
            current.take();
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn discard_vpack_export(state: tauri::State<PreparedExports>, token: String) {
    if let Ok(mut current) = state.0.lock() {
        if current.as_ref().is_some_and(|p| p.token == token) {
            current.take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saved_archive_cannot_be_placed_inside_its_source() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        std::fs::create_dir_all(source.join("content")).unwrap();
        assert!(
            check_destination(&source.join("content/export.vpack"), &[source.clone()]).is_err()
        );
        assert!(check_destination(&temp.path().join("export.vpack"), &[source]).is_ok());
    }
}
