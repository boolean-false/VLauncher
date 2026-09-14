use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
};

use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use walkdir::WalkDir;

const RESERVED_IDS: &[&str] = &[
    "res", "abs", "local", "core", "user", "world", "none", "null", "project", "pack", "packid",
    "root",
];

#[derive(Debug, Error)]
pub enum PackageProblem {
    #[error("could not read {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("invalid JSON in {path}: {source}")]
    Json {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("invalid package manifest: {0}")]
    Invalid(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum PackageKind {
    Mod,
    Library,
    Modpack,
    World,
    Runtime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum DependencyKind {
    Required,
    Optional,
    Weak,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Dependency {
    pub id: String,
    pub requirement: String,
    pub kind: DependencyKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    NetworkClient,
    NetworkServer,
    WriteWorld,
    WriteConfig,
    WriteUserFiles,
    Microphone,
    ExternalUrl,
    Subprocess,
    Debugging,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum PackageEnvironment {
    Client,
    Server,
}

fn default_environments() -> Vec<PackageEnvironment> {
    vec![PackageEnvironment::Client]
}

fn default_voxelcore_requirement() -> String {
    "*".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PackageManifest {
    pub schema_version: u32,
    pub id: String,
    #[serde(rename = "type")]
    pub kind: PackageKind,
    pub title: String,
    pub version: String,
    pub creators: Vec<String>,
    pub description: String,
    pub license: String,
    #[serde(default = "default_voxelcore_requirement")]
    pub voxelcore: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dependencies: Vec<Dependency>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflicts: Vec<Dependency>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provides: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<Capability>,
    #[serde(default = "default_environments")]
    pub environments: Vec<PackageEnvironment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub external_packages: Vec<ExternalPackageLock>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExternalPackageLock {
    pub source: String,
    pub id: String,
    pub title: String,
    pub project_id: u64,
    pub slug: String,
    pub version_id: u64,
    pub version: String,
    pub artifact_sha256: String,
    pub artifact_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeliveryFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeliveryManifest {
    pub schema_version: u32,
    pub package: PackageManifest,
    pub files: Vec<DeliveryFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LockedPackage {
    pub id: String,
    pub version: String,
    pub artifact_sha256: String,
    pub artifact_size: u64,
    pub download_url: String,
    pub dependencies: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Lockfile {
    pub schema_version: u32,
    pub revision: String,
    pub generated_at: String,
    pub voxelcore: LockedPackage,
    pub roots: Vec<String>,
    pub packages: Vec<LockedPackage>,
}

impl PackageManifest {
    pub fn read(path: impl AsRef<Path>) -> Result<Self, PackageProblem> {
        let path = manifest_path(path.as_ref());
        let bytes = fs::read(&path).map_err(|source| PackageProblem::Io {
            path: path.clone(),
            source,
        })?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|source| PackageProblem::Json {
                path: path.clone(),
                source,
            })?;
        let manifest = if value.get("schema_version").is_some() {
            serde_json::from_value(value).map_err(|source| PackageProblem::Json {
                path: path.clone(),
                source,
            })?
        } else {
            Self::from_legacy(value)?
        };
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn from_legacy(value: Value) -> Result<Self, PackageProblem> {
        let object = value
            .as_object()
            .ok_or_else(|| PackageProblem::Invalid("manifest must be an object".into()))?;
        let string = |name: &str| -> Result<String, PackageProblem> {
            object
                .get(name)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| PackageProblem::Invalid(format!("missing string field '{name}'")))
        };
        let creators = if let Some(items) = object.get("creators").and_then(Value::as_array) {
            items
                .iter()
                .map(|item| {
                    item.as_str().map(str::to_owned).ok_or_else(|| {
                        PackageProblem::Invalid("creators must contain strings".into())
                    })
                })
                .collect::<Result<Vec<_>, _>>()?
        } else {
            vec![string("creator")?]
        };
        let dependencies = object
            .get("dependencies")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| {
                        item.as_str()
                            .ok_or_else(|| {
                                PackageProblem::Invalid(
                                    "legacy dependencies must contain strings".into(),
                                )
                            })
                            .and_then(parse_legacy_dependency)
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?
            .unwrap_or_default();
        Ok(Self {
            schema_version: 1,
            id: string("id")?,
            kind: PackageKind::Mod,
            title: string("title")?,
            version: normalize_version(&string("version")?)?,
            creators,
            description: string("description")?,
            license: object
                .get("license")
                .and_then(Value::as_str)
                .unwrap_or("LicenseRef-Proprietary")
                .to_owned(),
            voxelcore: default_voxelcore_requirement(),
            source: object
                .get("source")
                .and_then(Value::as_str)
                .map(str::to_owned),
            dependencies,
            conflicts: Vec::new(),
            provides: Vec::new(),
            capabilities: Vec::new(),
            environments: default_environments(),
            external_packages: Vec::new(),
        })
    }

    pub fn validate(&self) -> Result<(), PackageProblem> {
        if self.schema_version != 1 {
            return invalid("schema_version must equal 1");
        }
        validate_id(&self.id)?;
        Version::parse(&self.version)
            .map_err(|error| PackageProblem::Invalid(format!("invalid version: {error}")))?;
        VersionReq::parse(&self.voxelcore).map_err(|error| {
            PackageProblem::Invalid(format!("invalid voxelcore requirement: {error}"))
        })?;
        if self.title.trim().is_empty() || self.title.chars().count() > 128 {
            return invalid("title must contain 1 to 128 characters");
        }
        if self.creators.is_empty() || self.creators.iter().any(|v| v.trim().is_empty()) {
            return invalid("at least one non-empty creator is required");
        }
        if self.license.trim().is_empty() {
            return invalid("license must not be empty");
        }
        let mut relations = HashSet::new();
        for dependency in self.dependencies.iter().chain(&self.conflicts) {
            validate_id(&dependency.id)?;
            VersionReq::parse(&dependency.requirement).map_err(|error| {
                PackageProblem::Invalid(format!(
                    "invalid requirement for '{}': {error}",
                    dependency.id
                ))
            })?;
            if dependency.id == self.id {
                return invalid("a package cannot depend on or conflict with itself");
            }
            if !relations.insert((&dependency.id, &dependency.kind)) {
                return invalid("duplicate dependency relation");
            }
        }
        let mut provided = HashSet::new();
        for id in &self.provides {
            validate_id(id)?;
            if !provided.insert(id) {
                return invalid("duplicate provided package id");
            }
        }
        let mut capabilities = HashSet::new();
        if self
            .capabilities
            .iter()
            .any(|item| !capabilities.insert(item))
        {
            return invalid("duplicate capability");
        }
        let mut environments = HashSet::new();
        if self.environments.is_empty()
            || self
                .environments
                .iter()
                .any(|item| !environments.insert(item))
        {
            return invalid("at least one unique package environment is required");
        }
        let mut external_ids = HashSet::new();
        if self.external_packages.len() > 256
            || !self.external_packages.is_empty() && self.kind != PackageKind::Modpack
        {
            return invalid("external packages are only valid in modpacks");
        }
        for package in &self.external_packages {
            validate_id(&package.id)?;
            Version::parse(&package.version).map_err(|error| {
                PackageProblem::Invalid(format!("invalid external package version: {error}"))
            })?;
            if package.source != "voxelworld"
                || package.project_id == 0
                || package.version_id == 0
                || package.slug.is_empty()
                || package.slug.len() > 255
                || !package
                    .slug
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
                || package.title.trim().is_empty()
                || package.title.chars().count() > 128
                || package.artifact_sha256.len() != 64
                || !package
                    .artifact_sha256
                    .chars()
                    .all(|c| c.is_ascii_digit() || matches!(c, 'a'..='f'))
                || package.artifact_size == 0
                || !external_ids.insert(package.id.as_str())
            {
                return invalid("invalid external package lock");
            }
        }
        Ok(())
    }

    pub fn write_migrated(&self, path: impl AsRef<Path>) -> Result<PathBuf, PackageProblem> {
        let path = manifest_path(path.as_ref());
        let backup = path.with_file_name("package.json.legacy");
        if !backup.exists() {
            fs::copy(&path, &backup).map_err(|source| PackageProblem::Io {
                path: backup.clone(),
                source,
            })?;
        }
        let bytes = serde_json::to_vec_pretty(self)
            .map_err(|error| PackageProblem::Invalid(error.to_string()))?;
        fs::write(&path, [bytes.as_slice(), b"\n"].concat()).map_err(|source| {
            PackageProblem::Io {
                path: path.clone(),
                source,
            }
        })?;
        Ok(backup)
    }
}

impl DeliveryManifest {
    pub fn build(root: impl AsRef<Path>) -> Result<Self, PackageProblem> {
        let root = root.as_ref();
        let package = PackageManifest::read(root)?;
        let mut files = Vec::new();
        for entry in WalkDir::new(root).follow_links(false) {
            let entry = entry.map_err(|error| PackageProblem::Invalid(error.to_string()))?;
            let file_type = entry.file_type();
            if file_type.is_symlink() {
                return invalid(format!("symlink is forbidden: {}", entry.path().display()));
            }
            if !file_type.is_file() || entry.file_name() == "package.json.legacy" {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|_| PackageProblem::Invalid("file escaped package root".into()))?;
            validate_relative_path(relative)?;
            let mut file = fs::File::open(entry.path()).map_err(|source| PackageProblem::Io {
                path: entry.path().to_owned(),
                source,
            })?;
            let mut hasher = Sha256::new();
            let size =
                std::io::copy(&mut file, &mut hasher).map_err(|source| PackageProblem::Io {
                    path: entry.path().to_owned(),
                    source,
                })?;
            files.push(DeliveryFile {
                path: relative.to_string_lossy().replace('\\', "/"),
                size,
                sha256: hex::encode(hasher.finalize()),
            });
        }
        files.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(Self {
            schema_version: 1,
            package,
            files,
        })
    }
}

impl Lockfile {
    pub fn validate(&self) -> Result<(), PackageProblem> {
        if self.schema_version != 1 || self.revision.trim().is_empty() {
            return invalid("invalid lockfile header");
        }
        let mut ids = HashSet::new();
        for package in std::iter::once(&self.voxelcore).chain(&self.packages) {
            validate_id(&package.id)?;
            Version::parse(&package.version)
                .map_err(|error| PackageProblem::Invalid(error.to_string()))?;
            if package.artifact_sha256.len() != 64
                || !package
                    .artifact_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
            {
                return invalid(format!("invalid artifact hash for '{}'", package.id));
            }
            if !ids.insert(&package.id) {
                return invalid(format!("duplicate locked package '{}'", package.id));
            }
        }
        if self.roots.iter().any(|root| !ids.contains(root)) {
            return invalid("a root requirement is absent from locked packages");
        }
        Ok(())
    }
}

fn parse_legacy_dependency(input: &str) -> Result<Dependency, PackageProblem> {
    let (kind, rest) = match input.as_bytes().first() {
        Some(b'?') => (DependencyKind::Optional, &input[1..]),
        Some(b'~') => (DependencyKind::Weak, &input[1..]),
        Some(b'!') => (DependencyKind::Required, &input[1..]),
        _ => (DependencyKind::Required, input),
    };
    let (id, requirement) = rest
        .rsplit_once('@')
        .map(|(id, requirement)| (id, normalize_requirement(requirement)))
        .unwrap_or((rest, "*".into()));
    validate_id(id)?;
    VersionReq::parse(&requirement).map_err(|error| {
        PackageProblem::Invalid(format!("invalid dependency '{input}': {error}"))
    })?;
    Ok(Dependency {
        id: id.to_owned(),
        requirement,
        kind,
    })
}

fn normalize_requirement(input: &str) -> String {
    if input == "*" {
        return input.into();
    }
    for operator in [">=", "<=", ">", "<", "="] {
        if let Some(version) = input.strip_prefix(operator) {
            return format!("{operator}{}", normalize_version_lossy(version));
        }
    }
    format!("={}", normalize_version_lossy(input))
}

fn normalize_version(input: &str) -> Result<String, PackageProblem> {
    let normalized = normalize_version_lossy(input);
    Version::parse(&normalized)
        .map_err(|error| PackageProblem::Invalid(format!("invalid version '{input}': {error}")))?;
    Ok(normalized)
}

fn normalize_version_lossy(input: &str) -> String {
    if input.matches('.').count() == 1 {
        format!("{input}.0")
    } else {
        input.to_owned()
    }
}

fn manifest_path(path: &Path) -> PathBuf {
    if path.is_dir() {
        path.join("package.json")
    } else {
        path.to_owned()
    }
}

fn validate_id(id: &str) -> Result<(), PackageProblem> {
    let mut chars = id.chars();
    let valid_first = chars
        .next()
        .is_some_and(|c| c == '_' || c.is_ascii_lowercase());
    if !(2..=24).contains(&id.len())
        || !valid_first
        || !chars.all(|c| c == '_' || c.is_ascii_lowercase() || c.is_ascii_digit())
        || RESERVED_IDS.contains(&id)
    {
        return invalid(format!("invalid or reserved package id '{id}'"));
    }
    Ok(())
}

fn validate_relative_path(path: &Path) -> Result<(), PackageProblem> {
    if path.as_os_str().is_empty()
        || path.components().count() > 32
        || path.to_string_lossy().len() > 1024
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return invalid(format!("unsafe package path '{}'", path.display()));
    }
    Ok(())
}

fn invalid<T>(message: impl Into<String>) -> Result<T, PackageProblem> {
    Err(PackageProblem::Invalid(message.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn migrates_current_voxelcore_manifest() {
        let value = serde_json::json!({
            "id": "wire_demo",
            "title": "Wire demo",
            "version": "1.2",
            "creator": "Dagger",
            "description": "Demo",
            "dependencies": ["base_api@>=0.4", "?pretty_lights", "~load_first"]
        });
        let manifest = PackageManifest::from_legacy(value).unwrap();
        manifest.validate().unwrap();
        assert_eq!(manifest.version, "1.2.0");
        assert_eq!(manifest.dependencies[0].requirement, ">=0.4.0");
        assert_eq!(manifest.dependencies[1].kind, DependencyKind::Optional);
        assert_eq!(manifest.dependencies[2].kind, DependencyKind::Weak);
        assert_eq!(manifest.voxelcore, "*");
    }

    #[test]
    fn current_manifest_without_voxelcore_is_unrestricted() {
        let manifest: PackageManifest = serde_json::from_value(serde_json::json!({
            "schema_version": 1,
            "id": "wire_demo",
            "type": "mod",
            "title": "Wire demo",
            "version": "1.2.0",
            "creators": ["Dagger"],
            "description": "Demo",
            "license": "MIT"
        }))
        .unwrap();
        manifest.validate().unwrap();
        assert_eq!(manifest.voxelcore, "*");
    }

    #[test]
    fn delivery_is_sorted_and_hashed() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("package.json"),
            serde_json::to_vec(&serde_json::json!({
                "id": "demo_pack", "title": "Demo", "version": "1.0.0",
                "creator": "Dagger", "description": "Demo"
            }))
            .unwrap(),
        )
        .unwrap();
        fs::create_dir(temp.path().join("scripts")).unwrap();
        let mut file = fs::File::create(temp.path().join("scripts/main.lua")).unwrap();
        file.write_all(b"return true\n").unwrap();
        let delivery = DeliveryManifest::build(temp.path()).unwrap();
        assert_eq!(delivery.files.len(), 2);
        assert_eq!(delivery.files[0].path, "package.json");
        assert_eq!(delivery.files[1].sha256.len(), 64);
    }
}
