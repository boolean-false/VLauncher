use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const APP_ID: &str = "space.vlauncher";
const WINDOW_ID: &str = "vlauncher";
const ICON: &[u8] = include_bytes!("../icons/icon.png");

// Переменные AppImage не должны попадать в запускаемые программы.
pub fn clean_environment(command: &mut Command, appdir: Option<&Path>) {
    let Some(appdir) = appdir else { return };
    for key in [
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
        "GTK_PATH",
        "GTK_EXE_PREFIX",
        "GTK_DATA_PREFIX",
        "GTK_IM_MODULE_FILE",
        "GSETTINGS_SCHEMA_DIR",
        "GDK_PIXBUF_MODULE_FILE",
        "GDK_PIXBUF_MODULEDIR",
        "GIO_EXTRA_MODULES",
        "GST_PLUGIN_PATH",
        "GST_PLUGIN_SYSTEM_PATH",
        "WEBKIT_EXEC_PATH",
        "APPDIR",
        "APPIMAGE",
        "ARGV0",
    ] {
        command.env_remove(key);
    }
    for key in ["PATH", "XDG_DATA_DIRS"] {
        if let Some(value) = std::env::var_os(key) {
            let paths: Vec<_> = std::env::split_paths(&value)
                .filter(|path| !path.starts_with(appdir))
                .collect();
            if let Ok(value) = std::env::join_paths(paths) {
                command.env(key, value);
            }
        }
    }
}

pub fn open_folder(path: &Path) -> Result<(), String> {
    let mut command = Command::new("/usr/bin/xdg-open");
    let appdir = std::env::var_os("APPDIR").map(std::path::PathBuf::from);
    clean_environment(&mut command, appdir.as_deref());
    let output = command
        .arg(path)
        .output()
        .map_err(|error| format!("Не удалось запустить xdg-open: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Не удалось открыть папку ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn desktop_exec(path: &Path) -> Result<String, String> {
    let value = path
        .to_str()
        .ok_or_else(|| "Путь к VLauncher содержит неподдерживаемые символы".to_owned())?;
    if value.contains(['\n', '\r']) {
        return Err("Путь к VLauncher содержит перевод строки".into());
    }
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('"');
    for character in value.chars() {
        if matches!(character, '"' | '\\' | '$' | '`') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped.push('"');
    Ok(escaped)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Некорректный путь desktop-интеграции".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    temporary
        .write_all(bytes)
        .map_err(|error| error.to_string())?;
    temporary.flush().map_err(|error| error.to_string())?;
    temporary
        .persist(path)
        .map_err(|error| error.error.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o644))
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn hide_appimage_launcher_entry(applications: &Path, executable: &Path) -> Result<(), String> {
    let Some(executable) = executable.to_str() else {
        return Ok(());
    };
    let try_exec = format!("TryExec={executable}");
    let entries = fs::read_dir(applications).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.starts_with("appimagekit_") || !name.ends_with("-VLauncher.desktop") {
            continue;
        }
        let Ok(mut contents) = fs::read_to_string(&path) else {
            continue;
        };
        if !contents.lines().any(|line| line == try_exec) {
            continue;
        }
        if contents.lines().any(|line| line == "NoDisplay=true") {
            continue;
        }
        let marker = "Type=Application\n";
        if !contents.contains(marker) {
            continue;
        }
        contents = contents.replacen(marker, "Type=Application\nNoDisplay=true\n", 1);
        write_atomic(&path, contents.as_bytes())?;
    }
    Ok(())
}

fn install_desktop_files(data_dir: &Path, executable: &Path) -> Result<PathBuf, String> {
    let applications = data_dir.join("applications");
    let desktop = applications.join(format!("{WINDOW_ID}.desktop"));
    let identifier_alias = applications.join(format!("{APP_ID}.desktop"));
    let icon = data_dir
        .join("icons/hicolor/512x512/apps")
        .join(format!("{APP_ID}.png"));
    let handler_contents = format!(
        "[Desktop Entry]\nType=Application\nName=VLauncher\nComment=VoxelCore launcher and content platform\nExec={} %u\nIcon={APP_ID}\nStartupWMClass={WINDOW_ID}\nTerminal=false\nNoDisplay=true\nMimeType=x-scheme-handler/vlauncher;\n",
        desktop_exec(executable)?
    );
    write_atomic(&desktop, handler_contents.as_bytes())?;
    write_atomic(&icon, ICON)?;
    let launcher_contents = format!(
        "[Desktop Entry]\nType=Application\nName=VLauncher\nComment=VoxelCore launcher and content platform\nExec={}\nIcon={}\nStartupWMClass={WINDOW_ID}\nTerminal=false\nCategories=Game;\n",
        desktop_exec(executable)?,
        icon.display()
    );
    write_atomic(&identifier_alias, launcher_contents.as_bytes())?;
    hide_appimage_launcher_entry(&applications, executable)?;

    // Старый deep-link плагин создаёт второй desktop-файл без иконки.
    let legacy = applications.join("vlauncher-handler.desktop");
    if fs::read_to_string(&legacy)
        .is_ok_and(|text| text.contains("MimeType=x-scheme-handler/vlauncher"))
    {
        fs::remove_file(&legacy).map_err(|error| error.to_string())?;
    }
    Ok(desktop)
}

pub fn register_desktop_integration(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let data_dir = app.path().data_dir().map_err(|error| error.to_string())?;
    let executable = app
        .env()
        .appimage
        .clone()
        .map(PathBuf::from)
        .unwrap_or(std::env::current_exe().map_err(|error| error.to_string())?);
    let desktop = install_desktop_files(&data_dir, &executable)?;
    let appdir = std::env::var_os("APPDIR").map(PathBuf::from);

    let mut database = Command::new("update-desktop-database");
    clean_environment(&mut database, appdir.as_deref());
    let status = database
        .arg(data_dir.join("applications"))
        .status()
        .map_err(|error| format!("Не удалось обновить базу приложений: {error}"))?;
    if !status.success() {
        return Err(format!("update-desktop-database завершился с {status}"));
    }

    let file_name = desktop.file_name().expect("desktop file has a name");
    let mut mime = Command::new("xdg-mime");
    clean_environment(&mut mime, appdir.as_deref());
    let status = mime
        .arg("default")
        .arg(file_name)
        .arg("x-scheme-handler/vlauncher")
        .status()
        .map_err(|error| format!("Не удалось зарегистрировать ссылки VLauncher: {error}"))?;
    if !status.success() {
        return Err(format!("xdg-mime завершился с {status}"));
    }
    Ok(())
}

pub fn prepare_game_appimage(
    command: &mut Command,
    launcher_appdir: Option<&Path>,
    game_dir: &Path,
) {
    clean_environment(command, launcher_appdir);
    // Дочерний AppImage должен использовать свой APPDIR.
    command.env("APPDIR", game_dir);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn game_appimage_uses_its_own_environment_file() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join(".env"), "APPDIR_LIBC_VERSION=2.35\n").unwrap();
        let mut command = Command::new("/bin/sh");
        command
            .env("APPDIR", "/tmp/launcher")
            .env("LD_LIBRARY_PATH", "/tmp/launcher/usr/lib");
        prepare_game_appimage(
            &mut command,
            Some(Path::new("/tmp/launcher")),
            directory.path(),
        );
        let output = command.args(["-c", ". \"$APPDIR/.env\"; test -z \"$LD_LIBRARY_PATH\" && printf '%s' \"$APPDIR_LIBC_VERSION\""])
            .output().unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"2.35");
    }

    #[test]
    fn host_process_does_not_inherit_appimage_libraries() {
        let mut command = Command::new("/usr/bin/env");
        command
            .env("LD_LIBRARY_PATH", "/tmp/launcher/usr/lib")
            .env("LD_PRELOAD", "/missing/wayland.so")
            .env("GIO_EXTRA_MODULES", "/tmp/launcher/usr/lib/gio")
            .env("VLAUNCHER_TEST_KEEP", "desktop-session");
        clean_environment(&mut command, Some(Path::new("/tmp/launcher")));
        let output = command.output().unwrap();
        assert!(output.status.success());
        let env = String::from_utf8(output.stdout).unwrap();
        assert!(!env.lines().any(|line| line.starts_with("LD_PRELOAD=")
            || line.starts_with("LD_LIBRARY_PATH=")
            || line.starts_with("GIO_EXTRA_MODULES=")));
        assert!(env.contains("VLAUNCHER_TEST_KEEP=desktop-session"));
    }

    #[test]
    fn desktop_integration_has_stable_app_id_icon_and_safe_exec() {
        let directory = tempfile::tempdir().unwrap();
        let applications = directory.path().join("applications");
        fs::create_dir_all(&applications).unwrap();
        fs::write(
            applications.join("vlauncher-handler.desktop"),
            "[Desktop Entry]\nMimeType=x-scheme-handler/vlauncher\n",
        )
        .unwrap();
        let desktop = install_desktop_files(
            directory.path(),
            Path::new("/tmp/VLauncher build/$release`1`.AppImage"),
        )
        .unwrap();
        let contents = fs::read_to_string(desktop).unwrap();
        assert!(contents.contains("Icon=space.vlauncher\n"));
        assert!(contents.contains("StartupWMClass=vlauncher\n"));
        assert!(contents.contains("Exec=\"/tmp/VLauncher build/\\$release\\`1\\`.AppImage\" %u\n"));
        assert!(contents.contains("NoDisplay=true\n"));
        assert!(!applications.join("vlauncher-handler.desktop").exists());
        let alias = fs::read_to_string(applications.join("space.vlauncher.desktop")).unwrap();
        assert!(alias.contains(&format!(
            "Icon={}\n",
            directory
                .path()
                .join("icons/hicolor/512x512/apps/space.vlauncher.png")
                .display()
        )));
        assert!(!alias.contains("NoDisplay="));
        assert!(!alias.contains("MimeType="));
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(applications.join("space.vlauncher.desktop"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o644
        );
        assert_eq!(
            fs::read(
                directory
                    .path()
                    .join("icons/hicolor/512x512/apps/space.vlauncher.png")
            )
            .unwrap(),
            ICON
        );
    }

    #[test]
    fn hides_only_the_matching_appimage_launcher_entry() {
        let directory = tempfile::tempdir().unwrap();
        let applications = directory.path().join("applications");
        fs::create_dir_all(&applications).unwrap();
        let matching = applications.join("appimagekit_123-VLauncher.desktop");
        fs::write(
            &matching,
            "[Desktop Entry]\nType=Application\nTryExec=/tmp/VLauncher.AppImage\n",
        )
        .unwrap();
        let other = applications.join("appimagekit_456-VLauncher.desktop");
        fs::write(
            &other,
            "[Desktop Entry]\nType=Application\nTryExec=/tmp/Other.AppImage\n",
        )
        .unwrap();

        hide_appimage_launcher_entry(&applications, Path::new("/tmp/VLauncher.AppImage")).unwrap();

        assert!(
            fs::read_to_string(matching)
                .unwrap()
                .contains("NoDisplay=true\n")
        );
        assert!(
            !fs::read_to_string(other)
                .unwrap()
                .contains("NoDisplay=true\n")
        );
    }
}
