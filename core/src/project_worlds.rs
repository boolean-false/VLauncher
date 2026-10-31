use super::*;

impl ProfileStore {
    /// Seed mutable level copies, including for profiles installed before this support existed.
    /// Never merge into an existing world: its region files and player state belong to the player.
    pub(super) fn install_project_worlds(
        &self,
        profile_id: Uuid,
        revision: &str,
        game: &Path,
        changes: &mut GameChanges,
    ) -> Result<(), PackageProblem> {
        let external = self.with_database(|database| {
            database.query_row(
                "SELECT external_project_path FROM profiles WHERE id = ?1",
                [profile_id.to_string()],
                |row| row.get::<_, Option<String>>(0),
            )
        })?;
        let mut projects = Vec::new();
        if let Some(path) = external {
            projects.push(PathBuf::from(path));
        } else {
            // Use the incoming snapshot: the DB still points at the old version during apply.
            let root = self
                .profile_path(profile_id)
                .join("snapshots")
                .join(revision)
                .join("projects");
            if root.is_dir() {
                for entry in fs::read_dir(&root).map_err(|e| io_error(&root, e))? {
                    let entry = entry.map_err(|e| io_error(&root, e))?;
                    if entry
                        .file_type()
                        .map_err(|e| io_error(&entry.path(), e))?
                        .is_dir()
                    {
                        projects.push(entry.path());
                    }
                }
            }
        }
        for project in projects {
            let source = project.join("worlds");
            let metadata = match fs::symlink_metadata(&source) {
                Ok(meta) => meta,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(io_error(&source, e)),
            };
            if !metadata.is_dir() {
                return invalid("project worlds must be a directory without symbolic links");
            }
            let identity = VoxelCoreProject::read(&project)?;
            let worlds = game.join("worlds");
            fs::create_dir_all(&worlds).map_err(|e| io_error(&worlds, e))?;
            for entry in fs::read_dir(&source).map_err(|e| io_error(&source, e))? {
                let entry = entry.map_err(|e| io_error(&source, e))?;
                let kind = entry.file_type().map_err(|e| io_error(&entry.path(), e))?;
                if kind.is_symlink() {
                    return invalid("project worlds contain a forbidden symbolic link");
                }
                if !kind.is_dir() || !entry.path().join("world.json").is_file() {
                    continue;
                }
                // Scripts refer to levels by these exact names; do not rename to display titles.
                let destination = worlds.join(entry.file_name());
                match fs::symlink_metadata(&destination) {
                    Ok(_) => continue,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(io_error(&destination, e)),
                }
                ensure_space(&worlds, tree_size(&entry.path())?)?;
                let staging =
                    changes.stage(worlds.join(format!(".world-staging-{}", Uuid::new_v4())));
                copy_tree(&entry.path(), &staging)?;
                let marker = serde_json::json!({
                    "schema_version": 1,
                    "package_id": format!("__project_{}", identity.name),
                    "project_world": entry.file_name().to_string_lossy(),
                    "bundled": true,
                });
                write_atomic(
                    &staging.join(".vlauncher-world.json"),
                    &serde_json::to_vec_pretty(&marker)
                        .map_err(|e| PackageProblem::Invalid(e.to_string()))?,
                )?;
                changes.replace(&staging, &destination)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn level(source: &Path, name: &str, contents: &[u8]) {
        let world = source.join("worlds").join(name);
        fs::create_dir_all(world.join("regions")).unwrap();
        fs::write(
            world.join("world.json"),
            br#"{"name":"Level title","next-player-id":1}"#,
        )
        .unwrap();
        fs::write(world.join("regions/0_0.bin"), contents).unwrap();
    }

    fn project(root: &Path) -> PathBuf {
        let source = root.join("project");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("project.toml"),
            "name = 'level-game'\ntitle = 'Levels'\n",
        )
        .unwrap();
        source
    }

    fn package(source: &Path, output: &Path, version: &str) -> InstallPackage {
        let artifact = crate::prepare_project(source, output, version, "Tester", "MIT").unwrap();
        InstallPackage {
            id: "11111111-1111-1111-1111-111111111111".into(),
            kind: PackageKind::Project,
            version: version.into(),
            artifact_sha256: artifact.sha256,
            artifact_size: artifact.size,
            archive_path: artifact.path,
            dependencies: Vec::new(),
        }
    }

    #[test]
    fn published_project_installs_ten_levels_and_preserves_progress_on_update() {
        let temp = tempfile::tempdir().unwrap();
        let source = project(temp.path());
        for n in 1..=10 {
            level(&source, &format!("level_{n:02}"), b"original");
        }
        let store = ProfileStore::open(temp.path().join("library")).unwrap();
        let profile = store.create("Levels").unwrap();
        let first = package(&source, &temp.path().join("archives"), "1.0.0");
        store
            .apply(
                profile.id,
                &InstallPlan {
                    revision: "one".into(),
                    packages: vec![first],
                },
            )
            .unwrap();
        let game = store.game_directory(profile.id).unwrap();
        assert_eq!(fs::read_dir(game.join("worlds")).unwrap().count(), 10);
        let world = game.join("worlds/level_01");
        assert_eq!(
            fs::read(world.join("regions/0_0.bin")).unwrap(),
            b"original"
        );
        let metadata: serde_json::Value =
            serde_json::from_slice(&fs::read(world.join("world.json")).unwrap()).unwrap();
        assert_eq!(metadata["next-player-id"], 0); // Missing author player cannot crash first launch.
        let snapshot = store.active_snapshot(profile.id).unwrap().unwrap();
        let template = snapshot
            .join("projects/11111111-1111-1111-1111-111111111111/worlds/level_01/world.json");
        let template_metadata: serde_json::Value =
            serde_json::from_slice(&fs::read(template).unwrap()).unwrap();
        assert_eq!(template_metadata["next-player-id"], 1);
        fs::write(world.join("regions/0_0.bin"), b"player progress").unwrap();
        fs::write(world.join("player.json"), b"player state").unwrap();
        store.materialize_game_folder(profile.id, "one").unwrap();
        level(&source, "level_01", b"updated template");
        level(&source, "level_11", b"new level");
        let next = package(&source, &temp.path().join("archives"), "2.0.0");
        store
            .apply(
                profile.id,
                &InstallPlan {
                    revision: "two".into(),
                    packages: vec![next],
                },
            )
            .unwrap();
        assert_eq!(fs::read_dir(game.join("worlds")).unwrap().count(), 11);
        assert_eq!(
            fs::read(world.join("regions/0_0.bin")).unwrap(),
            b"player progress"
        );
        assert_eq!(
            fs::read(world.join("player.json")).unwrap(),
            b"player state"
        );
        assert_eq!(
            fs::read(game.join("worlds/level_11/regions/0_0.bin")).unwrap(),
            b"new level"
        );
        assert_eq!(
            fs::read(source.join("worlds/level_01/regions/0_0.bin")).unwrap(),
            b"updated template"
        );
    }

    #[test]
    fn already_installed_project_gets_missing_levels_without_reinstalling() {
        let temp = tempfile::tempdir().unwrap();
        let source = project(temp.path());
        let store = ProfileStore::open(temp.path().join("library")).unwrap();
        let profile = store.create("Existing").unwrap();
        let artifact = package(&source, &temp.path().join("archives"), "1.0.0");
        store
            .apply(
                profile.id,
                &InstallPlan {
                    revision: "one".into(),
                    packages: vec![artifact],
                },
            )
            .unwrap();
        let snapshot = store.active_snapshot(profile.id).unwrap().unwrap();
        let installed_project = snapshot.join("projects/11111111-1111-1111-1111-111111111111");
        level(&installed_project, "level_01", b"template");
        // Emulate the old launcher: valid snapshot and revision marker but no level copies.
        store.materialize_game_folder(profile.id, "one").unwrap();
        assert_eq!(
            fs::read(
                store
                    .game_directory(profile.id)
                    .unwrap()
                    .join("worlds/level_01/regions/0_0.bin")
            )
            .unwrap(),
            b"template"
        );
    }

    #[test]
    fn local_project_levels_are_copies_and_failed_commit_rolls_back_new_levels() {
        let temp = tempfile::tempdir().unwrap();
        let source = project(temp.path());
        level(&source, "level_01", b"template");
        let store = ProfileStore::open(temp.path().join("library")).unwrap();
        let profile = store
            .create_local_project("Local", &source, "0.31.4", None)
            .unwrap();
        let revision = profile.active_revision.unwrap();
        let game = store.game_directory(profile.id).unwrap();
        let existing = game.join("worlds/level_01");
        fs::create_dir_all(&existing).unwrap();
        fs::write(existing.join("world.json"), b"{}").unwrap();
        fs::write(existing.join("save.bin"), b"keep me").unwrap();
        level(&source, "level_02", b"new template");
        let failed = store.materialize_game_folder_with_commit(profile.id, &revision, || {
            invalid("simulated DB failure")
        });
        assert!(failed.is_err());
        assert!(!game.join("worlds/level_02").exists());
        assert_eq!(fs::read(existing.join("save.bin")).unwrap(), b"keep me");
        store
            .materialize_game_folder(profile.id, &revision)
            .unwrap();
        fs::write(game.join("worlds/level_02/regions/0_0.bin"), b"local play").unwrap();
        assert_eq!(
            fs::read(source.join("worlds/level_02/regions/0_0.bin")).unwrap(),
            b"new template"
        );
        assert_eq!(fs::read(existing.join("save.bin")).unwrap(), b"keep me");
    }
}
