use super::*;

const FILES: [&str; 2] = ["controls.toml", "settings.toml"];
const MAX_SETTINGS_SIZE: u64 = 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct ProfileSettingsInfo {
    pub controls: bool,
    pub settings: bool,
    pub can_restore: bool,
}

#[derive(Serialize, Deserialize)]
struct Backup {
    files: Vec<(String, bool)>,
}

fn read_settings_file(path: &Path) -> Result<Option<Vec<u8>>, PackageProblem> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(path, error)),
    };
    if !meta.is_file() || meta.len() > MAX_SETTINGS_SIZE {
        return invalid("Файл настроек должен быть обычным файлом размером не более 1 МБ");
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|error| io_error(path, error))?
        .take(MAX_SETTINGS_SIZE + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| io_error(path, error))?;
    if bytes.len() as u64 > MAX_SETTINGS_SIZE {
        return invalid("Файл настроек превышает 1 МБ");
    }
    Ok(Some(bytes))
}

fn apply_files(game: &Path, files: &[(String, Option<Vec<u8>>)]) -> Result<(), PackageProblem> {
    for (name, bytes) in files {
        let path = game.join(name);
        if let Some(bytes) = bytes {
            write_atomic(&path, bytes)?;
        } else if path.exists() {
            fs::remove_file(&path).map_err(|error| io_error(&path, error))?;
        }
    }
    Ok(())
}

impl ProfileStore {
    pub fn profile_settings_info(&self, id: Uuid) -> Result<ProfileSettingsInfo, PackageProblem> {
        let game = self.game_directory(id)?;
        Ok(ProfileSettingsInfo {
            controls: read_settings_file(&game.join(FILES[0]))?.is_some(),
            settings: read_settings_file(&game.join(FILES[1]))?.is_some(),
            can_restore: self
                .profile_path(id)
                .join("settings-backups/last")
                .is_file(),
        })
    }

    pub fn import_profile_settings(
        &self,
        target: Uuid,
        source: Uuid,
        controls: bool,
        settings: bool,
    ) -> Result<(), PackageProblem> {
        if target == source || (!controls && !settings) {
            return invalid("Выберите другой профиль и настройки для переноса");
        }
        let _target_lock = self.lock_profile(target)?;
        let _source_lock = self.lock_profile(source)?;
        let target_game = self.game_directory(target)?;
        let source_game = self.game_directory(source)?;
        if self.profile(target)?.problem.is_some() || self.profile(source)?.problem.is_some() {
            return invalid("Сначала восстановите повреждённый профиль");
        }
        let target_path = fs::canonicalize(&target_game).map_err(|e| io_error(&target_game, e))?;
        let source_path = fs::canonicalize(&source_game).map_err(|e| io_error(&source_game, e))?;
        if target_path == source_path {
            return invalid("Профили используют одну и ту же папку игры");
        }
        let mut incoming = Vec::new();
        let mut previous = Vec::new();
        for (name, selected) in FILES.into_iter().zip([controls, settings]) {
            if !selected {
                continue;
            }
            let bytes = read_settings_file(&source_game.join(name))?
                .ok_or_else(|| PackageProblem::Invalid(format!("В исходном профиле нет {name}")))?;
            let text = std::str::from_utf8(&bytes)
                .map_err(|_| PackageProblem::Invalid(format!("{name}: некорректный UTF-8")))?;
            text.parse::<toml::Table>()
                .map_err(|_| PackageProblem::Invalid(format!("{name}: некорректный TOML")))?;
            previous.push((
                name.to_owned(),
                read_settings_file(&target_game.join(name))?,
            ));
            incoming.push((name.to_owned(), Some(bytes)));
        }
        let root = self.profile_path(target).join("settings-backups");
        let id = Uuid::new_v4().to_string();
        let backup_dir = root.join(&id);
        fs::create_dir_all(&backup_dir).map_err(|e| io_error(&backup_dir, e))?;
        apply_files(&backup_dir, &previous)?;
        let backup = Backup {
            files: previous
                .iter()
                .map(|(name, bytes)| (name.clone(), bytes.is_some()))
                .collect(),
        };
        let manifest =
            serde_json::to_vec(&backup).map_err(|e| PackageProblem::Invalid(e.to_string()))?;
        write_atomic(&backup_dir.join("manifest.json"), &manifest)?;
        // The durable pointer is recorded first so an interrupted import remains recoverable.
        write_atomic(&root.join("last"), id.as_bytes())?;
        if let Err(error) = apply_files(&target_game, &incoming) {
            if let Err(rollback) = apply_files(&target_game, &previous) {
                return invalid(format!(
                    "{error}. Не удалось восстановить настройки: {rollback}. Резервная копия сохранена."
                ));
            }
            return Err(error);
        }
        Ok(())
    }

    pub fn restore_profile_settings(&self, id: Uuid) -> Result<(), PackageProblem> {
        let _lock = self.lock_profile(id)?;
        if self.profile(id)?.problem.is_some() {
            return invalid("Сначала восстановите повреждённый профиль");
        }
        let root = self.profile_path(id).join("settings-backups");
        let pointer = root.join("last");
        let backup_id = fs::read_to_string(&pointer).map_err(|e| io_error(&pointer, e))?;
        let backup_id = Uuid::parse_str(backup_id.trim())
            .map_err(|_| PackageProblem::Invalid("Некорректная резервная копия настроек".into()))?;
        let folder = root.join(backup_id.to_string());
        let manifest = folder.join("manifest.json");
        let bytes = read_settings_file(&manifest)?
            .ok_or_else(|| PackageProblem::Invalid("Резервная копия настроек не найдена".into()))?;
        let backup: Backup = serde_json::from_slice(&bytes)
            .map_err(|_| PackageProblem::Invalid("Повреждена резервная копия настроек".into()))?;
        if backup.files.is_empty()
            || backup.files.len() > 2
            || backup
                .files
                .iter()
                .any(|(name, _)| !FILES.contains(&name.as_str()))
            || (backup.files.len() == 2 && backup.files[0].0 == backup.files[1].0)
        {
            return invalid("Некорректный список файлов резервной копии");
        }
        let game = self.game_directory(id)?;
        let mut restored = Vec::new();
        let mut current = Vec::new();
        for (name, existed) in backup.files {
            let saved = read_settings_file(&folder.join(&name))?;
            if existed && saved.is_none() {
                return invalid("В резервной копии отсутствует файл настроек");
            }
            current.push((name.clone(), read_settings_file(&game.join(&name))?));
            restored.push((name, if existed { saved } else { None }));
        }
        if let Err(error) = apply_files(&game, &restored) {
            apply_files(&game, &current)?;
            return Err(error);
        }
        fs::remove_file(&pointer).map_err(|e| io_error(&pointer, e))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_only_keys_and_undo_restores_previous_keys() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path()).unwrap();
        let source = store.create("Source").unwrap();
        let target = store.create("Target").unwrap();
        let from = store.game_directory(source.id).unwrap();
        let to = store.game_directory(target.id).unwrap();
        fs::write(from.join("controls.toml"), "jump = 'space'\n").unwrap();
        fs::write(from.join("settings.toml"), "volume = 0.2\n").unwrap();
        fs::write(to.join("controls.toml"), "jump = 'j'\n").unwrap();
        fs::write(to.join("settings.toml"), "volume = 0.9\n").unwrap();
        fs::create_dir_all(to.join("worlds")).unwrap();
        fs::write(to.join("worlds/keep"), "world").unwrap();
        store
            .import_profile_settings(target.id, source.id, true, false)
            .unwrap();
        assert_eq!(
            fs::read_to_string(to.join("controls.toml")).unwrap(),
            "jump = 'space'\n"
        );
        assert_eq!(
            fs::read_to_string(to.join("settings.toml")).unwrap(),
            "volume = 0.9\n"
        );
        assert!(store.profile_settings_info(target.id).unwrap().can_restore);
        // Reopen the store: undo is persisted, not limited to the dialog lifetime.
        drop(store);
        let store = ProfileStore::open(temp.path()).unwrap();
        store.restore_profile_settings(target.id).unwrap();
        assert_eq!(
            fs::read_to_string(to.join("controls.toml")).unwrap(),
            "jump = 'j'\n"
        );
        assert_eq!(
            fs::read_to_string(from.join("controls.toml")).unwrap(),
            "jump = 'space'\n"
        );
        assert_eq!(fs::read_to_string(to.join("worlds/keep")).unwrap(), "world");
        assert!(!store.profile_settings_info(target.id).unwrap().can_restore);
    }

    #[test]
    fn imports_both_and_undo_removes_previously_absent_files() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path()).unwrap();
        let source = store.create("Source").unwrap();
        let target = store.create("Target").unwrap();
        let from = store.game_directory(source.id).unwrap();
        let to = store.game_directory(target.id).unwrap();
        for name in FILES {
            fs::write(from.join(name), "value = 1\n").unwrap();
        }
        store
            .import_profile_settings(target.id, source.id, true, true)
            .unwrap();
        assert!(FILES.iter().all(|name| to.join(name).is_file()));
        store.restore_profile_settings(target.id).unwrap();
        assert!(FILES.iter().all(|name| !to.join(name).exists()));
    }

    #[test]
    fn validates_every_selected_file_before_replacing_anything() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path()).unwrap();
        let source = store.create("Source").unwrap();
        let target = store.create("Target").unwrap();
        let from = store.game_directory(source.id).unwrap();
        let to = store.game_directory(target.id).unwrap();
        fs::write(from.join("controls.toml"), "key = 'new'\n").unwrap();
        fs::write(from.join("settings.toml"), "not valid = [").unwrap();
        fs::write(to.join("controls.toml"), "key = 'old'\n").unwrap();
        assert!(
            store
                .import_profile_settings(target.id, source.id, true, true)
                .is_err()
        );
        assert_eq!(
            fs::read_to_string(to.join("controls.toml")).unwrap(),
            "key = 'old'\n"
        );
        assert!(!store.profile_settings_info(target.id).unwrap().can_restore);
        assert!(
            store
                .import_profile_settings(target.id, target.id, true, false)
                .is_err()
        );
        assert!(
            store
                .import_profile_settings(target.id, source.id, false, false)
                .is_err()
        );
        fs::remove_file(from.join("controls.toml")).unwrap();
        assert!(
            store
                .import_profile_settings(target.id, source.id, true, false)
                .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_settings_without_touching_the_destination() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path()).unwrap();
        let source = store.create("Source").unwrap();
        let target = store.create("Target").unwrap();
        let outside = temp.path().join("outside.toml");
        fs::write(&outside, "key = 'keep'\n").unwrap();
        fs::write(
            store
                .game_directory(source.id)
                .unwrap()
                .join("controls.toml"),
            "key = 'new'\n",
        )
        .unwrap();
        std::os::unix::fs::symlink(
            &outside,
            store
                .game_directory(target.id)
                .unwrap()
                .join("controls.toml"),
        )
        .unwrap();
        assert!(
            store
                .import_profile_settings(target.id, source.id, true, false)
                .is_err()
        );
        assert_eq!(fs::read_to_string(outside).unwrap(), "key = 'keep'\n");
    }
}
