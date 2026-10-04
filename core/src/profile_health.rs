use super::*;

#[derive(Debug, Serialize)]
pub struct ProfileIssue {
    pub kind: &'static str,
    pub component: String,
    pub message: String,
    pub repairable: bool,
}

impl ProfileStore {
    pub fn check_health(
        &self,
        id: Uuid,
        runtime_version: &str,
    ) -> Result<Vec<ProfileIssue>, PackageProblem> {
        let profile = self
            .list()?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| PackageProblem::Invalid("profile does not exist".into()))?;
        let mut issues = Vec::new();
        let runtime = if let Some(runtime) = &profile.external_runtime {
            Some((
                runtime.path.clone(),
                runtime.executable.clone(),
                runtime.resources.clone(),
            ))
        } else {
            self.list_runtimes()?
                .into_iter()
                .find(|r| r.version == runtime_version)
                .and_then(|runtime| {
                    let metadata: RuntimeManifest =
                        serde_json::from_slice(&fs::read(runtime.path.join("runtime.json")).ok()?)
                            .ok()?;
                    Some((runtime.path, metadata.executable, metadata.resources))
                })
        };
        let runtime_ok = runtime.as_ref().is_some_and(|(root, exe, res)| {
            safe_relative(exe).is_ok()
                && safe_relative(res).is_ok()
                && root.join(exe).is_file()
                && root.join(res).is_dir()
        });
        if !runtime_ok {
            let message = if profile.external_runtime.is_some() {
                "Не найден подключённый движок VoxelCore или его папка ресурсов. Проверьте расположение внешнего движка в управлении профилем."
            } else {
                "Не найден движок VoxelCore или его папка ресурсов. Переустановите движок; миры и содержимое профиля сохранятся."
            };
            issues.push(ProfileIssue {
                kind: "runtime",
                component: "runtime".into(),
                message: message.into(),
                repairable: profile.external_runtime.is_none(),
            });
        }
        if let Some(revision) = &profile.active_revision {
            let snapshot = self.profile_path(id).join("snapshots").join(revision);
            let game = self.game_directory(id)?;
            for package in &profile.packages {
                let (target, source, marker) = match package.kind {
                    PackageKind::Mod | PackageKind::Library => (
                        game.join("content").join(&package.id),
                        snapshot.join("content").join(&package.id),
                        "package.json",
                    ),
                    PackageKind::Project => (
                        snapshot.join("projects").join(&package.id),
                        snapshot.join("projects").join(&package.id),
                        "project.toml",
                    ),
                    _ => continue,
                };
                let valid = if marker == "package.json" {
                    PackageManifest::read(&target).is_ok_and(|manifest| {
                        manifest.id == package.id && manifest.version == package.version
                    })
                } else {
                    VoxelCoreProject::read(&target).is_ok()
                };
                if !valid {
                    let repairable = fs::symlink_metadata(&target)
                        .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
                        && source.join(marker).is_file();
                    let action = if repairable {
                        "Можно восстановить этот пак из сохранённой копии установки."
                    } else {
                        "Восстановите пак из исходного архива или исправной копии установки. Существующие файлы профиля автоматически не заменяются."
                    };
                    let title = package.title.as_deref().unwrap_or(&package.id);
                    issues.push(ProfileIssue {
                        kind: "package",
                        component: package.id.clone(),
                        message: format!(
                            "Отсутствует или повреждён {marker} для пака «{title}» {}. {action}",
                            package.version
                        ),
                        repairable,
                    });
                }
            }
        }
        if let Some(project) = &profile.external_project_path
            && !project.join("project.toml").is_file()
        {
            let message = "Не найден project.toml подключённого проекта. Проверьте его папку или подключите проект заново.";
            issues.push(ProfileIssue {
                kind: "project",
                component: "external-project".into(),
                message: message.into(),
                repairable: false,
            });
        }
        Ok(issues)
    }

    pub fn restore_missing_package(
        &self,
        id: Uuid,
        package_id: &str,
    ) -> Result<(), PackageProblem> {
        let _lock = self.lock_profile(id)?;
        let profile = self
            .list()?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| PackageProblem::Invalid("profile does not exist".into()))?;
        let package = profile
            .packages
            .iter()
            .find(|p| {
                p.id == package_id && matches!(p.kind, PackageKind::Mod | PackageKind::Library)
            })
            .ok_or_else(|| {
                PackageProblem::Invalid(
                    "Можно восстановить только установленный пак каталога.".into(),
                )
            })?;
        safe_relative(Path::new(package_id))?;
        let revision = profile
            .active_revision
            .ok_or_else(|| PackageProblem::Invalid("Нет сохранённой копии установки.".into()))?;
        let source = self
            .profile_path(id)
            .join("snapshots")
            .join(revision)
            .join("content")
            .join(package_id);
        let manifest = PackageManifest::read(&source)?;
        if manifest.id != package_id || manifest.version != package.version {
            return invalid(
                "Сохранённая копия не соответствует установленной версии. Добавьте пак заново через каталог.",
            );
        }
        let content = self.game_directory(id)?.join("content");
        fs::create_dir_all(&content).map_err(|e| io_error(&content, e))?;
        let target = content.join(package_id);
        if !fs::symlink_metadata(&target).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
            return invalid(
                "Папка пака уже существует. Восстановление остановлено, чтобы сохранить ваши файлы.",
            );
        }
        let staging = tempfile::tempdir_in(&content).map_err(|e| io_error(&content, e))?;
        let restored = staging.path().join("restored");
        copy_tree(&source, &restored)?;
        fs::rename(&restored, &target).map_err(|e| io_error(&target, e))?;
        Ok(())
    }
}
