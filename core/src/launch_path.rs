use crate::PackageProblem;
use std::path::{Path, PathBuf};

pub(crate) fn engine_path(path: &Path) -> Result<PathBuf, PackageProblem> {
    if path.as_os_str().is_ascii() {
        return Ok(path.to_path_buf());
    }
    Err(PackageProblem::Invalid(format!(
        "Путь для запуска VoxelCore содержит нелатинские символы: {}. Перенесите библиотеку через настройки в папку, полный путь к которой состоит из ASCII-символов; для подключённого движка или проекта перенесите его папку. Проверьте также имена родительских папок. Отображаемое название профиля можно оставить русским.",
        path.display()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_paths_are_unchanged() {
        for value in [
            "C:/Games/VLauncher/profiles/Profile/game",
            "/opt/vlauncher/profiles/Profile/game",
        ] {
            let path = Path::new(value);
            assert_eq!(engine_path(path).unwrap(), path);
        }
    }

    #[test]
    fn non_ascii_paths_are_rejected_on_every_platform() {
        for value in [
            "C:/Users/Даня/VLauncher/game",
            "/home/Даня/vlauncher/game",
            "/Users/danya/Шахта/game",
        ] {
            let error = engine_path(Path::new(value)).unwrap_err().to_string();
            assert!(error.contains(value));
            assert!(error.contains("Перенесите библиотеку"));
            assert!(!error.contains("Windows"));
        }
    }
}
