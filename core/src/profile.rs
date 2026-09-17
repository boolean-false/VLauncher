use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use fs2::FileExt;
use reqwest::{StatusCode, blocking::Client, header::RANGE};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use walkdir::WalkDir;
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

use crate::{
    DependencyKind, PackageKind, PackageManifest, PackageProblem, PreparedArtifact, prepare_package,
};

const MAX_FILES: usize = 100_000;
const MAX_UNPACKED_SIZE: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Profile {
    #[serde(default)]
    pub main_build: Option<crate::mainline::MainBuild>,
    pub id: Uuid,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    pub active_revision: Option<String>,
    pub voxelcore_version: Option<String>,
    pub roots: Vec<String>,
    #[serde(default)]
    pub root_requirements: HashMap<String, String>,
    pub packages: Vec<InstalledPackage>,
    #[serde(default)]
    pub external_packages: Vec<ExternalPackage>,
    #[serde(default)]
    pub manual_packages: Vec<String>,
    pub created_at: i64,
    #[serde(default)]
    pub problem: Option<String>,
    #[serde(default)]
    pub external_game_path: Option<PathBuf>,
    #[serde(default)]
    pub external_runtime: Option<ExternalRuntime>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstalledPackage {
    pub id: String,
    pub kind: PackageKind,
    pub version: String,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExternalPackage {
    pub id: String,
    pub source: String,
    pub project_id: u64,
    pub slug: String,
    pub version_id: u64,
    pub version: String,
    pub title: String,
    pub artifact_sha256: String,
    #[serde(default)]
    pub artifact_size: u64,
}

#[derive(Debug, Clone)]
pub struct ExternalInstallPackage {
    pub package: ExternalPackage,
    pub artifact: PreparedArtifact,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstallPackage {
    pub id: String,
    pub kind: PackageKind,
    pub version: String,
    pub artifact_sha256: String,
    pub artifact_size: u64,
    pub archive_path: PathBuf,
    #[serde(default)]
    pub dependencies: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstallPlan {
    pub revision: String,
    pub packages: Vec<InstallPackage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ProfileSnapshotMetadata {
    #[serde(default)]
    main_build: Option<crate::mainline::MainBuild>,
    voxelcore_version: Option<String>,
    roots: Vec<String>,
    #[serde(default)]
    root_requirements: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteInstallPackage {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: PackageKind,
    pub version: String,
    pub artifact_sha256: String,
    pub artifact_size: u64,
    pub download_url: String,
    #[serde(default)]
    pub dependencies: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteInstallPlan {
    pub revision: String,
    pub issued_at: i64,
    pub expires_at: i64,
    pub voxelcore_version: String,
    pub roots: Vec<String>,
    #[serde(default)]
    pub root_requirements: HashMap<String, String>,
    pub packages: Vec<RemoteInstallPackage>,
    #[serde(default)]
    pub external_packages: Option<Vec<crate::ExternalPackageLock>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SignedRemoteInstallPlan {
    pub plan: RemoteInstallPlan,
    pub algorithm: String,
    pub key_id: String,
    pub payload: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeManifest {
    pub schema_version: u32,
    pub version: String,
    pub platform: String,
    pub architecture: String,
    pub executable: PathBuf,
    pub resources: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstalledRuntime {
    #[serde(default)]
    pub main_build: Option<crate::mainline::MainBuild>,
    pub version: String,
    pub platform: String,
    pub architecture: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExistingRuntimeKind {
    Manifest,
    Detected,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExistingGameAnalysis {
    pub suggested_name: String,
    pub runtime_kind: ExistingRuntimeKind,
    pub runtime_version: Option<String>,
    pub content_count: u64,
    pub world_count: u64,
    pub has_config: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExternalRuntime {
    pub path: PathBuf,
    pub executable: PathBuf,
    pub resources: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LaunchSpec {
    pub executable: PathBuf,
    pub arguments: Vec<String>,
    pub working_directory: PathBuf,
    pub log_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CacheStatus {
    pub artifacts: u64,
    pub artifact_bytes: u64,
    pub partial_downloads: u64,
    pub partial_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProfileStorage {
    pub total_bytes: u64,
    pub game_bytes: u64,
    pub snapshot_bytes: u64,
    pub reclaimable_bytes: u64,
    pub snapshot_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProfileDefinition {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main_build: Option<crate::mainline::MainBuild>,
    pub schema_version: u32,
    pub name: String,
    pub voxelcore_version: String,
    pub roots: Vec<String>,
    #[serde(default)]
    pub locked: Vec<ProfileLockedPackage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProfileLockedPackage {
    pub id: String,
    pub version: String,
    pub artifact_sha256: String,
}

impl SignedRemoteInstallPlan {
    pub fn verify(&self, public_key: &str, now: i64) -> Result<RemoteInstallPlan, PackageProblem> {
        if self.algorithm != "Ed25519" {
            return invalid("unsupported resolution plan signature algorithm");
        }
        let public_key = URL_SAFE_NO_PAD
            .decode(public_key)
            .map_err(|_| PackageProblem::Invalid("trusted signing key is invalid".into()))?;
        let public_key: [u8; 32] = public_key.try_into().map_err(|_| {
            PackageProblem::Invalid("trusted signing key must contain 32 bytes".into())
        })?;
        let expected_key_id = hex::encode(Sha256::digest(public_key));
        if self.key_id != expected_key_id[..16] {
            return invalid("resolution plan was signed by an untrusted key");
        }
        let payload = URL_SAFE_NO_PAD
            .decode(&self.payload)
            .map_err(|_| PackageProblem::Invalid("signed resolution payload is invalid".into()))?;
        let signature = URL_SAFE_NO_PAD
            .decode(&self.signature)
            .map_err(|_| PackageProblem::Invalid("resolution signature is invalid".into()))?;
        let signature = Signature::from_slice(&signature).map_err(|_| {
            PackageProblem::Invalid("resolution signature has an invalid size".into())
        })?;
        VerifyingKey::from_bytes(&public_key)
            .map_err(|_| PackageProblem::Invalid("trusted signing key is invalid".into()))?
            .verify(&payload, &signature)
            .map_err(|_| {
                PackageProblem::Invalid("resolution plan signature verification failed".into())
            })?;
        let verified: RemoteInstallPlan = serde_json::from_slice(&payload)
            .map_err(|error| PackageProblem::Invalid(format!("signed plan is invalid: {error}")))?;
        if verified != self.plan {
            return invalid("displayed resolution plan differs from its signed payload");
        }
        if verified.issued_at > now + 300 {
            return invalid("resolution plan was issued in the future");
        }
        if verified.expires_at < now {
            return invalid("resolution plan has expired");
        }
        Ok(verified)
    }

    pub fn verify_trusted(&self, now: i64) -> Result<RemoteInstallPlan, PackageProblem> {
        if option_env!("VLAUNCHER_REVOKED_SIGNING_KEY_IDS")
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .any(|id| !id.is_empty() && id == self.key_id)
        {
            return invalid("resolution plan signing key has been revoked");
        }
        for public_key in trusted_signing_public_keys() {
            let Ok(bytes) = URL_SAFE_NO_PAD.decode(public_key) else {
                continue;
            };
            if self.key_id == hex::encode(Sha256::digest(bytes))[..16] {
                return self.verify(public_key, now);
            }
        }
        invalid("resolution plan was signed by an untrusted key")
    }
}

pub fn trusted_signing_public_key() -> &'static str {
    option_env!("VLAUNCHER_SIGNING_PUBLIC_KEY")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("4Qn9UZseKD_homP6xr5sMHf2a2Hz_hXWDxHEegLcu2o")
}

pub fn trusted_signing_public_keys() -> Vec<&'static str> {
    option_env!("VLAUNCHER_TRUSTED_SIGNING_PUBLIC_KEYS")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(trusted_signing_public_key())
        .split(',')
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .collect()
}

pub struct ProfileStore {
    root: PathBuf,
    profile_folders: Mutex<HashMap<Uuid, String>>,
}

impl ProfileStore {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, PackageProblem> {
        let root = root.as_ref().to_owned();
        fs::create_dir_all(root.join("profiles")).map_err(|source| io_error(&root, source))?;
        fs::create_dir_all(root.join("cache/blobs")).map_err(|source| io_error(&root, source))?;
        let store = Self {
            root,
            profile_folders: Mutex::new(HashMap::new()),
        };
        store.with_database(|database| {
            database.execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA foreign_keys = ON;
                 CREATE TABLE IF NOT EXISTS profiles (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    folder_name TEXT,
                    active_revision TEXT,
                    previous_revision TEXT,
                    created_at INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS operations (
                    id TEXT PRIMARY KEY,
                    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                    kind TEXT NOT NULL,
                    revision TEXT,
                    status TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                 );",
            )?;
            let _ = database.execute("ALTER TABLE profiles ADD COLUMN voxelcore_version TEXT", []);
            let _ = database.execute(
                "ALTER TABLE profiles ADD COLUMN roots_json TEXT NOT NULL DEFAULT '[]'",
                [],
            );
            let _ = database.execute(
                "ALTER TABLE profiles ADD COLUMN root_requirements_json TEXT NOT NULL DEFAULT '{}'",
                [],
            );
            let _ = database.execute("ALTER TABLE profiles ADD COLUMN folder_name TEXT", []);
            let _ = database.execute(
                "ALTER TABLE profiles ADD COLUMN external_game_path TEXT",
                [],
            );
            let _ = database.execute(
                "ALTER TABLE profiles ADD COLUMN external_runtime_json TEXT",
                [],
            );
            database.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS profiles_external_game_path
                 ON profiles(external_game_path) WHERE external_game_path IS NOT NULL",
                [],
            )?;
            Ok(())
        })?;
        let folders = store.with_database(|database| {
            let mut statement = database
                .prepare("SELECT id, folder_name FROM profiles WHERE folder_name IS NOT NULL")?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<Result<Vec<_>, _>>()
        })?;
        let mut profile_folders = store.profile_folders.lock().map_err(|_| {
            PackageProblem::Invalid("profile directory index is unavailable".into())
        })?;
        profile_folders.extend(
            folders
                .into_iter()
                .filter_map(|(id, folder)| Some((Uuid::parse_str(&id).ok()?, folder))),
        );
        drop(profile_folders);
        Ok(store)
    }

    pub fn create(&self, name: &str) -> Result<Profile, PackageProblem> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 80 {
            return invalid("profile name must contain 1 to 80 characters");
        }
        let id = Uuid::new_v4();
        let folder_name = self.available_profile_folder(name, None)?;
        let profile = Profile {
            main_build: None,
            id,
            name: name.to_owned(),
            icon: None,
            active_revision: None,
            voxelcore_version: None,
            roots: Vec::new(),
            root_requirements: HashMap::new(),
            packages: Vec::new(),
            external_packages: Vec::new(),
            manual_packages: Vec::new(),
            created_at: timestamp(),
            problem: None,
            external_game_path: None,
            external_runtime: None,
        };
        let profile_path = self.root.join("profiles").join(&folder_name);
        fs::create_dir(&profile_path).map_err(|source| io_error(&profile_path, source))?;
        let result = (|| {
            fs::create_dir(profile_path.join("snapshots"))
                .map_err(|source| io_error(&profile_path, source))?;
            fs::create_dir(profile_path.join("game"))
                .map_err(|source| io_error(&profile_path, source))?;
            self.with_database(|database| {
                database.execute(
                    "INSERT INTO profiles (id, name, folder_name, created_at) VALUES (?1, ?2, ?3, ?4)",
                    params![
                        profile.id.to_string(),
                        profile.name,
                        folder_name,
                        profile.created_at
                    ],
                )?;
                Ok(())
            })?;
            self.profile_folders
                .lock()
                .map_err(|_| {
                    PackageProblem::Invalid("profile directory index is unavailable".into())
                })?
                .insert(id, folder_name);
            Ok(())
        })();
        if let Err(error) = result {
            let _ = fs::remove_dir_all(&profile_path);
            return Err(error);
        }
        Ok(profile)
    }

    fn available_profile_folder(
        &self,
        name: &str,
        ignored: Option<&str>,
    ) -> Result<String, PackageProblem> {
        let profiles = self.root.join("profiles");
        let ignored = ignored.map(str::to_lowercase);
        let occupied = fs::read_dir(&profiles)
            .map_err(|error| io_error(&profiles, error))?
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .map(|name| name.to_lowercase())
            .filter(|name| ignored.as_ref() != Some(name))
            .collect::<HashSet<_>>();
        let base = safe_profile_folder_name(name);
        if !occupied.contains(&base.to_lowercase()) {
            return Ok(base);
        }
        for suffix in 2..=10_000 {
            let candidate = format!("{base} ({suffix})");
            if !occupied.contains(&candidate.to_lowercase()) {
                return Ok(candidate);
            }
        }
        invalid("could not allocate a profile directory")
    }

    pub fn root_path(&self) -> &Path {
        &self.root
    }

    pub fn copy_library_to(
        &self,
        destination: impl AsRef<Path>,
    ) -> Result<PathBuf, PackageProblem> {
        let destination = destination.as_ref();
        if destination.exists() {
            return invalid("library destination already exists");
        }
        let parent = destination
            .parent()
            .ok_or_else(|| PackageProblem::Invalid("library destination has no parent".into()))?;
        fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
        let source = fs::canonicalize(&self.root).map_err(|error| io_error(&self.root, error))?;
        let parent = fs::canonicalize(parent).map_err(|error| io_error(parent, error))?;
        if parent.starts_with(&source) {
            return invalid("library cannot be moved inside itself");
        }
        ensure_space(&parent, tree_size(&source)?.saturating_mul(2))?;
        let staging = parent.join(format!(".vlauncher-library-{}", Uuid::new_v4()));
        let result = (|| {
            copy_tree(&source, &staging)?;
            let copied_database = staging.join("launcher.sqlite3");
            if !copied_database.is_file() {
                return invalid("copied library is incomplete");
            }
            fs::rename(&staging, destination).map_err(|error| io_error(destination, error))?;
            Ok(destination.to_owned())
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&staging);
        }
        result
    }

    pub fn create_initialized(
        &self,
        name: &str,
        voxelcore_version: &str,
    ) -> Result<Profile, PackageProblem> {
        self.create_initialized_with_main(name, voxelcore_version, None)
    }

    pub fn create_initialized_with_main(
        &self,
        name: &str,
        voxelcore_version: &str,
        main_build: Option<crate::mainline::MainBuild>,
    ) -> Result<Profile, PackageProblem> {
        if let Some(build) = &main_build {
            build.validate().map_err(PackageProblem::Invalid)?;
        }
        let voxelcore_version = main_build
            .as_ref()
            .and_then(|b| b.engine_version.as_deref())
            .unwrap_or(voxelcore_version);
        let profile = self.create(name)?;
        let initialized = self
            .initialize_vanilla(profile.id, voxelcore_version)
            .and_then(|()| {
                if main_build.is_some() {
                    self.select_main_build(profile.id, main_build)
                } else {
                    Ok(())
                }
            });
        if let Err(error) = initialized {
            let _ = self.delete_profile(profile.id);
            return Err(error);
        }
        self.profile(profile.id)
    }

    pub fn create_with_signed_remote(
        &self,
        name: &str,
        signed: &SignedRemoteInstallPlan,
    ) -> Result<Profile, PackageProblem> {
        let profile = self.create(name)?;
        if let Err(error) = self.apply_signed_remote(profile.id, signed) {
            let _ = self.delete_profile(profile.id);
            return Err(error);
        }
        self.profile(profile.id)
    }

    pub fn set_icon(&self, id: Uuid, icon: Option<&str>) -> Result<(), PackageProblem> {
        if !self.list()?.iter().any(|p| p.id == id) {
            return invalid("profile does not exist");
        }
        let path = self.profile_path(id).join("icon.txt");
        if let Some(icon) = icon {
            if icon.len() > 512 * 1024 {
                return invalid("profile icon is too large");
            }
            let encoded = icon
                .strip_prefix("data:image/png;base64,")
                .ok_or_else(|| PackageProblem::Invalid("profile icon must be PNG".into()))?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| PackageProblem::Invalid("invalid profile icon".into()))?;
            if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR"
            {
                return invalid("invalid PNG icon");
            }
            let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
            let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
            if width == 0 || height == 0 || width > 256 || height > 256 {
                return invalid("profile icon must fit 256x256");
            }
            fs::write(&path, icon).map_err(|e| io_error(&path, e))?;
        } else if path.exists() {
            fs::remove_file(&path).map_err(|e| io_error(&path, e))?;
        }
        Ok(())
    }

    pub fn rename(&self, id: Uuid, name: &str) -> Result<(), PackageProblem> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 80 {
            return invalid("profile name must contain 1 to 80 characters");
        }
        let current_folder = self
            .profile_folders
            .lock()
            .map_err(|_| PackageProblem::Invalid("profile directory index is unavailable".into()))?
            .get(&id)
            .cloned()
            .unwrap_or_else(|| id.to_string());
        let folder_name = self.available_profile_folder(name, Some(&current_folder))?;
        let current_path = self.root.join("profiles").join(&current_folder);
        let next_path = self.root.join("profiles").join(&folder_name);
        let renamed = current_path != next_path;
        if renamed {
            fs::rename(&current_path, &next_path)
                .map_err(|error| io_error(&current_path, error))?;
        }
        let result = self.with_database(|db| {
            if db.execute(
                "UPDATE profiles SET name = ?1, folder_name = ?2 WHERE id = ?3",
                params![name, folder_name, id.to_string()],
            )? == 0
            {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            Ok(())
        });
        if let Err(error) = result {
            if renamed {
                let _ = fs::rename(&next_path, &current_path);
            }
            return Err(error);
        }
        self.profile_folders
            .lock()
            .map_err(|_| PackageProblem::Invalid("profile directory index is unavailable".into()))?
            .insert(id, folder_name);
        Ok(())
    }

    pub fn initialize_vanilla(&self, id: Uuid, version: &str) -> Result<(), PackageProblem> {
        semver::Version::parse(version).map_err(|e| PackageProblem::Invalid(e.to_string()))?;
        let profile = self
            .list()?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| PackageProblem::Invalid("profile does not exist".into()))?;
        if profile.active_revision.is_some() {
            return invalid("profile is already initialized");
        }
        self.apply_with_metadata(
            id,
            &InstallPlan {
                revision: format!("vanilla-{}", Uuid::new_v4()),
                packages: vec![],
            },
            &ProfileSnapshotMetadata {
                main_build: None,
                voxelcore_version: Some(version.to_owned()),
                roots: Vec::new(),
                root_requirements: HashMap::new(),
            },
        )
    }

    pub fn change_vanilla_runtime(&self, id: Uuid, version: &str) -> Result<(), PackageProblem> {
        semver::Version::parse(version).map_err(|e| PackageProblem::Invalid(e.to_string()))?;
        let profile = self.profile(id)?;
        if !profile.packages.is_empty() || !profile.roots.is_empty() {
            return invalid("a modded profile must be resolved before changing VoxelCore");
        }
        self.apply_with_metadata(
            id,
            &InstallPlan {
                revision: format!("vanilla-{}-{}", version, Uuid::new_v4()),
                packages: Vec::new(),
            },
            &ProfileSnapshotMetadata {
                main_build: None,
                voxelcore_version: Some(version.to_owned()),
                roots: Vec::new(),
                root_requirements: HashMap::new(),
            },
        )
    }

    pub fn game_directory(&self, id: Uuid) -> Result<PathBuf, PackageProblem> {
        let external = self.with_database(|database| {
            database.query_row(
                "SELECT external_game_path FROM profiles WHERE id = ?1",
                [id.to_string()],
                |row| row.get::<_, Option<String>>(0),
            )
        })?;
        Ok(external
            .map(PathBuf::from)
            .unwrap_or_else(|| self.profile_path(id).join("game")))
    }

    pub fn export_world(
        &self,
        profile_id: Uuid,
        folder: &str,
        output: impl AsRef<Path>,
    ) -> Result<PathBuf, PackageProblem> {
        let relative = Path::new(folder);
        safe_relative(relative)?;
        if relative.components().count() != 1 {
            return invalid("world folder must be a single directory name");
        }
        let source = self
            .game_directory(profile_id)?
            .join("worlds")
            .join(relative);
        if !source.join("world.json").is_file() {
            return invalid("world does not contain world.json");
        }
        let output = output.as_ref();
        let temporary = output.with_extension(format!("part-{}", Uuid::new_v4()));
        let file = fs::File::create(&temporary).map_err(|source| io_error(&temporary, source))?;
        let mut archive = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);
        for entry in WalkDir::new(&source)
            .follow_links(false)
            .sort_by_file_name()
        {
            let entry = entry.map_err(|error| PackageProblem::Invalid(error.to_string()))?;
            if entry.file_type().is_symlink() {
                let _ = fs::remove_file(&temporary);
                return invalid("world contains a symbolic link");
            }
            if !entry.file_type().is_file() {
                continue;
            }
            let name = entry
                .path()
                .strip_prefix(&source)
                .map_err(|error| PackageProblem::Invalid(error.to_string()))?
                .to_string_lossy()
                .replace('\\', "/");
            archive
                .start_file(name, options)
                .map_err(|error| PackageProblem::Invalid(error.to_string()))?;
            let mut input =
                fs::File::open(entry.path()).map_err(|source| io_error(entry.path(), source))?;
            std::io::copy(&mut input, &mut archive)
                .map_err(|source| io_error(&temporary, source))?;
        }
        archive
            .finish()
            .map_err(|error| PackageProblem::Invalid(error.to_string()))?
            .sync_all()
            .map_err(|source| io_error(&temporary, source))?;
        if output.exists() {
            fs::remove_file(output).map_err(|source| io_error(output, source))?;
        }
        fs::rename(&temporary, output).map_err(|source| io_error(output, source))?;
        Ok(output.to_owned())
    }

    pub fn import_world(
        &self,
        profile_id: Uuid,
        archive_path: impl AsRef<Path>,
    ) -> Result<PathBuf, PackageProblem> {
        self.profile(profile_id)?;
        let archive_path = archive_path.as_ref();
        let game = self.game_directory(profile_id)?;
        let staging = game.join(format!(".vlauncher-world-import-{}", Uuid::new_v4()));
        fs::create_dir_all(&staging).map_err(|source| io_error(&staging, source))?;
        let result = (|| {
            let file =
                fs::File::open(archive_path).map_err(|source| io_error(archive_path, source))?;
            extract_archive(file, &staging)?;
            let source = if staging.join("world.json").is_file() {
                staging.clone()
            } else {
                let entries = fs::read_dir(&staging)
                    .map_err(|source| io_error(&staging, source))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|source| io_error(&staging, source))?;
                if entries.len() != 1 || !entries[0].path().join("world.json").is_file() {
                    return invalid("world archive must contain world.json at its root");
                }
                entries[0].path()
            };
            let stem = archive_path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("imported-world");
            let base = stem
                .chars()
                .map(|character| {
                    if character.is_alphanumeric() || matches!(character, '-' | '_') {
                        character
                    } else {
                        '-'
                    }
                })
                .collect::<String>();
            let base = if base.is_empty() {
                "imported-world".to_owned()
            } else {
                base
            };
            let worlds = game.join("worlds");
            fs::create_dir_all(&worlds).map_err(|source| io_error(&worlds, source))?;
            let mut destination = worlds.join(&base);
            let mut suffix = 2;
            while destination.exists() {
                destination = worlds.join(format!("{base}-{suffix}"));
                suffix += 1;
            }
            fs::rename(&source, &destination).map_err(|source| io_error(&destination, source))?;
            Ok(destination)
        })();
        if staging.exists() {
            let _ = fs::remove_dir_all(&staging);
        }
        result
    }

    fn profile(&self, id: Uuid) -> Result<Profile, PackageProblem> {
        self.list()?
            .into_iter()
            .find(|profile| profile.id == id)
            .ok_or_else(|| PackageProblem::Invalid("profile does not exist".into()))
    }

    pub fn list(&self) -> Result<Vec<Profile>, PackageProblem> {
        let profiles = self.with_database(|database| {
            let mut statement = database.prepare(
                "SELECT id, name, active_revision, voxelcore_version, roots_json,
                        root_requirements_json, created_at, external_game_path,
                        external_runtime_json
                 FROM profiles ORDER BY created_at",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>()
        })?;
        let mut profiles = profiles
            .into_iter()
            .filter_map(
                |(
                    id,
                    name,
                    active_revision,
                    voxelcore_version,
                    roots_json,
                    root_requirements_json,
                    created_at,
                    external_game_path,
                    external_runtime_json,
                )| {
                    let id = Uuid::parse_str(&id).ok()?;
                    let roots = serde_json::from_str(&roots_json).unwrap_or_default();
                    let root_requirements =
                        serde_json::from_str(&root_requirements_json).unwrap_or_default();
                    let (external_runtime, problem) = match external_runtime_json {
                        Some(value) => match serde_json::from_str(&value) {
                            Ok(runtime) => (Some(runtime), None),
                            Err(error) => (
                                None,
                                Some(format!("Повреждены данные локального VoxelCore: {error}")),
                            ),
                        },
                        None => (None, None),
                    };
                    Some(Profile {
                        main_build: None,
                        id,
                        name,
                        icon: fs::read_to_string(self.profile_path(id).join("icon.txt")).ok(),
                        active_revision,
                        voxelcore_version,
                        roots,
                        root_requirements,
                        packages: Vec::new(),
                        external_packages: Vec::new(),
                        manual_packages: Vec::new(),
                        created_at,
                        problem,
                        external_game_path: external_game_path.map(PathBuf::from),
                        external_runtime,
                    })
                },
            )
            .collect::<Vec<_>>();
        for profile in &mut profiles {
            if profile.problem.is_some() {
                continue;
            }
            let Some(revision) = &profile.active_revision else {
                continue;
            };
            profile.main_build = match self.snapshot_main_build(profile.id, revision) {
                Ok(build) => build,
                Err(error) => {
                    profile.problem = Some(error.to_string());
                    continue;
                }
            };
            let lock_path = self
                .profile_path(profile.id)
                .join("snapshots")
                .join(revision)
                .join("vlauncher.lock.json");
            let plan: InstallPlan = match fs::read(&lock_path)
                .map_err(|source| io_error(&lock_path, source))
                .and_then(|bytes| {
                    serde_json::from_slice(&bytes).map_err(|error| {
                        PackageProblem::Invalid(format!("invalid profile lockfile: {error}"))
                    })
                }) {
                Ok(plan) => plan,
                Err(error) => {
                    profile.problem = Some(error.to_string());
                    continue;
                }
            };
            profile.packages = plan
                .packages
                .into_iter()
                .map(|package| {
                    let folder = match package.kind {
                        PackageKind::Mod | PackageKind::Library => "content",
                        PackageKind::Modpack => "modpacks",
                        PackageKind::World => "world-templates",
                        PackageKind::Runtime => "runtimes",
                    };
                    let manifest = lock_path
                        .parent()
                        .expect("snapshot directory")
                        .join(folder)
                        .join(&package.id)
                        .join("package.json");
                    let title = fs::read(manifest)
                        .ok()
                        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                        .and_then(|value| {
                            value
                                .get("title")
                                .and_then(|v| v.as_str())
                                .map(str::to_owned)
                        });
                    InstalledPackage {
                        id: package.id,
                        kind: package.kind,
                        version: package.version,
                        title,
                    }
                })
                .collect();
            profile.external_packages = match self.read_external_packages(profile.id) {
                Ok(packages) => packages,
                Err(error) => {
                    profile.problem = Some(error.to_string());
                    Vec::new()
                }
            };
            let mut managed = profile
                .packages
                .iter()
                .map(|package| package.id.clone())
                .collect::<HashSet<_>>();
            managed.extend(
                profile
                    .external_packages
                    .iter()
                    .map(|package| package.id.clone()),
            );
            let profile_path = self.profile_path(profile.id);
            let game = profile
                .external_game_path
                .clone()
                .unwrap_or_else(|| profile_path.join("game"));
            if !game.is_dir() {
                profile.problem = Some("Подключённая папка игры недоступна".into());
                continue;
            }
            if let Ok(materialized_revision) = fs::read_to_string(game.join(".vlauncher-revision"))
            {
                if safe_relative(Path::new(&materialized_revision)).is_ok() {
                    let materialized_content = profile_path
                        .join("snapshots")
                        .join(materialized_revision)
                        .join("content");
                    if let Ok(entries) = fs::read_dir(materialized_content) {
                        managed.extend(
                            entries
                                .filter_map(Result::ok)
                                .filter_map(|entry| entry.file_name().into_string().ok()),
                        );
                    }
                }
            }
            let content = game.join("content");
            if let Ok(entries) = fs::read_dir(content) {
                profile.manual_packages = entries
                    .filter_map(Result::ok)
                    .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                    .filter_map(|entry| entry.file_name().into_string().ok())
                    .filter(|name| !managed.contains(name))
                    .collect();
                profile.manual_packages.sort();
            }
        }
        Ok(profiles)
    }

    pub fn clone_profile(&self, profile_id: Uuid, name: &str) -> Result<Profile, PackageProblem> {
        let source = self
            .list()?
            .into_iter()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| PackageProblem::Invalid("profile does not exist".into()))?;
        let cloned = self.create(name)?;
        let result = (|| {
            let cloned_path = self.profile_path(cloned.id);
            self.set_icon(cloned.id, source.icon.as_deref())?;
            let external_metadata = self.profile_path(source.id).join("external-packages.json");
            if external_metadata.is_file() {
                fs::copy(
                    &external_metadata,
                    cloned_path.join("external-packages.json"),
                )
                .map_err(|error| io_error(&external_metadata, error))?;
            }
            if let Some(revision) = &source.active_revision {
                let source_snapshot = self
                    .profile_path(source.id)
                    .join("snapshots")
                    .join(revision);
                let target_snapshot = cloned_path.join("snapshots").join(revision);
                copy_tree(&source_snapshot, &target_snapshot)?;
            }

            // Так недокопированная папка не появится в библиотеке.
            let source_game = self.game_directory(source.id)?;
            let staged_game = cloned_path.join(format!(".clone-game-{}", Uuid::new_v4()));
            copy_tree(&source_game, &staged_game)?;
            let target_game = cloned_path.join("game");
            fs::remove_dir_all(&target_game).map_err(|error| io_error(&target_game, error))?;
            fs::rename(&staged_game, &target_game)
                .map_err(|error| io_error(&target_game, error))?;

            let roots = serde_json::to_string(&source.roots)
                .map_err(|error| PackageProblem::Invalid(error.to_string()))?;
            let root_requirements = serde_json::to_string(&source.root_requirements)
                .map_err(|error| PackageProblem::Invalid(error.to_string()))?;
            self.with_database(|database| {
                database.execute(
                    "UPDATE profiles SET active_revision = ?1, voxelcore_version = ?2,
                     roots_json = ?3, root_requirements_json = ?4 WHERE id = ?5",
                    params![
                        source.active_revision,
                        source.voxelcore_version,
                        roots,
                        root_requirements,
                        cloned.id.to_string()
                    ],
                )?;
                Ok(())
            })
        })();
        if let Err(error) = result {
            let _ = self.delete_profile(cloned.id);
            return Err(error);
        }
        Ok(self
            .list()?
            .into_iter()
            .find(|profile| profile.id == cloned.id)
            .expect("new profile exists"))
    }

    pub fn delete_profile(&self, profile_id: Uuid) -> Result<(), PackageProblem> {
        let path = self.profile_path(profile_id);
        if !path.is_dir() {
            return invalid("profile does not exist");
        }
        fs::remove_dir_all(&path).map_err(|source| io_error(&path, source))?;
        self.with_database(|database| {
            database.execute(
                "DELETE FROM profiles WHERE id = ?1",
                [profile_id.to_string()],
            )?;
            Ok(())
        })
    }

    pub fn apply(&self, profile_id: Uuid, plan: &InstallPlan) -> Result<(), PackageProblem> {
        let metadata = self.profile_metadata(profile_id)?;
        self.apply_with_metadata(profile_id, plan, &metadata)
    }

    pub fn install_external_packages(
        &self,
        profile_id: Uuid,
        packages: Vec<ExternalInstallPackage>,
    ) -> Result<Vec<ExternalPackage>, PackageProblem> {
        self.update_external_packages(profile_id, packages, false)
    }

    pub fn replace_external_packages(
        &self,
        profile_id: Uuid,
        packages: Vec<ExternalInstallPackage>,
    ) -> Result<Vec<ExternalPackage>, PackageProblem> {
        self.update_external_packages(profile_id, packages, true)
    }

    fn update_external_packages(
        &self,
        profile_id: Uuid,
        packages: Vec<ExternalInstallPackage>,
        replace_all: bool,
    ) -> Result<Vec<ExternalPackage>, PackageProblem> {
        if packages.is_empty() && !replace_all {
            return invalid("external install contains no packages");
        }
        let profile = self.profile(profile_id)?;
        if profile.active_revision.is_none() {
            return invalid("profile is not initialized");
        }
        let _operation_lock = self.lock_profile(profile_id)?;
        let content = self.game_directory(profile_id)?.join("content");
        fs::create_dir_all(&content).map_err(|source| io_error(&content, source))?;
        let operation = Uuid::new_v4();
        let operation_root = content
            .parent()
            .expect("content directory has parent")
            .join(format!(".vlauncher-external-{operation}"));
        let staging = operation_root.join("staging");
        let backup = operation_root.join("backup");
        fs::create_dir_all(&staging).map_err(|source| io_error(&staging, source))?;
        fs::create_dir_all(&backup).map_err(|source| io_error(&backup, source))?;

        let result = (|| {
            let existing = self.read_external_packages(profile_id)?;
            let vspace_ids = profile
                .packages
                .iter()
                .map(|package| package.id.as_str())
                .collect::<HashSet<_>>();
            let external_ids = existing
                .iter()
                .map(|package| package.id.as_str())
                .collect::<HashSet<_>>();
            let mut incoming_ids = HashSet::new();
            let mut incoming_projects = HashSet::new();
            for item in &packages {
                let record = &item.package;
                let manifest = &item.artifact.manifest;
                if record.source != "voxelworld"
                    || record.id != manifest.id
                    || !matches!(manifest.kind, PackageKind::Mod | PackageKind::Library)
                    || !incoming_ids.insert(record.id.clone())
                    || !incoming_projects.insert((record.source.clone(), record.project_id))
                {
                    return invalid("invalid external package identity");
                }
                if vspace_ids.contains(record.id.as_str()) {
                    return invalid(format!(
                        "external package '{}' conflicts with a VSpace package",
                        record.id
                    ));
                }
                if content.join(&record.id).exists() && !external_ids.contains(record.id.as_str()) {
                    return invalid(format!(
                        "local package '{}' already exists in this profile",
                        record.id
                    ));
                }
                if !verify_file(
                    &item.artifact.path,
                    &item.artifact.sha256,
                    item.artifact.size,
                )? {
                    return invalid(format!("external archive '{}' changed", record.id));
                }
                let destination = staging.join(&record.id);
                fs::create_dir_all(&destination)
                    .map_err(|source| io_error(&destination, source))?;
                let archive = fs::File::open(&item.artifact.path)
                    .map_err(|source| io_error(&item.artifact.path, source))?;
                extract_archive(archive, &destination)?;
                let extracted = PackageManifest::read(&destination)?;
                if extracted != *manifest {
                    return invalid(format!("external package '{}' changed", record.id));
                }
            }

            let mut available = profile
                .packages
                .iter()
                .map(|package| package.id.clone())
                .chain(
                    existing
                        .iter()
                        .filter(|_| !replace_all)
                        .map(|package| package.id.clone()),
                )
                .chain(profile.manual_packages.iter().cloned())
                .chain(packages.iter().map(|item| item.package.id.clone()))
                .collect::<HashSet<_>>();
            for replaced in &packages {
                for old in &existing {
                    if old.source == replaced.package.source
                        && old.project_id == replaced.package.project_id
                        && old.id != replaced.package.id
                    {
                        available.remove(&old.id);
                    }
                }
            }
            for item in &packages {
                for dependency in &item.artifact.manifest.dependencies {
                    if dependency.kind == DependencyKind::Required
                        && !available.contains(&dependency.id)
                    {
                        return invalid(format!(
                            "external package '{}' requires '{}'",
                            item.package.id, dependency.id
                        ));
                    }
                }
                for conflict in &item.artifact.manifest.conflicts {
                    if available.contains(&conflict.id) {
                        return invalid(format!(
                            "external package '{}' conflicts with '{}'",
                            item.package.id, conflict.id
                        ));
                    }
                }
            }

            let replaced = existing
                .iter()
                .filter(|old| {
                    replace_all
                        || packages.iter().any(|item| {
                            item.package.id == old.id
                                || item.package.source == old.source
                                    && item.package.project_id == old.project_id
                        })
                })
                .map(|package| package.id.clone())
                .chain(packages.iter().map(|item| item.package.id.clone()))
                .collect::<HashSet<_>>();
            let mut backed_up = Vec::new();
            for id in &replaced {
                let current = content.join(id);
                if current.exists() {
                    if let Err(source) = fs::rename(&current, backup.join(id)) {
                        for saved_id in &backed_up {
                            let _ = fs::rename(backup.join(saved_id), content.join(saved_id));
                        }
                        return Err(io_error(&current, source));
                    }
                    backed_up.push(id.clone());
                }
            }

            let mut installed = Vec::new();
            let install_result = (|| {
                for item in &packages {
                    let source = staging.join(&item.package.id);
                    let destination = content.join(&item.package.id);
                    fs::rename(&source, &destination)
                        .map_err(|error| io_error(&destination, error))?;
                    installed.push(item.package.id.clone());
                }
                let mut next = existing
                    .into_iter()
                    .filter(|old| !replaced.contains(&old.id))
                    .collect::<Vec<_>>();
                next.extend(packages.iter().map(|item| item.package.clone()));
                next.sort_by(|left, right| left.title.cmp(&right.title));
                self.write_external_packages(profile_id, &next)?;
                Ok(next)
            })();
            match install_result {
                Ok(next) => Ok(next),
                Err(error) => {
                    for id in installed {
                        let path = content.join(id);
                        if path.exists() {
                            let _ = fs::remove_dir_all(path);
                        }
                    }
                    for id in &backed_up {
                        let saved = backup.join(id);
                        if saved.exists() {
                            let _ = fs::rename(&saved, content.join(id));
                        }
                    }
                    Err(error)
                }
            }
        })();
        if staging.exists() {
            let _ = fs::remove_dir_all(&staging);
        }
        if backup.exists() {
            let _ = fs::remove_dir_all(&backup);
        }
        if operation_root.exists() {
            let _ = fs::remove_dir_all(&operation_root);
        }
        result
    }

    pub fn remove_external_package(
        &self,
        profile_id: Uuid,
        id: &str,
    ) -> Result<(), PackageProblem> {
        let _operation_lock = self.lock_profile(profile_id)?;
        let existing = self.read_external_packages(profile_id)?;
        if !existing.iter().any(|package| package.id == id) {
            return invalid("external package is not installed");
        }
        let content = self.game_directory(profile_id)?.join("content");
        for package in existing.iter().filter(|package| package.id != id) {
            let manifest = PackageManifest::read(content.join(&package.id))?;
            if manifest.dependencies.iter().any(|dependency| {
                dependency.kind == DependencyKind::Required && dependency.id == id
            }) {
                return invalid(format!(
                    "external package '{}' is required by '{}'",
                    id, package.title
                ));
            }
        }
        let source = content.join(id);
        let temporary = content
            .parent()
            .expect("content directory has parent")
            .join(format!(".vlauncher-external-remove-{}", Uuid::new_v4()));
        if source.exists() {
            fs::rename(&source, &temporary).map_err(|error| io_error(&source, error))?;
        }
        let next = existing
            .into_iter()
            .filter(|package| package.id != id)
            .collect::<Vec<_>>();
        if let Err(error) = self.write_external_packages(profile_id, &next) {
            if temporary.exists() {
                let _ = fs::rename(&temporary, &source);
            }
            return Err(error);
        }
        if temporary.exists() {
            fs::remove_dir_all(&temporary).map_err(|error| io_error(&temporary, error))?;
        }
        Ok(())
    }

    fn apply_with_metadata(
        &self,
        profile_id: Uuid,
        plan: &InstallPlan,
        metadata: &ProfileSnapshotMetadata,
    ) -> Result<(), PackageProblem> {
        if plan.revision.is_empty() {
            return invalid("install plan revision is empty");
        }
        let operation_id = Uuid::new_v4();
        let profile_path = self.profile_path(profile_id);
        if !profile_path.is_dir() {
            return invalid("profile does not exist");
        }
        let _operation_lock = self.lock_profile(profile_id)?;
        let compressed = plan
            .packages
            .iter()
            .map(|package| package.artifact_size)
            .sum::<u64>();
        if compressed > 0 {
            ensure_space(&self.root, compressed.saturating_mul(3))?;
        }
        let staging = profile_path.join(format!(".staging-{operation_id}"));
        fs::create_dir_all(staging.join("content")).map_err(|source| io_error(&staging, source))?;
        let result = self.stage_packages(plan, &staging);
        if let Err(error) = result {
            let _ = fs::remove_dir_all(&staging);
            self.record_operation(
                operation_id,
                profile_id,
                "install",
                &plan.revision,
                "failed",
            )?;
            return Err(error);
        }
        let lock = serde_json::to_vec_pretty(plan)
            .map_err(|error| PackageProblem::Invalid(error.to_string()))?;
        fs::write(staging.join("vlauncher.lock.json"), lock)
            .map_err(|source| io_error(&staging, source))?;
        let metadata_bytes = serde_json::to_vec_pretty(metadata)
            .map_err(|error| PackageProblem::Invalid(error.to_string()))?;
        fs::write(staging.join("profile-metadata.json"), metadata_bytes)
            .map_err(|source| io_error(&staging, source))?;
        let snapshot = profile_path.join("snapshots").join(&plan.revision);
        if snapshot.exists() {
            // Повторный запрос может прийти для уже активной ревизии.
            fs::remove_dir_all(&staging).map_err(|source| io_error(&staging, source))?;
        } else {
            fs::rename(&staging, &snapshot).map_err(|source| io_error(&staging, source))?;
        }
        if let Err(error) = self.materialize_game_folder_locked(profile_id, &plan.revision) {
            self.record_operation(
                operation_id,
                profile_id,
                "install",
                &plan.revision,
                "failed",
            )?;
            return Err(error);
        }
        let roots = serde_json::to_string(&metadata.roots)
            .map_err(|error| PackageProblem::Invalid(error.to_string()))?;
        let root_requirements = serde_json::to_string(&metadata.root_requirements)
            .map_err(|error| PackageProblem::Invalid(error.to_string()))?;
        self.with_database(|database| {
            let transaction = database.unchecked_transaction()?;
            let (active, previous): (Option<String>, Option<String>) = transaction.query_row(
                "SELECT active_revision, previous_revision FROM profiles WHERE id = ?1",
                [profile_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let next_previous = if active.as_deref() == Some(plan.revision.as_str()) {
                previous
            } else {
                active
            };
            transaction.execute(
                "UPDATE profiles SET previous_revision = ?1, active_revision = ?2,
                 voxelcore_version = ?3, roots_json = ?4,
                 root_requirements_json = ?5 WHERE id = ?6",
                params![
                    next_previous,
                    plan.revision,
                    metadata.voxelcore_version,
                    roots,
                    root_requirements,
                    profile_id.to_string()
                ],
            )?;
            transaction.execute(
                "INSERT INTO operations (id, profile_id, kind, revision, status, created_at)
                 VALUES (?1, ?2, 'install', ?3, 'complete', ?4)",
                params![
                    operation_id.to_string(),
                    profile_id.to_string(),
                    plan.revision,
                    timestamp()
                ],
            )?;
            transaction.commit()
        })?;
        Ok(())
    }

    pub fn apply_remote(
        &self,
        profile_id: Uuid,
        plan: &RemoteInstallPlan,
    ) -> Result<(), PackageProblem> {
        self.apply_remote_with_progress(profile_id, plan, |_, _, _| true)
    }

    pub fn apply_remote_with_progress(
        &self,
        profile_id: Uuid,
        plan: &RemoteInstallPlan,
        progress: impl Fn(&str, u64, u64) -> bool,
    ) -> Result<(), PackageProblem> {
        let client = Client::builder()
            .user_agent(concat!("VLauncher/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30 * 60))
            .build()
            .map_err(|error| PackageProblem::Invalid(format!("HTTP client error: {error}")))?;
        let mut packages = Vec::with_capacity(plan.packages.len());
        for package in &plan.packages {
            let archive_path = self.fetch_artifact_with_progress(&client, package, &progress)?;
            packages.push(InstallPackage {
                id: package.id.clone(),
                kind: package.kind.clone(),
                version: package.version.clone(),
                artifact_sha256: package.artifact_sha256.clone(),
                artifact_size: package.artifact_size,
                archive_path,
                dependencies: package.dependencies.clone(),
            });
        }
        let previous_metadata = self.profile_metadata(profile_id)?;
        let metadata = ProfileSnapshotMetadata {
            main_build: if previous_metadata
                .main_build
                .as_ref()
                .and_then(|b| b.engine_version.as_deref())
                .or(previous_metadata.voxelcore_version.as_deref())
                == Some(&plan.voxelcore_version)
            {
                previous_metadata.main_build
            } else {
                None
            },
            voxelcore_version: Some(plan.voxelcore_version.clone()),
            roots: plan.roots.clone(),
            root_requirements: plan.root_requirements.clone(),
        };
        self.apply_with_metadata(
            profile_id,
            &InstallPlan {
                // Это настройка профиля, а не самого пакета.
                revision: if metadata.main_build.is_some() {
                    format!("{}-main-{}", plan.revision, Uuid::new_v4())
                } else {
                    plan.revision.clone()
                },
                packages,
            },
            &metadata,
        )
    }

    pub fn apply_signed_remote(
        &self,
        profile_id: Uuid,
        signed: &SignedRemoteInstallPlan,
    ) -> Result<(), PackageProblem> {
        let plan = signed.verify_trusted(timestamp())?;
        self.apply_remote(profile_id, &plan)
    }

    pub fn apply_signed_remote_with_progress(
        &self,
        profile_id: Uuid,
        signed: &SignedRemoteInstallPlan,
        progress: impl Fn(&str, u64, u64) -> bool,
    ) -> Result<(), PackageProblem> {
        let plan = signed.verify_trusted(timestamp())?;
        self.apply_remote_with_progress(profile_id, &plan, progress)
    }

    pub fn clear_profile(&self, profile_id: Uuid) -> Result<(), PackageProblem> {
        let revision = format!("empty-{}", Uuid::new_v4());
        let mut metadata = self.profile_metadata(profile_id)?;
        metadata.roots.clear();
        metadata.root_requirements.clear();
        self.apply_with_metadata(
            profile_id,
            &InstallPlan {
                revision,
                packages: Vec::new(),
            },
            &metadata,
        )
    }

    pub fn export_profile(
        &self,
        profile_id: Uuid,
        path: impl AsRef<Path>,
    ) -> Result<PathBuf, PackageProblem> {
        let profile = self
            .list()?
            .into_iter()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| PackageProblem::Invalid("profile does not exist".into()))?;
        let locked = if let Some(revision) = &profile.active_revision {
            let lock_path = self
                .profile_path(profile_id)
                .join("snapshots")
                .join(revision)
                .join("vlauncher.lock.json");
            let plan: InstallPlan = serde_json::from_slice(
                &fs::read(&lock_path).map_err(|source| io_error(&lock_path, source))?,
            )
            .map_err(|error| {
                PackageProblem::Invalid(format!("invalid profile lockfile: {error}"))
            })?;
            plan.packages
                .into_iter()
                .map(|package| ProfileLockedPackage {
                    id: package.id,
                    version: package.version,
                    artifact_sha256: package.artifact_sha256,
                })
                .collect()
        } else {
            Vec::new()
        };
        let definition = ProfileDefinition {
            main_build: profile.main_build.clone(),
            schema_version: if profile.main_build.is_some() { 3 } else { 2 },
            name: profile.name,
            voxelcore_version: profile
                .main_build
                .as_ref()
                .and_then(|b| b.engine_version.clone())
                .or(profile.voxelcore_version)
                .ok_or_else(|| {
                    PackageProblem::Invalid("profile has no VoxelCore version".into())
                })?,
            roots: profile.roots,
            locked,
        };
        semver::Version::parse(&definition.voxelcore_version)
            .map_err(|_| PackageProblem::Invalid("profile has no VoxelCore version".into()))?;
        let path = path.as_ref();
        let bytes = serde_json::to_vec_pretty(&definition)
            .map_err(|error| PackageProblem::Invalid(error.to_string()))?;
        write_atomic(path, &[bytes.as_slice(), b"\n"].concat())?;
        Ok(path.to_owned())
    }

    pub fn prepare_modpack(
        &self,
        profile_id: Uuid,
        slug: &str,
        title: &str,
        version: &str,
        creator: &str,
        license: &str,
        output_folder: impl AsRef<Path>,
    ) -> Result<PreparedArtifact, PackageProblem> {
        let profile = self.profile(profile_id)?;
        if profile.main_build.is_some() {
            return invalid("a modpack cannot use a temporary main build");
        }
        if !profile.manual_packages.is_empty() {
            return invalid("a modpack cannot include manually installed packages");
        }
        if profile
            .external_packages
            .iter()
            .any(|package| package.artifact_size == 0)
        {
            return invalid("reinstall VoxelWorld packages before creating a modpack");
        }
        let engine = profile
            .main_build
            .as_ref()
            .and_then(|build| build.engine_version.as_deref())
            .or(profile.voxelcore_version.as_deref())
            .ok_or_else(|| PackageProblem::Invalid("profile has no VoxelCore version".into()))?;
        let dependencies = profile
            .packages
            .iter()
            .filter(|package| package.id != slug)
            .map(|package| {
                serde_json::json!({
                    "id": package.id,
                    "requirement": format!("={}", package.version),
                    "kind": "required"
                })
            })
            .collect::<Vec<_>>();
        let external_packages = profile
            .external_packages
            .iter()
            .map(|package| crate::ExternalPackageLock {
                source: package.source.clone(),
                id: package.id.clone(),
                title: package.title.clone(),
                project_id: package.project_id,
                slug: package.slug.clone(),
                version_id: package.version_id,
                version: package.version.clone(),
                artifact_sha256: package.artifact_sha256.clone(),
                artifact_size: package.artifact_size,
            })
            .collect::<Vec<_>>();
        let output_folder = output_folder.as_ref();
        fs::create_dir_all(output_folder).map_err(|source| io_error(output_folder, source))?;
        let source = output_folder.join(format!(".modpack-source-{}", Uuid::new_v4()));
        fs::create_dir_all(&source).map_err(|error| io_error(&source, error))?;
        let result = (|| {
            let manifest = serde_json::json!({
                "schema_version": 1,
                "id": slug,
                "type": "modpack",
                "title": title,
                "version": version,
                "creators": [creator],
                "description": format!("Сборка профиля {}", profile.name),
                "license": license,
                "voxelcore": format!("={engine}"),
                "dependencies": dependencies,
                "external_packages": external_packages,
                "capabilities": [],
                "environments": ["client"]
            });
            fs::write(
                source.join("package.json"),
                serde_json::to_vec_pretty(&manifest)
                    .map_err(|error| PackageProblem::Invalid(error.to_string()))?,
            )
            .map_err(|error| io_error(&source, error))?;
            if let Some(icon) = profile.icon.as_deref() {
                let encoded = icon
                    .strip_prefix("data:image/png;base64,")
                    .ok_or_else(|| PackageProblem::Invalid("profile icon must be PNG".into()))?;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| PackageProblem::Invalid("invalid profile icon".into()))?;
                fs::write(source.join("icon.png"), bytes)
                    .map_err(|error| io_error(&source, error))?;
            }
            let config = self.game_directory(profile_id)?.join("config");
            if config.is_dir() {
                copy_tree(&config, &source.join("config"))?;
            }
            prepare_package(&source, output_folder)
        })();
        let _ = fs::remove_dir_all(&source);
        result
    }

    pub fn prepare_world_package(
        &self,
        profile_id: Uuid,
        folder: &str,
        slug: &str,
        title: &str,
        version: &str,
        creator: &str,
        license: &str,
        output_folder: impl AsRef<Path>,
    ) -> Result<PreparedArtifact, PackageProblem> {
        let relative = Path::new(folder);
        safe_relative(relative)?;
        if relative.components().count() != 1 {
            return invalid("world folder must be a single directory name");
        }
        let profile = self.profile(profile_id)?;
        let world = self
            .game_directory(profile_id)?
            .join("worlds")
            .join(relative);
        if !world.join("world.json").is_file() {
            return invalid("world does not contain world.json");
        }
        let engine = profile
            .voxelcore_version
            .as_deref()
            .ok_or_else(|| PackageProblem::Invalid("profile has no VoxelCore version".into()))?;
        let installed = profile
            .packages
            .iter()
            .map(|package| (package.id.as_str(), package.version.as_str()))
            .collect::<HashMap<_, _>>();
        let dependencies = fs::read_to_string(world.join("packs.list"))
            .unwrap_or_default()
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .filter_map(|id| installed.get(id).map(|version| (id, *version)))
            .map(|(id, version)| {
                serde_json::json!({
                    "id": id, "requirement": format!("={version}"), "kind": "required"
                })
            })
            .collect::<Vec<_>>();
        let output_folder = output_folder.as_ref();
        fs::create_dir_all(output_folder).map_err(|source| io_error(output_folder, source))?;
        let source = output_folder.join(format!(".world-source-{}", Uuid::new_v4()));
        let packaged_world = source.join("world");
        fs::create_dir_all(&packaged_world).map_err(|error| io_error(&packaged_world, error))?;
        let result = (|| {
            copy_world_for_publication(&world, &packaged_world)?;
            let manifest = serde_json::json!({
                "schema_version": 1, "id": slug, "type": "world", "title": title,
                "version": version, "creators": [creator],
                "description": format!("Карта из профиля {}", profile.name),
                "license": license, "voxelcore": format!("={engine}"),
                "dependencies": dependencies, "capabilities": [], "environments": ["client"]
            });
            fs::write(
                source.join("package.json"),
                serde_json::to_vec_pretty(&manifest)
                    .map_err(|error| PackageProblem::Invalid(error.to_string()))?,
            )
            .map_err(|error| io_error(&source, error))?;
            prepare_package(&source, output_folder)
        })();
        let _ = fs::remove_dir_all(&source);
        result
    }

    pub fn read_profile_definition(
        path: impl AsRef<Path>,
    ) -> Result<ProfileDefinition, PackageProblem> {
        let path = path.as_ref();
        let definition: ProfileDefinition =
            serde_json::from_slice(&fs::read(path).map_err(|source| io_error(path, source))?)
                .map_err(|error| {
                    PackageProblem::Invalid(format!("invalid profile file: {error}"))
                })?;
        if !matches!(definition.schema_version, 1 | 2 | 3)
            || definition.name.trim().is_empty()
            || definition.name.chars().count() > 80
            || definition.roots.len() > 128
            || definition.locked.len() > 512
            || definition.roots.iter().any(|root| {
                root.len() < 2
                    || root.len() > 24
                    || !root.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'
                    })
            })
            || definition.locked.iter().any(|package| {
                package.id.len() < 2
                    || package.id.len() > 24
                    || !package.id.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'
                    })
                    || semver::Version::parse(&package.version).is_err()
                    || package.artifact_sha256.len() != 64
                    || !package
                        .artifact_sha256
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit())
            })
        {
            return invalid("profile definition is invalid");
        }
        semver::Version::parse(&definition.voxelcore_version).map_err(|error| {
            PackageProblem::Invalid(format!("invalid VoxelCore version: {error}"))
        })?;
        if let Some(build) = &definition.main_build {
            build.validate().map_err(PackageProblem::Invalid)?;
        }
        Ok(definition)
    }

    pub fn install_signed_runtime(
        &self,
        signed: &SignedRemoteInstallPlan,
    ) -> Result<InstalledRuntime, PackageProblem> {
        self.install_signed_runtime_with_progress(signed, |_, _, _| true)
    }

    pub fn install_signed_runtime_with_progress(
        &self,
        signed: &SignedRemoteInstallPlan,
        progress: impl Fn(&str, u64, u64) -> bool,
    ) -> Result<InstalledRuntime, PackageProblem> {
        let plan = signed.verify_trusted(timestamp())?;
        let _operation_lock = self.lock_runtime_store()?;
        let root_id = plan
            .roots
            .first()
            .ok_or_else(|| PackageProblem::Invalid("runtime plan has no root package".into()))?;
        let package = plan
            .packages
            .iter()
            .find(|package| &package.id == root_id)
            .ok_or_else(|| PackageProblem::Invalid("runtime root is absent from plan".into()))?;
        let client = Client::builder()
            .user_agent(concat!("VLauncher/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30 * 60))
            .build()
            .map_err(|error| PackageProblem::Invalid(format!("HTTP client error: {error}")))?;
        let archive = self.fetch_artifact_with_progress(&client, package, &progress)?;
        let temporary = self
            .root
            .join("runtimes")
            .join(format!(".staging-{}", Uuid::new_v4()));
        fs::create_dir_all(&temporary).map_err(|source| io_error(&temporary, source))?;
        let result = (|| {
            ensure_space(&self.root, package.artifact_size.saturating_mul(3))?;
            let file = fs::File::open(&archive).map_err(|source| io_error(&archive, source))?;
            extract_archive(file, &temporary)?;
            let metadata_path = temporary.join("runtime.json");
            let metadata: RuntimeManifest = serde_json::from_slice(
                &fs::read(&metadata_path).map_err(|source| io_error(&metadata_path, source))?,
            )
            .map_err(|error| PackageProblem::Invalid(format!("invalid runtime.json: {error}")))?;
            if metadata.schema_version != 1
                || metadata.version != package.version
                || metadata.platform != std::env::consts::OS
                || metadata.architecture != std::env::consts::ARCH
            {
                return invalid("runtime package is incompatible with this system");
            }
            safe_relative(&metadata.executable)?;
            safe_relative(&metadata.resources)?;
            let executable = temporary.join(&metadata.executable);
            if !executable.is_file() || !temporary.join(&metadata.resources).is_dir() {
                return invalid("runtime executable or resources are missing");
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
                    .map_err(|source| io_error(&executable, source))?;
            }
            let destination = self.root.join("runtimes").join(format!(
                "{}-{}-{}",
                metadata.version, metadata.platform, metadata.architecture
            ));
            let backup = self
                .root
                .join("runtimes")
                .join(format!(".previous-{}", Uuid::new_v4()));
            if destination.exists() {
                fs::rename(&destination, &backup)
                    .map_err(|source| io_error(&destination, source))?;
            }
            fs::create_dir_all(destination.parent().expect("runtime has parent"))
                .map_err(|source| io_error(&destination, source))?;
            if let Err(source) = fs::rename(&temporary, &destination) {
                if backup.exists() {
                    let _ = fs::rename(&backup, &destination);
                }
                return Err(io_error(&destination, source));
            }
            if backup.exists() {
                fs::remove_dir_all(&backup).map_err(|source| io_error(&backup, source))?;
            }
            Ok(InstalledRuntime {
                main_build: read_main_build(&destination)?,
                version: metadata.version,
                platform: metadata.platform,
                architecture: metadata.architecture,
                path: destination,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&temporary);
        }
        result
    }

    pub fn list_runtimes(&self) -> Result<Vec<InstalledRuntime>, PackageProblem> {
        let folder = self.root.join("runtimes");
        fs::create_dir_all(&folder).map_err(|source| io_error(&folder, source))?;
        let mut runtimes = Vec::new();
        for entry in fs::read_dir(&folder).map_err(|source| io_error(&folder, source))? {
            let path = entry.map_err(|source| io_error(&folder, source))?.path();
            if !path.is_dir()
                || path
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with('.'))
            {
                continue;
            }
            let metadata_path = path.join("runtime.json");
            let Ok(bytes) = fs::read(&metadata_path) else {
                continue;
            };
            let Ok(metadata) = serde_json::from_slice::<RuntimeManifest>(&bytes) else {
                continue;
            };
            runtimes.push(InstalledRuntime {
                main_build: read_main_build(&path)?,
                version: metadata.version,
                platform: metadata.platform,
                architecture: metadata.architecture,
                path,
            });
        }
        runtimes.sort_by(|left, right| right.version.cmp(&left.version));
        Ok(runtimes)
    }

    pub fn analyze_existing_game(
        &self,
        source: impl AsRef<Path>,
    ) -> Result<ExistingGameAnalysis, PackageProblem> {
        analyze_existing_game_directory(source.as_ref())
    }

    pub fn attach_existing_game(
        &self,
        source: impl AsRef<Path>,
        name: &str,
        version: &str,
    ) -> Result<Profile, PackageProblem> {
        semver::Version::parse(version).map_err(|error| {
            PackageProblem::Invalid(format!("invalid VoxelCore version: {error}"))
        })?;
        let source =
            fs::canonicalize(source.as_ref()).map_err(|error| io_error(source.as_ref(), error))?;
        let analysis = analyze_existing_game_directory(&source)?;
        if analysis
            .runtime_version
            .as_deref()
            .is_some_and(|detected| detected != version)
        {
            return invalid("selected VoxelCore version does not match the detected version");
        }
        if analysis.runtime_kind == ExistingRuntimeKind::None
            && analysis.content_count == 0
            && analysis.world_count == 0
            && !analysis.has_config
        {
            return invalid("directory does not contain VoxelCore or profile data");
        }

        let data_root = existing_game_data_root(&source);
        let data_root =
            fs::canonicalize(&data_root).map_err(|error| io_error(&data_root, error))?;
        let duplicate = self.with_database(|database| {
            database.query_row(
                "SELECT EXISTS(SELECT 1 FROM profiles WHERE external_game_path = ?1)",
                [data_root.to_string_lossy().as_ref()],
                |row| row.get::<_, bool>(0),
            )
        })?;
        if duplicate {
            return invalid("this game directory is already attached to a profile");
        }

        let external_runtime = match analysis.runtime_kind {
            ExistingRuntimeKind::Manifest => {
                let path = source.join("runtime.json");
                let manifest: RuntimeManifest = serde_json::from_slice(
                    &fs::read(&path).map_err(|error| io_error(&path, error))?,
                )
                .map_err(|error| {
                    PackageProblem::Invalid(format!("invalid runtime.json: {error}"))
                })?;
                Some(ExternalRuntime {
                    path: source.clone(),
                    executable: manifest.executable,
                    resources: manifest.resources,
                })
            }
            ExistingRuntimeKind::Detected => {
                let (executable, resources) = crate::official::detect_runtime_layout(&source)
                    .map_err(PackageProblem::Invalid)?;
                Some(ExternalRuntime {
                    path: source.clone(),
                    executable,
                    resources,
                })
            }
            ExistingRuntimeKind::None => {
                if !self
                    .list_runtimes()?
                    .iter()
                    .any(|runtime| runtime.version == version)
                {
                    return invalid(format!(
                        "VoxelCore {version} must be installed before attaching this directory"
                    ));
                }
                None
            }
        };
        let runtime_json = external_runtime
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| PackageProblem::Invalid(error.to_string()))?;
        let profile = self.create_initialized(name, version)?;
        let result = self.with_database(|database| {
            database.execute(
                "UPDATE profiles SET external_game_path = ?1, external_runtime_json = ?2
                 WHERE id = ?3",
                params![
                    data_root.to_string_lossy().as_ref(),
                    runtime_json,
                    profile.id.to_string()
                ],
            )?;
            Ok(())
        });
        if let Err(error) = result {
            let _ = self.delete_profile(profile.id);
            return Err(error);
        }
        let internal_game = self.profile_path(profile.id).join("game");
        if internal_game.exists() {
            if let Err(error) = fs::remove_dir_all(&internal_game) {
                let _ = self.delete_profile(profile.id);
                return Err(io_error(&internal_game, error));
            }
        }
        self.profile(profile.id)
    }

    pub fn import_runtime(
        &self,
        source: impl AsRef<Path>,
    ) -> Result<InstalledRuntime, PackageProblem> {
        let _operation_lock = self.lock_runtime_store()?;
        let source = source.as_ref();
        if !source.is_dir() {
            return invalid("runtime source must be a directory");
        }
        let metadata_path = source.join("runtime.json");
        let metadata: RuntimeManifest = serde_json::from_slice(
            &fs::read(&metadata_path).map_err(|error| io_error(&metadata_path, error))?,
        )
        .map_err(|error| PackageProblem::Invalid(format!("invalid runtime.json: {error}")))?;
        if metadata.schema_version != 1
            || semver::Version::parse(&metadata.version).is_err()
            || metadata.platform != std::env::consts::OS
            || metadata.architecture != std::env::consts::ARCH
        {
            return invalid("runtime directory is incompatible with this system");
        }
        safe_relative(&metadata.executable)?;
        safe_relative(&metadata.resources)?;
        if !source.join(&metadata.executable).is_file()
            || !source.join(&metadata.resources).is_dir()
        {
            return invalid("runtime executable or resources are missing");
        }
        if let Some(build) = read_main_build(source)? {
            if metadata.version != build.runtime_id()
                || metadata.platform != build.platform
                || metadata.architecture != build.architecture
            {
                return invalid("runtime identity does not match its main build metadata");
            }
        }

        let temporary = self
            .root
            .join("runtimes")
            .join(format!(".import-{}", Uuid::new_v4()));
        let result = (|| {
            copy_tree(source, &temporary)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let executable = temporary.join(&metadata.executable);
                fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
                    .map_err(|error| io_error(&executable, error))?;
            }
            let destination = self.root.join("runtimes").join(format!(
                "{}-{}-{}",
                metadata.version, metadata.platform, metadata.architecture
            ));
            let backup = self
                .root
                .join("runtimes")
                .join(format!(".previous-{}", Uuid::new_v4()));
            if destination.exists() {
                fs::rename(&destination, &backup).map_err(|error| io_error(&destination, error))?;
            }
            if let Err(error) = fs::rename(&temporary, &destination) {
                if backup.exists() {
                    let _ = fs::rename(&backup, &destination);
                }
                return Err(io_error(&destination, error));
            }
            if backup.exists() {
                fs::remove_dir_all(&backup).map_err(|error| io_error(&backup, error))?;
            }
            Ok(InstalledRuntime {
                main_build: read_main_build(&destination)?,
                version: metadata.version,
                platform: metadata.platform,
                architecture: metadata.architecture,
                path: destination,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&temporary);
        }
        result
    }

    pub fn remove_runtime(&self, version: &str) -> Result<(), PackageProblem> {
        let _operation_lock = self.lock_runtime_store()?;
        semver::Version::parse(version).map_err(|e| PackageProblem::Invalid(e.to_string()))?;
        if self.list()?.iter().any(|profile| {
            profile.voxelcore_version.as_deref() == Some(version)
                || profile
                    .main_build
                    .as_ref()
                    .is_some_and(|b| b.runtime_id() == version)
        }) {
            return invalid("VoxelCore version is still used by a profile");
        }
        let destination = self.root.join("runtimes").join(format!(
            "{}-{}-{}",
            version,
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
        if !destination.is_dir() {
            return invalid("VoxelCore runtime is not installed");
        }
        fs::remove_dir_all(&destination).map_err(|source| io_error(&destination, source))
    }

    pub fn cache_status(&self) -> Result<CacheStatus, PackageProblem> {
        let folder = self.root.join("cache/blobs");
        let mut status = CacheStatus {
            artifacts: 0,
            artifact_bytes: 0,
            partial_downloads: 0,
            partial_bytes: 0,
        };
        for entry in fs::read_dir(&folder).map_err(|source| io_error(&folder, source))? {
            let entry = entry.map_err(|source| io_error(&folder, source))?;
            if !entry
                .file_type()
                .map_err(|source| io_error(&entry.path(), source))?
                .is_file()
            {
                continue;
            }
            let size = entry
                .metadata()
                .map_err(|source| io_error(&entry.path(), source))?
                .len();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".part") {
                status.partial_downloads += 1;
                status.partial_bytes += size;
            } else if valid_digest_name(&name) {
                status.artifacts += 1;
                status.artifact_bytes += size;
            }
        }
        Ok(status)
    }

    pub fn profile_storage(&self, profile_id: Uuid) -> Result<ProfileStorage, PackageProblem> {
        let attached = self.profile(profile_id)?.external_game_path.is_some();
        let profile = self.profile_path(profile_id);
        let game_bytes = tree_size(&self.game_directory(profile_id)?)?;
        let snapshots = profile.join("snapshots");
        let (active, previous): (Option<String>, Option<String>) =
            self.with_database(|database| {
                database.query_row(
                    "SELECT active_revision, previous_revision FROM profiles WHERE id = ?1",
                    [profile_id.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
            })?;
        let mut snapshot_bytes = 0;
        let mut reclaimable_bytes = 0;
        let mut snapshot_count = 0;
        for entry in fs::read_dir(&snapshots).map_err(|source| io_error(&snapshots, source))? {
            let entry = entry.map_err(|source| io_error(&snapshots, source))?;
            if !entry
                .file_type()
                .map_err(|source| io_error(&entry.path(), source))?
                .is_dir()
            {
                continue;
            }
            snapshot_count += 1;
            let bytes = tree_size(&entry.path())?;
            snapshot_bytes += bytes;
            let name = entry.file_name().to_string_lossy().into_owned();
            if active.as_deref() != Some(&name) && previous.as_deref() != Some(&name) {
                reclaimable_bytes += bytes;
            }
        }
        Ok(ProfileStorage {
            total_bytes: snapshot_bytes + if attached { 0 } else { game_bytes },
            game_bytes,
            snapshot_bytes,
            reclaimable_bytes,
            snapshot_count,
        })
    }

    pub fn clean_profile_snapshots(
        &self,
        profile_id: Uuid,
    ) -> Result<ProfileStorage, PackageProblem> {
        self.profile(profile_id)?;
        let _operation_lock = self.lock_profile(profile_id)?;
        let (active, previous): (Option<String>, Option<String>) =
            self.with_database(|database| {
                database.query_row(
                    "SELECT active_revision, previous_revision FROM profiles WHERE id = ?1",
                    [profile_id.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
            })?;
        let snapshots = self.profile_path(profile_id).join("snapshots");
        for entry in fs::read_dir(&snapshots).map_err(|source| io_error(&snapshots, source))? {
            let entry = entry.map_err(|source| io_error(&snapshots, source))?;
            if !entry
                .file_type()
                .map_err(|source| io_error(&entry.path(), source))?
                .is_dir()
            {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if active.as_deref() != Some(&name) && previous.as_deref() != Some(&name) {
                fs::remove_dir_all(entry.path())
                    .map_err(|source| io_error(&entry.path(), source))?;
            }
        }
        self.profile_storage(profile_id)
    }

    pub fn clear_cache(&self) -> Result<CacheStatus, PackageProblem> {
        let folder = self.root.join("cache/blobs");
        for entry in fs::read_dir(&folder).map_err(|source| io_error(&folder, source))? {
            let entry = entry.map_err(|source| io_error(&folder, source))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry
                .file_type()
                .map_err(|source| io_error(&entry.path(), source))?
                .is_file()
                && (valid_digest_name(&name) || name.ends_with(".part"))
            {
                fs::remove_file(entry.path()).map_err(|source| io_error(&entry.path(), source))?;
            }
        }
        self.cache_status()
    }

    pub fn launch_spec(
        &self,
        profile_id: Uuid,
        runtime_version: &str,
    ) -> Result<LaunchSpec, PackageProblem> {
        let profile = self
            .list()?
            .into_iter()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| PackageProblem::Invalid("profile does not exist".into()))?;
        let selected_runtime = profile
            .main_build
            .as_ref()
            .map(|b| b.runtime_id())
            .or_else(|| profile.voxelcore_version.clone());
        if selected_runtime
            .as_deref()
            .is_some_and(|version| version != runtime_version)
        {
            return invalid("runtime version does not match this profile");
        }
        let revision = profile
            .active_revision
            .ok_or_else(|| PackageProblem::Invalid("profile has no installed snapshot".into()))?;
        let (runtime_path, executable, resources) = if let Some(runtime) =
            profile.external_runtime.as_ref()
        {
            safe_relative(&runtime.executable)?;
            safe_relative(&runtime.resources)?;
            if !runtime.path.join(&runtime.executable).is_file()
                || !runtime.path.join(&runtime.resources).is_dir()
            {
                return invalid("attached VoxelCore executable or resources are unavailable");
            }
            (
                runtime.path.clone(),
                runtime.executable.clone(),
                runtime.resources.clone(),
            )
        } else {
            let runtime = self
                .list_runtimes()?
                .into_iter()
                .find(|runtime| runtime.version == runtime_version)
                .ok_or_else(|| {
                    PackageProblem::Invalid("VoxelCore runtime is not installed".into())
                })?;
            if !match (&profile.main_build, &runtime.main_build) {
                (Some(expected), Some(actual)) => expected.same_artifact(actual),
                (None, None) => true,
                _ => false,
            } {
                return invalid("runtime identity does not match this profile");
            }
            let metadata_path = runtime.path.join("runtime.json");
            let metadata: RuntimeManifest = serde_json::from_slice(
                &fs::read(&metadata_path).map_err(|source| io_error(&metadata_path, source))?,
            )
            .map_err(|error| PackageProblem::Invalid(format!("invalid runtime.json: {error}")))?;
            (runtime.path, metadata.executable, metadata.resources)
        };
        let user_folder = self.materialize_game_folder(profile_id, &revision)?;
        let logs = self.profile_path(profile_id).join("logs");
        fs::create_dir_all(&logs).map_err(|source| io_error(&logs, source))?;
        // Для неизвестной версии запускаем без дополнительных аргументов.
        let arguments = vec![
            "--res".into(),
            runtime_path.join(&resources).to_string_lossy().into_owned(),
            "--dir".into(),
            user_folder.to_string_lossy().into_owned(),
        ];
        Ok(LaunchSpec {
            executable: runtime_path.join(executable),
            arguments,
            working_directory: runtime_path,
            log_path: logs.join("latest.log"),
        })
    }

    pub fn rollback(&self, profile_id: Uuid) -> Result<String, PackageProblem> {
        let current_metadata = self.profile_metadata(profile_id)?;
        let revision = self.with_database(|database| {
            let transaction = database.unchecked_transaction()?;
            let (active, previous): (Option<String>, Option<String>) = transaction.query_row(
                "SELECT active_revision, previous_revision FROM profiles WHERE id = ?1",
                [profile_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let previous = previous.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
            let metadata_path = self
                .profile_path(profile_id)
                .join("snapshots")
                .join(&previous)
                .join("profile-metadata.json");
            let metadata = fs::read(&metadata_path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<ProfileSnapshotMetadata>(&bytes).ok())
                .unwrap_or_else(|| current_metadata.clone());
            let roots = serde_json::to_string(&metadata.roots)
                .map_err(|_| rusqlite::Error::InvalidParameterName("profile roots".into()))?;
            let root_requirements =
                serde_json::to_string(&metadata.root_requirements).map_err(|_| {
                    rusqlite::Error::InvalidParameterName("profile root requirements".into())
                })?;
            transaction.execute(
                "UPDATE profiles SET active_revision = ?1, previous_revision = ?2,
                 voxelcore_version = ?3, roots_json = ?4,
                 root_requirements_json = ?5 WHERE id = ?6",
                params![
                    previous,
                    active,
                    metadata.voxelcore_version,
                    roots,
                    root_requirements,
                    profile_id.to_string()
                ],
            )?;
            transaction.commit()?;
            Ok(previous)
        })?;
        Ok(revision)
    }

    pub fn active_snapshot(&self, profile_id: Uuid) -> Result<Option<PathBuf>, PackageProblem> {
        let revision = self
            .list()?
            .into_iter()
            .find(|profile| profile.id == profile_id)
            .and_then(|profile| profile.active_revision);
        Ok(revision.map(|value| self.profile_path(profile_id).join("snapshots").join(value)))
    }

    fn materialize_game_folder(
        &self,
        profile_id: Uuid,
        revision: &str,
    ) -> Result<PathBuf, PackageProblem> {
        let _operation_lock = self.lock_profile(profile_id)?;
        self.materialize_game_folder_locked(profile_id, revision)
    }

    fn materialize_game_folder_locked(
        &self,
        profile_id: Uuid,
        revision: &str,
    ) -> Result<PathBuf, PackageProblem> {
        let profile = self.profile_path(profile_id);
        let source = profile.join("snapshots").join(revision).join("content");
        if !source.is_dir() {
            return invalid("active profile snapshot is missing its content directory");
        }
        let game = self.game_directory(profile_id)?;
        fs::create_dir_all(&game).map_err(|source| io_error(&game, source))?;
        let marker = game.join(".vlauncher-revision");
        if fs::read_to_string(&marker).is_ok_and(|installed| installed == revision)
            && game.join("content").is_dir()
        {
            return Ok(game);
        }
        let newly_attached = self.with_database(|database| {
            database.query_row(
                "SELECT external_game_path IS NOT NULL FROM profiles WHERE id = ?1",
                [profile_id.to_string()],
                |row| row.get::<_, bool>(0),
            )
        })? && !marker.exists();
        if newly_attached
            && source
                .read_dir()
                .map_err(|error| io_error(&source, error))?
                .next()
                .is_none()
        {
            fs::create_dir_all(game.join("content")).map_err(|error| io_error(&game, error))?;
            write_atomic(&marker, revision.as_bytes())?;
            return Ok(game);
        }

        let operation_id = Uuid::new_v4();
        ensure_space(&game, tree_size(&source)?.saturating_mul(2))?;
        let staging = game.join(format!(".vlauncher-content-staging-{operation_id}"));
        let previous = game.join(format!(".vlauncher-content-previous-{operation_id}"));
        copy_tree(&source, &staging)?;
        let content = game.join("content");
        // Пользователь мог сам положить сюда другие паки.
        let old_source = fs::read_to_string(&marker)
            .ok()
            .filter(|revision| safe_relative(Path::new(revision)).is_ok())
            .map(|revision| profile.join("snapshots").join(revision).join("content"));
        let preserve = (|| {
            if content.is_dir() {
                for entry in fs::read_dir(&content).map_err(|e| io_error(&content, e))? {
                    let entry = entry.map_err(|e| io_error(&content, e))?;
                    if old_source
                        .as_ref()
                        .is_some_and(|old| old.join(entry.file_name()).exists())
                    {
                        continue;
                    }
                    let target = staging.join(entry.file_name());
                    if target.exists() {
                        return invalid(format!(
                            "Локальный пакет '{}' совпадает с пакетом из каталога. Перенесите локальную копию из папки content перед запуском",
                            entry.file_name().to_string_lossy()
                        ));
                    }
                    let kind = entry.file_type().map_err(|e| io_error(&entry.path(), e))?;
                    if kind.is_symlink() {
                        return invalid(
                            "Локальный контент содержит символическую ссылку. Перенесите её из папки content перед изменением состава",
                        );
                    }
                    if kind.is_dir() {
                        copy_tree(&entry.path(), &target)?;
                    } else {
                        fs::copy(entry.path(), &target).map_err(|e| io_error(&target, e))?;
                    }
                }
            }
            Ok(())
        })();
        if let Err(error) = preserve {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        if content.exists() {
            fs::rename(&content, &previous).map_err(|source| io_error(&content, source))?;
        }
        if let Err(source) = fs::rename(&staging, &content) {
            if previous.exists() {
                let _ = fs::rename(&previous, &content);
            }
            return Err(io_error(&content, source));
        }
        if previous.exists() {
            fs::remove_dir_all(&previous).map_err(|source| io_error(&previous, source))?;
        }
        let templates = profile
            .join("snapshots")
            .join(revision)
            .join("world-templates");
        if templates.is_dir() {
            let worlds = game.join("worlds");
            fs::create_dir_all(&worlds).map_err(|source| io_error(&worlds, source))?;
            for entry in fs::read_dir(&templates).map_err(|source| io_error(&templates, source))? {
                let template = entry.map_err(|source| io_error(&templates, source))?;
                let destination = worlds.join(template.file_name());
                if !destination.exists() {
                    let staging = worlds.join(format!(".world-staging-{}", Uuid::new_v4()));
                    let copied = copy_tree(&template.path().join("world"), &staging);
                    if let Err(error) = copied {
                        let _ = fs::remove_dir_all(&staging);
                        return Err(error);
                    }
                    if let Err(source) = fs::rename(&staging, &destination) {
                        let _ = fs::remove_dir_all(&staging);
                        return Err(io_error(&destination, source));
                    }
                }
            }
        }
        let modpacks = profile.join("snapshots").join(revision).join("modpacks");
        if modpacks.is_dir() {
            for entry in fs::read_dir(&modpacks).map_err(|source| io_error(&modpacks, source))? {
                let defaults = entry
                    .map_err(|source| io_error(&modpacks, source))?
                    .path()
                    .join("config");
                if defaults.is_dir() {
                    copy_tree_missing(&defaults, &game.join("config"))?;
                }
            }
        }
        write_atomic(&marker, revision.as_bytes())?;
        Ok(game)
    }

    fn stage_packages(&self, plan: &InstallPlan, staging: &Path) -> Result<(), PackageProblem> {
        for package in &plan.packages {
            if !verify_file(
                &package.archive_path,
                &package.artifact_sha256,
                package.artifact_size,
            )? {
                return invalid(format!("artifact hash mismatch for '{}'", package.id));
            }
            let cache_path = self.root.join("cache/blobs").join(&package.artifact_sha256);
            if !cache_path.exists() {
                copy_file_atomic(&package.archive_path, &cache_path)?;
            }
            let destination = match package.kind {
                PackageKind::Mod | PackageKind::Library => {
                    staging.join("content").join(&package.id)
                }
                PackageKind::Modpack => staging.join("modpacks").join(&package.id),
                PackageKind::World => staging.join("world-templates").join(&package.id),
                PackageKind::Runtime => {
                    return invalid("runtime packages cannot be installed into a profile");
                }
            };
            fs::create_dir_all(&destination).map_err(|source| io_error(&destination, source))?;
            let archive =
                fs::File::open(&cache_path).map_err(|source| io_error(&cache_path, source))?;
            extract_archive(archive, &destination)?;
            let manifest = PackageManifest::read(&destination)?;
            if (matches!(package.kind, PackageKind::Mod | PackageKind::Library)
                && manifest.id != package.id)
                || manifest.version != package.version
                || manifest.kind != package.kind
            {
                return invalid(format!("artifact identity mismatch for '{}'", package.id));
            }
            if matches!(package.kind, PackageKind::World)
                && !destination.join("world/world.json").is_file()
            {
                return invalid(format!(
                    "world package '{}' must contain world/world.json",
                    package.id
                ));
            }
        }
        Ok(())
    }

    fn fetch_artifact_with_progress(
        &self,
        client: &Client,
        package: &RemoteInstallPackage,
        progress: &dyn Fn(&str, u64, u64) -> bool,
    ) -> Result<PathBuf, PackageProblem> {
        if package.artifact_sha256.len() != 64
            || !package
                .artifact_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return invalid("invalid expected artifact hash");
        }
        let target = self.root.join("cache/blobs").join(&package.artifact_sha256);
        if target.exists() && verify_file(&target, &package.artifact_sha256, package.artifact_size)?
        {
            if !progress(&package.id, package.artifact_size, package.artifact_size) {
                return invalid("download paused by user");
            }
            return Ok(target);
        }
        if target.exists() {
            fs::remove_file(&target).map_err(|source| io_error(&target, source))?;
        }
        let partial = target.with_extension("part");
        let existing = fs::metadata(&partial).map(|value| value.len()).unwrap_or(0);
        if existing > package.artifact_size {
            fs::remove_file(&partial).map_err(|source| io_error(&partial, source))?;
        }
        let offset = fs::metadata(&partial).map(|value| value.len()).unwrap_or(0);
        ensure_space(&self.root, package.artifact_size.saturating_sub(offset))?;
        if !progress(&package.id, offset, package.artifact_size) {
            return invalid("download paused by user");
        }
        let mut request = client.get(&package.download_url).header(
            reqwest::header::USER_AGENT,
            format!(
                "VLauncher/{} ({})",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS
            ),
        );
        if offset > 0 {
            request = request.header(RANGE, format!("bytes={offset}-"));
        }
        let mut response = request.send().map_err(|error| {
            PackageProblem::Invalid(format!("artifact download failed: {error}"))
        })?;
        if !response.status().is_success() {
            return invalid(format!("artifact server returned {}", response.status()));
        }
        let append = offset > 0 && response.status() == StatusCode::PARTIAL_CONTENT;
        let mut options = fs::OpenOptions::new();
        options.create(true).write(true);
        if append {
            options.append(true);
        } else {
            options.truncate(true);
        }
        let mut output = options
            .open(&partial)
            .map_err(|source| io_error(&partial, source))?;
        // Некоторые серверы игнорируют Range и присылают весь файл.
        let mut downloaded = if append { offset } else { 0 };
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = response
                .read(&mut buffer)
                .map_err(|source| io_error(&partial, source))?;
            if read == 0 {
                break;
            }
            downloaded = downloaded.saturating_add(read as u64);
            if downloaded > package.artifact_size {
                let _ = fs::remove_file(&partial);
                return invalid("artifact server sent more data than declared");
            }
            output
                .write_all(&buffer[..read])
                .map_err(|source| io_error(&partial, source))?;
            if !progress(&package.id, downloaded, package.artifact_size) {
                output
                    .sync_all()
                    .map_err(|source| io_error(&partial, source))?;
                return invalid("download paused by user");
            }
        }
        output
            .sync_all()
            .map_err(|source| io_error(&partial, source))?;
        if !verify_file(&partial, &package.artifact_sha256, package.artifact_size)? {
            let _ = fs::remove_file(&partial);
            return invalid(format!("downloaded artifact mismatch for '{}'", package.id));
        }
        fs::rename(&partial, &target).map_err(|source| io_error(&target, source))?;
        Ok(target)
    }

    fn record_operation(
        &self,
        operation_id: Uuid,
        profile_id: Uuid,
        kind: &str,
        revision: &str,
        status: &str,
    ) -> Result<(), PackageProblem> {
        self.with_database(|database| {
            database.execute(
                "INSERT INTO operations (id, profile_id, kind, revision, status, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    operation_id.to_string(),
                    profile_id.to_string(),
                    kind,
                    revision,
                    status,
                    timestamp()
                ],
            )?;
            Ok(())
        })
    }

    fn profile_path(&self, id: Uuid) -> PathBuf {
        let folder = self
            .profile_folders
            .lock()
            .ok()
            .and_then(|folders| folders.get(&id).cloned())
            .unwrap_or_else(|| id.to_string());
        self.root.join("profiles").join(folder)
    }

    fn read_external_packages(
        &self,
        profile_id: Uuid,
    ) -> Result<Vec<ExternalPackage>, PackageProblem> {
        let path = self.profile_path(profile_id).join("external-packages.json");
        if !path.exists() {
            return Ok(Vec::new());
        }
        let bytes = fs::read(&path).map_err(|source| io_error(&path, source))?;
        if bytes.len() > 1024 * 1024 {
            return invalid("external package metadata is too large");
        }
        let packages: Vec<ExternalPackage> = serde_json::from_slice(&bytes).map_err(|error| {
            PackageProblem::Invalid(format!("invalid external package metadata: {error}"))
        })?;
        let mut ids = HashSet::new();
        if packages.iter().any(|package| {
            package.source != "voxelworld"
                || package.slug.is_empty()
                || package.version.is_empty()
                || package.artifact_sha256.len() != 64
                || !package
                    .artifact_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                || !ids.insert(package.id.clone())
                || safe_relative(Path::new(&package.id)).is_err()
        }) {
            return invalid("invalid external package metadata");
        }
        Ok(packages)
    }

    fn write_external_packages(
        &self,
        profile_id: Uuid,
        packages: &[ExternalPackage],
    ) -> Result<(), PackageProblem> {
        let path = self.profile_path(profile_id).join("external-packages.json");
        let bytes = serde_json::to_vec_pretty(packages)
            .map_err(|error| PackageProblem::Invalid(error.to_string()))?;
        write_atomic(&path, &[bytes.as_slice(), b"\n"].concat())
    }

    fn lock_profile(&self, id: Uuid) -> Result<fs::File, PackageProblem> {
        let path = self.profile_path(id).join(".operation.lock");
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|source| io_error(&path, source))?;
        file.try_lock_exclusive().map_err(|_| {
            PackageProblem::Invalid("another profile operation is in progress".into())
        })?;
        Ok(file)
    }

    fn lock_runtime_store(&self) -> Result<fs::File, PackageProblem> {
        let folder = self.root.join("runtimes");
        fs::create_dir_all(&folder).map_err(|source| io_error(&folder, source))?;
        let path = folder.join(".operation.lock");
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|source| io_error(&path, source))?;
        file.try_lock_exclusive().map_err(|_| {
            PackageProblem::Invalid("another VoxelCore operation is in progress".into())
        })?;
        Ok(file)
    }

    fn profile_metadata(
        &self,
        profile_id: Uuid,
    ) -> Result<ProfileSnapshotMetadata, PackageProblem> {
        let (voxelcore_version, roots, root_requirements): (Option<String>, String, String) = self
            .with_database(|database| {
                database.query_row(
                    "SELECT voxelcore_version, roots_json, root_requirements_json
                     FROM profiles WHERE id = ?1",
                    [profile_id.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
            })?;
        let roots = serde_json::from_str(&roots)
            .map_err(|error| PackageProblem::Invalid(format!("invalid profile roots: {error}")))?;
        let root_requirements = serde_json::from_str(&root_requirements).map_err(|error| {
            PackageProblem::Invalid(format!("invalid profile root requirements: {error}"))
        })?;
        Ok(ProfileSnapshotMetadata {
            main_build: self
                .with_database(|database| {
                    database.query_row(
                        "SELECT active_revision FROM profiles WHERE id = ?1",
                        [profile_id.to_string()],
                        |row| row.get::<_, Option<String>>(0),
                    )
                })?
                .map(|revision| self.snapshot_main_build(profile_id, &revision))
                .transpose()?
                .flatten(),
            voxelcore_version,
            roots,
            root_requirements,
        })
    }

    fn snapshot_main_build(
        &self,
        id: Uuid,
        revision: &str,
    ) -> Result<Option<crate::mainline::MainBuild>, PackageProblem> {
        let path = self
            .profile_path(id)
            .join("snapshots")
            .join(revision)
            .join("profile-metadata.json");
        if !path.exists() {
            return Ok(None);
        }
        let metadata: ProfileSnapshotMetadata =
            serde_json::from_slice(&fs::read(&path).map_err(|e| io_error(&path, e))?)
                .map_err(|e| PackageProblem::Invalid(format!("invalid profile metadata: {e}")))?;
        if let Some(build) = &metadata.main_build {
            build.validate().map_err(PackageProblem::Invalid)?;
        }
        Ok(metadata.main_build)
    }

    pub fn select_main_build(
        &self,
        id: Uuid,
        build: Option<crate::mainline::MainBuild>,
    ) -> Result<(), PackageProblem> {
        if let Some(build) = &build {
            build.validate().map_err(PackageProblem::Invalid)?;
        }
        let _lock = self.lock_profile(id)?;
        let profile = self.profile(id)?;
        let active = profile
            .active_revision
            .ok_or_else(|| PackageProblem::Invalid("profile has no installed snapshot".into()))?;
        let mut metadata = self.profile_metadata(id)?;
        if let Some(version) = build
            .as_ref()
            .and_then(|build| build.engine_version.as_ref())
        {
            metadata.voxelcore_version = Some(version.clone());
        }
        if metadata.main_build == build {
            return Ok(());
        }
        metadata.main_build = build;
        let revision = format!("engine-{}", Uuid::new_v4());
        let root = self.profile_path(id).join("snapshots");
        let destination = root.join(&revision);
        let result = (|| {
            copy_tree(&root.join(&active), &destination)?;
            let path = destination.join("profile-metadata.json");
            fs::write(
                &path,
                serde_json::to_vec_pretty(&metadata)
                    .map_err(|e| PackageProblem::Invalid(e.to_string()))?,
            )
            .map_err(|e| io_error(&path, e))?;
            let path = destination.join("vlauncher.lock.json");
            let mut plan: InstallPlan =
                serde_json::from_slice(&fs::read(&path).map_err(|e| io_error(&path, e))?)
                    .map_err(|e| PackageProblem::Invalid(e.to_string()))?;
            plan.revision = revision.clone();
            fs::write(
                &path,
                serde_json::to_vec_pretty(&plan)
                    .map_err(|e| PackageProblem::Invalid(e.to_string()))?,
            )
            .map_err(|e| io_error(&path, e))?;
            self.with_database(|database| {
                database.execute("UPDATE profiles SET previous_revision = active_revision, active_revision = ?1, voxelcore_version = ?2 WHERE id = ?3", params![revision, metadata.voxelcore_version, id.to_string()])?;
                Ok(())
            })
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&destination);
        }
        result
    }

    fn with_database<T>(
        &self,
        action: impl FnOnce(&mut Connection) -> rusqlite::Result<T>,
    ) -> Result<T, PackageProblem> {
        let path = self.root.join("launcher.sqlite3");
        let mut connection = Connection::open(&path)
            .map_err(|error| PackageProblem::Invalid(format!("local database error: {error}")))?;
        action(&mut connection)
            .map_err(|error| PackageProblem::Invalid(format!("local database error: {error}")))
    }
}

fn read_main_build(path: &Path) -> Result<Option<crate::mainline::MainBuild>, PackageProblem> {
    let source = path.join("main-build.json");
    if !source.exists() {
        return Ok(None);
    }
    let build: crate::mainline::MainBuild =
        serde_json::from_slice(&fs::read(&source).map_err(|e| io_error(&source, e))?)
            .map_err(|e| PackageProblem::Invalid(format!("invalid main build: {e}")))?;
    build.validate().map_err(PackageProblem::Invalid)?;
    Ok(Some(build))
}

fn extract_archive<R: Read + Seek>(reader: R, destination: &Path) -> Result<(), PackageProblem> {
    let mut archive = ZipArchive::new(reader)
        .map_err(|error| PackageProblem::Invalid(format!("invalid ZIP archive: {error}")))?;
    if archive.len() > MAX_FILES {
        return invalid("archive contains too many files");
    }
    let mut unpacked = 0_u64;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|error| PackageProblem::Invalid(error.to_string()))?;
        unpacked = unpacked.saturating_add(file.size());
        if unpacked > MAX_UNPACKED_SIZE {
            return invalid("archive is too large after unpacking");
        }
        if file
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return invalid("archive symlinks are forbidden");
        }
        let enclosed = file
            .enclosed_name()
            .ok_or_else(|| PackageProblem::Invalid("archive path escapes destination".into()))?;
        if enclosed.components().count() > 32
            || enclosed
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return invalid("unsafe archive path");
        }
        let output = destination.join(enclosed);
        if file.is_dir() {
            fs::create_dir_all(&output).map_err(|source| io_error(&output, source))?;
        } else {
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent).map_err(|source| io_error(parent, source))?;
            }
            let mut target =
                fs::File::create(&output).map_err(|source| io_error(&output, source))?;
            std::io::copy(&mut file, &mut target).map_err(|source| io_error(&output, source))?;
        }
    }
    Ok(())
}

fn analyze_existing_game_directory(source: &Path) -> Result<ExistingGameAnalysis, PackageProblem> {
    if !source.is_dir() {
        return invalid("selected path must be a directory");
    }
    let data_root = existing_game_data_root(source);
    let content = data_root.join("content");
    let worlds = data_root.join("worlds");
    let config = data_root.join("config");
    let metadata_path = source.join("runtime.json");
    let (runtime_kind, runtime_version) = if metadata_path.is_file() {
        let metadata: RuntimeManifest = serde_json::from_slice(
            &fs::read(&metadata_path).map_err(|error| io_error(&metadata_path, error))?,
        )
        .map_err(|error| PackageProblem::Invalid(format!("invalid runtime.json: {error}")))?;
        if metadata.schema_version != 1
            || metadata.platform != std::env::consts::OS
            || metadata.architecture != std::env::consts::ARCH
            || semver::Version::parse(&metadata.version).is_err()
        {
            return invalid("runtime directory is incompatible with this system");
        }
        safe_relative(&metadata.executable)?;
        safe_relative(&metadata.resources)?;
        if !source.join(&metadata.executable).is_file()
            || !source.join(&metadata.resources).is_dir()
        {
            return invalid("runtime executable or resources are missing");
        }
        (ExistingRuntimeKind::Manifest, Some(metadata.version))
    } else {
        match crate::official::detect_runtime_layout(source) {
            Ok((executable, _)) => (
                ExistingRuntimeKind::Detected,
                detect_voxelcore_version(source, &executable),
            ),
            Err(_) => (ExistingRuntimeKind::None, None),
        }
    };
    let suggested_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("VoxelCore")
        .to_owned();
    Ok(ExistingGameAnalysis {
        suggested_name,
        runtime_kind,
        runtime_version,
        content_count: immediate_directory_count(&content)?,
        world_count: immediate_directory_count(&worlds)?,
        has_config: config.is_dir(),
    })
}

fn detect_voxelcore_version(root: &Path, executable: &Path) -> Option<String> {
    let mut stdout = tempfile::tempfile().ok()?;
    let mut stderr = tempfile::tempfile().ok()?;
    let mut command = Command::new(root.join(executable));
    command
        .arg("--version")
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout.try_clone().ok()?))
        .stderr(Stdio::from(stderr.try_clone().ok()?));
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut text = String::new();
    stdout.seek(SeekFrom::Start(0)).ok()?;
    stdout.take(128 * 1024).read_to_string(&mut text).ok()?;
    stderr.seek(SeekFrom::Start(0)).ok()?;
    stderr.take(128 * 1024).read_to_string(&mut text).ok()?;
    parse_voxelcore_version(&text)
}

fn parse_voxelcore_version(text: &str) -> Option<String> {
    let mut shortened = None;
    for token in text.split_whitespace() {
        let Some(start) = token.find(|character: char| character.is_ascii_digit()) else {
            continue;
        };
        let candidate = token[start..]
            .trim_end_matches(|character: char| {
                !character.is_ascii_alphanumeric() && !matches!(character, '.' | '-' | '+')
            })
            .trim_end_matches(['.', '-', '+']);
        let core = candidate.split(['-', '+']).next().unwrap_or(candidate);
        let components = core.split('.').count();
        if components >= 3 {
            if let Ok(version) = semver::Version::parse(candidate) {
                return Some(version.to_string());
            }
        } else if components == 2 && shortened.is_none() {
            if let Ok(version) = semver::Version::parse(&format!("{candidate}.0")) {
                shortened = Some(version.to_string());
            }
        }
    }
    shortened
}

fn existing_game_data_root(source: &Path) -> PathBuf {
    let nested = source.join("game");
    if ["content", "worlds", "config"]
        .iter()
        .any(|folder| nested.join(folder).is_dir())
    {
        nested
    } else {
        source.to_owned()
    }
}

fn immediate_directory_count(path: &Path) -> Result<u64, PackageProblem> {
    if !path.is_dir() {
        return Ok(0);
    }
    let mut count = 0u64;
    for entry in fs::read_dir(path).map_err(|error| io_error(path, error))? {
        let entry = entry.map_err(|error| io_error(path, error))?;
        if entry
            .file_type()
            .map_err(|error| io_error(&entry.path(), error))?
            .is_dir()
        {
            count += 1;
        }
    }
    Ok(count)
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), PackageProblem> {
    fs::create_dir_all(destination).map_err(|error| io_error(destination, error))?;
    for entry in walkdir::WalkDir::new(source).follow_links(false) {
        let entry = entry.map_err(|error| PackageProblem::Invalid(error.to_string()))?;
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|error| PackageProblem::Invalid(error.to_string()))?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let target = destination.join(relative);
        if entry.file_type().is_symlink() {
            return invalid("profile snapshot contains a forbidden symbolic link");
        }
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target).map_err(|error| io_error(&target, error))?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
            }
            fs::copy(entry.path(), &target).map_err(|error| io_error(&target, error))?;
        }
    }
    Ok(())
}

fn copy_world_for_publication(source: &Path, destination: &Path) -> Result<(), PackageProblem> {
    for entry in WalkDir::new(source).follow_links(false) {
        let entry = entry.map_err(|error| PackageProblem::Invalid(error.to_string()))?;
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|error| PackageProblem::Invalid(error.to_string()))?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        if entry.file_type().is_symlink() {
            return invalid("world contains a symbolic link");
        }
        let first = relative
            .components()
            .next()
            .and_then(|component| match component {
                Component::Normal(value) => value.to_str(),
                _ => None,
            });
        if first.is_some_and(|name| {
            name == "player.json"
                || name == ".DS_Store"
                || name.starts_with(".vlauncher")
                || name.starts_with(".tmp")
        }) {
            continue;
        }
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target).map_err(|error| io_error(&target, error))?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
            }
            fs::copy(entry.path(), &target).map_err(|error| io_error(&target, error))?;
        }
    }
    Ok(())
}

fn tree_size(path: &Path) -> Result<u64, PackageProblem> {
    if !path.exists() {
        return Ok(0);
    }
    let mut total = 0u64;
    for entry in WalkDir::new(path).follow_links(false) {
        let entry = entry.map_err(|error| PackageProblem::Invalid(error.to_string()))?;
        if entry.file_type().is_symlink() {
            continue;
        }
        if entry.file_type().is_file() {
            total = total.saturating_add(
                entry
                    .metadata()
                    .map_err(|error| PackageProblem::Invalid(error.to_string()))?
                    .len(),
            );
        }
    }
    Ok(total)
}

fn copy_tree_missing(source: &Path, destination: &Path) -> Result<(), PackageProblem> {
    fs::create_dir_all(destination).map_err(|error| io_error(destination, error))?;
    for entry in walkdir::WalkDir::new(source).follow_links(false) {
        let entry = entry.map_err(|error| PackageProblem::Invalid(error.to_string()))?;
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|error| PackageProblem::Invalid(error.to_string()))?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let target = destination.join(relative);
        if entry.file_type().is_symlink() {
            return invalid("package defaults contain a forbidden symbolic link");
        }
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target).map_err(|error| io_error(&target, error))?;
        } else if entry.file_type().is_file() && !target.exists() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
            }
            fs::copy(entry.path(), &target).map_err(|error| io_error(&target, error))?;
        }
    }
    Ok(())
}

fn safe_relative(path: &Path) -> Result<(), PackageProblem> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return invalid("runtime metadata contains an unsafe path");
    }
    Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), PackageProblem> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| io_error(parent, source))?;
    }
    let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
    let mut output = fs::File::create(&temporary).map_err(|source| io_error(&temporary, source))?;
    output
        .write_all(bytes)
        .map_err(|source| io_error(&temporary, source))?;
    output
        .sync_all()
        .map_err(|source| io_error(&temporary, source))?;
    replace_path(&temporary, path)
}

fn copy_file_atomic(source: &Path, destination: &Path) -> Result<(), PackageProblem> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
    }
    let temporary = destination.with_extension(format!("copy-{}", Uuid::new_v4()));
    let result = (|| {
        let mut input = fs::File::open(source).map_err(|error| io_error(source, error))?;
        let mut output =
            fs::File::create(&temporary).map_err(|error| io_error(&temporary, error))?;
        std::io::copy(&mut input, &mut output).map_err(|error| io_error(&temporary, error))?;
        output
            .sync_all()
            .map_err(|error| io_error(&temporary, error))?;
        replace_path(&temporary, destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn replace_path(source: &Path, destination: &Path) -> Result<(), PackageProblem> {
    let backup = destination.with_extension(format!("previous-{}", Uuid::new_v4()));
    if destination.exists() {
        fs::rename(destination, &backup).map_err(|error| io_error(destination, error))?;
    }
    if let Err(error) = fs::rename(source, destination) {
        if backup.exists() {
            let _ = fs::rename(&backup, destination);
        }
        return Err(io_error(destination, error));
    }
    if backup.exists() {
        if backup.is_dir() {
            fs::remove_dir_all(&backup).map_err(|error| io_error(&backup, error))?;
        } else {
            fs::remove_file(&backup).map_err(|error| io_error(&backup, error))?;
        }
    }
    Ok(())
}

fn ensure_space(path: &Path, required: u64) -> Result<(), PackageProblem> {
    let available = fs2::available_space(path).map_err(|error| io_error(path, error))?;
    if available < required {
        return invalid(format!(
            "insufficient disk space: need {required} bytes, {available} bytes available"
        ));
    }
    Ok(())
}

fn verify_file(
    path: &Path,
    expected_hash: &str,
    expected_size: u64,
) -> Result<bool, PackageProblem> {
    let mut file = fs::File::open(path).map_err(|source| io_error(path, source))?;
    if file
        .metadata()
        .map_err(|source| io_error(path, source))?
        .len()
        != expected_size
    {
        return Ok(false);
    }
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|source| io_error(path, source))?;
    Ok(hex::encode(hasher.finalize()) == expected_hash)
}

fn valid_digest_name(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn io_error(path: &Path, source: std::io::Error) -> PackageProblem {
    PackageProblem::Io {
        path: path.to_owned(),
        source,
    }
}

fn invalid<T>(message: impl Into<String>) -> Result<T, PackageProblem> {
    Err(PackageProblem::Invalid(message.into()))
}

fn safe_profile_folder_name(name: &str) -> String {
    let mut folder = String::new();
    let mut replaced = false;
    for character in name.trim().chars() {
        let forbidden = character.is_control()
            || matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            );
        if forbidden {
            if !replaced {
                folder.push('-');
            }
            replaced = true;
        } else {
            folder.push(character);
            replaced = false;
        }
        if folder.chars().count() >= 64 {
            break;
        }
    }
    let mut folder = folder
        .trim_matches(|character| character == ' ' || character == '.' || character == '-')
        .to_owned();
    if folder.is_empty() {
        folder = "Profile".into();
    }
    let stem = folder.split('.').next().unwrap_or_default().to_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|number| {
                matches!(number, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            });
    if reserved {
        folder.push_str(" Profile");
    }
    folder
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
    };
    use zip::write::SimpleFileOptions;

    fn package_archive(folder: &Path, version: &str) -> InstallPackage {
        package_archive_for_environment(folder, version, false)
    }

    fn external_artifact(folder: &Path, version: &str) -> PreparedArtifact {
        let source = folder.join(format!("external-source-{version}"));
        fs::create_dir_all(source.join("scripts")).unwrap();
        fs::create_dir_all(source.join(".git")).unwrap();
        fs::write(source.join("scripts/main.lua"), "return true").unwrap();
        fs::write(source.join(".git/config"), "private metadata").unwrap();
        fs::write(
            source.join("package.json"),
            serde_json::to_vec(&serde_json::json!({
                "schema_version": 1,
                "id": "external_mod",
                "type": "mod",
                "title": "External",
                "version": version,
                "creators": ["Tester"],
                "description": "External package",
                "license": "MIT",
                "voxelcore": ">=0.31.0"
            }))
            .unwrap(),
        )
        .unwrap();
        prepare_package(&source, folder.join("prepared")).unwrap()
    }

    fn package_archive_for_environment(
        folder: &Path,
        version: &str,
        server_compatible: bool,
    ) -> InstallPackage {
        let path = folder.join(format!("demo-{version}.zip"));
        let file = fs::File::create(&path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("package.json", SimpleFileOptions::default())
            .unwrap();
        archive
            .write_all(
                serde_json::to_string(&serde_json::json!({
                    "schema_version": 1,
                    "id": "demo_mod",
                    "type": "mod",
                    "title": "Demo",
                    "version": version,
                    "creators": ["Dagger"],
                    "description": "Demo",
                    "license": "MIT",
                    "voxelcore": ">=0.31.4",
                    "environments": if server_compatible { vec!["client", "server"] } else { vec!["client"] }
                }))
                .unwrap()
                .as_bytes(),
            )
            .unwrap();
        archive
            .start_file("scripts/main.lua", SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"return true\n").unwrap();
        archive.finish().unwrap();
        let bytes = fs::read(&path).unwrap();
        InstallPackage {
            id: "demo_mod".into(),
            kind: PackageKind::Mod,
            version: version.into(),
            artifact_sha256: hex::encode(Sha256::digest(&bytes)),
            artifact_size: bytes.len() as u64,
            archive_path: path,
            dependencies: Vec::new(),
        }
    }

    fn world_archive(folder: &Path) -> InstallPackage {
        let path = folder.join("demo-world.zip");
        let file = fs::File::create(&path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("package.json", SimpleFileOptions::default())
            .unwrap();
        archive
            .write_all(
                serde_json::to_string(&serde_json::json!({
                    "schema_version": 1, "id": "demo_world", "type": "world",
                    "title": "Demo world", "version": "1.0.0", "creators": ["Dagger"],
                    "description": "World", "license": "MIT", "voxelcore": ">=0.31.4"
                }))
                .unwrap()
                .as_bytes(),
            )
            .unwrap();
        archive
            .start_file("world/world.json", SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"{\"title\":\"Demo\"}").unwrap();
        archive
            .start_file("world/regions/0_0.bin", SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"original world").unwrap();
        archive.finish().unwrap();
        let bytes = fs::read(&path).unwrap();
        InstallPackage {
            id: "demo_world".into(),
            kind: PackageKind::World,
            version: "1.0.0".into(),
            artifact_sha256: hex::encode(Sha256::digest(&bytes)),
            artifact_size: bytes.len() as u64,
            archive_path: path,
            dependencies: Vec::new(),
        }
    }

    fn signed_remote_plan(expires_at: i64) -> (SignedRemoteInstallPlan, String) {
        let plan = RemoteInstallPlan {
            revision: "signed-revision".into(),
            issued_at: 1_000,
            expires_at,
            voxelcore_version: "0.31.4".into(),
            roots: vec!["demo_mod".into()],
            root_requirements: HashMap::from([("demo_mod".into(), "=1.0.0".into())]),
            packages: vec![RemoteInstallPackage {
                id: "demo_mod".into(),
                kind: PackageKind::Mod,
                version: "1.0.0".into(),
                artifact_sha256: "a".repeat(64),
                artifact_size: 42,
                download_url: "https://registry.invalid/artifact".into(),
                dependencies: Vec::new(),
            }],
            external_packages: None,
        };
        let signing_key = SigningKey::from_bytes(&[7; 32]);
        let public_key = signing_key.verifying_key().to_bytes();
        let payload = serde_json::to_vec(&plan).unwrap();
        let signature = signing_key.sign(&payload).to_bytes();
        let key_id = hex::encode(Sha256::digest(public_key));
        (
            SignedRemoteInstallPlan {
                plan,
                algorithm: "Ed25519".into(),
                key_id: key_id[..16].into(),
                payload: URL_SAFE_NO_PAD.encode(payload),
                signature: URL_SAFE_NO_PAD.encode(signature),
            },
            URL_SAFE_NO_PAD.encode(public_key),
        )
    }

    #[test]
    fn verifies_signed_remote_plan_before_download() {
        let (signed, public_key) = signed_remote_plan(2_000);
        assert_eq!(
            signed.verify(&public_key, 1_500).unwrap().revision,
            "signed-revision"
        );
    }

    #[test]
    fn rejects_tampered_or_expired_remote_plan() {
        let (mut signed, public_key) = signed_remote_plan(2_000);
        signed.plan.revision = "tampered".into();
        assert!(signed.verify(&public_key, 1_500).is_err());
        let (expired, public_key) = signed_remote_plan(2_000);
        assert!(expired.verify(&public_key, 2_001).is_err());
    }

    #[test]
    fn atomically_installs_and_rolls_back_profile() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let profile = store.create("Main world").unwrap();
        let first = InstallPlan {
            revision: "revision-one".into(),
            packages: vec![package_archive(temp.path(), "1.0.0")],
        };
        store.apply(profile.id, &first).unwrap();
        let second = InstallPlan {
            revision: "revision-two".into(),
            packages: vec![package_archive(temp.path(), "2.0.0")],
        };
        store.apply(profile.id, &second).unwrap();
        assert!(
            store
                .active_snapshot(profile.id)
                .unwrap()
                .unwrap()
                .ends_with("revision-two")
        );
        assert_eq!(store.rollback(profile.id).unwrap(), "revision-one");
    }

    #[test]
    fn external_packages_are_tracked_preserved_and_removed() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let profile = store.create("External content").unwrap();
        store.initialize_vanilla(profile.id, "0.31.4").unwrap();
        let artifact = external_artifact(temp.path(), "1.0.0");
        let record = ExternalPackage {
            id: artifact.manifest.id.clone(),
            source: "voxelworld".into(),
            project_id: 10,
            slug: "external-project".into(),
            version_id: 20,
            version: "1.0.0".into(),
            title: "External project".into(),
            artifact_sha256: artifact.sha256.clone(),
            artifact_size: artifact.size,
        };
        store
            .install_external_packages(
                profile.id,
                vec![ExternalInstallPackage {
                    package: record,
                    artifact,
                }],
            )
            .unwrap();

        let installed = store.list().unwrap().remove(0);
        assert_eq!(installed.external_packages.len(), 1);
        assert!(installed.manual_packages.is_empty());
        let content = store
            .game_directory(profile.id)
            .unwrap()
            .join("content/external_mod");
        assert!(content.join("scripts/main.lua").is_file());
        assert!(!content.join(".git").exists());

        let updated_artifact = external_artifact(temp.path(), "2.0.0");
        store
            .install_external_packages(
                profile.id,
                vec![ExternalInstallPackage {
                    package: ExternalPackage {
                        id: updated_artifact.manifest.id.clone(),
                        source: "voxelworld".into(),
                        project_id: 10,
                        slug: "external-project".into(),
                        version_id: 21,
                        version: "2.0.0".into(),
                        title: "External project".into(),
                        artifact_sha256: updated_artifact.sha256.clone(),
                        artifact_size: updated_artifact.size,
                    },
                    artifact: updated_artifact,
                }],
            )
            .unwrap();
        assert_eq!(
            store.list().unwrap()[0].external_packages[0].version,
            "2.0.0"
        );

        store.clear_profile(profile.id).unwrap();
        assert!(content.join("scripts/main.lua").is_file());
        store
            .remove_external_package(profile.id, "external_mod")
            .unwrap();
        assert!(!content.exists());
        assert!(store.list().unwrap()[0].external_packages.is_empty());
    }

    #[test]
    fn an_empty_modpack_lock_removes_external_packages() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let profile = store.create("Strict build").unwrap();
        store.initialize_vanilla(profile.id, "0.31.4").unwrap();
        let artifact = external_artifact(temp.path(), "1.0.0");
        store
            .install_external_packages(
                profile.id,
                vec![ExternalInstallPackage {
                    package: ExternalPackage {
                        id: artifact.manifest.id.clone(),
                        source: "voxelworld".into(),
                        project_id: 10,
                        slug: "external-project".into(),
                        version_id: 20,
                        version: artifact.manifest.version.clone(),
                        title: "External project".into(),
                        artifact_sha256: artifact.sha256.clone(),
                        artifact_size: artifact.size,
                    },
                    artifact,
                }],
            )
            .unwrap();
        store
            .replace_external_packages(profile.id, Vec::new())
            .unwrap();
        let installed = store.list().unwrap().remove(0);
        assert!(installed.external_packages.is_empty());
        assert!(
            !store
                .game_directory(profile.id)
                .unwrap()
                .join("content/external_mod")
                .exists()
        );
    }

    #[test]
    fn retrying_same_revision_preserves_previous_snapshot_and_rollback_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let profile = store.create("Retry safe").unwrap();
        let first = InstallPlan {
            revision: "metadata-one".into(),
            packages: vec![package_archive(temp.path(), "1.0.0")],
        };
        let first_metadata = ProfileSnapshotMetadata {
            main_build: None,
            voxelcore_version: Some("0.31.4".into()),
            roots: vec!["demo_mod".into()],
            root_requirements: HashMap::from([("demo_mod".into(), "=1.0.0".into())]),
        };
        store
            .apply_with_metadata(profile.id, &first, &first_metadata)
            .unwrap();
        let second = InstallPlan {
            revision: "metadata-two".into(),
            packages: vec![package_archive(temp.path(), "2.0.0")],
        };
        let second_metadata = ProfileSnapshotMetadata {
            main_build: None,
            voxelcore_version: Some("0.33.0".into()),
            roots: vec!["other_mod".into()],
            root_requirements: HashMap::from([("other_mod".into(), "^2.0".into())]),
        };
        store
            .apply_with_metadata(profile.id, &second, &second_metadata)
            .unwrap();
        store
            .apply_with_metadata(profile.id, &second, &second_metadata)
            .unwrap();

        assert_eq!(store.rollback(profile.id).unwrap(), "metadata-one");
        assert_eq!(store.profile_metadata(profile.id).unwrap(), first_metadata);
        assert!(
            store
                .profile_path(profile.id)
                .join("snapshots/metadata-two/content/demo_mod/package.json")
                .is_file()
        );
    }

    #[test]
    fn snapshot_cleanup_keeps_current_and_rollback_target() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let profile = store.create("Cleanup").unwrap();
        for (revision, version) in [("one", "1.0.0"), ("two", "2.0.0"), ("three", "3.0.0")] {
            store
                .apply(
                    profile.id,
                    &InstallPlan {
                        revision: revision.into(),
                        packages: vec![package_archive(temp.path(), version)],
                    },
                )
                .unwrap();
        }
        let before = store.profile_storage(profile.id).unwrap();
        assert_eq!(before.snapshot_count, 3);
        assert!(before.reclaimable_bytes > 0);
        let after = store.clean_profile_snapshots(profile.id).unwrap();
        assert_eq!(after.snapshot_count, 2);
        assert_eq!(after.reclaimable_bytes, 0);
        assert_eq!(store.rollback(profile.id).unwrap(), "two");
    }

    #[test]
    fn copies_complete_library_to_a_new_location() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let profile = store.create_initialized("Portable", "0.31.4").unwrap();
        fs::write(
            store.profile_path(profile.id).join("game/settings.json"),
            "settings",
        )
        .unwrap();
        let destination = temp.path().join("other/VLauncherLibrary");
        store.copy_library_to(&destination).unwrap();
        let moved = ProfileStore::open(&destination).unwrap();
        assert_eq!(moved.list().unwrap()[0].name, "Portable");
        assert_eq!(
            fs::read_to_string(moved.profile_path(profile.id).join("game/settings.json")).unwrap(),
            "settings"
        );
    }

    #[test]
    fn failed_hash_does_not_change_active_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let profile = store.create("Safe profile").unwrap();
        let valid = InstallPlan {
            revision: "valid".into(),
            packages: vec![package_archive(temp.path(), "1.0.0")],
        };
        store.apply(profile.id, &valid).unwrap();
        let mut broken_package = package_archive(temp.path(), "2.0.0");
        broken_package.artifact_sha256 = "0".repeat(64);
        let broken = InstallPlan {
            revision: "broken".into(),
            packages: vec![broken_package],
        };
        assert!(store.apply(profile.id, &broken).is_err());
        assert!(
            store
                .active_snapshot(profile.id)
                .unwrap()
                .unwrap()
                .ends_with("valid")
        );
    }

    #[test]
    fn damaged_profile_does_not_hide_healthy_profiles() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let damaged = store.create("Damaged").unwrap();
        store.initialize_vanilla(damaged.id, "0.31.4").unwrap();
        let healthy = store.create("Healthy").unwrap();
        store.initialize_vanilla(healthy.id, "0.31.4").unwrap();
        let snapshot = store.active_snapshot(damaged.id).unwrap().unwrap();
        fs::remove_file(snapshot.join("vlauncher.lock.json")).unwrap();

        let profiles = store.list().unwrap();
        assert_eq!(profiles.len(), 2);
        assert!(
            profiles
                .iter()
                .find(|item| item.id == damaged.id)
                .unwrap()
                .problem
                .is_some()
        );
        assert!(
            profiles
                .iter()
                .find(|item| item.id == healthy.id)
                .unwrap()
                .problem
                .is_none()
        );
    }

    #[test]
    fn rejects_concurrent_profile_mutation() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let profile = store.create("Locked").unwrap();
        let held = store.lock_profile(profile.id).unwrap();
        let result = store.apply(
            profile.id,
            &InstallPlan {
                revision: "blocked".into(),
                packages: Vec::new(),
            },
        );
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("operation is in progress")
        );
        drop(held);
        store.initialize_vanilla(profile.id, "0.31.4").unwrap();
    }

    #[test]
    fn clones_and_deletes_an_installed_profile() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let profile = store.create("Original").unwrap();
        store
            .apply(
                profile.id,
                &InstallPlan {
                    revision: "clone-source".into(),
                    packages: vec![package_archive(temp.path(), "1.0.0")],
                },
            )
            .unwrap();
        let source_game = store.profile_path(profile.id).join("game");
        fs::create_dir_all(source_game.join("worlds/home")).unwrap();
        fs::write(source_game.join("worlds/home/world.json"), "{}").unwrap();
        fs::write(source_game.join("settings.json"), "user settings").unwrap();
        let cloned = store.clone_profile(profile.id, "Copy").unwrap();
        assert_eq!(cloned.active_revision.as_deref(), Some("clone-source"));
        assert!(store.active_snapshot(cloned.id).unwrap().unwrap().is_dir());
        assert_eq!(
            fs::read_to_string(store.profile_path(cloned.id).join("game/settings.json")).unwrap(),
            "user settings"
        );
        assert!(
            store
                .profile_path(cloned.id)
                .join("game/worlds/home/world.json")
                .is_file()
        );
        store.clear_profile(cloned.id).unwrap();
        let cleared = store.active_snapshot(cloned.id).unwrap().unwrap();
        assert!(cleared.join("content").read_dir().unwrap().next().is_none());
        store.delete_profile(profile.id).unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
    }

    #[test]
    fn profile_directories_use_safe_readable_unique_names() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("state");
        let store = ProfileStore::open(&root).unwrap();

        let first = store.create("My Profile").unwrap();
        let second = store.create("my profile").unwrap();
        let sanitized = store.create("Rail/Core:*").unwrap();
        let reserved = store.create("NUL").unwrap();

        assert!(root.join("profiles/My Profile/game").is_dir());
        assert!(root.join("profiles/my profile (2)/game").is_dir());
        assert!(root.join("profiles/Rail-Core/game").is_dir());
        assert!(root.join("profiles/NUL Profile/game").is_dir());
        assert_eq!(
            store.profile_path(first.id),
            root.join("profiles/My Profile")
        );
        assert_eq!(
            store.profile_path(second.id),
            root.join("profiles/my profile (2)")
        );

        drop(store);
        let reopened = ProfileStore::open(&root).unwrap();
        assert_eq!(
            reopened.game_directory(sanitized.id).unwrap(),
            root.join("profiles/Rail-Core/game")
        );
        assert_eq!(
            reopened.game_directory(reserved.id).unwrap(),
            root.join("profiles/NUL Profile/game")
        );
        reopened.rename(sanitized.id, "Railway").unwrap();
        assert!(!root.join("profiles/Rail-Core").exists());
        assert_eq!(
            reopened.game_directory(sanitized.id).unwrap(),
            root.join("profiles/Railway/game")
        );
        reopened.rename(sanitized.id, "railway").unwrap();
        assert_eq!(
            reopened.game_directory(sanitized.id).unwrap(),
            root.join("profiles/railway/game")
        );
    }

    #[test]
    fn content_updates_preserve_manual_packs_and_reject_collisions() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let profile = store.create("Manual content").unwrap();
        store
            .apply(
                profile.id,
                &InstallPlan {
                    revision: "managed-content".into(),
                    packages: vec![package_archive(temp.path(), "1.0.0")],
                },
            )
            .unwrap();
        let first = store.list().unwrap()[0].active_revision.clone().unwrap();
        let game = store.materialize_game_folder(profile.id, &first).unwrap();
        fs::create_dir_all(game.join("content/local_pack")).unwrap();
        fs::write(game.join("content/local_pack/file.txt"), "user content").unwrap();
        store.clear_profile(profile.id).unwrap();
        let second = store.list().unwrap()[0].active_revision.clone().unwrap();
        assert!(!game.join("content/demo_mod").exists());
        assert_eq!(
            fs::read_to_string(game.join("content/local_pack/file.txt")).unwrap(),
            "user content"
        );
        assert_eq!(store.list().unwrap()[0].manual_packages, vec!["local_pack"]);
        // Не затираем добавленный вручную пак с таким же именем.
        let snapshot = store.active_snapshot(profile.id).unwrap().unwrap();
        fs::write(game.join(".vlauncher-revision"), &first).unwrap();
        fs::create_dir_all(snapshot.join("content/local_pack")).unwrap();
        assert!(store.materialize_game_folder(profile.id, &second).is_err());
        assert_eq!(
            fs::read_to_string(game.join("content/local_pack/file.txt")).unwrap(),
            "user content"
        );
    }

    #[test]
    fn profile_icons_persist_clone_reset_and_reject_invalid_data() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path()).unwrap();
        let p = store.create("Icon").unwrap();
        let icon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
        store.set_icon(p.id, Some(icon)).unwrap();
        let reopened = ProfileStore::open(temp.path()).unwrap();
        assert_eq!(reopened.list().unwrap()[0].icon.as_deref(), Some(icon));
        let clone = reopened.clone_profile(p.id, "Copy").unwrap();
        assert_eq!(clone.icon.as_deref(), Some(icon));
        assert!(
            store
                .set_icon(p.id, Some("data:image/svg+xml,<svg />"))
                .is_err()
        );
        assert!(
            store
                .set_icon(p.id, Some("data:image/png;base64,aaaa"))
                .is_err()
        );
        assert!(store.set_icon(Uuid::new_v4(), Some(icon)).is_err());
        store.set_icon(p.id, None).unwrap();
        assert!(
            store
                .list()
                .unwrap()
                .iter()
                .find(|x| x.id == p.id)
                .unwrap()
                .icon
                .is_none()
        );
    }

    #[test]
    fn vanilla_initialization_preserves_existing_content_and_validates_engine() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path()).unwrap();
        let profile = store.create("Vanilla").unwrap();
        assert!(store.initialize_vanilla(profile.id, "invalid").is_err());
        assert!(store.list().unwrap()[0].active_revision.is_none());
        store.initialize_vanilla(profile.id, "0.31.4").unwrap();
        let before = store.list().unwrap()[0].clone();
        assert!(before.packages.is_empty());
        assert_eq!(before.voxelcore_version.as_deref(), Some("0.31.4"));
        assert!(
            store
                .active_snapshot(profile.id)
                .unwrap()
                .unwrap()
                .join("content")
                .is_dir()
        );
        assert!(store.initialize_vanilla(profile.id, "0.31.0").is_err());
        assert_eq!(store.list().unwrap()[0], before);
        assert!(
            store
                .launch_spec(profile.id, "0.31.0")
                .unwrap_err()
                .to_string()
                .contains("does not match")
        );
        store.rename(profile.id, "  My game  ").unwrap();
        assert_eq!(store.list().unwrap()[0].name, "My game");
        assert!(store.rename(profile.id, " ").is_err());
        assert!(store.rename(Uuid::new_v4(), "Missing").is_err());
    }

    #[test]
    fn builds_launch_spec_for_installed_runtime_and_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let profile = store.create("Playable").unwrap();
        store
            .apply(
                profile.id,
                &InstallPlan {
                    revision: "playable-snapshot".into(),
                    packages: Vec::new(),
                },
            )
            .unwrap();
        let runtime = store.root.join(format!(
            "runtimes/0.31.4-{}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
        fs::create_dir_all(runtime.join("bin")).unwrap();
        fs::create_dir_all(runtime.join("res")).unwrap();
        fs::write(runtime.join("bin/VoxelCore"), b"binary").unwrap();
        fs::write(
            runtime.join("runtime.json"),
            serde_json::to_vec(&RuntimeManifest {
                schema_version: 1,
                version: "0.31.4".into(),
                platform: std::env::consts::OS.into(),
                architecture: std::env::consts::ARCH.into(),
                executable: "bin/VoxelCore".into(),
                resources: "res".into(),
            })
            .unwrap(),
        )
        .unwrap();
        let spec = store.launch_spec(profile.id, "0.31.4").unwrap();
        assert!(spec.executable.ends_with("bin/VoxelCore"));
        assert!(spec.arguments.iter().any(|argument| argument == "--dir"));
        assert!(
            spec.arguments
                .iter()
                .any(|argument| argument.ends_with("game"))
        );
        assert!(store.profile_path(profile.id).join("game/content").is_dir());
        assert!(spec.log_path.ends_with("logs/latest.log"));
        assert!(!spec.arguments.iter().any(|arg| arg == "--log"));
    }

    #[test]
    fn main_build_selection_preserves_content_and_round_trips_snapshots() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("library")).unwrap();
        let profile = store.create_initialized("Experimental", "0.31.4").unwrap();
        let build = crate::mainline::MainBuild {
            engine_version: Some("0.32.0".into()),
            sha: "a".repeat(40),
            run_id: 10,
            artifact_id: 20,
            digest: format!("sha256:{}", "b".repeat(64)),
            size: 40,
            created_at: "2026-09-08T00:00:00Z".into(),
            expires_at: "2026-12-07T00:00:00Z".into(),
            platform: "linux".into(),
            architecture: "x86_64".into(),
        };
        let created = store
            .create_initialized_with_main("Main from creation", "0.31.4", Some(build.clone()))
            .unwrap();
        assert_eq!(created.main_build, Some(build.clone()));
        assert_eq!(created.voxelcore_version.as_deref(), Some("0.32.0"));
        assert_eq!(
            store.profile(created.id).unwrap().main_build,
            Some(build.clone())
        );
        assert_eq!(store.profile(profile.id).unwrap().main_build, None);
        let count = store.list().unwrap().len();
        let mut invalid_build = build.clone();
        invalid_build.sha = "invalid".into();
        assert!(
            store
                .create_initialized_with_main("Invalid build", "0.31.4", Some(invalid_build))
                .is_err()
        );
        assert!(
            store
                .create_initialized("Invalid reference", "invalid")
                .is_err()
        );
        assert_eq!(store.list().unwrap().len(), count);
        let game = store.profile_path(profile.id).join("game");
        fs::create_dir_all(game.join("content/manual_mod")).unwrap();
        fs::write(
            game.join("content/manual_mod/package.json"),
            r#"{"id":"manual_mod","title":"Manual","version":"1.0.0"}"#,
        )
        .unwrap();
        fs::create_dir_all(game.join("worlds/test")).unwrap();
        fs::write(game.join("worlds/test/world.json"), "saved world").unwrap();
        store
            .select_main_build(profile.id, Some(build.clone()))
            .unwrap();
        assert_eq!(
            store
                .profile(profile.id)
                .unwrap()
                .voxelcore_version
                .as_deref(),
            Some("0.32.0")
        );
        let selected_revision = store.profile(profile.id).unwrap().active_revision;
        store
            .select_main_build(profile.id, Some(build.clone()))
            .unwrap();
        assert_eq!(
            store.profile(profile.id).unwrap().active_revision,
            selected_revision
        );
        assert!(
            store
                .launch_spec(profile.id, "0.31.4")
                .unwrap_err()
                .to_string()
                .contains("does not match")
        );
        let cloned = store.clone_profile(profile.id, "Copy").unwrap();
        assert_eq!(cloned.main_build, Some(build.clone()));
        let export = temp.path().join("profile.json");
        store.export_profile(profile.id, &export).unwrap();
        let definition = ProfileStore::read_profile_definition(&export).unwrap();
        assert_eq!(definition.schema_version, 3);
        assert_eq!(definition.main_build, Some(build.clone()));
        assert_eq!(definition.voxelcore_version, "0.32.0");
        let mut legacy_build = build.clone();
        legacy_build.engine_version = None;
        assert!(build.same_artifact(&legacy_build));
        legacy_build.sha = "c".repeat(40);
        assert!(!build.same_artifact(&legacy_build));
        // Сборка main остаётся той же после обновления паков.
        store
            .apply_remote(
                profile.id,
                &RemoteInstallPlan {
                    revision: "remote-content".into(),
                    issued_at: timestamp(),
                    expires_at: timestamp() + 100,
                    voxelcore_version: "0.32.0".into(),
                    roots: vec![],
                    root_requirements: HashMap::new(),
                    packages: vec![],
                    external_packages: None,
                },
            )
            .unwrap();
        assert_eq!(
            store.profile(profile.id).unwrap().main_build,
            Some(build.clone())
        );
        store.select_main_build(profile.id, None).unwrap();
        assert!(store.profile(profile.id).unwrap().main_build.is_none());
        store.rollback(profile.id).unwrap();
        assert_eq!(store.profile(profile.id).unwrap().main_build, Some(build));
        assert_eq!(
            fs::read_to_string(game.join("worlds/test/world.json")).unwrap(),
            "saved world"
        );
        assert!(game.join("content/manual_mod/package.json").is_file());
        assert!(
            store
                .remove_runtime(&definition.main_build.unwrap().runtime_id())
                .unwrap_err()
                .to_string()
                .contains("used by a profile")
        );
    }

    #[test]
    fn imports_local_runtime_as_an_independent_installation() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let source = temp.path().join("local-runtime");
        fs::create_dir_all(source.join("bin")).unwrap();
        fs::create_dir_all(source.join("res")).unwrap();
        fs::write(source.join("bin/VoxelCore"), b"binary").unwrap();
        fs::write(
            source.join("runtime.json"),
            serde_json::to_vec(&RuntimeManifest {
                schema_version: 1,
                version: "0.40.0".into(),
                platform: std::env::consts::OS.into(),
                architecture: std::env::consts::ARCH.into(),
                executable: "bin/VoxelCore".into(),
                resources: "res".into(),
            })
            .unwrap(),
        )
        .unwrap();
        let installed = store.import_runtime(&source).unwrap();
        fs::remove_dir_all(&source).unwrap();
        assert_eq!(installed.version, "0.40.0");
        assert!(installed.path.join("bin/VoxelCore").is_file());
        assert_eq!(store.list_runtimes().unwrap(), vec![installed]);
    }

    #[test]
    fn prepares_reproducible_modpack_from_profile_roots_and_config() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let profile = store.create("Builder source").unwrap();
        let icon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
        store.set_icon(profile.id, Some(icon)).unwrap();
        store
            .apply_with_metadata(
                profile.id,
                &InstallPlan {
                    revision: "builder-snapshot".into(),
                    packages: vec![package_archive(temp.path(), "1.0.0")],
                },
                &ProfileSnapshotMetadata {
                    main_build: None,
                    voxelcore_version: Some("0.31.4".into()),
                    roots: vec!["demo_mod".into()],
                    root_requirements: HashMap::new(),
                },
            )
            .unwrap();
        let external_artifact = external_artifact(temp.path(), "1.0.0");
        store
            .install_external_packages(
                profile.id,
                vec![ExternalInstallPackage {
                    package: ExternalPackage {
                        id: external_artifact.manifest.id.clone(),
                        source: "voxelworld".into(),
                        project_id: 10,
                        slug: "external-project".into(),
                        version_id: 20,
                        version: "1.0.0".into(),
                        title: "External project".into(),
                        artifact_sha256: external_artifact.sha256.clone(),
                        artifact_size: external_artifact.size,
                    },
                    artifact: external_artifact,
                }],
            )
            .unwrap();
        let config = store.profile_path(profile.id).join("game/config");
        fs::create_dir_all(&config).unwrap();
        fs::write(config.join("demo.json"), "custom").unwrap();
        let artifact = store
            .prepare_modpack(
                profile.id,
                "my_pack",
                "My pack",
                "2.0.0",
                "Tester",
                "MIT",
                temp.path().join("output"),
            )
            .unwrap();
        assert_eq!(artifact.manifest.kind, PackageKind::Modpack);
        assert_eq!(artifact.manifest.voxelcore, "=0.31.4");
        assert_eq!(artifact.manifest.dependencies[0].id, "demo_mod");
        assert_eq!(artifact.manifest.dependencies[0].requirement, "=1.0.0");
        assert_eq!(artifact.manifest.external_packages.len(), 1);
        assert_eq!(artifact.manifest.external_packages[0].source, "voxelworld");
        assert_eq!(artifact.manifest.external_packages[0].version_id, 20);
        let mut archive = ZipArchive::new(fs::File::open(artifact.path).unwrap()).unwrap();
        assert!(archive.by_name("icon.png").is_ok());
    }

    #[test]
    fn prepares_world_without_private_player_state() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let profile = store.create_initialized("World source", "0.31.4").unwrap();
        let world = store.profile_path(profile.id).join("game/worlds/home");
        fs::create_dir_all(world.join("regions")).unwrap();
        fs::write(world.join("world.json"), "{}").unwrap();
        fs::write(world.join("player.json"), "private").unwrap();
        fs::write(world.join("regions/0_0.bin"), "terrain").unwrap();
        let artifact = store
            .prepare_world_package(
                profile.id,
                "home",
                "shared_world",
                "Shared world",
                "1.0.0",
                "Tester",
                "MIT",
                temp.path().join("output"),
            )
            .unwrap();
        let file = fs::File::open(artifact.path).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        assert!(archive.by_name("world/world.json").is_ok());
        assert!(archive.by_name("world/regions/0_0.bin").is_ok());
        assert!(archive.by_name("world/player.json").is_err());
    }

    #[test]
    fn changing_content_preserves_worlds_and_settings() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let profile = store.create("Persistent data").unwrap();
        let runtime = store.root.join(format!(
            "runtimes/0.31.4-{}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
        fs::create_dir_all(runtime.join("bin")).unwrap();
        fs::create_dir_all(runtime.join("res")).unwrap();
        fs::write(runtime.join("bin/VoxelCore"), b"binary").unwrap();
        fs::write(
            runtime.join("runtime.json"),
            serde_json::to_vec(&RuntimeManifest {
                schema_version: 1,
                version: "0.31.4".into(),
                platform: std::env::consts::OS.into(),
                architecture: std::env::consts::ARCH.into(),
                executable: "bin/VoxelCore".into(),
                resources: "res".into(),
            })
            .unwrap(),
        )
        .unwrap();
        store
            .apply(
                profile.id,
                &InstallPlan {
                    revision: "one".into(),
                    packages: vec![package_archive(temp.path(), "1.0.0")],
                },
            )
            .unwrap();
        store.launch_spec(profile.id, "0.31.4").unwrap();
        let game = store.profile_path(profile.id).join("game");
        fs::create_dir_all(game.join("worlds/my-world")).unwrap();
        fs::write(game.join("worlds/my-world/world.json"), b"saved world").unwrap();
        fs::write(game.join("settings.toml"), b"volume = 0.5").unwrap();

        store
            .apply(
                profile.id,
                &InstallPlan {
                    revision: "two".into(),
                    packages: vec![package_archive(temp.path(), "2.0.0")],
                },
            )
            .unwrap();
        store.launch_spec(profile.id, "0.31.4").unwrap();

        assert_eq!(
            fs::read(game.join("worlds/my-world/world.json")).unwrap(),
            b"saved world"
        );
        assert_eq!(
            fs::read(game.join("settings.toml")).unwrap(),
            b"volume = 0.5"
        );
        let manifest = PackageManifest::read(game.join("content/demo_mod")).unwrap();
        assert_eq!(manifest.version, "2.0.0");
    }

    #[test]
    fn indexes_and_clears_only_managed_cache_files() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let cache = store.root.join("cache/blobs");
        fs::write(cache.join("a".repeat(64)), b"artifact").unwrap();
        fs::write(cache.join(format!("{}.part", "b".repeat(64))), b"partial").unwrap();
        fs::write(cache.join("keep-me"), b"unmanaged").unwrap();
        assert_eq!(
            store.cache_status().unwrap(),
            CacheStatus {
                artifacts: 1,
                artifact_bytes: 8,
                partial_downloads: 1,
                partial_bytes: 7,
            }
        );
        assert_eq!(store.clear_cache().unwrap().artifacts, 0);
        assert!(cache.join("keep-me").is_file());
    }

    #[test]
    fn refuses_an_operation_that_cannot_fit_on_disk() {
        let temp = tempfile::tempdir().unwrap();
        let error = ensure_space(temp.path(), u64::MAX).unwrap_err();
        assert!(error.to_string().contains("insufficient disk space"));
    }

    #[test]
    fn paused_download_resumes_and_restarts_if_range_is_ignored() {
        let artifact = vec![0x5a; 128 * 1024];
        let digest = hex::encode(Sha256::digest(&artifact));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let served = artifact.clone();
        let requests = Arc::new(Mutex::new(Vec::<String>::new()));
        let observed = requests.clone();
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 1024];
                loop {
                    let read = stream.read(&mut buffer).unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                observed
                    .lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&request).into_owned());
                let headers = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    served.len()
                );
                let _ = stream.write_all(headers.as_bytes());
                let _ = stream.write_all(&served);
            }
        });
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let package = RemoteInstallPackage {
            id: "demo_mod".into(),
            kind: PackageKind::Mod,
            version: "1.0.0".into(),
            artifact_sha256: digest,
            artifact_size: artifact.len() as u64,
            download_url: format!("http://{address}/artifact"),
            dependencies: Vec::new(),
        };
        let first =
            store.fetch_artifact_with_progress(&Client::new(), &package, &|_, done, _| done == 0);
        assert!(first.unwrap_err().to_string().contains("paused"));
        let downloaded = store
            .fetch_artifact_with_progress(&Client::new(), &package, &|_, _, _| true)
            .unwrap();
        assert_eq!(fs::read(downloaded).unwrap(), artifact);
        server.join().unwrap();
        let second_request = requests.lock().unwrap()[1].to_ascii_lowercase();
        assert!(second_request.contains("range: bytes="));
        assert!(!second_request.contains("range: bytes=0-"));
    }

    #[test]
    fn refuses_to_export_a_profile_without_engine_version() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let profile = store.create("Uninitialized").unwrap();
        let output = temp.path().join("profile.json");
        let error = store.export_profile(profile.id, &output).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("profile has no VoxelCore version")
        );
        assert!(!output.exists());
    }

    #[test]
    fn exports_and_validates_portable_profile_definition() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let profile = store.create("Portable").unwrap();
        let package = package_archive(temp.path(), "1.0.0");
        let package_hash = package.artifact_sha256.clone();
        store
            .apply(
                profile.id,
                &InstallPlan {
                    revision: "portable-lock".into(),
                    packages: vec![package],
                },
            )
            .unwrap();
        store
            .with_database(|database| {
                database.execute(
                    "UPDATE profiles SET voxelcore_version = '0.31.4', roots_json = '[\"demo_mod\"]' WHERE id = ?1",
                    [profile.id.to_string()],
                )?;
                Ok(())
            })
            .unwrap();
        let output = temp.path().join("portable.vlauncher.json");
        store.export_profile(profile.id, &output).unwrap();
        assert_eq!(
            ProfileStore::read_profile_definition(output).unwrap(),
            ProfileDefinition {
                main_build: None,
                schema_version: 2,
                name: "Portable".into(),
                voxelcore_version: "0.31.4".into(),
                roots: vec!["demo_mod".into()],
                locked: vec![ProfileLockedPackage {
                    id: "demo_mod".into(),
                    version: "1.0.0".into(),
                    artifact_sha256: package_hash,
                }],
            }
        );
    }

    #[test]
    fn installs_world_template_once_as_mutable_copy() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let profile = store.create("World profile").unwrap();
        store
            .apply(
                profile.id,
                &InstallPlan {
                    revision: "world-one".into(),
                    packages: vec![world_archive(temp.path())],
                },
            )
            .unwrap();
        let snapshot = store.active_snapshot(profile.id).unwrap().unwrap();
        assert!(
            snapshot
                .join("world-templates/demo_world/world/world.json")
                .is_file()
        );
        assert!(!snapshot.join("content/demo_world").exists());
        let game = store
            .materialize_game_folder(profile.id, "world-one")
            .unwrap();
        let region = game.join("worlds/demo_world/regions/0_0.bin");
        fs::write(&region, b"player changes").unwrap();
        store
            .materialize_game_folder(profile.id, "world-one")
            .unwrap();
        assert_eq!(fs::read(region).unwrap(), b"player changes");
    }

    #[test]
    fn exports_and_imports_world_as_an_independent_copy() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let source = store.create_initialized("Source", "0.31.4").unwrap();
        let source_world = store.profile_path(source.id).join("game/worlds/my-world");
        fs::create_dir_all(&source_world).unwrap();
        fs::write(source_world.join("world.json"), br#"{"name":"My world"}"#).unwrap();
        fs::write(source_world.join("data.bin"), b"world state").unwrap();
        let archive = temp.path().join("shared-world.zip");
        store.export_world(source.id, "my-world", &archive).unwrap();

        let target = store.create_initialized("Target", "0.31.4").unwrap();
        let imported = store.import_world(target.id, archive).unwrap();
        assert_eq!(fs::read(imported.join("data.bin")).unwrap(), b"world state");
        assert!(imported.join("world.json").is_file());
        assert_ne!(imported, source_world);
    }

    #[test]
    fn attaches_an_existing_game_without_copying_its_source_data() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();
        let source = temp.path().join("My existing game");
        fs::create_dir_all(source.join("res")).unwrap();
        fs::write(source.join("VoxelCore"), b"local executable").unwrap();
        fs::create_dir_all(source.join("content/local_mod")).unwrap();
        fs::write(source.join("content/local_mod/package.json"), b"{}").unwrap();
        fs::create_dir_all(source.join("worlds/home")).unwrap();
        fs::write(source.join("worlds/home/world.json"), b"{}").unwrap();
        fs::create_dir_all(source.join("config")).unwrap();
        fs::write(source.join("config/settings.toml"), b"volume = 0.5").unwrap();

        let analysis = store.analyze_existing_game(&source).unwrap();
        assert_eq!(analysis.suggested_name, "My existing game");
        assert_eq!(analysis.runtime_kind, ExistingRuntimeKind::Detected);
        assert_eq!(analysis.runtime_version, None);
        assert_eq!(analysis.content_count, 1);
        assert_eq!(analysis.world_count, 1);
        assert!(analysis.has_config);

        let profile = store
            .attach_existing_game(&source, "Imported", "0.31.4")
            .unwrap();
        let game = store.game_directory(profile.id).unwrap();
        assert_eq!(game, fs::canonicalize(&source).unwrap());
        assert!(game.join("content/local_mod/package.json").is_file());
        assert!(game.join("worlds/home/world.json").is_file());
        assert!(game.join("config/settings.toml").is_file());
        assert!(source.join("content/local_mod/package.json").is_file());

        assert!(store.list_runtimes().unwrap().is_empty());
        assert_eq!(profile.external_runtime.unwrap().path, source);
        let launch = store.launch_spec(profile.id, "0.31.4").unwrap();
        assert_eq!(launch.executable, source.join("VoxelCore"));
        assert_eq!(launch.arguments.last().map(String::as_str), source.to_str());
        assert_eq!(
            store.profile(profile.id).unwrap().manual_packages,
            ["local_mod"]
        );
        store.delete_profile(profile.id).unwrap();
        assert!(source.join("worlds/home/world.json").is_file());
    }

    #[test]
    fn parses_the_full_engine_version_before_the_short_display_version() {
        let output = "[I] 2026/09/15 21:03:24.250 [ main] build: 0.31.4\nVoxelCore v0.31\n";
        assert_eq!(parse_voxelcore_version(output).as_deref(), Some("0.31.4"));
    }

    #[cfg(unix)]
    #[test]
    fn detects_an_existing_engine_version_without_runtime_metadata() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("game");
        fs::create_dir_all(source.join("res")).unwrap();
        let executable = source.join("VoxelCore");
        fs::write(
            &executable,
            b"#!/bin/sh\nprintf '[I] main build: 0.31.4\\nVoxelCore v0.31\\n'\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let store = ProfileStore::open(temp.path().join("state")).unwrap();

        let analysis = store.analyze_existing_game(&source).unwrap();
        assert_eq!(analysis.runtime_kind, ExistingRuntimeKind::Detected);
        assert_eq!(analysis.runtime_version.as_deref(), Some("0.31.4"));
    }
}
