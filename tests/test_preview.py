"""Launcher checks without starting the Host, browser, or system proxy."""
import importlib.util
from pathlib import Path
import subprocess
import os
import plistlib
import tempfile
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import master_store
import proxy_guard
import bridge_certificate
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location("sph_next_preview", Path(__file__).resolve().parents[1] / "preview.py")
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


def response(text):
    result = MagicMock()
    result.__enter__.return_value = result
    result.status = 200
    result.read.return_value = text.encode("utf-8")
    return result


class BrowserLaunchTests(unittest.TestCase):
    @patch.object(preview.time, "sleep")
    @patch.object(preview, "process_alive", return_value=True)
    @patch.object(preview, "build_opener")
    def test_waits_past_connection_failure_and_old_page(self, opener, alive, sleep):
        opener.return_value.open.side_effect = [OSError("starting"), response("<title>Download & Manage</title>"), response("<title>视频号工作台</title>")]
        self.assertTrue(preview.wait_for_workbench(123))
        self.assertEqual(opener.return_value.open.call_count, 3)
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(opener.call_args.args[0].proxies, {})

    @patch.object(preview, "process_alive", return_value=False)
    @patch.object(preview, "build_opener")
    def test_exited_host_does_not_probe(self, opener, alive):
        self.assertFalse(preview.wait_for_workbench(123))
        opener.return_value.open.assert_not_called()

    @patch.object(preview.time, "sleep")
    @patch.object(preview, "process_alive", return_value=True)
    @patch.object(preview.socket, "create_connection")
    def test_waits_until_proxy_is_listening(self, connect, alive, sleep):
        connect.side_effect = [OSError("starting"), MagicMock()]
        self.assertTrue(preview.wait_for_proxy(123))
        self.assertEqual(connect.call_count, 2)
        sleep.assert_called_once_with(0.5)

    @patch.object(preview.subprocess, "run")
    @patch.object(preview, "open_wechat_workbench")
    @patch.object(preview, "process_alive", return_value=False)
    @patch.object(preview, "wait_for_workbench", return_value=False)
    def test_failed_start_does_not_open_browser_or_wechat(self, wait, alive, wechat, run):
        preview.open_browser_when_ready(123)
        run.assert_not_called()
        wechat.assert_not_called()

    @patch("builtins.print")
    @patch.object(preview, "watch_wechat_search_bridge")
    @patch.object(preview.subprocess, "run")
    @patch.object(preview, "open_wechat_workbench")
    @patch.object(preview, "wait_for_proxy", return_value=True)
    @patch.object(preview, "wait_for_workbench", return_value=True)
    def test_opens_wechat_and_browser_once_after_ready(self, wait, proxy, wechat, run, watch, output):
        run.return_value.stdout = "com.apple.Safari\n"
        preview.open_browser_when_ready(123)
        wait.assert_called_once_with(123)
        proxy.assert_called_once_with(123)
        wechat.assert_called_once_with()
        run.assert_called_once()
        self.assertEqual(run.call_args.args[0][-1], preview.WORKBENCH_URL)
        self.assertEqual(run.call_args.args[0][0], "/usr/bin/osascript")
        self.assertTrue(run.call_args.kwargs["check"])

    @patch("builtins.print")
    @patch.object(preview, "watch_wechat_search_bridge")
    @patch.object(preview.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "osascript"))
    @patch.object(preview, "open_wechat_workbench")
    @patch.object(preview, "wait_for_proxy", return_value=True)
    @patch.object(preview, "wait_for_workbench", return_value=True)
    def test_browser_permission_failure_does_not_stop_host(self, wait, proxy, wechat, run, watch, output):
        preview.open_browser_when_ready(123)
        wechat.assert_called_once_with()
        self.assertIn("Host 继续运行", output.call_args.args[0])

    @patch("builtins.print")
    @patch.object(preview.subprocess, "run")
    @patch.object(preview, "open_wechat_workbench")
    @patch.object(preview, "process_alive", return_value=True)
    @patch.object(preview, "wait_for_proxy", return_value=False)
    @patch.object(preview, "wait_for_workbench", return_value=True)
    def test_proxy_failure_does_not_open_wechat_or_browser(self, wait, proxy, alive, wechat, run, output):
        preview.open_browser_when_ready(123)
        wechat.assert_not_called()
        run.assert_not_called()
        self.assertIn("代理尚未就绪", output.call_args.args[0])


class WeChatSearchMonitorTests(unittest.TestCase):
    @patch("builtins.print")
    @patch.object(preview.time, "sleep")
    @patch.object(preview, "process_alive", side_effect=[True, False])
    @patch.object(preview, "search_bridge_signature", side_effect=[("before",), ("downloaded",), ("patched",)])
    def test_reinstalls_bridge_after_online_resource_update(self, signature, alive, sleep, output):
        module = MagicMock()
        module.install.side_effect = [(1, 0, 0), (2, 1, 0)]
        preview.watch_wechat_search_bridge(123, Path("/project"), poll_interval=0, module=module)
        self.assertEqual(module.install.call_count, 2)
        self.assertIn("自动重新安装桥接", output.call_args_list[-2].args[0])


class WeChatLaunchTests(unittest.TestCase):
    def test_accepts_exact_413_build_and_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "WeChat Workbench.app"
            (app / "Contents/MacOS").mkdir(parents=True)
            with (app / "Contents/Info.plist").open("wb") as stream:
                plistlib.dump(
                    {
                        "CFBundleShortVersionString": "4.1.13",
                        "CFBundleVersion": "269628",
                    },
                    stream,
                )
            executable = app / "Contents/MacOS/WeChat"
            executable.write_bytes(b"known-413")
            with patch.object(preview, "WECHAT_WORKBENCH_EXECUTABLE_SHA256", preview.sha256_file(executable)):
                version, build, _ = preview.validate_wechat_workbench_app(app, require_immutable=False)
            self.assertEqual((version, build), ("4.1.13", "269628"))

    def test_rejects_upgraded_dedicated_app(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "WeChat Workbench.app"
            (app / "Contents/MacOS").mkdir(parents=True)
            with (app / "Contents/Info.plist").open("wb") as stream:
                plistlib.dump(
                    {
                        "CFBundleShortVersionString": "4.1.15",
                        "CFBundleVersion": "270135",
                    },
                    stream,
                )
            (app / "Contents/MacOS/WeChat").write_bytes(b"upgraded")
            with self.assertRaisesRegex(RuntimeError, "必须是 4.1.13/269628"):
                preview.validate_wechat_workbench_app(app, require_immutable=False)

    @patch("builtins.print")
    @patch.object(preview, "validate_wechat_workbench_app")
    @patch.object(preview, "compatible_wechat_pids", return_value=[])
    @patch.object(preview, "daily_wechat_pids", return_value=[])
    @patch.object(preview, "wait_for_compatible_wechat", return_value=True)
    @patch.object(preview.subprocess, "run")
    def test_launches_exact_compatible_app_when_not_running(self, run, wait, daily, pids, validate, output):
        run.return_value = subprocess.CompletedProcess([], 0)
        preview.open_wechat_workbench()
        self.assertEqual(
            run.call_args_list[0].args[0],
            [
                "/usr/bin/open", "-n", "/Applications/WeChat Workbench.app", "--args",
                *preview.WECHAT_WORKBENCH_SPARKLE_ARGS,
            ],
        )
        self.assertIn("4.1.13", output.call_args.args[0])

    @patch("builtins.print")
    @patch.object(preview, "validate_wechat_workbench_app")
    @patch.object(preview, "compatible_wechat_pids", return_value=[])
    @patch.object(preview, "daily_wechat_pids", return_value=[])
    @patch.object(preview.subprocess, "run")
    def test_reports_launchservices_error_detail(self, run, daily, pids, validate, output):
        run.side_effect = subprocess.CalledProcessError(
            1, ["/usr/bin/open"], stderr="Security policy issue"
        )
        preview.open_wechat_workbench()
        self.assertIn("Security policy issue", output.call_args.args[0])

    @patch("builtins.print")
    @patch.object(preview, "validate_wechat_workbench_app")
    @patch.object(preview, "compatible_wechat_pids", return_value=[123])
    @patch.object(preview.subprocess, "run")
    def test_never_restarts_or_duplicates_running_app(self, run, pids, validate, output):
        preview.open_wechat_workbench()
        run.assert_not_called()
        self.assertIn("4.1.13 已在运行", output.call_args.args[0])

    @patch("builtins.print")
    @patch.object(preview, "validate_wechat_workbench_app")
    @patch.object(preview, "compatible_wechat_pids", return_value=[])
    @patch.object(preview, "daily_wechat_pids", return_value=[456])
    @patch.object(preview.subprocess, "run")
    def test_refuses_to_launch_413_while_daily_wechat_runs(self, run, daily, pids, validate, output):
        preview.open_wechat_workbench()
        run.assert_not_called()
        self.assertIn("日常微信仍在运行", output.call_args.args[0])
        self.assertIn("请先手动退出", output.call_args.args[0])

    @patch.object(preview.subprocess, "run")
    def test_finds_only_exact_compatible_executable(self, run):
        run.return_value = subprocess.CompletedProcess(
            [],
            0,
            stdout=(
                " 123 /Applications/WeChat Workbench.app/Contents/MacOS/WeChat -SUAutomaticallyUpdate NO\n"
                " 456 /Applications/WeChat.app/Contents/MacOS/WeChat\n"
                " 789 /bin/zsh -c /Applications/WeChat Workbench.app/Contents/MacOS/WeChat\n"
            ),
        )
        self.assertEqual(preview.compatible_wechat_pids(), [123])
        self.assertEqual(
            run.call_args.args[0],
            ["/bin/ps", "-axo", "pid=,command="],
        )

        self.assertEqual(preview.daily_wechat_pids(), [456])

    @patch.object(preview.subprocess, "run")
    def test_process_check_fails_closed(self, run):
        run.return_value = subprocess.CompletedProcess([], 1, stdout="")
        with self.assertRaisesRegex(RuntimeError, "已停止启动"):
            preview.daily_wechat_pids()

class ProxyEnvironmentTests(unittest.TestCase):
    @patch.object(preview, "daily_wechat_pids", return_value=[456])
    @patch.object(preview, "validate_wechat_workbench_app")
    def test_prepare_stops_before_host_when_daily_wechat_runs(self, validate, daily):
        with self.assertRaisesRegex(RuntimeError, "日常微信仍在运行"):
            preview.prepare()

    def test_self_proxy_removed_without_mutating_parent_environment(self):
        source = {"HTTP_PROXY": "http://127.0.0.1:2023", "https_proxy": "http://localhost:2023",
                  "ALL_PROXY": "socks5h://127.0.0.1:7897", "NO_PROXY": "localhost,127.0.0.1", "PATH": "/bin"}
        result, removed = preview.engine_environment(source)
        self.assertEqual(set(removed), {"HTTP_PROXY", "https_proxy"})
        self.assertEqual(result, {"ALL_PROXY": source["ALL_PROXY"], "NO_PROXY": source["NO_PROXY"], "PATH": "/bin"})
        self.assertIn("HTTP_PROXY", source)

    def test_loopback_aliases_and_proxy_schemes(self):
        for value in ("http://[::1]:2023", "socks5h://[::ffff:127.0.0.1]:2023", "localhost:2023", "http://localhost.:2023", "http://127.0.0.2:2023", "http://0.0.0.0:2023"):
            with self.subTest(value=value):
                result, removed = preview.engine_environment({"HTTPS_PROXY": value})
                self.assertEqual(result, {})
                self.assertEqual(removed, ["HTTPS_PROXY"])

    def test_external_proxy_is_preserved(self):
        source = {"HTTPS_PROXY": "http://127.0.0.1:7897", "HTTP_PROXY": "http://proxy.example:2023"}
        self.assertEqual(preview.engine_environment(source), (source, []))

    @patch("builtins.print")
    @patch.object(preview.os, "chdir")
    @patch.object(preview.os, "execve", side_effect=OSError("test exec failure"))
    @patch.object(preview.subprocess, "Popen")
    @patch.object(preview.subprocess, "run")
    @patch.object(preview.socket, "socket")
    def test_launch_passes_clean_environment_and_cleans_helper_on_failure(self, socket, run, popen, execve, chdir, output):
        socket.return_value.__enter__.return_value.connect_ex.return_value = 1
        run.return_value.returncode = 0
        with patch.object(preview, "validate_wechat_workbench_app"), patch.object(preview, "ensure_daily_wechat_stopped"), patch.object(proxy_guard, "prepare"), patch.object(bridge_certificate, "ensure_pair", return_value=False), patch.object(master_store, "ensure_credentials", return_value=(Path("/tmp/test-cert"),Path("/tmp/test-key"))), tempfile.TemporaryDirectory() as directory, patch.object(preview.Path, "home", return_value=Path(directory)), patch.object(preview.Path, "is_file", return_value=True), patch.dict(os.environ, {"HTTP_PROXY": "http://127.0.0.1:2023", "HTTPS_PROXY": "http://127.0.0.1:2023", "VIDEO_CHANNEL_WORKBENCH_MASTER": directory}):
            with self.assertRaisesRegex(OSError, "test exec failure"):
                preview.prepare()
        environment = execve.call_args.args[2]
        self.assertNotIn("HTTP_PROXY", environment)
        self.assertNotIn("HTTPS_PROXY", environment)
        self.assertEqual(popen.call_args.kwargs["env"], environment)
        popen.return_value.terminate.assert_called_once()


if __name__ == "__main__":
    unittest.main()
