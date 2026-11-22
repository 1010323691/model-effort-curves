#!/usr/bin/env python3
"""看板的本机服务：提供页面，并执行页面发起的数据更新。

只监听 127.0.0.1，只提供白名单内的文件。更新接口只接受同源页面的请求。
用法：python3 -I scripts/serve.py [--port 8765] [--strict-port] [--no-open]
"""
import argparse
import errno
import hashlib
import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.request
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORTS = range(8765, 8775)  # 与 assets/update.js 中的探测范围一致
TIMEOUT = 600
TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".csv": "text/csv; charset=utf-8", ".svg": "image/svg+xml",
}
PUBLIC = {"index.html", "data/data.js", "data/models.json", "data/models.csv", "tests/index.html", "tests/e2e.js"}
PUBLIC |= {f"assets/{name}" for name in ("core.js", "plot.js", "views.js", "ui.js", "update.js", "style.css")}


def project_id(root):
    # 与 assets/update.js 的 projectId 算法一致
    return hashlib.sha256(unicodedata.normalize("NFC", str(root)).encode()).hexdigest()[:16]


def ping_path(root):
    return f"/ping-{project_id(root)}.svg"


def logical_paths(root):
    """用户打开项目时可能经过软链接，页面算出的是那条未解析的路径。"""
    candidates = [Path(os.path.abspath(__file__)).parent.parent]
    if os.environ.get("PWD"):
        candidates.append(Path(os.environ["PWD"]))
    found = []
    for path in candidates:
        try:
            if os.path.samefile(path, root):
                found.append(path)
        except OSError:
            pass
    return found


def taken_on_ipv6(port):
    """浏览器会先试 [::1]：那里若有别的程序，localhost 打开的就不是看板。"""
    try:
        with socket.create_connection(("::1", port), timeout=0.3):
            return True
    except OSError:
        return False


def read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


class Updater:
    """同一时间只跑一个更新子进程，并把它输出的事件整理成页面可读的状态。"""

    def __init__(self, root, command=None, timeout=TIMEOUT, launched_from=None):
        self.root = root
        aliases = logical_paths(root) if launched_from is None else launched_from
        self.pings = {ping_path(path) for path in (root, *aliases)}
        self.command = command or [sys.executable, "-I", str(root / "scripts" / "update_data.py"), "--events"]
        self.timeout = timeout
        self.lock = threading.Lock()
        self.process = None
        self.job = {"id": None, "state": "idle"}
        self._cache = (None, None, None)

    def _busy(self):
        return self.job["state"] in ("running", "cancelling")

    def start(self):
        with self.lock:
            if self._busy():
                return False
            job = {"id": uuid.uuid4().hex, "state": "running", "stage": "index", "done": 0, "total": 0,
                   "label": "", "error": None, "startedAt": time.time(), "endedAt": None}
            try:
                # 独立会话：终端的 Ctrl-C 与关窗只到服务端，由服务端决定如何结束它
                self.process = subprocess.Popen(self.command, cwd=self.root, stdin=subprocess.DEVNULL,
                                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
                                                start_new_session=True)
            except OSError as err:
                job.update(state="error", error=f"无法启动更新脚本：{err}", endedAt=time.time())
                self.job = job
                return True
            self.job = job
            threading.Thread(target=self._watch, args=(self.process, job), daemon=True).start()
            return True

    def _watch(self, process, job):
        expired = threading.Event()

        def expire():
            expired.set()
            process.kill()

        timer = threading.Timer(self.timeout, expire)
        timer.daemon = True
        timer.start()
        errors = []
        drain = threading.Thread(target=lambda: errors.append(process.stderr.read()), daemon=True)
        drain.start()
        final = None
        for line in process.stdout:
            try:
                event = json.loads(line)
                kind = event.get("event")
            except (ValueError, AttributeError):
                continue
            if kind == "progress":
                with self.lock:
                    job.update({k: event[k] for k in ("stage", "done", "total", "label") if k in event})
            elif kind in ("done", "error", "cancelled"):
                final = event
        code = process.wait()
        timer.cancel()
        drain.join(2)
        with self.lock:
            if final and final["event"] == "done" and code == 0:
                job["state"] = "done"
            elif (final and final["event"] == "cancelled") or (job["state"] == "cancelling" and not final):
                job["state"] = "cancelled"
            else:
                if expired.is_set():
                    message = f"更新超过 {self.timeout} 秒，已停止"
                elif final and final.get("message"):
                    message = final["message"]
                else:
                    tail = b"".join(errors).decode("utf-8", "replace").strip().splitlines()
                    message = f"更新进程意外退出（{code}）" + (f"：{tail[-1]}" if tail else "")
                job.update(state="error", error=message)
            job["endedAt"] = time.time()
        process.stdout.close()
        process.stderr.close()

    def cancel(self):
        with self.lock:
            # 开始写入后不再接受取消，避免留下半套文件
            if self.job["state"] != "running" or self.job.get("stage") == "save":
                return False
            self.job["state"] = "cancelling"
            process = self.process
            process.terminate()
        timer = threading.Timer(8, lambda: process.poll() is None and process.kill())
        timer.daemon = True
        timer.start()
        return True

    def status(self):
        data = self.root / "data"
        paths = (data / "models.json", data / "last-update.json")
        stamp = tuple(p.stat().st_mtime_ns if p.exists() else None for p in paths)
        with self.lock:
            if stamp != self._cache[0]:
                meta = (read_json(paths[0]) or {}).get("meta") or {}
                meta = {k: meta.get(k) for k in ("fetchedAt", "indexVersion", "ranked", "plottable")}
                self._cache = (stamp, meta, read_json(paths[1]))
            return {"project": project_id(self.root), "now": time.time(), "job": dict(self.job),
                    "data": self._cache[1], "last": self._cache[2]}

    def shutdown(self):
        with self.lock:
            process = self.process
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(8)
            except subprocess.TimeoutExpired:
                process.kill()


class Handler(BaseHTTPRequestHandler):
    server_version = "ScoreTrends"
    sys_version = ""
    timeout = 15

    def log_message(self, *args):
        pass

    def reply(self, code, body=b"", kind="text/plain; charset=utf-8", shared=False):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Content-Security-Policy", "frame-ancestors 'self'")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin" if shared else "same-origin")
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass  # 页面刷新时会主动断开

    def reply_json(self, code, value):
        self.reply(code, json.dumps(value, ensure_ascii=False).encode(), TYPES[".json"])

    def trusted_host(self):
        port = self.server.server_address[1]
        # 校验 Host，防止 DNS rebinding
        return self.headers.get("Host") in (f"localhost:{port}", f"127.0.0.1:{port}")

    def do_GET(self):
        if not self.trusted_host():
            return self.reply(403)
        path = self.path.split("?", 1)[0]
        if path in self.server.updater.pings:
            # 只让同一份项目的 file:// 页面知道服务在运行，不含任何数据
            svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="7" height="7"/>'
            return self.reply(200, svg, TYPES[".svg"], shared=True)
        if path == "/api/status":
            return self.reply_json(200, self.server.updater.status())
        name = "index.html" if path == "/" else path[1:]
        if name.endswith("/"):
            name += "index.html"
        if name not in PUBLIC:
            return self.reply(404)
        root = self.server.updater.root
        file = (root / name).resolve()
        if root not in file.parents:
            return self.reply(404)
        try:
            body = file.read_bytes()
        except OSError:
            return self.reply(404)
        self.reply(200, body, TYPES[file.suffix])

    do_HEAD = do_GET

    def do_POST(self):
        origin = self.headers.get("Origin")
        same_origin = origin == f"http://{self.headers.get('Host')}"
        if not self.trusted_host() or not same_origin or self.headers.get("X-Score-Trends") != "1":
            return self.reply_json(403, {"error": "只接受看板页面本身发起的请求"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self.reply_json(400, {"error": "请求无效"})
        if not 0 <= length <= 1024:
            return self.reply_json(413, {"error": "请求过大"})
        if length:
            self.rfile.read(length)
        updater = self.server.updater
        if self.path == "/api/update":
            started = updater.start()
            self.reply_json(202 if started else 409, updater.status())
        elif self.path == "/api/cancel":
            accepted = updater.cancel()
            self.reply_json(202 if accepted else 409, updater.status())
        else:
            self.reply_json(404, {"error": "没有这个接口"})


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port, updater):
        self.updater = updater
        super().__init__(("127.0.0.1", port), Handler)


def running_here(port):
    """端口上是否已是本项目的服务。"""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"http://127.0.0.1:{port}/api/status", timeout=1) as res:
            return json.load(res).get("project") == project_id(ROOT)
    except (OSError, ValueError, AttributeError, http.client.HTTPException):
        return False  # 包括端口上跑着别的、甚至不是 HTTP 的程序


def main():
    parser = argparse.ArgumentParser(description="启动看板")
    parser.add_argument("--port", type=int, default=PORTS[0])
    parser.add_argument("--strict-port", action="store_true", help="端口被占用时不换端口")
    parser.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    args = parser.parse_args()

    ports = [args.port] if args.strict_port else [args.port, *[p for p in PORTS if p != args.port]]

    def show(port):
        url = f"http://localhost:{port}/"
        print(f"看板地址：{url}", flush=True)
        if not args.no_open:
            webbrowser.open(url)

    for port in ports:
        if running_here(port):
            print("看板已经在运行。")
            show(port)
            return
    updater = Updater(ROOT)
    for port in ports:
        if taken_on_ipv6(port):
            continue
        try:
            server = Server(port, updater)
            break
        except OSError as err:
            if err.errno != errno.EADDRINUSE:
                sys.exit(f"无法启动：{err}")
    else:
        sys.exit(f"端口 {', '.join(map(str, ports))} 均被占用")

    def stop(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()

    for name in ("SIGINT", "SIGTERM", "SIGHUP"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), stop)
    if not (ROOT / "data" / "data.js").is_file():
        print("本地还没有数据。请先在项目文件夹里运行：python3 -I scripts/update_data.py，完成后刷新页面。", flush=True)
    show(port)
    print("保持本窗口打开即可在页面里更新数据；关闭窗口即停止。", flush=True)
    try:
        server.serve_forever()
    finally:
        updater.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
