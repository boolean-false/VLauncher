use super::*;

/// Retain replaced paths until both filesystem work and the profile DB commit succeed.
#[derive(Default)]
pub(super) struct GameChanges {
    replaced: Vec<(PathBuf, Option<PathBuf>)>,
    temporary: Vec<PathBuf>,
}
fn remove_path(path: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}
impl GameChanges {
    pub(super) fn stage(&mut self, path: PathBuf) -> PathBuf {
        self.temporary.push(path.clone());
        path
    }
    pub(super) fn replace(
        &mut self,
        staged: &Path,
        destination: &Path,
    ) -> Result<(), PackageProblem> {
        let exists = match fs::symlink_metadata(destination) {
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(io_error(destination, error)),
        };
        let backup = if exists {
            let backup = destination.with_extension(format!("vlauncher-backup-{}", Uuid::new_v4()));
            fs::rename(destination, &backup).map_err(|e| io_error(destination, e))?;
            Some(backup)
        } else {
            None
        };
        self.replaced.push((destination.to_owned(), backup));
        fs::rename(staged, destination).map_err(|e| io_error(destination, e))
    }
    pub(super) fn write(&mut self, destination: &Path, bytes: &[u8]) -> Result<(), PackageProblem> {
        let staged =
            self.stage(destination.with_extension(format!("vlauncher-stage-{}", Uuid::new_v4())));
        write_atomic(&staged, bytes)?;
        self.replace(&staged, destination)
    }
    pub(super) fn finish<T>(
        mut self,
        result: Result<T, PackageProblem>,
    ) -> Result<T, PackageProblem> {
        let mut rollback_errors = Vec::new();
        if result.is_err() {
            for (destination, backup) in self.replaced.iter().rev() {
                if let Err(e) = remove_path(destination).and_then(|()| match backup {
                    Some(path) => fs::rename(path, destination),
                    None => Ok(()),
                }) {
                    rollback_errors.push(format!("{}: {e}", destination.display()));
                }
            }
        } else {
            for (_, backup) in &self.replaced {
                if let Some(path) = backup {
                    let _ = remove_path(path);
                }
            }
        }
        self.replaced.clear();
        for path in &self.temporary {
            let _ = remove_path(path);
        }
        if !rollback_errors.is_empty() {
            return invalid(format!(
                "{}. Не удалось полностью восстановить файлы: {}. Резервные копии сохранены рядом с ними.",
                result.err().unwrap(),
                rollback_errors.join("; ")
            ));
        }
        result
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn rollback_preserves_a_dangling_destination_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("content");
        let missing = temp.path().join("missing");
        std::os::unix::fs::symlink(&missing, &destination).unwrap();
        let staged = temp.path().join("staged");
        fs::create_dir(&staged).unwrap();
        let mut changes = GameChanges::default();
        changes.stage(staged.clone());
        changes.replace(&staged, &destination).unwrap();
        assert!(destination.is_dir());
        let result: Result<(), PackageProblem> = invalid("simulated DB failure");
        assert!(changes.finish(result).is_err());
        assert_eq!(fs::read_link(&destination).unwrap(), missing);
        assert!(!staged.exists());
    }
}
