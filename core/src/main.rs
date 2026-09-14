use std::{env, fs, path::PathBuf, process::ExitCode};

use serde::Serialize;
use vlauncher_core::{
    DeliveryManifest, PackageManifest, ProfileStore, SignedRemoteInstallPlan, prepare_package,
    upload_package,
};

#[derive(Serialize)]
struct CommandResult<T: Serialize> {
    ok: bool,
    result: Option<T>,
    error: Option<String>,
}

fn main() -> ExitCode {
    match execute() {
        Ok(value) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&CommandResult {
                    ok: true,
                    result: Some(value),
                    error: None,
                })
                .expect("serializable result")
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&CommandResult::<serde_json::Value> {
                    ok: false,
                    result: None,
                    error: Some(error),
                })
                .expect("serializable error")
            );
            ExitCode::FAILURE
        }
    }
}

fn execute() -> Result<serde_json::Value, String> {
    let mut args = env::args().skip(1);
    let command = args.next().ok_or_else(usage)?;
    let path = PathBuf::from(args.next().ok_or_else(usage)?);
    match command.as_str() {
        "validate" => {
            let manifest = PackageManifest::read(path).map_err(|error| error.to_string())?;
            serde_json::to_value(manifest).map_err(|error| error.to_string())
        }
        "migrate" => {
            let manifest = PackageManifest::read(&path).map_err(|error| error.to_string())?;
            if args.next().as_deref() == Some("--write") {
                let backup = manifest
                    .write_migrated(path)
                    .map_err(|error| error.to_string())?;
                Ok(serde_json::json!({ "manifest": manifest, "backup": backup }))
            } else {
                serde_json::to_value(manifest).map_err(|error| error.to_string())
            }
        }
        "delivery" => {
            let manifest = DeliveryManifest::build(path).map_err(|error| error.to_string())?;
            serde_json::to_value(manifest).map_err(|error| error.to_string())
        }
        "install-remote" => {
            let plan_path = PathBuf::from(args.next().ok_or_else(usage)?);
            let bytes = fs::read(&plan_path).map_err(|error| error.to_string())?;
            let plan: SignedRemoteInstallPlan =
                serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
            let store = ProfileStore::open(path).map_err(|error| error.to_string())?;
            let profile = store
                .create("CLI test profile")
                .map_err(|error| error.to_string())?;
            store
                .apply_signed_remote(profile.id, &plan)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(profile).map_err(|error| error.to_string())
        }
        "install-runtime" => {
            let plan_path = PathBuf::from(args.next().ok_or_else(usage)?);
            let bytes = fs::read(&plan_path).map_err(|error| error.to_string())?;
            let plan: SignedRemoteInstallPlan =
                serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
            let store = ProfileStore::open(path).map_err(|error| error.to_string())?;
            let runtime = store
                .install_signed_runtime(&plan)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(runtime).map_err(|error| error.to_string())
        }
        "prepare" => {
            let output = PathBuf::from(args.next().ok_or_else(usage)?);
            let artifact = prepare_package(path, output).map_err(|error| error.to_string())?;
            serde_json::to_value(artifact).map_err(|error| error.to_string())
        }
        "publish" => {
            let registry = args.next().ok_or_else(usage)?;
            let project_id = args.next().ok_or_else(usage)?;
            let channel = args.next().unwrap_or_else(|| "stable".into());
            let token = env::var("VLAUNCHER_TOKEN")
                .map_err(|_| "VLAUNCHER_TOKEN environment variable is required".to_owned())?;
            let output = env::temp_dir().join("vlauncher-prepared");
            let artifact = prepare_package(path, output).map_err(|error| error.to_string())?;
            let receipt = upload_package(
                &registry,
                &token,
                &project_id,
                &artifact,
                &channel,
                "Published with vlauncher-core",
            )
            .map_err(|error| error.to_string())?;
            serde_json::to_value(receipt).map_err(|error| error.to_string())
        }
        _ => Err(usage()),
    }
}

fn usage() -> String {
    "usage: vlauncher-core <validate|migrate|delivery|prepare|publish|install-remote|install-runtime> <path> [arguments]".into()
}
