import importlib.util
import pathlib
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name("create-github-draft.py")
SPEC = importlib.util.spec_from_file_location("create_github_draft", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class GitHubReleaseDraftTests(unittest.TestCase):
    def test_collects_the_four_platform_builds(self):
        version = "1.2.3"
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            files = {
                ("linux", "x86_64"): ("VLauncher_1.2.3_amd64.AppImage", None),
                ("windows", "x86_64"): ("VLauncher_1.2.3_x64-setup.exe", None),
                ("darwin", "x86_64"): (
                    "VLauncher_1.2.3_x64.dmg",
                    "VLauncher_1.2.3_x64.app.tar.gz",
                ),
                ("darwin", "aarch64"): (
                    "VLauncher_1.2.3_aarch64.dmg",
                    "VLauncher_1.2.3_aarch64.app.tar.gz",
                ),
            }
            for (target, architecture), (installer_name, update_name) in files.items():
                folder = root / f"vlauncher-{version}-{target}-{architecture}"
                folder.mkdir(parents=True)
                installer = folder / installer_name
                installer.write_bytes(b"installer")
                update = installer if update_name is None else folder / update_name
                if update_name is not None:
                    update.write_bytes(b"update")
                pathlib.Path(f"{update}.sig").write_text("signature", encoding="utf-8")

            builds, uploads = MODULE.collect_builds(version, root)

        self.assertEqual(len(builds), 4)
        self.assertEqual(len(uploads), 10)
        self.assertIn("VLauncher_1.2.3_x86_64.AppImage", uploads)
        self.assertIn("VLauncher_1.2.3_aarch64.app.tar.gz.sig", uploads)
        self.assertEqual(
            {(build["target"], build["architecture"]) for build in builds},
            {
                ("linux", "x86_64"),
                ("windows", "x86_64"),
                ("darwin", "x86_64"),
                ("darwin", "aarch64"),
            },
        )


if __name__ == "__main__":
    unittest.main()
