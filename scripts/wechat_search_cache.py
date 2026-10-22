"""Install the local workbench bridge into WeChat's cached search bundle."""
from __future__ import annotations

import json
import hashlib
import os
import re
from pathlib import Path

START = "/* __SPH_WECHAT_SEARCH_BRIDGE_START__ */"
END = "/* __SPH_WECHAT_SEARCH_BRIDGE_END__ */"
BLOCK = re.compile(re.escape(START) + r".*?" + re.escape(END), re.S)
HTML_START = "<!-- __SPH_WECHAT_SEARCH_BRIDGE_HTML_START__ -->"
HTML_END = "<!-- __SPH_WECHAT_SEARCH_BRIDGE_HTML_END__ -->"
HTML_BLOCK = re.compile(re.escape(HTML_START) + r".*?" + re.escape(HTML_END), re.S)
CHUNK_CONFIG = re.compile(
    r"(?P<prefix>\s*window\.chunkConfig\s*=\s*)(?P<payload>\{.*\})(?P<suffix>;?\s*)",
    re.S,
)
NATIVE_HOOK_NEEDLE = "is_security_check:!0};n&&n(a),E(C.transferH5Data"
NATIVE_HOOK = 'is_security_check:!0};try{t.url&&t.url.indexOf("mmpcwebsearch")>=0&&(globalThis.__sph_wechat_search_template__=JSON.parse(JSON.stringify(a)))}catch(t){};n&&n(a),E(C.transferH5Data'
NATIVE_HOOK_NEEDLE_209 = "is_security_check:!0};n&&n(a),E(A.transferH5Data"
NATIVE_HOOK_209 = 'is_security_check:!0};try{t.url&&t.url.indexOf("mmpcwebsearch")>=0&&(globalThis.__sph_wechat_search_template__=JSON.parse(JSON.stringify(a)))}catch(t){};n&&n(a),E(A.transferH5Data'
NATIVE_HOOK_NEEDLE_213 = "is_security_check:!0};n&&n(a),w(A.transferH5Data"
NATIVE_HOOK_213 = 'is_security_check:!0};try{t.url&&t.url.indexOf("mmpcwebsearch")>=0&&(globalThis.__sph_wechat_search_template__=JSON.parse(JSON.stringify(a)))}catch(t){};n&&n(a),w(A.transferH5Data'
NATIVE_HOOK_VARIANTS = (
    (NATIVE_HOOK_NEEDLE, NATIVE_HOOK),
    (NATIVE_HOOK_NEEDLE_209, NATIVE_HOOK_209),
    (NATIVE_HOOK_NEEDLE_213, NATIVE_HOOK_213),
)


def search_bundles(home: Path) -> list[Path]:
    base = home / "Library/Containers/com.tencent.xinWeChat/Data/Documents/app_data/radium/users"
    if not base.is_dir():
        return []
    return sorted(base.glob("*/xworker/search/resources/*/*/dist/build*.js"))


def render_bridge(template: str, ws_url: str) -> str:
    if "__SPH_WS_URL__" not in template:
        raise ValueError("search bridge template is missing its WebSocket placeholder")
    return template.replace("__SPH_WS_URL__", json.dumps(ws_url))


def patch_bundle(path: Path, _bridge: str) -> bool:
    original = path.read_text(encoding="utf-8")
    cleaned = BLOCK.sub("", original).rstrip()
    if not any(hook in cleaned for _, hook in NATIVE_HOOK_VARIANTS):
        matches = [
            (needle, hook)
            for needle, hook in NATIVE_HOOK_VARIANTS
            if cleaned.count(needle) == 1
        ]
        if len(matches) != 1:
            raise ValueError(f"cannot locate the native search request hook in {path}")
        needle, hook = matches[0]
        cleaned = cleaned.replace(needle, hook, 1)
    # Keep the large, integrity-checked build chunk as close to upstream as
    # possible. The always-on WebSocket bridge is installed in app.html below;
    # this bundle only needs the tiny native-request capture hook.
    updated = cleaned + "\n"
    if updated == original:
        return False
    tmp = path.with_name("." + path.name + ".sph-tmp")
    tmp.write_text(updated, encoding="utf-8")
    os.chmod(tmp, path.stat().st_mode)
    os.replace(tmp, path)
    return True


def patch_app_html(bundle: Path, bridge: str) -> tuple[Path | None, bool]:
    """Install the bridge in the bootstrap page that WeChat loads first."""
    app_html = bundle.parent.parent / "app.html"
    if not app_html.is_file():
        return None, False
    original = app_html.read_text(encoding="utf-8")
    cleaned = HTML_BLOCK.sub("", original)
    if "</body>" not in cleaned:
        raise ValueError(f"cannot locate </body> in search bootstrap page {app_html}")
    html_bridge = (
        HTML_START
        + '\n<script type="text/javascript">\n'
        + bridge
        + "\n</script>\n"
        + HTML_END
    )
    body_index = cleaned.rfind("</body>")
    updated = cleaned[:body_index].rstrip() + "\n" + html_bridge + "\n" + cleaned[body_index:]
    if updated == original:
        return app_html, False
    tmp = app_html.with_name("." + app_html.name + ".sph-tmp")
    tmp.write_text(updated, encoding="utf-8")
    os.chmod(tmp, app_html.stat().st_mode)
    os.replace(tmp, app_html)
    return app_html, True


def update_chunk_info(bundle: Path) -> tuple[Path | None, bool]:
    """Keep WeChat's lazy-loader byte-size metadata in sync with the bundle."""
    chunk_info = bundle.parent / "chunk-info.js"
    if not chunk_info.is_file():
        return None, False
    original = chunk_info.read_text(encoding="utf-8")
    match = CHUNK_CONFIG.fullmatch(original)
    if match is None:
        raise ValueError(f"cannot parse search chunk metadata in {chunk_info}")
    config = json.loads(match.group("payload"))
    build_chunks = config.get("chunkMap", {}).get("build", [])
    build_entry = next(
        (
            entry
            for entry in build_chunks
            if isinstance(entry, dict)
            and isinstance(entry.get("n"), str)
            and entry["n"].endswith(".js")
        ),
        None,
    )
    if build_entry is None:
        raise ValueError(f"cannot locate the build chunk size in {chunk_info}")
    size = bundle.stat().st_size
    if build_entry.get("s") == size:
        return chunk_info, False
    build_entry["s"] = size
    updated = (
        match.group("prefix")
        + json.dumps(config, ensure_ascii=False, separators=(",", ":"))
        + match.group("suffix")
    )
    tmp = chunk_info.with_name("." + chunk_info.name + ".sph-tmp")
    tmp.write_text(updated, encoding="utf-8")
    os.chmod(tmp, chunk_info.stat().st_mode)
    os.replace(tmp, chunk_info)
    return chunk_info, True


def update_manifest(resource: Path) -> bool:
    manifest = resource.parent.parent / "config.conf"
    if not manifest.is_file():
        return False
    content = resource.read_bytes()
    md5 = hashlib.md5(content).hexdigest()
    sha1 = hashlib.sha1(content).hexdigest()
    basename = resource.name
    relative = "dist/" + basename
    lines = manifest.read_text(encoding="utf-8").splitlines()
    changed = False
    for index, line in enumerate(lines):
        if " = " not in line:
            continue
        key, raw = line.split(" = ", 1)
        if key not in {"jsmd5", "md5map", "shamap"}:
            continue
        value = json.loads(raw)
        if key == "jsmd5":
            for entry in value:
                if basename in entry and entry[basename] != md5:
                    entry[basename] = md5
                    changed = True
        else:
            digest = md5 if key == "md5map" else sha1
            if value.get(relative) != digest:
                value[relative] = digest
                changed = True
        lines[index] = key + " = " + json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if not changed:
        return False
    tmp = manifest.with_name("." + manifest.name + ".sph-tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chmod(tmp, manifest.stat().st_mode)
    os.replace(tmp, manifest)
    return True


def install(project: Path, home: Path, ws_url: str) -> tuple[int, int, int]:
    template = (project / "scripts/wechat_search_bridge.js").read_text(encoding="utf-8")
    bridge = render_bridge(template, ws_url)
    found = changed = skipped = 0
    for path in search_bundles(home):
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
            if "mmpcwebsearch" not in text:
                continue
            bundle_changed = patch_bundle(path, bridge)
            app_html, app_html_changed = patch_app_html(path, bridge)
            chunk_info, chunk_info_changed = update_chunk_info(path)
            bundle_manifest_changed = update_manifest(path)
            html_manifest_changed = bool(app_html and update_manifest(app_html))
            chunk_manifest_changed = bool(chunk_info and update_manifest(chunk_info))
            found += 1
            changed += int(
                bundle_changed
                or app_html_changed
                or chunk_info_changed
                or bundle_manifest_changed
                or html_manifest_changed
                or chunk_manifest_changed
            )
        except ValueError:
            # Different WeChat/search releases can coexist in the shared
            # container. One incompatible cache must not prevent a compatible
            # active profile from being prepared.
            skipped += 1
        except OSError:
            continue
    return found, changed, skipped
