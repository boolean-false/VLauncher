use super::*;
use std::collections::VecDeque;

#[derive(Clone, Serialize)]
pub struct OpenRequest {
    id: String,
    path: String,
}

#[derive(Default)]
pub struct OpenFiles(Mutex<VecDeque<OpenRequest>>);

fn local_path(value: &str, cwd: &Path) -> Option<PathBuf> {
    let path = if value.starts_with("file:") {
        reqwest::Url::parse(value).ok()?.to_file_path().ok()?
    } else {
        let path = PathBuf::from(value);
        if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        }
    };
    if !path.extension()?.eq_ignore_ascii_case("vpack") || !path.is_file() {
        return None;
    }
    std::fs::canonicalize(path).ok()
}

pub fn enqueue(app: &tauri::AppHandle, values: impl IntoIterator<Item = String>, cwd: &Path) {
    let state = app.state::<OpenFiles>();
    let Ok(mut pending) = state.0.lock() else {
        return;
    };
    for value in values {
        let Some(path) = local_path(&value, cwd) else {
            continue;
        };
        let path = path.to_string_lossy().into_owned();
        if pending.len() < 32 && !pending.iter().any(|request| request.path == path) {
            #[cfg(debug_assertions)]
            eprintln!("vpack open request queued");
            pending.push_back(OpenRequest {
                id: uuid::Uuid::new_v4().to_string(),
                path,
            });
        }
    }
    let has_pending = !pending.is_empty();
    drop(pending);
    if has_pending {
        let _ = app.emit("vpack-open-requested", ());
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
}

#[tauri::command]
pub fn pending_vpack_files(state: tauri::State<OpenFiles>) -> Vec<OpenRequest> {
    state
        .0
        .lock()
        .map(|pending| pending.iter().cloned().collect())
        .unwrap_or_default()
}

#[tauri::command]
pub fn acknowledge_vpack_file(state: tauri::State<OpenFiles>, id: String) {
    if let Ok(mut pending) = state.0.lock() {
        #[cfg(debug_assertions)]
        if pending.iter().any(|request| request.id == id) {
            eprintln!("vpack open request handled");
        }
        pending.retain(|request| request.id != id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_local_paths_and_file_urls_with_spaces_and_rejects_other_sources() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("Моя сборка.VPACK");
        std::fs::write(&file, "archive").unwrap();
        let canonical = std::fs::canonicalize(&file).unwrap();
        assert_eq!(
            local_path("Моя сборка.VPACK", temp.path()),
            Some(canonical.clone())
        );
        assert_eq!(
            local_path(
                &reqwest::Url::from_file_path(&file).unwrap().to_string(),
                temp.path()
            ),
            Some(canonical)
        );
        assert!(local_path("https://example.test/demo.vpack", temp.path()).is_none());
        assert!(local_path("missing.vpack", temp.path()).is_none());
        assert!(local_path("--verbose", temp.path()).is_none());
        assert!(local_path("file://remote-host/shared/demo.vpack", temp.path()).is_none());
    }
}
