import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "prepare_linux_bundle", Path(__file__).with_name("prepare-linux-bundle.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BundleTests(unittest.TestCase):
    def test_pinned_source_retries_a_network_error(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def read(self):
                return b"source"

        error = urllib.error.URLError("connection reset")
        with (
            patch.object(module.urllib.request, "urlopen", side_effect=[error, Response()]) as request,
            patch.object(module.time, "sleep") as sleep,
            patch.object(module, "sha256", return_value=module.UPSTREAM_SHA256),
        ):
            self.assertEqual(module.pinned_source(), "source")
        self.assertEqual(request.call_count, 2)
        sleep.assert_called_once_with(1)

    def test_pinned_source_rejects_unexpected_content(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def read(self):
                return b"unexpected"

        with patch.object(module.urllib.request, "urlopen", return_value=Response()):
            with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                module.pinned_source()

    def test_removes_only_wayland_and_preserves_backend_choice(self):
        source = '''#!/bin/bash
set -e
APPDIR="$1"
HOOKSDIR="$APPDIR"
HOOKFILE="$HOOKSDIR/linuxdeploy-plugin-gtk.sh"
cat > "$HOOKFILE" <<'EOF'
export GDK_BACKEND=x11 # upstream default
gsettings get org.gnome.desktop.interface gtk-theme 2> /dev/null | grep -qi "dark" && GTK_THEME_VARIANT="dark" || GTK_THEME_VARIANT="light"
APPIMAGE_GTK_THEME="${APPIMAGE_GTK_THEME:-"Adwaita:$GTK_THEME_VARIANT"}" # Allow user to override theme (discouraged)
export GTK_THEME="$APPIMAGE_GTK_THEME"
EOF
'''
        patched = module.patch_plugin(source)
        self.assertEqual(module.patch_plugin(patched), patched)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            libs = root / "usr/lib"
            libs.mkdir(parents=True)
            (libs / "libwayland-client.so.0.23").touch()
            (libs / "libwayland-client.so.0").symlink_to("libwayland-client.so.0.23")
            (libs / "libgtk-3.so.0").touch()
            subprocess.run(["bash", "-s", "--", str(root)], input=patched, text=True, check=True)
            self.assertEqual([p.name for p in libs.iterdir()], ["libgtk-3.so.0"])
            hook = (root / "linuxdeploy-plugin-gtk.sh").read_text()
            self.assertNotIn("GDK_BACKEND", hook)
            self.assertIn('APPIMAGE_GTK_THEME="${APPIMAGE_GTK_THEME:-"Adwaita:dark"}"', hook)
            self.assertNotIn("GTK_THEME_VARIANT", hook)
            self.assertIn('export GTK_THEME="$APPIMAGE_GTK_THEME"', hook)

    def test_unknown_plugin_is_rejected(self):
        with self.assertRaises(RuntimeError):
            module.patch_plugin("#!/bin/bash\n")


if __name__ == "__main__":
    unittest.main()
