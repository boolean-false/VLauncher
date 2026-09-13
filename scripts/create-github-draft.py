"""Создаёт GitHub draft и регистрирует его файлы в VSpace."""

import hashlib
import json
import os
import pathlib
import subprocess
import urllib.parse
import urllib.request

BUILDS = (
    ("linux", "x86_64", "*.AppImage", "*.AppImage"),
    ("windows", "x86_64", "*-setup.exe", "*-setup.exe"),
    ("darwin", "x86_64", "*.dmg", "*.app.tar.gz"),
    ("darwin", "aarch64", "*.dmg", "*.app.tar.gz"),
)
MAX_FILE_SIZE = 512 * 1024 * 1024


def one_file(folder: pathlib.Path, pattern: str) -> pathlib.Path:
    found = list(folder.rglob(pattern))
    if len(found) != 1:
        names = ", ".join(str(path) for path in found) or "nothing"
        raise RuntimeError(f"Expected one {pattern} in {folder}; found: {names}")
    return found[0]


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def collect_builds(
    version: str, root: pathlib.Path
) -> tuple[list[dict], dict[str, pathlib.Path]]:
    builds = []
    uploads: dict[str, pathlib.Path] = {}
    for target, architecture, installer_pattern, update_pattern in BUILDS:
        folder = root / f"vlauncher-{version}-{target}-{architecture}"
        installer = one_file(folder, installer_pattern)
        update = one_file(folder, update_pattern)
        signature = pathlib.Path(f"{update}.sig")
        if not signature.is_file():
            raise FileNotFoundError(signature)
        installer_suffix = {
            "linux": ".AppImage",
            "windows": "-setup.exe",
            "darwin": ".dmg",
        }[target]
        installer_name = f"VLauncher_{version}_{architecture}{installer_suffix}"
        update_name = (
            installer_name
            if target != "darwin"
            else f"VLauncher_{version}_{architecture}.app.tar.gz"
        )
        if installer == update:
            destination = folder / installer_name
            if installer != destination:
                installer.rename(destination)
            installer = update = destination
        else:
            installer_destination = folder / installer_name
            update_destination = folder / update_name
            if installer != installer_destination:
                installer.rename(installer_destination)
            if update != update_destination:
                update.rename(update_destination)
            installer = installer_destination
            update = update_destination
        signature_destination = pathlib.Path(f"{update}.sig")
        if signature != signature_destination:
            signature.rename(signature_destination)
        signature = signature_destination
        for path in {installer, update, signature}:
            if not path.stat().st_size:
                raise ValueError(f"Release file is empty: {path}")
            if path.stat().st_size > MAX_FILE_SIZE:
                raise ValueError(f"Release file exceeds 512 MiB: {path}")
            if path.name in uploads and uploads[path.name] != path:
                raise ValueError(f"Duplicate release filename: {path.name}")
            uploads[path.name] = path
        builds.append(
            {
                "target": target,
                "architecture": architecture,
                "installer": installer.name,
                "update": update.name,
                "signature_file": signature.name,
                "signature": signature.read_text(encoding="utf-8").strip(),
            }
        )
    if len(uploads) != 10:
        raise RuntimeError(f"Expected 10 release files, found {len(uploads)}")
    return builds, uploads


def main() -> None:
    version = os.environ["RELEASE_VERSION"]
    channel = os.environ["RELEASE_CHANNEL"]
    repository = os.environ["GITHUB_REPOSITORY"]
    commit = os.environ["GITHUB_SHA"]
    registry_url = os.environ["VLAUNCHER_REGISTRY_URL"].strip().rstrip("/")
    token = os.environ["VLAUNCHER_PUBLISH_TOKEN"].strip()
    if channel not in {"stable", "beta"}:
        raise ValueError("RELEASE_CHANNEL must be stable or beta")
    parsed = urllib.parse.urlsplit(registry_url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("VLAUNCHER_REGISTRY_URL must be a plain HTTPS API URL")
    if not token:
        raise ValueError("VLAUNCHER_PUBLISH_TOKEN is empty")

    builds, uploads = collect_builds(version, pathlib.Path("release-artifacts"))

    notes = pathlib.Path("RELEASE_NOTES.md")
    notes_text = notes.read_text(encoding="utf-8").strip()
    if not notes_text or notes_text.splitlines()[0].strip() != f"VLauncher {version}":
        raise ValueError("RELEASE_NOTES.md must start with the release version")

    tag = f"v{version}"
    command = [
        "gh",
        "release",
        "create",
        tag,
        *[str(path) for path in uploads.values()],
        "--draft",
        "--target",
        commit,
        "--title",
        f"VLauncher {version}",
        "--notes-file",
        str(notes),
    ]
    if channel == "beta":
        command.append("--prerelease")
    quiet = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if (
        subprocess.run(["gh", "release", "view", tag], check=False, **quiet).returncode
        == 0
    ):
        raise RuntimeError(f"GitHub release {tag} already exists")
    if (
        subprocess.run(
            ["gh", "api", f"repos/{repository}/git/ref/tags/{tag}"],
            check=False,
            **quiet,
        ).returncode
        == 0
    ):
        raise RuntimeError(f"Git tag {tag} already exists")
    try:
        subprocess.run(command, check=True)
        release = json.loads(
            subprocess.check_output(
                ["gh", "api", f"repos/{repository}/releases/tags/{tag}"],
                text=True,
            )
        )
        assets = {asset["name"]: asset for asset in release["assets"]}
        if set(assets) != set(uploads):
            raise RuntimeError("GitHub returned an unexpected release asset list")
        for name, path in uploads.items():
            asset = assets[name]
            if asset["size"] != path.stat().st_size:
                raise RuntimeError(f"GitHub returned an unexpected size for {name}")
            digest = asset.get("digest")
            if digest and digest != f"sha256:{sha256(path)}":
                raise RuntimeError(f"GitHub returned an unexpected digest for {name}")
        payload = {
            "version": version,
            "channel": channel,
            "notes": notes_text,
            "github_release_id": release["id"],
            "github_release_tag": tag,
            "builds": [
                {
                    "target": build["target"],
                    "architecture": build["architecture"],
                    "signature": build["signature"],
                    "installer_asset_id": assets[build["installer"]]["id"],
                    "update_asset_id": assets[build["update"]]["id"],
                    "signature_asset_id": assets[build["signature_file"]]["id"],
                }
                for build in builds
            ],
        }
        request = urllib.request.Request(
            f"{registry_url}/admin/launcher-releases/github-draft",
            data=json.dumps(payload).encode(),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            json.load(response)
    except Exception:
        subprocess.run(
            ["gh", "release", "delete", tag, "--cleanup-tag", "--yes"],
            check=False,
        )
        raise

    print(f"GitHub draft {tag} is ready for review in VLauncher")


if __name__ == "__main__":
    main()
