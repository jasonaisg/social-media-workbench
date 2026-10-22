"""Search-cache installer regression checks without touching real WeChat data."""
import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/wechat_search_cache.py"
SPEC = importlib.util.spec_from_file_location("wechat_search_cache_test", SCRIPT)
cache = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cache)


class SearchCacheInstallTests(unittest.TestCase):
    def _project(self, root: Path) -> Path:
        project = root / "project"
        scripts = project / "scripts"
        scripts.mkdir(parents=True)
        (scripts / "wechat_search_bridge.js").write_text(
            cache.START + "\nconst url = __SPH_WS_URL__;\n" + cache.END,
            encoding="utf-8",
        )
        return project

    def test_incompatible_profile_does_not_block_compatible_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = self._project(root)
            resources = root / "Library/Containers/com.tencent.xinWeChat/Data/Documents/app_data/radium/users"
            compatible = resources / "a/xworker/search/resources/package/200/dist/build.good.js"
            incompatible = resources / "b/xworker/search/resources/package/209/dist/build.new.js"
            compatible.parent.mkdir(parents=True)
            incompatible.parent.mkdir(parents=True)
            compatible.write_text(
                "mmpcwebsearch;" + cache.NATIVE_HOOK_NEEDLE, encoding="utf-8"
            )
            incompatible.write_text("mmpcwebsearch;new-layout", encoding="utf-8")

            self.assertEqual(cache.install(project, root, "ws://127.0.0.1:2022/ws/mp"), (1, 1, 1))
            self.assertIn(cache.NATIVE_HOOK, compatible.read_text(encoding="utf-8"))
            self.assertEqual(incompatible.read_text(encoding="utf-8"), "mmpcwebsearch;new-layout")

    def test_resource_209_native_hook_is_supported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = self._project(root)
            bundle = (
                root
                / "Library/Containers/com.tencent.xinWeChat/Data/Documents/app_data/radium/users"
                / "active/xworker/search/resources/package/209/dist/build.new.js"
            )
            bundle.parent.mkdir(parents=True)
            bundle.write_text(
                "mmpcwebsearch;" + cache.NATIVE_HOOK_NEEDLE_209,
                encoding="utf-8",
            )

            self.assertEqual(
                cache.install(project, root, "ws://127.0.0.1:2022/ws/mp"),
                (1, 1, 0),
            )
            patched = bundle.read_text(encoding="utf-8")
            self.assertIn(cache.NATIVE_HOOK_209, patched)
            self.assertNotIn(cache.START, patched)

            self.assertEqual(
                cache.install(project, root, "ws://127.0.0.1:2022/ws/mp"),
                (1, 0, 0),
            )

    def test_resource_213_native_hook_is_supported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = self._project(root)
            bundle = (
                root
                / "Library/Containers/com.tencent.xinWeChat/Data/Documents/app_data/radium/users"
                / "active/xworker/search/resources/package/213/dist/build.current.js"
            )
            bundle.parent.mkdir(parents=True)
            bundle.write_text(
                "mmpcwebsearch;" + cache.NATIVE_HOOK_NEEDLE_213,
                encoding="utf-8",
            )

            self.assertEqual(
                cache.install(project, root, "ws://127.0.0.1:2022/ws/mp"),
                (1, 1, 0),
            )
            patched = bundle.read_text(encoding="utf-8")
            self.assertIn(cache.NATIVE_HOOK_213, patched)
            self.assertNotIn(cache.START, patched)

            self.assertEqual(
                cache.install(project, root, "ws://127.0.0.1:2022/ws/mp"),
                (1, 0, 0),
            )

    def test_install_embeds_bridge_in_bootstrap_page_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = self._project(root)
            version = (
                root
                / "Library/Containers/com.tencent.xinWeChat/Data/Documents/app_data/radium/users"
                / "active/xworker/search/resources/package/213"
            )
            bundle = version / "dist/build.current.js"
            bundle.parent.mkdir(parents=True)
            bundle.write_text(
                "mmpcwebsearch;" + cache.NATIVE_HOOK_NEEDLE_213,
                encoding="utf-8",
            )
            app_html = version / "app.html"
            app_html.write_text(
                "<!doctype html><html><body><main></main></body></html>",
                encoding="utf-8",
            )

            self.assertEqual(
                cache.install(project, root, "ws://127.0.0.1:2022/ws/mp"),
                (1, 1, 0),
            )
            installed = app_html.read_text(encoding="utf-8")
            self.assertEqual(installed.count(cache.HTML_START), 1)
            self.assertEqual(installed.count(cache.HTML_END), 1)
            self.assertIn(cache.START, installed)
            self.assertIn('"ws://127.0.0.1:2022/ws/mp"', installed)
            self.assertNotIn(cache.START, bundle.read_text(encoding="utf-8"))

            self.assertEqual(
                cache.install(project, root, "ws://127.0.0.1:2022/ws/mp"),
                (1, 0, 0),
            )

    def test_install_updates_build_chunk_size_and_manifest_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = self._project(root)
            version = (
                root
                / "Library/Containers/com.tencent.xinWeChat/Data/Documents/app_data/radium/users"
                / "active/xworker/search/resources/package/213"
            )
            dist = version / "dist"
            dist.mkdir(parents=True)
            bundle = dist / "build.current.js"
            bundle.write_text(
                "mmpcwebsearch;" + cache.NATIVE_HOOK_NEEDLE_213,
                encoding="utf-8",
            )
            chunk_info = dist / "chunk-info.js"
            chunk_info.write_text(
                'window.chunkConfig = {"chunkMap":{"build":['
                '{"n":"build-style.css","s":7},{"n":"build.js","s":1}]}}',
                encoding="utf-8",
            )
            (version / "config.conf").write_text(
                "jsmd5 = "
                + json.dumps(
                    [{bundle.name: "old"}, {chunk_info.name: "old"}],
                    separators=(",", ":"),
                )
                + "\nmd5map = "
                + json.dumps(
                    {f"dist/{bundle.name}": "old", "dist/chunk-info.js": "old"},
                    separators=(",", ":"),
                )
                + "\nshamap = "
                + json.dumps(
                    {f"dist/{bundle.name}": "old", "dist/chunk-info.js": "old"},
                    separators=(",", ":"),
                )
                + "\n",
                encoding="utf-8",
            )

            self.assertEqual(
                cache.install(project, root, "ws://127.0.0.1:2022/ws/mp"),
                (1, 1, 0),
            )
            chunk_payload = json.loads(
                cache.CHUNK_CONFIG.fullmatch(
                    chunk_info.read_text(encoding="utf-8")
                ).group("payload")
            )
            self.assertEqual(
                chunk_payload["chunkMap"]["build"][1]["s"], bundle.stat().st_size
            )

            manifest = {}
            for line in (version / "config.conf").read_text(encoding="utf-8").splitlines():
                key, value = line.split(" = ", 1)
                manifest[key] = json.loads(value)
            expected = {
                bundle.name: hashlib.md5(bundle.read_bytes()).hexdigest(),
                chunk_info.name: hashlib.md5(chunk_info.read_bytes()).hexdigest(),
            }
            for entry in manifest["jsmd5"]:
                name, digest = next(iter(entry.items()))
                self.assertEqual(digest, expected[name])
            self.assertEqual(
                manifest["md5map"][f"dist/{bundle.name}"], expected[bundle.name]
            )
            self.assertEqual(
                manifest["md5map"]["dist/chunk-info.js"], expected[chunk_info.name]
            )

            self.assertEqual(
                cache.install(project, root, "ws://127.0.0.1:2022/ws/mp"),
                (1, 0, 0),
            )


if __name__ == "__main__":
    unittest.main()
