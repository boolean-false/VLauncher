"""Подготовка GTK-плагина для AppImage."""

import hashlib
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request

MARKER = "# VLauncher host Wayland libraries v1"
UPSTREAM_COMMIT = "b5eb8d05b4c0ed40107fe2158c5d8527f94568ef"
URL = (
    "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/"
    f"{UPSTREAM_COMMIT}/linuxdeploy-plugin-gtk.sh"
)
UPSTREAM_SHA256 = "cb379f9b0733e9ad9f8bd78f8c2fa038aef2478523bb7d4c8e64ff6a1ea3501a"


def sha256(source: str) -> str:
    return hashlib.sha256(source.encode()).hexdigest()


def pinned_source() -> str:
    for attempt in range(4):
        try:
            with urllib.request.urlopen(URL, timeout=30) as response:
                source = response.read().decode()
            break
        except urllib.error.URLError:
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)
    actual = sha256(source)
    if actual != UPSTREAM_SHA256:
        raise RuntimeError(f"GTK deployment plugin checksum mismatch: {actual}")
    return source


def patch_plugin(source: str) -> str:
    if MARKER in source:
        return source
    if 'HOOKFILE="$HOOKSDIR/linuxdeploy-plugin-gtk.sh"' not in source:
        raise RuntimeError("GTK deployment plugin changed; review compatibility patch")
    # GTK сам выберет Wayland или X11.
    source = "\n".join(
        line for line in source.splitlines()
        if not line.startswith("export GDK_BACKEND=x11")
    )
    return source + '\n' + MARKER + r'''
# Эти библиотеки должны браться из системы вместе с Mesa.
test -n "$APPDIR" && test -d "$APPDIR/usr"
find "$APPDIR/usr" \( -type f -o -type l \) \
    \( -name 'libwayland-client.so*' -o -name 'libwayland-server.so*' \
       -o -name 'libwayland-cursor.so*' -o -name 'libwayland-egl.so*' \) -delete
'''


def main() -> None:
    if sys.platform != "linux":
        return
    cache = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "tauri"
    cache.mkdir(parents=True, exist_ok=True)
    plugin = cache / "linuxdeploy-plugin-gtk.sh"
    source = plugin.read_text() if plugin.exists() else None
    upstream = pinned_source()
    patched = patch_plugin(upstream)
    if source == patched:
        return
    if source is not None:
        backup = plugin.with_suffix(".sh.vlauncher-original")
        if not backup.exists():
            backup.write_text(source)
    plugin.write_text(patched)
    plugin.chmod(0o755)


if __name__ == "__main__":
    main()
