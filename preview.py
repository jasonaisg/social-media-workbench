"""Prepare isolated native preview; services are launched only by the user."""
import argparse
import hashlib
import importlib.util
import json
import ipaddress
import os
import plistlib
import stat
import socket
import subprocess
import sys
import threading
import time
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, build_opener
from pathlib import Path


WORKBENCH_URL = "http://127.0.0.1:2022/"
DAILY_WECHAT_APP = Path("/Applications/WeChat.app")
WECHAT_WORKBENCH_APP = Path("/Applications/WeChat Workbench.app")
WECHAT_WORKBENCH_VERSION = "4.1.13"
WECHAT_WORKBENCH_BUILD = "269628"
WECHAT_WORKBENCH_EXECUTABLE_SHA256 = "84820b679fb538ffc1ba82ec1f5504196ea666c53a02dd74ff25efa8ea435183"
WECHAT_WORKBENCH_SPARKLE_ARGS = (
    "-SUEnableAutomaticChecks", "NO",
    "-SUAutomaticallyUpdate", "NO",
    "-SUAllowsAutomaticUpdates", "NO",
)
BROWSER_SCRIPT = r"""
function run(argv) {
    ObjC.import('AppKit');
    var browser = 'com.apple.Safari';
    try {
        var appURL = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString(argv[0]));
        browser = ObjC.unwrap($.NSBundle.bundleWithURL(appURL).bundleIdentifier) || browser;
    } catch (_) {}
    var chromium = ['com.google.Chrome', 'com.google.Chrome.beta', 'com.google.Chrome.canary',
                    'com.microsoft.edgemac', 'com.brave.Browser', 'org.chromium.Chromium'];
    if (chromium.indexOf(browser) === -1 && browser !== 'com.apple.Safari') {
        browser = 'com.apple.Safari';
    }
    var app = Application(browser);
    if (browser === 'com.apple.Safari') {
        app.Document({url: argv[0]}).make();
    } else {
        var window = app.Window().make();
        window.activeTab.url = argv[0];
    }
    app.activate();
    return browser;
}
"""


def load_wechat_search_cache(project):
    script = project / "scripts/wechat_search_cache.py"
    spec = importlib.util.spec_from_file_location("wechat_search_cache", script)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载微信搜一搜桥接安装器。")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def prepare_wechat_search_bridge(project):
    module = load_wechat_search_cache(project)
    try:
        found, changed, skipped = module.install(project, Path.home(), "ws://127.0.0.1:2022/ws/mp")
    except (OSError, ValueError) as error:
        print(f"微信搜一搜桥接准备失败：{error}；视频功能仍可使用。", flush=True)
        return False
    if found == 0:
        message = "未找到兼容的微信搜一搜资源；视频功能仍可使用，公众号文章搜索暂不可用。"
        if skipped:
            message += f"（已跳过不兼容资源 {skipped} 份）"
        print(message, flush=True)
        return False
    print(f"微信搜一搜桥接已准备（资源 {found} 份，本次更新 {changed} 份）。", flush=True)
    if skipped:
        print(f"另有 {skipped} 份其他版本的搜一搜缓存不兼容，已跳过，不影响当前兼容资源。", flush=True)
    if changed:
        print("微信搜索资源已更新；若搜一搜窗口已打开，请关闭后重新打开一次。", flush=True)
    return bool(changed)


def search_bridge_signature(module, home):
    """Track bundle and manifest replacements made by WeChat's online updater."""
    signature = []
    for bundle in module.search_bundles(home):
        for path in (
            bundle,
            bundle.parent / "chunk-info.js",
            bundle.parent.parent / "app.html",
            bundle.parent.parent / "config.conf",
        ):
            try:
                stat = path.stat()
            except OSError:
                continue
            signature.append((str(path), stat.st_mtime_ns, stat.st_size))
    return tuple(sorted(signature))


def watch_wechat_search_bridge(host_pid, project, poll_interval=1.0, module=None):
    """Reinstall the bridge when WeChat downloads a new search resource."""
    module = module or load_wechat_search_cache(project)
    home = Path.home()
    try:
        module.install(project, home, "ws://127.0.0.1:2022/ws/mp")
        previous = search_bridge_signature(module, home)
    except (OSError, ValueError) as error:
        print(f"微信搜一搜缓存监视器初始化失败：{error}", flush=True)
        return
    while process_alive(host_pid):
        time.sleep(poll_interval)
        current = search_bridge_signature(module, home)
        if current == previous:
            continue
        try:
            found, changed, skipped = module.install(
                project, home, "ws://127.0.0.1:2022/ws/mp"
            )
            previous = search_bridge_signature(module, home)
            if changed:
                print(
                    f"检测到微信更新搜一搜资源，已自动重新安装桥接（资源 {found} 份，更新 {changed} 份）。",
                    flush=True,
                )
                print("若搜一搜已打开，请关闭后重新进入一次。", flush=True)
            elif skipped:
                print(f"微信搜一搜缓存监视器跳过不兼容资源 {skipped} 份。", flush=True)
        except (OSError, ValueError) as error:
            # Keep the previous signature so a transient or partial download is
            # retried instead of being accepted as the new steady state.
            print(f"微信搜一搜桥接自动更新失败，将继续重试：{error}", flush=True)



def engine_environment(source, proxy_port=2023):
    """Do not let the forwarding engine use itself as its upstream proxy.

    Sanitize before exec: Go caches ProxyFromEnvironment on first use.
    Other proxies and NO_PROXY rules remain unchanged.
    """
    environment = dict(source)
    removed = []
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        value = environment.get(key, "").strip()
        if not value:
            continue
        try:
            target = urlsplit(value if "://" in value else "http://" + value)
            host = (target.hostname or "").rstrip(".").lower()
            local = host == "localhost"
            if not local:
                try:
                    address = ipaddress.ip_address(host)
                    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
                        address = address.ipv4_mapped
                    local = address.is_loopback or address.is_unspecified
                except ValueError:
                    pass
            if target.port == proxy_port and local:
                environment.pop(key)
                removed.append(key)
        except ValueError:
            # Preserve unrelated malformed configuration rather than guessing.
            continue
    return environment, removed


def process_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_wechat_workbench_app(app=WECHAT_WORKBENCH_APP, require_immutable=None):
    """Reject an upgraded or writable dedicated WeChat before Host startup.

    The daily and dedicated apps intentionally share Tencent's bundle ID and
    profile.  Version, build and executable hash therefore identify the frozen
    4.1.13 copy; the user-immutable flag prevents Sparkle from replacing it.
    """
    app = Path(app)
    info_path = app / "Contents/Info.plist"
    executable = app / "Contents/MacOS/WeChat"
    if not info_path.is_file() or not executable.is_file():
        raise RuntimeError(
            "未找到完整的专用微信：/Applications/WeChat Workbench.app。"
            "请先恢复固定的 4.1.13 版本。"
        )
    try:
        with info_path.open("rb") as stream:
            info = plistlib.load(stream)
    except (OSError, plistlib.InvalidFileException) as error:
        raise RuntimeError(f"无法读取专用微信版本信息：{error}") from error

    version = str(info.get("CFBundleShortVersionString", ""))
    build = str(info.get("CFBundleVersion", ""))
    if (version, build) != (WECHAT_WORKBENCH_VERSION, WECHAT_WORKBENCH_BUILD):
        raise RuntimeError(
            f"专用微信版本不正确：检测到 {version or '未知版本'}/{build or '未知 build'}，"
            f"必须是 {WECHAT_WORKBENCH_VERSION}/{WECHAT_WORKBENCH_BUILD}。"
            "为避免再次误用新版，已停止启动。"
        )
    try:
        executable_hash = sha256_file(executable)
    except OSError as error:
        raise RuntimeError(f"无法校验专用微信主程序：{error}") from error
    if executable_hash != WECHAT_WORKBENCH_EXECUTABLE_SHA256:
        raise RuntimeError("专用微信主程序哈希与已确认的 4.1.13 安装包不一致，已停止启动。")

    if require_immutable is None:
        require_immutable = sys.platform == "darwin"
    immutable = getattr(stat, "UF_IMMUTABLE", 0)
    if require_immutable and immutable:
        # Lock only the bundle directory. Some older WeChat builds still write
        # an internal GPU cache at runtime; recursively locking every file makes
        # 4.1.13 exit during startup. Sparkle replaces the bundle as a unit, so
        # the top-level directory flag is the correct boundary.
        if not app.stat().st_flags & immutable:
            raise RuntimeError("专用微信没有处于版本锁定状态，已停止启动，避免 Sparkle 自动升级。")
    return version, build, executable_hash


def wait_for_workbench(pid, timeout=180):
    # Startup enables a system proxy. The local readiness probe must bypass it.
    opener = build_opener(ProxyHandler({}))
    deadline = time.monotonic() + timeout
    while process_alive(pid) and time.monotonic() < deadline:
        try:
            with opener.open(WORKBENCH_URL, timeout=1) as response:
                body = response.read(65536).decode("utf-8", errors="replace")
                if response.status == 200 and "<title>视频号工作台</title>" in body:
                    return process_alive(pid)
        except (OSError, URLError):
            pass
        time.sleep(0.5)
    return False


def wait_for_proxy(pid, timeout=180):
    """Do not open WeChat until interception is actually listening."""
    deadline = time.monotonic() + timeout
    while process_alive(pid) and time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", 2023), timeout=1):
                return process_alive(pid)
        except OSError:
            time.sleep(0.5)
    return False


def wechat_main_pids(app):
    """Return main-process IDs whose executable belongs to exactly one app."""
    executable = str(Path(app) / "Contents/MacOS/WeChat")
    try:
        result = subprocess.run(
            ["/bin/ps", "-axo", "pid=,command="],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError(f"无法检查微信进程状态：{error}") from error
    if result.returncode != 0:
        raise RuntimeError("无法检查微信进程状态，已停止启动，避免两个版本同时运行。")
    pids = []
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) != 2 or not fields[0].isdigit():
            continue
        command = fields[1]
        if command == executable or command.startswith(executable + " "):
            pids.append(int(fields[0]))
    return pids


def compatible_wechat_pids():
    """Return only the dedicated compatible app's main process IDs."""
    return wechat_main_pids(WECHAT_WORKBENCH_APP)


def daily_wechat_pids():
    """Return only the normal updateable WeChat app's main process IDs."""
    return wechat_main_pids(DAILY_WECHAT_APP)


def ensure_daily_wechat_stopped():
    """Prevent macOS from launching two unequal instances with one identity."""
    if daily_wechat_pids():
        raise RuntimeError(
            "检测到日常微信仍在运行。4.1.15 与专用 4.1.13 使用相同 Bundle ID，"
            "但内部 Helper 身份不同；macOS 同时运行时会拒绝第二个实例，严重时可能造成系统卡死。"
            "请先手动退出 /Applications/WeChat.app，再启动新视频号工作台。"
        )


def wait_for_compatible_wechat(timeout=10, poll_interval=0.25):
    """Confirm LaunchServices produced the dedicated main process."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if compatible_wechat_pids():
            return True
        time.sleep(poll_interval)
    return False


def open_wechat_workbench():
    """Launch the dedicated app after the proxy is ready.

    Never stop or restart an existing WeChat process. Sparkle launch arguments
    apply only to the dedicated copy; the daily WeChat keeps its normal
    shared-user update settings.
    """
    app = WECHAT_WORKBENCH_APP
    try:
        validate_wechat_workbench_app(app)
        running_pids = compatible_wechat_pids()
        if running_pids:
            print("WeChat Workbench 4.1.13 已在运行；代理现已就绪，请重新打开或刷新视频号/搜一搜页面。", flush=True)
            return
        ensure_daily_wechat_stopped()
        # -n is intentional: the daily WeChat installation has the same bundle ID.
        subprocess.run(
            ["/usr/bin/open", "-n", str(app), "--args", *WECHAT_WORKBENCH_SPARKLE_ARGS],
            check=True, capture_output=True, text=True, timeout=30,
        )
        if wait_for_compatible_wechat():
            print("已启动固定版 WeChat Workbench 4.1.13（专用进程自动更新已关闭）。", flush=True)
        else:
            print("macOS 已接收启动请求，但未检测到 WeChat Workbench 4.1.13 进程。请查看系统安全提示。", flush=True)
    except RuntimeError as error:
        print(str(error), flush=True)
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or error.stdout or "").strip()
        suffix = ("；系统错误：" + detail) if detail else ""
        print("未能自动启动 WeChat Workbench：" + str(app) + suffix, flush=True)
    except (OSError, subprocess.SubprocessError) as error:
        print("未能自动启动 WeChat Workbench：" + str(app) + "；" + str(error), flush=True)


def open_browser_when_ready(pid):
    if not wait_for_workbench(pid):
        if process_alive(pid):
            print("工作台尚未就绪，未自动打开浏览器。服务就绪后可访问：" + WORKBENCH_URL, flush=True)
        return
    if not wait_for_proxy(pid):
        if process_alive(pid):
            print("本地代理尚未就绪，未自动打开微信和浏览器，避免页面绕过检测。", flush=True)
        return
    project = Path(__file__).resolve().parent
    # WeChat updates the search XWorker independently of the desktop app. Keep
    # this helper alive with the Host so a post-launch resource replacement is
    # patched without requiring another full Workbench restart.
    threading.Thread(
        target=watch_wechat_search_bridge,
        args=(pid, project),
        name="wechat-search-cache-monitor",
        daemon=False,
    ).start()
    open_wechat_workbench()
    try:
        result = subprocess.run(
            ["/usr/bin/osascript", "-l", "JavaScript", "-e", BROWSER_SCRIPT, WORKBENCH_URL],
            check=True, capture_output=True, text=True, timeout=60,
        )
        print("已在新的浏览器窗口打开视频号工作台（" + result.stdout.strip() + "）。", flush=True)
    except (OSError, subprocess.SubprocessError):
        print("浏览器新窗口未能自动打开（可能尚未允许终端控制浏览器），Host 继续运行。请访问：" + WORKBENCH_URL, flush=True)


def prepare(selected_master=None):
    project = Path(__file__).resolve().parent
    binary = project/'dist/wx_video_download'
    validate_wechat_workbench_app()
    # Do this before any certificate, cache, proxy or Host work. The two app
    # bundles can coexist on disk, but macOS cannot safely run these unequal
    # same-identity versions at the same time.
    ensure_daily_wechat_stopped()
    runtime_value = os.environ.get("VIDEO_CHANNEL_WORKBENCH_MASTER", "").strip()
    if not runtime_value:
        raise RuntimeError(
            "未配置 VIDEO_CHANNEL_WORKBENCH_MASTER；为避免误建空资料库，已停止启动。"
        )
    runtime = Path(runtime_value).expanduser().resolve()
    if not binary.is_file():
        raise RuntimeError('未找到新工作台构建产物 dist/wx_video_download，请先执行 build-workbench.sh。不会回退运行不含本次改动的旧引擎。')
    for port in (19321,19222,2022,2023):
        with socket.socket() as sock:
            if sock.connect_ex(('127.0.0.1',port))==0:
                raise RuntimeError(f'端口 {port} 仍在使用。请先在旧工作台所属 Terminal 按 Ctrl+C 停止，再运行启动新视频号工作台.command。')
    prepare_wechat_search_bridge(project)
    cert = runtime/'runtime/engine/session.crt'
    key = runtime/'runtime/engine/session.key'
    runtime.mkdir(parents=True,exist_ok=True,mode=0o700)
    config=runtime/'config.yaml'
    if not config.exists():
        data=dict(workdir=str(runtime),api=dict(hostname='127.0.0.1',port=2022,protocol='http'),
                  proxy=dict(enabled=True,system=True,hostname='127.0.0.1',port=2023,tun=False),
                  cert=dict(name='SPH Workbench Local Bridge',file=str(cert),key=str(key)),
                  download=dict(dir=str(runtime/'library'),maxRunning=1,resourceConcurrency=1,
                                segmentConcurrency=1,connectionConcurrency=1),mcp=dict(enabled=False))
        config.write_text(json.dumps(data,ensure_ascii=False,indent=2))
        config.chmod(0o600)
    # Resolve the selected Master only after all Host ports are stopped.
    import master_store
    if selected_master:
        selected = Path(selected_master).expanduser().resolve()
        marker = selected / 'master.json'
        if not marker.is_file() or json.loads(marker.read_text()).get('layout_version') != master_store.VERSION:
            raise RuntimeError('--master 必须指向已有的新版资料库')
        selected_config = master_store.read_config(selected / 'config.yaml')
        selected_config['workdir'] = str(selected)
        master_store.atomic_json(selected / 'config.yaml', selected_config)
        master_store.atomic_json(runtime / 'runtime/launcher.json', {'master':str(selected)})
    runtime, config = master_store.prepare_master(runtime)
    cert, key = master_store.ensure_credentials(runtime)
    import bridge_certificate
    certificate_rotated = bridge_certificate.ensure_pair(cert.parent)
    if subprocess.run(['/usr/bin/openssl','x509','-in',str(cert),'-checkend','0','-noout'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
        raise RuntimeError('工作台证书更新后仍不可用，已停止启动。')
    if certificate_rotated:
        print('工作台本地证书已安全续期；本次启动可能要求授权信任新证书。', flush=True)

    print('新版微信平台工作台：http://127.0.0.1:2022/ （/channels 同样可用）',flush=True)
    print('Master 资料库：'+str(runtime),flush=True)
    print('使用视频功能时在微信打开或刷新视频号作者页；搜索公众号文章时保持微信搜一搜页面打开。所有搜索、浏览和下载操作都在工作台完成。结束时在此 Terminal 按 Ctrl+C。',flush=True)
    print('Host 就绪后会自动打开新的浏览器窗口；首次可能需要允许终端控制浏览器。', flush=True)
    environment, removed = engine_environment(os.environ)
    if removed:
        print("已忽略指向工作台自身的代理变量，避免请求循环：" + ", ".join(removed), flush=True)
    os.chdir(runtime)
    # Detached monitor survives closing Terminal or killing the native Host.
    import proxy_guard
    proxy_guard.prepare(runtime, master_store.read_config(config))
    # Keep exec: Ctrl+C still reaches the native engine and its proxy cleanup.
    # The helper retains this exact Conda interpreter and watches the engine PID.
    browser_helper = subprocess.Popen(
        [sys.executable, str(project / "preview.py"), "--open-browser", str(os.getpid())],
        start_new_session=True, env=environment,
    )
    try:
        os.execve(str(binary),[str(binary),'--config',str(config),'--workdir',str(runtime)],environment)
    except OSError:
        browser_helper.terminate()
        raise


if __name__=='__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument("--open-browser", type=int, metavar="HOST_PID", help=argparse.SUPPRESS)
    parser.add_argument("--master", help="读取移动后的已有 Master 资料库")
    args = parser.parse_args()
    try:
        if args.open_browser is not None:
            open_browser_when_ready(args.open_browser)
        else:
            prepare(args.master)
    except (OSError,RuntimeError) as error:
        print(str(error),flush=True)
        raise SystemExit(1)
