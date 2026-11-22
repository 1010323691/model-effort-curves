#!/usr/bin/env python3
"""更新脚本与本机服务的测试，不访问外网，也不改动项目里的数据。

用法：python3 -I tests/test_update.py
"""
import copy
import http.client
import importlib.util
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


update = load("update_data")
serve = load("serve")


def model(i, **extra):
    return {
        "id": f"id-{i}", "name": f"Model {i}", "release": {"slug": f"model-{i}", "name": f"Model {i}"},
        "suffix": "High", "modelCreatorName": "OpenAI", "intelligenceIndex": 10 + i,
        "intelligenceIndexCostPerTask": 0.1 * i, "intelligenceIndexTimePerTask": 60,
        "scores": {"bench": 0.5}, **extra,
    }


def detail(m):
    """与原站一致：没有价格时，详情对象里根本没有成本这个键。"""
    out = {
        "id": m["id"], "inputModalityImage": m.get("image", True),
        "release": {"slug": m["release"]["slug"], "defaultEffort": {"slug": "high"}},
        "intelligenceIndexOutputTokensPerTask": {"output": 300, "reasoning": 200, "answer": 100},
    }
    total = m["intelligenceIndexCostPerTask"]
    if total is not None:
        out["intelligenceIndexCostPerTask"] = {
            "cost": {"total": total}, "evaluations": [{"slug": "bench", "weightedCostPerTask": total}],
        }
    return out


def site(models, version="5.0.1", detail_error=None, broken=(), blank=()):
    releases = [{"slug": m["release"]["slug"], "releaseDate": "2026-11-01"} for m in models if "release" in m]
    index = "".join((
        '"initialModels":', json.dumps(models),
        ',"releases":', json.dumps(releases),
        ',"generalEvaluations":[],"title":"Artificial Analysis Intelligence Index v', version, '"',
    ))

    def fetch(url, tries=3):
        if url == update.SOURCE:
            return index
        if detail_error:
            raise update.ScrapeError(detail_error)
        slug = url.rsplit("/", 1)[-1]
        if slug in broken:
            raise update.ScrapeError("超时")
        if slug in blank:
            return "<html>请稍候</html>"
        found = [m for m in models if m["release"]["slug"] == slug]
        return "".join(json.dumps(detail(m), separators=(",", ":")) for m in found)

    return fetch


class UpdateBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "data"
        for patch in (mock.patch.object(update, "DATA", self.data), mock.patch.object(update.time, "sleep"),
                      mock.patch.object(update.signal, "signal")):
            patch.start()
            self.addCleanup(patch.stop)
        self.models = [model(i) for i in range(40)]
        self.summary = self.refresh(self.models)

    def refresh(self, models, **options):
        with mock.patch.object(update, "fetch", site(models, **options)):
            return update.run()[1]

    def snapshot(self):
        return {p.name: p.read_bytes() for p in self.data.iterdir() if not p.name.endswith((".tmp", ".lock"))}

    def assert_rejected(self, models, text, **options):
        before = self.snapshot()
        with self.assertRaises((update.ScrapeError, KeyError)) as caught:
            self.refresh(models, **options)
        self.assertIn(text, str(caught.exception))
        self.assertEqual(before, self.snapshot())


class UpdateScript(UpdateBase):
    def test_writes_consistent_files(self):
        self.assertEqual(set(self.snapshot()),
                         {"models.json", "models.csv", "data.js", "leaderboard-raw.json", "last-update.json"})
        payload = json.loads((self.data / "models.json").read_text())
        script = (self.data / "data.js").read_text()
        self.assertEqual(payload, json.loads(script[len("window.AA_DATA="):-2]))
        self.assertEqual(41, len((self.data / "models.csv").read_text("utf-8-sig").strip().splitlines()))
        self.assertEqual([], self.summary["added"], "首次运行不应把全部配置报成新增")

    def test_script_tag_is_escaped(self):
        self.models[3]["name"] = "</script><script>alert(1)</script>"
        self.refresh(self.models)
        self.assertNotIn("</script>", (self.data / "data.js").read_text())

    def test_csv_formula_is_escaped(self):
        self.models[3]["name"] = "=HYPERLINK(1)"
        self.refresh(self.models)
        self.assertIn("'=HYPERLINK(1)", (self.data / "models.csv").read_text("utf-8-sig"))

    def test_reports_added_removed_changed(self):
        models = copy.deepcopy(self.models[1:]) + [model(99)]
        models[4]["intelligenceIndexCostPerTask"] = 9.5
        summary = self.refresh(models)
        self.assertEqual(["id-99"], [r["id"] for r in summary["added"]])
        self.assertEqual(["id-0"], [r["id"] for r in summary["removed"]])
        self.assertEqual([("id-5", [0.5, 9.5])], [(r["id"], r["fields"]["cost"]) for r in summary["changed"]])

    def test_noise_is_not_a_change(self):
        self.models[4]["intelligenceIndexCostPerTask"] *= 1.0001
        self.assertEqual([], self.refresh(self.models)["changed"])

    def test_speed_is_counted_separately(self):
        self.models[4]["outputSpeed"] = 123
        summary = self.refresh(self.models)
        self.assertEqual(([], 1), (summary["changed"], summary["performance"]))

    def test_missing_becomes_value(self):
        self.models[4]["intelligenceIndexCostPerTask"] = None
        self.assertIsNone(self.refresh(self.models)["changed"][0]["fields"]["cost"][1])

    def test_rejects_too_few(self):
        self.assert_rejected(self.models[:10], "只解析到 10")

    def test_rejects_no_prices(self):
        for m in self.models:
            m["intelligenceIndexCostPerTask"] = None
        self.assert_rejected(self.models, "没有任何单任务价格")

    def test_rejects_price_collapse(self):
        for m in self.models[:30]:
            m["intelligenceIndexCostPerTask"] = None
        self.assert_rejected(self.models, "骤降")

    def test_allows_collapse_on_new_index_version(self):
        for m in self.models[:30]:
            m["intelligenceIndexCostPerTask"] = None
        self.assertEqual(["5.0.1", "6.0"], self.refresh(self.models, version="6.0")["version"])

    def test_rejects_bad_number(self):
        self.models[2]["intelligenceIndex"] = "12"
        self.assert_rejected(self.models, "iq")

    def test_rejects_negative_price(self):
        self.models[2]["intelligenceIndexCostPerTask"] = -1
        self.assert_rejected(self.models, "cost")

    def test_rejects_duplicate_id(self):
        self.models[2]["id"] = "id-1"
        self.assert_rejected(self.models, "重复")

    def test_rejects_bad_slug(self):
        self.models[2]["release"]["slug"] = "../../x?y"
        self.assert_rejected(self.models, "标识异常")

    def test_rejects_missing_field(self):
        del self.models[2]["release"]["name"]
        self.assert_rejected(self.models, "name")

    def test_rejects_detail_outage(self):
        self.assert_rejected(self.models, "详情页失败", detail_error="503")

    def test_rolls_back_partial_write(self):
        before = self.snapshot()
        real, calls = os.replace, []

        def flaky(src, dst):
            calls.append(dst)
            if len(calls) == 3:
                raise OSError("disk full")
            real(src, dst)

        self.models[4]["intelligenceIndexCostPerTask"] = 9.5
        with mock.patch.object(update.os, "replace", flaky), self.assertRaises(OSError):
            self.refresh(self.models)
        self.assertEqual(before, self.snapshot())

    @unittest.skipUnless(update.fcntl, "系统不支持 flock")
    def test_second_writer_is_refused(self):
        with update.update_lock(), self.assertRaisesRegex(update.ScrapeError, "另一个更新"):
            self.refresh(self.models)

    @unittest.skipUnless(hasattr(signal, "SIGHUP"), "仅 POSIX")
    def test_real_process_cancels_during_request(self):
        before = self.snapshot()
        code = "\n".join((
            "import importlib.util, pathlib, sys, time",
            "sys.dont_write_bytecode = True",
            "sys.argv.append('--events')",
            f"spec = importlib.util.spec_from_file_location('u', {str(ROOT / 'scripts' / 'update_data.py')!r})",
            "u = importlib.util.module_from_spec(spec); spec.loader.exec_module(u)",
            f"u.DATA = pathlib.Path({str(self.data)!r})",
            "u.fetch = lambda url, tries=3: time.sleep(30)",
            "u.main()",
        ))
        child = subprocess.Popen([sys.executable, "-I", "-c", code], stdout=subprocess.PIPE)
        self.assertIn(b'"progress"', child.stdout.readline())
        child.send_signal(signal.SIGTERM)
        output = child.communicate(timeout=5)[0]
        self.assertEqual(130, child.returncode)
        self.assertIn(b'"cancelled"', output)
        self.assertEqual(before, self.snapshot())


class PartialDetails(UpdateBase):
    def rows(self):
        return {r["id"]: r for r in json.loads((self.data / "models.json").read_text())["rows"]}

    def meta(self):
        return json.loads((self.data / "models.json").read_text())["meta"]

    def test_failed_page_keeps_previous_details(self):
        before = self.rows()["id-5"]
        summary = self.refresh(self.models, broken={"model-5"})
        after = self.rows()["id-5"]
        for key in ("costParts", "costByEval", "tokens", "tokensReasoning", "tokensAnswer", "image", "isDefault"):
            self.assertEqual(before[key], after[key], key)
        self.assertTrue(after["detailFrom"])
        self.assertNotIn("detailFrom", self.rows()["id-6"])
        self.assertEqual((1, 0), (summary["stale"], summary["incomplete"]))

    def test_blank_200_counts_as_failure(self):
        before = self.rows()["id-5"]
        self.refresh(self.models, blank={"model-5"})
        self.assertEqual(before["costParts"], self.rows()["id-5"]["costParts"])
        self.assertEqual(1, len(self.meta()["detailFailures"]))

    def test_many_blank_pages_abort(self):
        self.assert_rejected(self.models, "详情页失败", blank={f"model-{i}" for i in range(9)})

    def test_stale_origin_survives_repeated_failures(self):
        self.refresh(self.models, broken={"model-5"})
        first = self.rows()["id-5"]["detailFrom"]
        self.refresh(self.models, broken={"model-5"})
        self.assertEqual(first, self.rows()["id-5"]["detailFrom"])

    def test_recovery_clears_stale_mark(self):
        self.refresh(self.models, broken={"model-5"})
        self.refresh(self.models)
        self.assertNotIn("detailFrom", self.rows()["id-5"])

    def test_breakdown_not_reused_for_new_price(self):
        self.models[5]["intelligenceIndexCostPerTask"] = 7.5
        summary = self.refresh(self.models, broken={"model-5"})
        row = self.rows()["id-5"]
        self.assertIsNone(row["costParts"])
        self.assertTrue(row["image"])
        self.assertEqual(1, summary["incomplete"])

    def test_index_costs_not_reused_across_versions(self):
        self.refresh(self.models, version="5.1", broken={"model-5"})
        row = self.rows()["id-5"]
        self.assertEqual((None, None, True), (row["costParts"], row["tokens"], row["image"]))

    def test_only_one_default_per_group(self):
        low = model(50, suffix="Low", release=self.models[5]["release"])
        self.refresh(self.models + [low])
        rows = [r for r in self.rows().values() if r["group"] == "model-5"]
        self.assertEqual(1, sum(r["isDefault"] for r in rows))

    def test_unpriced_keeps_other_details(self):
        self.models[7].update(intelligenceIndexCostPerTask=None, image=False)
        self.refresh(self.models)
        row = self.rows()["id-7"]
        self.assertEqual((False, 300, True, None), (row["image"], row["tokens"], row["isDefault"], row["costParts"]))

    def test_version_shapes(self):
        for version in ("6", "6.1", "10", "5.0.1"):
            self.refresh(self.models, version=version)
            self.assertEqual(version, self.meta()["indexVersion"])

    def test_integer_version_allows_collapse(self):
        for m in self.models[:30]:
            m["intelligenceIndexCostPerTask"] = None
        self.assertEqual(["5.0.1", "6"], self.refresh(self.models, version="6")["version"])

    def test_version_ending_a_sentence(self):
        self.refresh(self.models, version="6.")
        self.assertEqual("6", self.meta()["indexVersion"])

    def test_guard_survives_unknown_version(self):
        self.refresh(self.models, version="?")
        for m in self.models[:30]:
            m["intelligenceIndexCostPerTask"] = None
        self.assert_rejected(self.models, "骤降")


SLOW_SAVE = """import importlib.util, pathlib, sys, time
sys.dont_write_bytecode = True
if '--events' not in sys.argv: sys.argv.append('--events')
spec = importlib.util.spec_from_file_location('u', {script!r})
u = importlib.util.module_from_spec(spec); spec.loader.exec_module(u)
u.DATA = pathlib.Path({data!r})
rows = [{{'id': 'new', 'name': 'new', 'iq': 1, 'cost': 1}}]
def replace(src, dst, real=u.os.replace):
    real(src, dst)
    (u.DATA.parent / 'saving').touch()
    time.sleep(0.2)
u.os.replace = replace
u.scrape = lambda: ({{'meta': {{'fetchedAt': 'new'}}, 'rows': rows}}, [])
u.validate = u.carry_details = lambda *args: None
u.compare = lambda *args: dict(fetchedAt='new', added=[], removed=[], changed=[])
u.main()
"""


@unittest.skipUnless(hasattr(signal, "SIGHUP"), "仅 POSIX")
class Hangup(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.data = self.root / "data"
        self.data.mkdir()
        self.names = ("models.json", "models.csv", "data.js", "leaderboard-raw.json", "last-update.json")
        for name in self.names:
            (self.data / name).write_text("old")
        self.code = SLOW_SAVE.format(script=str(ROOT / "scripts" / "update_data.py"), data=str(self.data))

    def wait_for_save(self):
        deadline = time.time() + 8
        while not (self.root / "saving").exists():
            self.assertLess(time.time(), deadline, "没有进入写入阶段")
            time.sleep(0.02)

    def assert_complete(self):
        self.assertEqual([], [n for n in self.names if (self.data / n).read_text("utf-8-sig") == "old"], "仍是旧文件")
        self.assertEqual([], list(self.data.glob("*.tmp")))

    def test_hangup_while_saving_finishes_the_write(self):
        child = subprocess.Popen([sys.executable, "-I", "-c", self.code], stdout=subprocess.PIPE)
        self.wait_for_save()
        child.send_signal(signal.SIGHUP)
        child.communicate(timeout=8)
        self.assert_complete()

    def test_hangup_while_fetching_cancels(self):
        code = self.code.replace("u.main()", "u.run = lambda: (u.progress('index'), time.sleep(30))\nu.main()")
        child = subprocess.Popen([sys.executable, "-I", "-c", code], stdout=subprocess.PIPE)
        self.assertIn(b"progress", child.stdout.readline())
        child.send_signal(signal.SIGHUP)
        self.assertIn(b'"cancelled"', child.communicate(timeout=5)[0])

    def test_worker_has_its_own_session(self):
        updater = serve.Updater(ROOT, fake("time.sleep(30)"))
        self.addCleanup(updater.shutdown)
        updater.start()
        self.assertNotEqual(os.getsid(0), os.getsid(updater.process.pid))

    def test_closing_the_terminal_while_saving(self):
        import pty

        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        host = "\n".join((
            "import importlib.util, pathlib, sys",
            "sys.dont_write_bytecode = True",
            f"spec = importlib.util.spec_from_file_location('s', {str(ROOT / 'scripts' / 'serve.py')!r})",
            "s = importlib.util.module_from_spec(spec); spec.loader.exec_module(s)",
            f"s.ROOT = pathlib.Path({str(self.root.resolve())!r})",
            "real = s.Updater",
            f"s.Updater = lambda root: real(root, [sys.executable, '-I', '-c', {self.code!r}])",
            f"sys.argv = ['serve', '--no-open', '--strict-port', '--port', '{port}']",
            "s.main()",
        ))
        pid, terminal = pty.fork()
        if pid == 0:
            os.execv(sys.executable, [sys.executable, "-I", "-c", host])
        os.read(terminal, 4096)  # 等服务打印出地址
        base = f"http://127.0.0.1:{port}"
        request = urllib.request.Request(f"{base}/api/update", b"", {"Origin": base, "X-Score-Trends": "1"})
        urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=5).close()
        self.wait_for_save()
        os.killpg(pid, signal.SIGHUP)  # 关闭终端窗口时，shell 会通知整个前台进程组
        os.close(terminal)
        os.waitpid(pid, 0)
        time.sleep(0.2)
        self.assert_complete()


class OccupiedPort(unittest.TestCase):
    def squat(self, reply):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(8)

        def answer():
            while True:
                try:
                    client, _ = listener.accept()
                except OSError:
                    return
                with client:
                    try:
                        client.recv(4096)
                        client.sendall(reply)
                    except OSError:
                        pass

        threading.Thread(target=answer, daemon=True).start()
        self.addCleanup(listener.close)
        return listener.getsockname()[1]

    def test_non_http_replies_are_not_ours(self):
        for reply in (b"SSH-2.0-OpenSSH_9.9\r\n", b"\x00\x01\x02\xff\r\n\r\n",
                      b"HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n{", b"HTTP/1.1 999999 ?\r\n\r\n"):
            self.assertFalse(serve.running_here(self.squat(reply)), reply)

    def start_copy(self, port, workdir=None):
        """在临时副本里启动：不碰项目本身的端口与 data/。返回打印出的地址行。"""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        copy = Path(tmp.name).resolve() / "project"
        (copy / "scripts").mkdir(parents=True)
        shutil.copy(ROOT / "scripts" / "serve.py", copy / "scripts")
        child = subprocess.Popen([sys.executable, "-I", str(copy / "scripts" / "serve.py"), "--no-open", "--port", str(port)],
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

        def stop():
            if child.poll() is None:
                child.terminate()
            child.communicate(timeout=10)

        self.addCleanup(stop)
        for line in child.stdout:
            if b"http://localhost:" in line:
                return line.decode()
        self.fail("没有打印出看板地址")

    def test_launcher_moves_to_a_free_port(self):
        busy = self.squat(b"SSH-2.0-OpenSSH_9.9\r\n")
        self.assertNotIn(f":{busy}/", self.start_copy(busy))

    @unittest.skipUnless(socket.has_ipv6, "没有 IPv6")
    def test_skips_a_port_taken_on_ipv6_localhost(self):
        listener = socket.socket(socket.AF_INET6)
        self.addCleanup(listener.close)
        try:
            listener.bind(("::1", 0))
        except OSError as err:
            self.skipTest(f"没有 IPv6 回环：{err}")
        listener.listen(8)
        busy = listener.getsockname()[1]
        self.assertNotIn(f":{busy}/", self.start_copy(busy))


class CommandLine(unittest.TestCase):
    def test_help_and_typos_never_fetch(self):
        for argument in ("--help", "--dry-run", "--event", "now"):
            code = "\n".join((
                "import importlib.util, sys",
                "sys.dont_write_bytecode = True",
                f"spec = importlib.util.spec_from_file_location('u', {str(ROOT / 'scripts' / 'update_data.py')!r})",
                "u = importlib.util.module_from_spec(spec); spec.loader.exec_module(u)",
                "u.run = lambda: (print('FETCH'), sys.exit(9))",
                f"sys.argv = ['update_data.py', {argument!r}]",
                "u.main()",
            ))
            done = subprocess.run([sys.executable, "-I", "-c", code], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
            self.assertNotIn(b"FETCH", done.stdout, argument)


class IgnoreRules(unittest.TestCase):
    @unittest.skipUnless(shutil.which("git"), "没有 git")
    def test_local_data_can_never_be_staged(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, outside = Path(tmp) / "repo", Path(tmp) / "outside"
            repo.mkdir()
            outside.mkdir()
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            shutil.copy(ROOT / ".gitignore", repo)
            (repo / "data").symlink_to(outside)  # 数据放在仓库外
            (repo / "docs").mkdir()
            names = [f"ai-models-table-2026-11-22.{ext}" for ext in ("csv", "json", "png", "svg")]
            names += ["docs/preview.jpg", "ai-models-table-2026-11-22 (1).csv"]
            for name in names:
                (repo / name).write_text("x")
            seen = subprocess.run(["git", "-C", str(repo), "status", "--porcelain", "--untracked-files=all"],
                                  stdout=subprocess.PIPE, check=True).stdout.decode().splitlines()
            self.assertEqual(["?? .gitignore"], seen)

    @unittest.skipUnless(shutil.which("git"), "没有 git")
    def test_plain_data_folder_is_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(["git", "init", "-q", tmp], check=True)
            shutil.copy(ROOT / ".gitignore", tmp)
            (Path(tmp) / "data").mkdir()
            (Path(tmp) / "data" / "data.js").write_text("x")
            seen = subprocess.run(["git", "-C", tmp, "status", "--porcelain", "--untracked-files=all"],
                                  stdout=subprocess.PIPE, check=True).stdout.decode().splitlines()
            self.assertEqual(["?? .gitignore"], seen)


def fake(body):
    prelude = "import json,sys,time\ndef e(**k): print(json.dumps(k), flush=True)\n"
    return [sys.executable, "-I", "-c", prelude + body]


class Jobs(unittest.TestCase):
    def run_job(self, body, timeout=10):
        updater = serve.Updater(ROOT, fake(body), timeout)
        self.addCleanup(updater.shutdown)
        self.assertTrue(updater.start())
        return updater

    def wait(self, updater, *states):
        deadline = time.time() + 10
        while time.time() < deadline:
            job = updater.status()["job"]
            if job["state"] in states:
                return job
            time.sleep(0.03)
        self.fail(f"没有进入 {states}：{updater.job}")

    def test_success(self):
        job = self.wait(self.run_job("e(event='progress',stage='details',done=3,total=9)\ne(event='done')"), "done")
        self.assertEqual((3, 9), (job["done"], job["total"]))

    def test_reported_error(self):
        job = self.wait(self.run_job("e(event='error',message='原站改版')\nsys.exit(1)"), "error")
        self.assertEqual("原站改版", job["error"])

    def test_crash(self):
        self.assertIn("boom", self.wait(self.run_job("raise RuntimeError('boom')"), "error")["error"])

    def test_noise_on_stdout(self):
        self.wait(self.run_job("print('hello')\nprint('[1,2]')\ne(event='done')"), "done")

    def test_timeout(self):
        self.assertIn("已停止", self.wait(self.run_job("time.sleep(30)", timeout=0.3), "error")["error"])

    def test_only_one_at_a_time(self):
        self.assertFalse(self.run_job("time.sleep(30)").start())

    def test_cancel(self):
        updater = self.run_job("time.sleep(30)")
        self.assertTrue(updater.cancel())
        self.wait(updater, "cancelled")

    def test_no_cancel_while_saving(self):
        updater = self.run_job("e(event='progress',stage='save')\ntime.sleep(1)\ne(event='done')")
        deadline = time.time() + 5
        while updater.status()["job"]["stage"] != "save" and time.time() < deadline:
            time.sleep(0.02)
        self.assertFalse(updater.cancel())
        self.wait(updater, "done")

    def test_retry_after_failure(self):
        updater = self.run_job("sys.exit(2)")
        self.wait(updater, "error")
        self.assertTrue(updater.start())

    def test_missing_executable(self):
        updater = serve.Updater(ROOT, ["/no/such/python"])
        updater.start()
        self.assertEqual("error", updater.status()["job"]["state"])


class LocalServer(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        # 克隆下来时没有 data/，所以用一份独立的站点目录
        root = Path(tmp.name).resolve()
        for folder in ("assets", "tests"):
            shutil.copytree(ROOT / folder, root / folder, ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copy(ROOT / "index.html", root)
        (root / "data").mkdir()
        (root / "data" / "data.js").write_text("window.AA_DATA={};")
        # 不在白名单里的文件必须真实存在，否则 404 说明不了任何问题
        for name in ("scripts/serve.py", ".claude/launch.json", "README.md", "data/.update.lock",
                     "data/leaderboard-raw.json", "data/index.html"):
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_text("secret")
        self.root = root
        self.updater = serve.Updater(root, fake("time.sleep(30)"))
        self.server = serve.Server(0, self.updater)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, args=(0.05,), daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.updater.shutdown)
        self.addCleanup(self.server.shutdown)

    def request(self, path, method="GET", host=None, **headers):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        self.addCleanup(connection.close)
        connection.request(method, path, headers={
            "Host": host or f"localhost:{self.port}", **{k.replace("_", "-"): v for k, v in headers.items()},
        })
        response = connection.getresponse()
        return response, response.read()

    def post(self, path, origin="same", token="1", host=None):
        headers = {}
        if origin:
            headers["Origin"] = f"http://localhost:{self.port}" if origin == "same" else origin
        if token:
            headers["X_Score_Trends"] = token
        return self.request(path, "POST", host, **headers)[0].status

    def test_serves_app(self):
        for path in ("/", "/index.html?x=1", "/assets/update.js", "/data/data.js", "/tests/", "/tests/e2e.js"):
            self.assertEqual(200, self.request(path)[0].status, path)

    def test_hides_everything_else(self):
        for path in ("/scripts/serve.py", "/.claude/launch.json", "/README.md", "/data/.update.lock", "/data/",
                     "/data/leaderboard-raw.json",
                     "/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/assets/../scripts/serve.py", "//etc/passwd"):
            self.assertEqual(404, self.request(path)[0].status, path)

    def test_only_listens_on_loopback(self):
        self.assertEqual("127.0.0.1", self.server.server_address[0])

    def test_rejects_dns_rebinding(self):
        for host in ("evil.example", f"evil.example:{self.port}", "localhost", f"localhost.evil.example:{self.port}"):
            self.assertEqual(403, self.request("/api/status", host=host)[0].status, host)

    def test_rejects_foreign_pages(self):
        for origin in (None, "null", "https://evil.example", "http://localhost:1", f"https://localhost:{self.port}"):
            self.assertEqual(403, self.post("/api/update", origin=origin), origin)
        self.assertEqual(403, self.post("/api/update", token=None))
        self.assertEqual("idle", self.updater.job["state"])

    def test_get_cannot_start(self):
        self.assertEqual(404, self.request("/api/update")[0].status)
        self.assertEqual("idle", self.updater.job["state"])

    def test_start_then_conflict_then_cancel(self):
        self.assertEqual(202, self.post("/api/update"))
        self.assertEqual(409, self.post("/api/update"))
        self.assertEqual(202, self.post("/api/cancel"))

    def test_no_cors_on_status(self):
        response, body = self.request("/api/status", Origin="https://evil.example")
        self.assertIsNone(response.getheader("Access-Control-Allow-Origin"))
        self.assertEqual("same-origin", response.getheader("Cross-Origin-Resource-Policy"))
        self.assertNotIn(str(self.root), body.decode())

    def test_ping_accepts_a_symlinked_project_path(self):
        link = self.root.parent / f"{self.root.name}-link"
        link.symlink_to(self.root)
        self.addCleanup(link.unlink)
        self.updater = serve.Updater(self.root, fake("pass"), launched_from=[link])
        self.server.updater = self.updater
        self.assertEqual(200, self.request(serve.ping_path(link))[0].status)
        self.assertEqual(200, self.request(serve.ping_path(self.root))[0].status)
        self.assertEqual(404, self.request(serve.ping_path(self.root.parent))[0].status)

    def test_ping_reveals_nothing(self):
        response, body = self.request(serve.ping_path(self.root))
        self.assertEqual("cross-origin", response.getheader("Cross-Origin-Resource-Policy"))
        self.assertLess(len(body), 100)

    def test_not_cached_and_not_frameable(self):
        response = self.request("/data/data.js")[0]
        self.assertEqual("no-store", response.getheader("Cache-Control"))
        self.assertEqual("SAMEORIGIN", response.getheader("X-Frame-Options"))


if __name__ == "__main__":
    unittest.main()
