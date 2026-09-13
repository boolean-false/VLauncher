use crate::{InstalledRuntime, ProfileStore};
use reqwest::{blocking::Client, redirect::Policy};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    time::Duration,
};

const API: &str = "https://api.github.com/repos/MihailRis/voxelcore";
const REPOSITORY_ID: u64 = 361430837;
const MAX_ARCHIVE: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MainBuild {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_version: Option<String>,
    pub sha: String,
    pub run_id: u64,
    pub artifact_id: u64,
    pub digest: String,
    pub size: u64,
    pub created_at: String,
    pub expires_at: String,
    pub platform: String,
    pub architecture: String,
}

impl MainBuild {
    pub fn same_artifact(&self, other: &Self) -> bool {
        let mut left = self.clone();
        let mut right = other.clone();
        left.engine_version = None;
        right.engine_version = None;
        left == right
    }
    pub fn runtime_id(&self) -> String {
        format!("0.0.0-main.{}+g{}", self.artifact_id, self.sha)
    }
    pub fn validate(&self) -> Result<(), String> {
        if let Some(version) = &self.engine_version {
            let parsed =
                semver::Version::parse(version).map_err(|_| "Некорректная версия движка main")?;
            if !parsed.pre.is_empty() || !parsed.build.is_empty() {
                return Err("Некорректная версия движка main".into());
            }
        }
        if self.sha.len() != 40
            || !self.sha.bytes().all(|b| b.is_ascii_hexdigit())
            || self.artifact_id == 0
            || self.run_id == 0
            || self.size == 0
            || self.size > MAX_ARCHIVE
            || !self
                .digest
                .strip_prefix("sha256:")
                .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err("Некорректные метаданные сборки main".into());
        }
        platform_workflow(&self.platform, &self.architecture)?;
        Ok(())
    }
}

#[derive(Serialize)]
pub struct MainCatalog {
    pub head_sha: String,
    pub builds: Vec<MainBuild>,
}

#[derive(Deserialize)]
struct Repository {
    id: u64,
}
#[derive(Deserialize)]
struct Run {
    id: u64,
    head_sha: String,
    head_branch: Option<String>,
    event: String,
    status: String,
    conclusion: Option<String>,
    path: String,
    repository: Repository,
    head_repository: Repository,
}
#[derive(Deserialize)]
struct Runs {
    workflow_runs: Vec<Run>,
}
#[derive(Deserialize)]
struct Artifact {
    id: u64,
    name: String,
    size_in_bytes: u64,
    expired: bool,
    digest: Option<String>,
    created_at: String,
    expires_at: String,
    workflow_run: ArtifactRun,
}
#[derive(Deserialize)]
struct ArtifactRun {
    id: u64,
    head_sha: String,
    head_branch: String,
    repository_id: u64,
    head_repository_id: u64,
}
#[derive(Deserialize)]
struct Artifacts {
    artifacts: Vec<Artifact>,
}

pub(crate) fn platform_workflow(
    os: &str,
    arch: &str,
) -> Result<(&'static str, &'static str), String> {
    match (os, arch) {
        ("linux", "x86_64") => Ok(("appimage.yml", "AppImage")),
        ("windows", "x86_64") => Ok(("windows-clang.yml", "Windows-Build")),
        ("macos", "aarch64") => Ok(("macos.yml", "VoxelEngineMacOs")),
        _ => Err("Для этой ОС и архитектуры нет сборок main".into()),
    }
}

fn client() -> Result<Client, String> {
    Client::builder()
        .user_agent(concat!("VLauncher/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .redirect(Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

fn api<T: serde::de::DeserializeOwned>(
    http: &Client,
    route: &str,
    token: &str,
) -> Result<T, String> {
    let request = http.get(format!("{API}{route}"));
    let request = if token.is_empty() {
        request
    } else {
        request.bearer_auth(token)
    };
    let response = request.send().map_err(|_| "GitHub недоступен")?;
    match response.status().as_u16() {
        401 => return Err("Войдите в GitHub заново в настройках сборок main".into()),
        403 | 429 => {
            return Err(
                "GitHub ограничил запрос: проверьте права входа или повторите позже".into(),
            );
        }
        404 | 410 => return Err("Сборка удалена или срок хранения артефакта истёк".into()),
        _ => (),
    }
    response
        .error_for_status()
        .map_err(|e| format!("Ошибка GitHub: {}", e.status().unwrap()))?
        .json()
        .map_err(|_| "Некорректный ответ GitHub".into())
}

fn verified_build(
    run: &Run,
    artifact: Artifact,
    os: &str,
    arch: &str,
) -> Result<MainBuild, String> {
    let (workflow, name) = platform_workflow(os, arch)?;
    if run.event != "push"
        || run.head_branch.as_deref() != Some("main")
        || run.status != "completed"
        || run.conclusion.as_deref() != Some("success")
        || run.path != format!(".github/workflows/{workflow}")
        || run.repository.id != REPOSITORY_ID
        || run.head_repository.id != REPOSITORY_ID
        || artifact.name != name
        || artifact.expired
        || artifact.workflow_run.id != run.id
        || artifact.workflow_run.head_sha != run.head_sha
        || artifact.workflow_run.head_branch != "main"
        || artifact.workflow_run.repository_id != REPOSITORY_ID
        || artifact.workflow_run.head_repository_id != REPOSITORY_ID
    {
        return Err("Артефакт не принадлежит успешной официальной сборке main".into());
    }
    let build = MainBuild {
        engine_version: None,
        sha: run.head_sha.clone(),
        run_id: run.id,
        artifact_id: artifact.id,
        digest: artifact
            .digest
            .ok_or("GitHub не предоставил контрольную сумму")?,
        size: artifact.size_in_bytes,
        created_at: artifact.created_at,
        expires_at: artifact.expires_at,
        platform: os.into(),
        architecture: arch.into(),
    };
    build.validate()?;
    Ok(build)
}

pub fn list(token: &str) -> Result<MainCatalog, String> {
    let (workflow, name) = platform_workflow(std::env::consts::OS, std::env::consts::ARCH)?;
    let http = client()?;
    #[derive(Deserialize)]
    struct Head {
        sha: String,
    }
    let head: Head = api(&http, "/commits/main", token)?;
    let runs: Runs = api(
        &http,
        &format!(
            "/actions/workflows/{workflow}/runs?branch=main&event=push&status=success&per_page=10"
        ),
        token,
    )?;
    let mut builds = Vec::new();
    for run in runs.workflow_runs {
        let artifacts: Artifacts = api(
            &http,
            &format!("/actions/runs/{}/artifacts?per_page=100", run.id),
            token,
        )?;
        for artifact in artifacts.artifacts {
            if artifact.name == name && !artifact.expired {
                let mut build =
                    verified_build(&run, artifact, std::env::consts::OS, std::env::consts::ARCH)?;
                build.engine_version = Some(fetch_engine_version(&http, &build.sha, token)?);
                builds.push(build);
            }
        }
        if builds.len() >= 5 {
            break;
        }
    }
    Ok(MainCatalog {
        head_sha: head.sha,
        builds,
    })
}

pub fn install(
    store: &ProfileStore,
    expected: &MainBuild,
    token: &str,
    mut progress: impl FnMut(u64, u64) -> bool,
) -> Result<InstalledRuntime, String> {
    expected.validate()?;
    if expected.platform != std::env::consts::OS || expected.architecture != std::env::consts::ARCH
    {
        return Err("Эта сборка main предназначена для другой системы".into());
    }
    let http = client()?;
    let artifact: Artifact = api(
        &http,
        &format!("/actions/artifacts/{}", expected.artifact_id),
        token,
    )?;
    let run: Run = api(
        &http,
        &format!("/actions/runs/{}", artifact.workflow_run.id),
        token,
    )?;
    let mut actual = verified_build(&run, artifact, &expected.platform, &expected.architecture)?;
    actual.engine_version = Some(fetch_engine_version(&http, &actual.sha, token)?);
    if !actual.same_artifact(expected)
        || expected
            .engine_version
            .as_ref()
            .is_some_and(|v| Some(v) != actual.engine_version.as_ref())
    {
        return Err("Метаданные сборки изменились; обновите список".into());
    }
    let redirect = http
        .get(format!(
            "{API}/actions/artifacts/{}/zip",
            actual.artifact_id
        ))
        .bearer_auth(token)
        .send()
        .map_err(|_| "Не удалось получить ссылку GitHub")?;
    if redirect.status().as_u16() != 302 {
        return Err(match redirect.status().as_u16() {
            401 | 403 => "Для скачивания артефактов войдите в GitHub с правом public_repo",
            404 | 410 => "Артефакт удалён или срок его хранения истёк",
            _ => "GitHub не предоставил ссылку на артефакт",
        }
        .into());
    }
    let location = redirect
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or("Отсутствует ссылка GitHub")?;
    let url = reqwest::Url::parse(location).map_err(|_| "Некорректная ссылка GitHub")?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("Небезопасная ссылка GitHub".into());
    }
    // В эту ссылку токен добавлять не надо.
    let mut response = http
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|_| "Не удалось скачать архив GitHub")?;
    let stage = tempfile::tempdir().map_err(|e| e.to_string())?;
    let archive = stage.path().join("actions.zip");
    let mut file = fs::File::create(&archive).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut completed = 0;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        if !progress(completed, actual.size) {
            return Err("Загрузка отменена".into());
        }
        let n = response
            .read(&mut buffer)
            .map_err(|_| "Ошибка загрузки артефакта")?;
        if n == 0 {
            break;
        }
        completed += n as u64;
        if completed > actual.size || completed > MAX_ARCHIVE {
            return Err("Архив превышает заявленный размер".into());
        }
        file.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
        hasher.update(&buffer[..n]);
    }
    drop(file);
    if completed != actual.size
        || format!("sha256:{}", hex::encode(hasher.finalize())) != actual.digest
    {
        return Err("Контрольная сумма или размер артефакта не совпадает".into());
    }
    if !progress(completed, actual.size) {
        return Err("Установка отменена".into());
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let archive = {
        let outer = stage.path().join("outer");
        crate::official::extract_zip(&archive, &outer)?;
        let extension = if cfg!(target_os = "linux") {
            "AppImage"
        } else {
            "dmg"
        };
        let candidates: Vec<_> = walkdir::WalkDir::new(&outer)
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|e| {
                e.file_type().is_file() && e.path().extension().is_some_and(|s| s == extension)
            })
            .collect();
        if candidates.len() != 1 {
            return Err("Артефакт должен содержать один установочный файл".into());
        }
        candidates[0].path().to_owned()
    };
    #[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
    return crate::official::install_archive(
        store,
        &archive,
        &actual.runtime_id(),
        &stage,
        Some(&actual),
        || progress(completed, actual.size),
    );
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    Err("Система не поддерживается".into())
}

fn parse_engine_version(source: &str) -> Result<String, String> {
    let versions: Vec<_> = source
        .lines()
        .filter_map(|line| {
            let declaration = line
                .trim()
                .strip_prefix("inline const std::string ENGINE_VERSION_STRING")?;
            let literal = declaration
                .trim()
                .strip_prefix('=')?
                .trim()
                .strip_prefix('"')?;
            let (value, tail) = literal.split_once('"')?;
            (tail.trim() == ";").then_some(value)
        })
        .collect();
    if versions.len() != 1 {
        return Err("Не удалось определить версию движка по коммиту".into());
    }
    let value = versions[0];
    let normalized = if value.split('.').count() == 2 {
        format!("{value}.0")
    } else {
        value.into()
    };
    let version = semver::Version::parse(&normalized)
        .map_err(|_| "Некорректная версия в исходниках движка")?;
    if !version.pre.is_empty() || !version.build.is_empty() {
        return Err("Неожиданный формат версии движка".into());
    }
    Ok(version.to_string())
}

fn fetch_engine_version(http: &Client, sha: &str, token: &str) -> Result<String, String> {
    use base64::Engine;
    #[derive(Deserialize)]
    struct Source {
        encoding: String,
        content: String,
        size: u64,
    }
    let source: Source = api(
        http,
        &format!("/contents/src/constants.hpp?ref={sha}"),
        token,
    )?;
    if source.encoding != "base64" || source.size > 256 * 1024 || source.content.len() > 512 * 1024
    {
        return Err("Некорректный файл версии движка".into());
    }
    let content = source.content.replace(['\r', '\n'], "");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content)
        .map_err(|_| "Некорректный файл версии движка")?;
    let text = String::from_utf8(bytes).map_err(|_| "Некорректный файл версии движка")?;
    parse_engine_version(&text)
}

pub fn resolve_version(mut build: MainBuild) -> Result<MainBuild, String> {
    build.validate()?;
    if build.engine_version.is_none() {
        build.engine_version = Some(fetch_engine_version(&client()?, &build.sha, "")?);
    }
    Ok(build)
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "requires public GitHub API access"]
    fn pinned_version_from_github() {
        assert_eq!(
            super::fetch_engine_version(
                &super::client().unwrap(),
                "bb6bd27b94e80d813c350fc277832145bc582f21",
                ""
            )
            .unwrap(),
            "0.32.0"
        );
    }
    #[test]
    fn parses_and_normalizes_pinned_source_version() {
        assert_eq!(
            super::parse_engine_version(
                "inline const std::string ENGINE_VERSION_STRING = \"0.32\";\r\n"
            )
            .unwrap(),
            "0.32.0"
        );
        assert_eq!(
            super::parse_engine_version(
                "inline const std::string ENGINE_VERSION_STRING = \"0.31.4\";"
            )
            .unwrap(),
            "0.31.4"
        );
        for source in [
            "",
            "// inline const std::string ENGINE_VERSION_STRING = \"0.32\";",
            "inline const std::string ENGINE_VERSION_STRING = \"develop\";",
            "inline const std::string ENGINE_VERSION_STRING = \"0.32.0-dev\";",
        ] {
            assert!(super::parse_engine_version(source).is_err());
        }
        assert!(
            super::parse_engine_version(
                &"inline const std::string ENGINE_VERSION_STRING = \"0.32\";\n".repeat(2)
            )
            .is_err()
        );
    }

    use super::*;
    #[test]
    fn rejects_pr_failed_workflow_and_msvc_collision() {
        fn fixture() -> (Run, Artifact) {
            let run = Run {
                id: 7,
                head_sha: "a".repeat(40),
                head_branch: Some("main".into()),
                event: "push".into(),
                status: "completed".into(),
                conclusion: Some("success".into()),
                path: ".github/workflows/windows-clang.yml".into(),
                repository: Repository { id: REPOSITORY_ID },
                head_repository: Repository { id: REPOSITORY_ID },
            };
            let artifact = Artifact {
                id: 9,
                name: "Windows-Build".into(),
                size_in_bytes: 20,
                expired: false,
                digest: Some(format!("sha256:{}", "b".repeat(64))),
                created_at: "date".into(),
                expires_at: "expiry".into(),
                workflow_run: ArtifactRun {
                    id: 7,
                    head_sha: "a".repeat(40),
                    head_branch: "main".into(),
                    repository_id: REPOSITORY_ID,
                    head_repository_id: REPOSITORY_ID,
                },
            };
            (run, artifact)
        }
        let (run, artifact) = fixture();
        let build = verified_build(&run, artifact, "windows", "x86_64").unwrap();
        assert!(semver::Version::parse(&build.runtime_id()).is_ok());
        for kind in ["pr", "failed", "msvc", "fork", "expired", "sha"] {
            let (mut run, mut artifact) = fixture();
            match kind {
                "pr" => run.event = "pull_request".into(),
                "failed" => run.conclusion = Some("failure".into()),
                "msvc" => run.path = ".github/workflows/windows.yml".into(),
                "fork" => run.head_repository.id = 1,
                "expired" => artifact.expired = true,
                _ => artifact.workflow_run.head_sha = "c".repeat(40),
            }
            assert!(
                verified_build(&run, artifact, "windows", "x86_64").is_err(),
                "{kind}"
            );
        }
    }
}
