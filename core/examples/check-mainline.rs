//! VLAUNCHER_GITHUB_TOKEN=... cargo run --manifest-path core/Cargo.toml --example check-mainline
use vlauncher_core::{ProfileStore, mainline};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let token = std::env::var("VLAUNCHER_GITHUB_TOKEN")?;
    let catalog = mainline::list(&token)?;
    let build = catalog.builds.first().ok_or("No available main build")?;
    println!("Main HEAD: {}; selected: {}", catalog.head_sha, build.sha);
    let temporary = tempfile::tempdir()?;
    let store = ProfileStore::open(temporary.path().join("library"))?;
    let runtime = mainline::install(&store, build, &token, |_, _| true)?;
    assert_eq!(runtime.main_build.as_ref(), Some(build));
    let profile = store.create_initialized("Integration main", "0.31.4")?;
    store.select_main_build(profile.id, Some(build.clone()))?;
    let spec = store.launch_spec(profile.id, &build.runtime_id())?;
    assert!(spec.executable.is_file());
    let res = std::path::Path::new(&spec.arguments[1]);
    assert!(res.join("scripts/stdmin.lua").is_file());
    assert!(std::fs::read_to_string(res.join("scripts/stdmin.lua"))?.contains("is_client"));
    #[cfg(target_os = "linux")]
    {
        let script = temporary.path().join("check.lua");
        std::fs::write(
            &script,
            "assert(type(vc) == 'table'); assert(vc.is_headless()); assert(not vc.is_client()); print('VLAUNCHER_MAINLINE_API_OK'); app.quit()",
        )?;
        let output = std::process::Command::new("timeout")
            .arg("20s")
            .arg(&spec.executable)
            .args(&spec.arguments)
            .arg("--headless")
            .arg("--script")
            .arg(&script)
            .current_dir(&spec.working_directory)
            .env("APPDIR", &spec.working_directory)
            .env("SYSTEM_INTERP", "/lib64/ld-linux-x86-64.so.2")
            .env_remove("LD_LIBRARY_PATH")
            .env_remove("LD_PRELOAD")
            .env_remove("APPIMAGE")
            .output()?;
        if !output.status.success()
            || !String::from_utf8_lossy(&output.stdout).contains("VLAUNCHER_MAINLINE_API_OK")
        {
            return Err(format!(
                "Headless engine check failed: {}\n{}\n{}",
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
            .into());
        }
        println!("Headless engine initialized vc API and exited successfully.");
    }
    let export = temporary.path().join("profile.json");
    store.export_profile(profile.id, &export)?;
    assert_eq!(
        ProfileStore::read_profile_definition(export)?
            .main_build
            .as_ref(),
        Some(build)
    );
    let clone = store.clone_profile(profile.id, "Clone main")?;
    assert_eq!(clone.main_build.as_ref(), Some(build));
    store.rollback(profile.id)?;
    assert!(
        store
            .list()?
            .iter()
            .find(|p| p.id == profile.id)
            .unwrap()
            .main_build
            .is_none()
    );
    println!(
        "Verified archive hash, installation, resources, pinned launch, clone, export and rollback."
    );
    Ok(())
}
