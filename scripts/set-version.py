#!/usr/bin/env python3
"""Меняет версию VLauncher во всех конфигах."""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys


ROOT = pathlib.Path(__file__).resolve().parent.parent
SEMVER = re.compile(
    r"(?:0|[1-9][0-9]*)\."
    r"(?:0|[1-9][0-9]*)\."
    r"(?:0|[1-9][0-9]*)"
    r"(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?"
)


def read_json(path: pathlib.Path) -> tuple[dict, str]:
    text = path.read_text(encoding="utf-8")
    newline = "\r\n" if "\r\n" in text else "\n"
    return json.loads(text), newline


def render_json(document: dict, newline: str) -> str:
    return json.dumps(document, ensure_ascii=False, indent=2) + newline


def package_version(text: str, path: pathlib.Path) -> str:
    match = re.search(
        r"(?ms)^\[package\]\s*.*?^version\s*=\s*\"([^\"]+)\"",
        text,
    )
    if not match:
        raise ValueError(f"{path}: [package].version not found")
    return match.group(1)


def replace_package_version(text: str, version: str, path: pathlib.Path) -> str:
    updated, count = re.subn(
        r"(?ms)(^\[package\]\s*.*?^version\s*=\s*\")[^\"]+(\")",
        rf"\g<1>{version}\2",
        text,
        count=1,
    )
    if count != 1:
        raise ValueError(f"{path}: expected one [package].version")
    return updated


def lock_versions(text: str, package_names: set[str]) -> dict[str, str]:
    found: dict[str, str] = {}
    for block in re.split(r"(?=^\[\[package\]\]$)", text, flags=re.MULTILINE):
        name = re.search(r'^name\s*=\s*"([^"]+)"$', block, re.MULTILINE)
        version = re.search(r'^version\s*=\s*"([^"]+)"$', block, re.MULTILINE)
        if name and version and name.group(1) in package_names:
            found[name.group(1)] = version.group(1)
    missing = package_names - found.keys()
    if missing:
        raise ValueError(f"Cargo.lock: missing packages: {', '.join(sorted(missing))}")
    return found


def replace_lock_versions(text: str, package_names: set[str], version: str) -> str:
    blocks = re.split(r"(?=^\[\[package\]\]$)", text, flags=re.MULTILINE)
    changed: set[str] = set()
    for index, block in enumerate(blocks):
        name = re.search(r'^name\s*=\s*"([^"]+)"$', block, re.MULTILINE)
        if not name or name.group(1) not in package_names:
            continue
        blocks[index], count = re.subn(
            r'(?m)(^version\s*=\s*")[^"]+("$)',
            rf"\g<1>{version}\2",
            block,
            count=1,
        )
        if count != 1:
            raise ValueError(f"Cargo.lock: version missing for {name.group(1)}")
        changed.add(name.group(1))
    missing = package_names - changed
    if missing:
        raise ValueError(f"Cargo.lock: packages not updated: {', '.join(sorted(missing))}")
    return "".join(blocks)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("version", help="target SemVer, for example 1.0.2 or 1.1.0-beta.1")
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the version without writing files",
    )
    args = parser.parse_args()
    if not SEMVER.fullmatch(args.version):
        parser.error("version must be valid SemVer without build metadata")

    package_path = ROOT / "package.json"
    package_lock_path = ROOT / "package-lock.json"
    tauri_config_path = ROOT / "src-tauri" / "tauri.conf.json"
    core_manifest_path = ROOT / "core" / "Cargo.toml"
    tauri_manifest_path = ROOT / "src-tauri" / "Cargo.toml"
    core_lock_path = ROOT / "core" / "Cargo.lock"
    tauri_lock_path = ROOT / "src-tauri" / "Cargo.lock"

    package, package_newline = read_json(package_path)
    package_lock, package_lock_newline = read_json(package_lock_path)
    tauri_config, tauri_config_newline = read_json(tauri_config_path)
    core_manifest = core_manifest_path.read_text(encoding="utf-8")
    tauri_manifest = tauri_manifest_path.read_text(encoding="utf-8")
    core_lock = core_lock_path.read_text(encoding="utf-8")
    tauri_lock = tauri_lock_path.read_text(encoding="utf-8")
    tauri_lock_packages = lock_versions(tauri_lock, {"vlauncher", "vlauncher-core"})

    versions = {
        "package.json": package["version"],
        "package-lock.json": package_lock["version"],
        "package-lock.json packages['']": package_lock["packages"][""]["version"],
        "src-tauri/tauri.conf.json": tauri_config["version"],
        "core/Cargo.toml": package_version(core_manifest, core_manifest_path),
        "src-tauri/Cargo.toml": package_version(tauri_manifest, tauri_manifest_path),
        "core/Cargo.lock vlauncher-core": lock_versions(
            core_lock, {"vlauncher-core"}
        )["vlauncher-core"],
        "src-tauri/Cargo.lock vlauncher": tauri_lock_packages["vlauncher"],
        "src-tauri/Cargo.lock vlauncher-core": tauri_lock_packages["vlauncher-core"],
    }
    current_versions = set(versions.values())
    if len(current_versions) != 1:
        details = "\n".join(f"  {path}: {value}" for path, value in versions.items())
        raise ValueError(f"current versions are inconsistent:\n{details}")
    old_version = current_versions.pop()

    if args.check:
        if old_version != args.version:
            raise ValueError(
                f"expected {args.version}, but project metadata is {old_version}"
            )
        print(f"VLauncher version is consistently {args.version}.")
        return 0

    package["version"] = args.version
    package_lock["version"] = args.version
    package_lock["packages"][""]["version"] = args.version
    tauri_config["version"] = args.version
    updates = {
        package_path: render_json(package, package_newline),
        package_lock_path: render_json(package_lock, package_lock_newline),
        tauri_config_path: render_json(tauri_config, tauri_config_newline),
        core_manifest_path: replace_package_version(
            core_manifest, args.version, core_manifest_path
        ),
        tauri_manifest_path: replace_package_version(
            tauri_manifest, args.version, tauri_manifest_path
        ),
        core_lock_path: replace_lock_versions(
            core_lock, {"vlauncher-core"}, args.version
        ),
        tauri_lock_path: replace_lock_versions(
            tauri_lock, {"vlauncher", "vlauncher-core"}, args.version
        ),
    }
    for path, text in updates.items():
        path.write_text(text, encoding="utf-8", newline="")
    print(f"VLauncher {old_version} -> {args.version}; updated {len(updates)} files.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (KeyError, ValueError) as error:
        print(f"set-version: {error}", file=sys.stderr)
        raise SystemExit(1)
