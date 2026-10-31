//! Project branding is derived at launch; installed engines and projects stay immutable.
use image::{DynamicImage, ImageFormat, ImageReader};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Read},
    path::Path,
};
use vlauncher_core::LaunchSpec;

fn project_icon(project: &Path) -> Option<DynamicImage> {
    let root = project.canonicalize().ok()?;
    for relative in ["icon.png", "textures/misc/icon.png"] {
        let path = project.join(relative);
        let metadata = fs::symlink_metadata(&path).ok();
        if !metadata
            .as_ref()
            .is_some_and(|m| m.is_file() && m.len() <= 4 * 1024 * 1024)
        {
            continue;
        }
        if !path.canonicalize().ok()?.starts_with(&root) {
            continue;
        }
        let mut bytes = Vec::new();
        if fs::File::open(path)
            .and_then(|file| file.take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes))
            .is_err()
            || bytes.len() > 4 * 1024 * 1024
        {
            continue;
        }
        let mut reader = ImageReader::with_format(Cursor::new(bytes), ImageFormat::Png);
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(4096);
        limits.max_image_height = Some(4096);
        limits.max_alloc = Some(64 * 1024 * 1024);
        reader.limits(limits);
        if let Ok(icon) = reader.decode() {
            return Some(icon);
        }
    }
    None
}

fn png(icon: &DynamicImage, size: u32) -> Result<Vec<u8>, String> {
    let mut out = Cursor::new(Vec::new());
    icon.resize_exact(size, size, image::imageops::FilterType::Lanczos3)
        .write_to(&mut out, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

// Hash the full inventory, including timestamps, so edits to attached engines invalidate it.
// Reject resource symlinks rather than following cycles or copying files outside the engine.
fn resource_tree(source: &Path, target: Option<&Path>, hash: &mut Sha256) -> Result<(), String> {
    let mut entries = fs::read_dir(source)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    entries.sort_by_key(|e| e.file_name());
    if let Some(target) = target {
        fs::create_dir_all(target).map_err(|e| e.to_string())?;
    }
    for entry in entries {
        let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        hash.update(entry.file_name().as_encoded_bytes());
        hash.update([0]);
        hash.update(meta.len().to_le_bytes());
        if let Ok(time) = meta.modified().and_then(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .map_err(std::io::Error::other)
        }) {
            hash.update(time.as_nanos().to_le_bytes());
        }
        let destination = target.map(|p| p.join(entry.file_name()));
        if meta.is_dir() {
            hash.update(b"dir");
            resource_tree(&entry.path(), destination.as_deref(), hash)?;
        } else if meta.is_file() {
            hash.update(b"file");
            if let Some(destination) = destination {
                fs::copy(entry.path(), destination).map_err(|e| e.to_string())?;
            }
        } else {
            return Err(format!(
                "Unsupported resource link: {}",
                entry.path().display()
            ));
        }
    }
    Ok(())
}

pub fn prepare(mut spec: LaunchSpec, cache: &Path, profile_id: &str) -> Result<LaunchSpec, String> {
    let Some(icon) = spec.project_path.as_deref().and_then(project_icon) else {
        return Ok(spec);
    };
    let bytes = png(&icon, 256)?;
    let mut hash = Sha256::new();
    hash.update(b"project-branding-v1");
    hash.update(&bytes);
    if let Some(project) = spec
        .project_path
        .as_deref()
        .and_then(|p| vlauncher_core::VoxelCoreProject::read(p).ok())
    {
        hash.update(project.title.as_bytes());
    }
    hash.update(spec.executable.as_os_str().as_encoded_bytes());
    let meta = fs::metadata(&spec.executable).map_err(|e| e.to_string())?;
    hash.update(meta.len().to_le_bytes());
    hash.update(format!("{:?}", meta.modified()).as_bytes());
    hash.update(spec.resources_path.as_os_str().as_encoded_bytes());
    hash.update(serde_json::to_vec(&spec.arguments).map_err(|e| e.to_string())?);
    resource_tree(&spec.resources_path, None, &mut hash)?;
    let root = cache.join("project-launch").join(profile_id);
    let destination = root.join(format!("{:x}", hash.finalize()));
    let res = destination.join("res");
    if !res.as_os_str().is_ascii() {
        return Err("Путь к кэшу запуска содержит нелатинские символы".into());
    }
    if !destination.is_dir() {
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let temporary = tempfile::tempdir_in(&root).map_err(|e| e.to_string())?;
        let resources = temporary.path().join("res");
        resource_tree(&spec.resources_path, Some(&resources), &mut Sha256::new())?;
        let icon_path = resources.join("textures/misc/icon.png");
        fs::create_dir_all(icon_path.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(icon_path, &bytes).map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        mac_app(&spec, &icon, temporary.path(), &destination, profile_id)?;
        fs::rename(temporary.path(), &destination).map_err(|e| e.to_string())?;
    }
    let index = spec
        .arguments
        .iter()
        .position(|arg| arg == "--res")
        .ok_or("Missing resource argument")?;
    *spec
        .arguments
        .get_mut(index + 1)
        .ok_or("Missing resource path")? = res.to_string_lossy().into_owned();
    #[cfg(target_os = "macos")]
    {
        spec.executable = destination.join("Game.app/Contents/MacOS/Launch");
        spec.arguments.clear(); // The wrapper retains arguments when reopened from the Dock.
    }
    Ok(spec)
}

#[cfg(target_os = "macos")]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(target_os = "macos")]
fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(target_os = "macos")]
fn mac_app(
    spec: &LaunchSpec,
    icon: &DynamicImage,
    temporary: &Path,
    destination: &Path,
    id: &str,
) -> Result<(), String> {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let contents = temporary.join("Game.app/Contents");
    let bin = contents.join("MacOS");
    let resources = contents.join("Resources");
    fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    fs::create_dir_all(&resources).map_err(|e| e.to_string())?;
    // Keep the original basename: some runtimes locate their adjacent libraries by name.
    let exe_name = spec
        .executable
        .file_name()
        .ok_or("Missing engine executable name")?;
    if exe_name == "Launch" {
        return Err("Reserved engine executable name: Launch".into());
    }
    fs::copy(&spec.executable, bin.join(exe_name)).map_err(|e| e.to_string())?;
    let parent = spec.executable.parent().ok_or("Missing engine directory")?;
    for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name() == exe_name || entry.file_name() == "Launch" {
            continue;
        }
        symlink(entry.path(), bin.join(entry.file_name())).map_err(|e| e.to_string())?;
    }
    // Support attached .app runtimes using @executable_path/../Frameworks.
    if parent.file_name().is_some_and(|n| n == "MacOS") {
        if let Some(source_contents) = parent.parent() {
            let frameworks = source_contents.join("Frameworks");
            if frameworks.is_dir() {
                symlink(frameworks, contents.join("Frameworks")).map_err(|e| e.to_string())?;
            }
        }
    }
    let mut chunks = Vec::new();
    for (kind, size) in [
        (b"ic07", 128),
        (b"ic08", 256),
        (b"ic09", 512),
        (b"ic10", 1024),
    ] {
        let bytes = png(icon, size)?;
        chunks.extend_from_slice(kind);
        chunks.extend_from_slice(&((bytes.len() + 8) as u32).to_be_bytes());
        chunks.extend_from_slice(&bytes);
    }
    let mut icns = b"icns".to_vec();
    icns.extend_from_slice(&((chunks.len() + 8) as u32).to_be_bytes());
    icns.extend(chunks);
    fs::write(resources.join("Project.icns"), icns).map_err(|e| e.to_string())?;
    let title = spec
        .project_path
        .as_deref()
        .and_then(|p| vlauncher_core::VoxelCoreProject::read(p).ok())
        .map(|p| p.title)
        .unwrap_or_else(|| "Game".into());
    let info = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>space.vlauncher.project.{id}</string><key>CFBundleName</key><string>{}</string><key>CFBundleDisplayName</key><string>{}</string><key>CFBundleExecutable</key><string>Launch</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleIconFile</key><string>Project.icns</string><key>NSHighResolutionCapable</key><true/></dict></plist>"#,
        xml(&title),
        xml(&title)
    );
    fs::write(contents.join("Info.plist"), info).map_err(|e| e.to_string())?;
    let final_bin = destination.join("Game.app/Contents/MacOS");
    let mut args = spec.arguments.clone();
    let index = args
        .iter()
        .position(|a| a == "--res")
        .ok_or("Missing resource argument")?;
    *args.get_mut(index + 1).ok_or("Missing resource path")? =
        destination.join("res").to_string_lossy().into_owned();
    let script = format!(
        "#!/bin/sh\ncd {} || exit 1\nexec {} {}\n",
        shell_quote(&spec.working_directory.to_string_lossy()),
        shell_quote(&final_bin.join(exe_name).to_string_lossy()),
        args.iter()
            .map(|a| shell_quote(a))
            .collect::<Vec<_>>()
            .join(" ")
    );
    fs::write(bin.join("Launch"), script).map_err(|e| e.to_string())?;
    fs::set_permissions(bin.join("Launch"), fs::Permissions::from_mode(0o755))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(root: &Path) -> LaunchSpec {
        let project = root.join("project");
        let resources = root.join("engine/res");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(resources.join("textures/misc")).unwrap();
        fs::write(resources.join("textures/misc/icon.png"), b"original").unwrap();
        fs::write(resources.join("other.txt"), b"resource").unwrap();
        fs::write(
            project.join("project.toml"),
            "name = 'demo'\ntitle = 'A & B'\n",
        )
        .unwrap();
        let executable = root.join("engine/Engine");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::write(&executable, b"#!/bin/sh\nprintf '%s\\n' \"$@\"\n").unwrap();
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        }
        #[cfg(not(unix))]
        fs::write(&executable, b"engine").unwrap();
        LaunchSpec {
            executable,
            arguments: vec![
                "--res".into(),
                resources.to_string_lossy().into_owned(),
                "--project".into(),
                project.to_string_lossy().into_owned(),
                "quote' space $(touch NEVER)".into(),
            ],
            project_path: Some(project),
            resources_path: resources,
            working_directory: root.join("engine"),
            log_path: root.join("log"),
        }
    }
    fn write_icon(spec: &LaunchSpec, color: u8) {
        let image = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            32,
            32,
            image::Rgba([color, 0, 0, 255]),
        ));
        fs::write(
            spec.project_path.as_ref().unwrap().join("icon.png"),
            png(&image, 32).unwrap(),
        )
        .unwrap();
    }
    #[test]
    fn missing_or_invalid_icon_keeps_original_launch() {
        let root = tempfile::tempdir().unwrap();
        let spec = fixture(root.path());
        assert_eq!(
            prepare(spec.clone(), &root.path().join("cache"), "demo").unwrap(),
            spec
        );
        fs::write(
            spec.project_path.as_ref().unwrap().join("icon.png"),
            b"invalid",
        )
        .unwrap();
        assert_eq!(
            prepare(spec.clone(), &root.path().join("cache"), "demo").unwrap(),
            spec
        );
    }
    #[test]
    fn branding_preserves_sources_and_invalidates_cached_icon() {
        let root = tempfile::tempdir().unwrap();
        let spec = fixture(root.path());
        write_icon(&spec, 100);
        let original_engine = fs::read(&spec.executable).unwrap();
        let cache = root.path().join("cache");
        let first = prepare(spec.clone(), &cache, "demo").unwrap();
        assert_eq!(prepare(spec.clone(), &cache, "demo").unwrap(), first);
        assert_eq!(
            fs::read(spec.resources_path.join("textures/misc/icon.png")).unwrap(),
            b"original"
        );
        assert_eq!(fs::read(&spec.executable).unwrap(), original_engine);
        write_icon(&spec, 200);
        let second = prepare(spec.clone(), &cache, "demo").unwrap();
        assert_ne!(first, second);
        fs::write(
            spec.resources_path.join("other.txt"),
            b"new resource length",
        )
        .unwrap();
        assert_ne!(prepare(spec, &cache, "demo").unwrap(), second);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn mac_bundle_keeps_project_identity_and_exact_arguments() {
        let root = tempfile::Builder::new()
            .prefix("launch ' test")
            .tempdir()
            .unwrap();
        let spec = fixture(root.path());
        write_icon(&spec, 100);
        let prepared = prepare(spec.clone(), &root.path().join("cache"), "demo").unwrap();
        let output = std::process::Command::new(&prepared.executable)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "status: {:?}; stderr: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(text.contains("quote' space $(touch NEVER)"));
        assert!(!spec.working_directory.join("NEVER").exists());
        let contents = prepared.executable.parent().unwrap().parent().unwrap();
        let info = fs::read_to_string(contents.join("Info.plist")).unwrap();
        assert!(info.contains("A &amp; B"));
        assert!(info.contains("space.vlauncher.project.demo"));
        let icns = fs::read(contents.join("Resources/Project.icns")).unwrap();
        assert_eq!(&icns[..4], b"icns");
        assert_eq!(
            u32::from_be_bytes(icns[4..8].try_into().unwrap()) as usize,
            icns.len()
        );
        assert!(prepared.arguments.is_empty());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn mac_native_process_reads_its_project_bundle_and_dock_icon() {
        use std::{
            io::Write,
            process::{Command, Stdio},
        };
        let root = tempfile::tempdir().unwrap();
        let spec = fixture(root.path());
        write_icon(&spec, 100);
        let source = br#"#import <AppKit/AppKit.h>
int main() { @autoreleasepool {
    NSApplication *app = [NSApplication sharedApplication];
    printf("bundle=%s\n", NSBundle.mainBundle.bundleIdentifier.UTF8String);
    NSBitmapImageRep *rep = [NSBitmapImageRep imageRepWithData:app.applicationIconImage.TIFFRepresentation];
    NSColor *c = [[rep colorAtX:rep.pixelsWide/2 y:rep.pixelsHigh/2] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    printf("project-color=%d\n", c.redComponent - c.greenComponent > 0.25 && c.redComponent - c.blueComponent > 0.25);
} return 0; }
"#;
        // A native application is necessary here: shell scripts cannot inspect NSBundle.
        let mut compiler = Command::new("/usr/bin/clang")
            .args(["-x", "objective-c", "-framework", "AppKit", "-o"])
            .arg(&spec.executable)
            .arg("-")
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        compiler.stdin.take().unwrap().write_all(source).unwrap();
        let compiled = compiler.wait_with_output().unwrap();
        assert!(
            compiled.status.success(),
            "{}",
            String::from_utf8_lossy(&compiled.stderr)
        );
        let prepared = prepare(spec, &root.path().join("cache"), "native-test").unwrap();
        let result = Command::new(prepared.executable).output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let text = String::from_utf8(result.stdout).unwrap();
        assert!(
            text.contains("bundle=space.vlauncher.project.native-test"),
            "{text}"
        );
        // Dock applies system rendering/color conversion; verify the project's red,
        // rather than requiring byte-identical channels from the rendered image.
        assert!(text.contains("project-color=1"), "{text}");
    }
    #[cfg(unix)]
    #[test]
    fn icon_symlinks_outside_project_are_ignored() {
        let root = tempfile::tempdir().unwrap();
        let spec = fixture(root.path());
        write_icon(&spec, 100);
        let project = spec.project_path.as_ref().unwrap();
        fs::rename(project.join("icon.png"), root.path().join("outside.png")).unwrap();
        std::os::unix::fs::symlink(root.path().join("outside.png"), project.join("icon.png"))
            .unwrap();
        assert_eq!(
            prepare(spec.clone(), &root.path().join("cache"), "demo").unwrap(),
            spec
        );
    }
}
