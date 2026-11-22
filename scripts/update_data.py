#!/usr/bin/env python3
"""抓取 Artificial Analysis 模型排行榜中公开的明文数据。

只读取页面 HTML 内嵌的明文 RSC 数据，不读取、不解密站点的加密 manifest。
只依赖 Python 标准库。用法：python3 -I scripts/update_data.py [--events]
--events 供本机服务使用：逐行输出 JSON 进度。
"""
import argparse
import contextlib
import csv
import http.client
import io
import json
import math
import os
import re
import signal
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

try:
    import fcntl
except ImportError:  # Windows 没有 fcntl
    fcntl = None

BASE = "https://artificialanalysis.ai"
SOURCE = f"{BASE}/zh/leaderboards/models"
DATA = Path(__file__).resolve().parent.parent / "data"
PUSH = re.compile(r'<script>self\.__next_f\.push\((\[1,.*?\])\)</script>', re.S)
DECODER = json.JSONDecoder()

EFFORT_RE = re.compile(r"^(non-reasoning|minimal|low|medium|high|xhigh|max)\b", re.I)
EFFORT_RANK = {"non-reasoning": 0, "minimal": 1, "low": 2, "medium": 3, "high": 4, "xhigh": 5, "max": 6}
CN = {"Alibaba", "DeepSeek", "Kimi", "Z AI", "Tencent", "InclusionAI", "Xiaomi", "MiniMax", "StepFun",
      "Joy Future Academy", "Nanbeige", "China Mobile", "Baidu", "ByteDance Seed", "KwaiKAT"}
US = {"Anthropic", "OpenAI", "Google", "Meta", "SpaceXAI", "NVIDIA", "Thinking Machines", "IBM", "Liquid AI",
      "Microsoft", "Amazon", "Reflection", "Apodex"}


NUMBERS = ("cost", "minutes", "ttft", "speed", "context", "priceIn", "priceOut", "priceHit", "priceWrite",
           "tokens", "tokensReasoning", "tokensAnswer")
TRACKED = ("iq", "cost", "minutes", "priceIn", "priceOut", "priceHit", "priceWrite")
# 关闭终端发来的是 SIGHUP，要与另外两个同等对待
INTERRUPTS = [getattr(signal, name) for name in ("SIGTERM", "SIGINT", "SIGHUP") if hasattr(signal, name)]
EVENTS = "--events" in sys.argv[1:]


class ScrapeError(Exception):
    pass


class Cancelled(BaseException):
    """继承 BaseException，避免被网络层的 except Exception 吞掉。"""


def emit(event, **fields):
    if EVENTS:
        print(json.dumps({"event": event, **fields}, ensure_ascii=True), flush=True)


def progress(stage, done=0, total=0, label=""):
    emit("progress", stage=stage, done=done, total=total, label=label)
    if not EVENTS and stage == "details" and sys.stdout.isatty():
        print(f"\r详情页 {done}/{total} {label[:50]:50}", end="\n" if done == total else "", flush=True)


def fetch(url, tries=3):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=45) as res:
                html = res.read().decode("utf-8")
            return "".join(json.loads(m)[1] for m in PUSH.findall(html))
        except urllib.error.HTTPError as err:
            # 4xx 重试也不会好，429 除外
            if attempt == tries - 1 or (err.code < 500 and err.code != 429):
                raise ScrapeError(f"原站返回 HTTP {err.code}：{url}") from err
            time.sleep(2 ** (attempt + 1))
        except (OSError, http.client.HTTPException, ValueError) as err:
            if attempt == tries - 1:
                reason = getattr(err, "reason", err)
                raise ScrapeError(f"连不上原站，请检查网络或代理后重试（{reason}）") from err
            time.sleep(2 ** (attempt + 1))


def value_after(text, key):
    at = text.find(f'"{key}":')
    if at < 0:
        raise ScrapeError(f"页面结构已变化：找不到 {key}")
    return DECODER.raw_decode(text, at + len(key) + 3)[0]


def detail_objects(text):
    """完整的模型详情对象。没有价格的模型不带成本键，所以不能拿成本来识别。"""
    for match in re.finditer(r'\{"id":"', text):
        try:
            obj, _ = DECODER.raw_decode(text, match.start())
        except ValueError:
            continue
        if isinstance(obj.get("release"), dict) and "inputModalityImage" in obj:
            yield obj


def build_row(model, released, detail):
    release = model["release"]
    suffix = model.get("suffix") or ""
    match = EFFORT_RE.match(suffix)
    effort = match.group(1).lower() if match else None
    cost = detail.get("intelligenceIndexCostPerTask")
    cost = cost if isinstance(cost, dict) else {}
    tokens = detail.get("intelligenceIndexOutputTokensPerTask") or {}
    default = ((detail.get("release") or {}).get("defaultEffort") or {}).get("slug")
    seconds = model.get("intelligenceIndexTimePerTask")
    creator = model["modelCreatorName"]
    scores = dict(model.get("scores") or {})
    if model.get("omniscience") is not None:
        scores["omniscience"] = model["omniscience"]
    return {
        "id": model["id"], "name": model["name"], "group": release["slug"], "model": release["name"],
        "suffix": suffix, "effort": effort, "rank": EFFORT_RANK.get(effort),
        # None 表示这次没取到，留给 carry_details 处理
        "isDefault": False if not effort else (effort == default if default else None),
        "vendor": creator,
        "region": "cn" if creator in CN else "us" if creator in US else "other",
        "open": bool(model.get("isOpenWeights")), "reasoning": bool(model.get("isReasoning")),
        "size": model.get("paramClass") or "unknown", "priceClass": model.get("priceClass") or "unknown",
        "released": released.get(release["slug"]),
        "iq": model["intelligenceIndex"],
        "cost": model.get("intelligenceIndexCostPerTask"),
        "minutes": seconds / 60 if seconds is not None else None,
        "ttft": model.get("timeToFirstAnswerToken"), "speed": model.get("outputSpeed"),
        "context": model.get("contextWindowTokens"),
        "priceIn": model.get("price1mInputTokens"), "priceOut": model.get("price1mOutputTokens"),
        "priceHit": model.get("cacheHitPrice"), "priceWrite": model.get("cacheWritePrice"),
        "tokens": tokens.get("output"), "tokensReasoning": tokens.get("reasoning"),
        "tokensAnswer": tokens.get("answer"),
        "costParts": cost.get("cost"),
        "costByEval": {e["slug"]: e["weightedCostPerTask"] for e in cost.get("evaluations") or []},
        "image": detail.get("inputModalityImage"),
        "scores": scores,
    }


def scrape():
    progress("index")
    page = fetch(SOURCE)
    models = value_after(page, "initialModels")
    released = {r["slug"]: r.get("releaseDate") for r in value_after(page, "releases")}
    version = re.search(r"Artificial Analysis Intelligence Index v(\d+(?:\.\d+)*)", page)
    names = {}
    for item in value_after(page, "generalEvaluations"):
        slug = (item.get("href") or "").rsplit("/", 1)[-1]
        names[slug] = re.sub(r" Benchmark$", "", item["name"].split(":")[0])

    ranked = [m for m in models if m.get("intelligenceIndex") is not None]
    if len(ranked) < 30:
        raise ScrapeError(f"只解析到 {len(ranked)} 条有智能指数的数据，疑似页面改版，未覆盖旧数据")

    details, failed = {}, []
    members = {}
    for m in ranked:
        members.setdefault(m["release"]["slug"], set()).add(m["id"])
    groups = sorted(members)
    progress("details", 0, len(groups))
    for i, slug in enumerate(groups, 1):
        if not re.fullmatch(r"[\w.-]+", slug):
            raise ScrapeError(f"模型标识异常：{slug[:80]!r}，未覆盖旧数据")
        try:
            found = {obj["id"]: obj for obj in detail_objects(fetch(f"{BASE}/models/{slug}"))}
            details.update(found)
            if members[slug].isdisjoint(found):
                raise ScrapeError(f"详情页里没有解析出该模型：{slug}")
        except ScrapeError as err:
            failed.append(str(err))
            # 已注定失败时不再继续请求原站
            if len(failed) > len(groups) * 0.2:
                raise ScrapeError(f"{len(failed)}/{len(groups)} 个详情页失败，未覆盖旧数据。首个错误：{failed[0]}")
        progress("details", i, len(groups), slug)
        time.sleep(0.4)

    rows = [build_row(m, released, details.get(m["id"], {})) for m in ranked]

    drift = [r["name"] for r in rows if r["costParts"] and r["cost"] is not None
             and abs(r["costParts"]["total"] - r["cost"]) > 1e-6]
    for row in rows:
        if row["name"] in drift:
            row["costParts"] = None
    meta = {
        "source": SOURCE,
        "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "indexVersion": version.group(1) if version else None,
        "listed": len(models),
        "listedGroups": len({m["release"]["slug"] for m in models}),
        "ranked": len(rows),
        "plottable": sum(r["cost"] is not None for r in rows),
        "withCostParts": sum(bool(r["costParts"]) for r in rows),
        "detailFailures": failed,
        "costDrift": drift,
        "evalNames": names,
    }
    return {"meta": meta, "rows": rows}, models


def is_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def version_changed(meta, before):
    new, previous = meta["indexVersion"], before.get("indexVersion")
    return bool(new and previous and new != previous)


def validate(payload, old):
    """在覆盖任何文件之前拦下会让页面出错或明显残缺的数据。"""
    meta, rows = payload["meta"], payload["rows"]
    if len({r["id"] for r in rows}) != len(rows):
        raise ScrapeError("新数据里有重复的配置 ID，未覆盖旧数据")
    for row in rows:
        bad = [k for k in ("id", "name", "group", "model", "vendor") if not isinstance(row[k], str) or not row[k]]
        bad += [k for k in NUMBERS if row[k] is not None and (not is_number(row[k]) or row[k] < 0)]
        if not is_number(row["iq"]):
            bad.append("iq")
        if row["released"] is not None:
            try:
                datetime.strptime(row["released"], "%Y-%m-%d")
            except (TypeError, ValueError):
                bad.append("released")
        if any(v is not None and not is_number(v) for v in row["scores"].values()):
            bad.append("scores")
        if any(not is_number(v) for v in row["costByEval"].values()):
            bad.append("costByEval")
        if bad:
            raise ScrapeError(f"{str(row['name'])[:80]} 的 {', '.join(bad)} 格式异常，未覆盖旧数据")
    if not meta["plottable"]:
        raise ScrapeError("新数据里没有任何单任务价格，疑似原站改版，未覆盖旧数据")

    before = (old or {}).get("meta") or {}
    # 指数换版时数量骤降是正常的；同一版本内骤降基本都是解析坏了
    if not version_changed(meta, before):
        for key, name in (("ranked", "有智能分的配置"), ("plottable", "有价格的配置"), ("withCostParts", "成本构成")):
            if meta[key] < (before.get(key) or 0) * 0.5:
                raise ScrapeError(f"{name}从 {before[key]} 骤降到 {meta[key]}，疑似原站改版，未覆盖旧数据")


def carry_details(payload, old):
    """这次没取到的详情沿用上一版，并在该行用 detailFrom 记下这些值的来源时间。

    必须在 validate 之后调用，否则沿用的旧值会掩盖原站改版造成的整体缺失。
    """
    meta, before = payload["meta"], (old or {}).get("meta") or {}
    previous = {r["id"]: r for r in (old or {}).get("rows", [])}
    same_index = not version_changed(meta, before)
    has_default = {r["group"] for r in payload["rows"] if r["isDefault"]}
    for row in payload["rows"]:
        prev = previous.get(row["id"], {})
        fields = ["image"]
        # 成本与 Token 都按指数的评测任务计量，换版后不能沿用
        if same_index:
            fields += ["tokens", "tokensReasoning", "tokensAnswer"]
            parts = prev.get("costParts")
            # 价格变了，旧的拆分就对不上新的总价
            if parts and row["cost"] is not None and abs(parts["total"] - row["cost"]) <= 1e-6:
                fields += ["costParts", "costByEval"]
        kept = False
        for key in fields:
            if row[key] in (None, {}) and prev.get(key) not in (None, {}):
                row[key] = prev[key]
                kept = True
        if row["isDefault"] is None:
            row["isDefault"] = bool(prev.get("isDefault")) and row["group"] not in has_default
            kept = kept or row["isDefault"]
        if kept:
            row["detailFrom"] = prev.get("detailFrom") or before.get("fetchedAt")
    meta["withCostParts"] = sum(bool(r["costParts"]) for r in payload["rows"])


def same_value(a, b):
    if is_number(a) and is_number(b):
        # 万分之五以内视为浮点与取整噪声
        return math.isclose(a, b, rel_tol=5e-4, abs_tol=1e-9)
    return a == b


def compare(payload, old):
    before = {r["id"]: r for r in (old or {}).get("rows", [])}
    after = {r["id"]: r for r in payload["rows"]}
    brief = lambda r: {k: r.get(k) for k in ("id", "group", "name", "iq", "cost")}
    changed, performance = [], 0
    for key, row in after.items():
        prev = before.get(key)
        if not prev:
            continue
        fields = {k: [prev.get(k), row[k]] for k in TRACKED if not same_value(prev.get(k), row[k])}
        if fields:
            changed.append({**brief(row), "fields": fields})
        # 延迟和速度是滚动实测值，单独计数，不淹没真正的变化
        if not all(same_value(prev.get(k), row[k]) for k in ("speed", "ttft")):
            performance += 1
    meta, old_meta = payload["meta"], (old or {}).get("meta") or {}
    return {
        "fetchedAt": meta["fetchedAt"], "previousAt": old_meta.get("fetchedAt"),
        "version": [old_meta.get("indexVersion"), meta["indexVersion"]],
        "added": [brief(r) for k, r in after.items() if before and k not in before],
        "removed": [brief(r) for k, r in before.items() if k not in after],
        "changed": changed, "performance": performance,
        "stale": sum("detailFrom" in r for r in payload["rows"]),
        "incomplete": sum(r["image"] is None or (r["cost"] is not None and not r["costParts"])
                          for r in payload["rows"]),
    }


def read_previous():
    try:
        old = json.loads((DATA / "models.json").read_text(encoding="utf-8"))
        return old if isinstance(old.get("rows"), list) else None
    except (OSError, ValueError, AttributeError):
        return None


@contextlib.contextmanager
def update_lock():
    """命令行和页面同时更新时，只放行一个。"""
    DATA.mkdir(exist_ok=True)
    with (DATA / ".update.lock").open("w") as handle:
        if fcntl:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as err:
                raise ScrapeError("已有另一个更新正在运行，请稍后再试") from err
        yield


def commit(files):
    """先全部写成临时文件再替换；中途失败就把已替换的写回原内容。"""
    staged = []
    replaced = []
    try:
        for path, content in files.items():
            tmp = path.with_name(path.name + ".tmp")
            staged.append((path, tmp, path.read_bytes() if path.exists() else None))
            tmp.write_bytes(content)
        for path, tmp, previous in staged:
            os.replace(tmp, path)
            replaced.append((path, previous))
    except OSError:
        for path, previous in replaced:
            if previous is None:
                path.unlink()
            else:
                path.write_bytes(previous)
        for _, tmp, _ in staged:
            with contextlib.suppress(OSError):
                tmp.unlink()
        raise


def csv_cell(value):
    # 来源文本以 = + - @ 开头时，电子表格会当作公式执行
    return f"'{value}" if isinstance(value, str) and value[:1] in "=+-@" else value


def save(payload, models, summary):
    compact = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).replace("<", "\\u003c")
    cols = [k for k in payload["rows"][0] if k not in ("scores", "costParts", "costByEval", "detailFrom")]
    cols.append("detailFrom")  # 只有部分行有这个键，不能依赖第一行
    table = io.StringIO()
    writer = csv.writer(table)
    writer.writerow(cols)
    writer.writerows([csv_cell(r.get(c)) for c in cols] for r in payload["rows"])
    commit({
        DATA / "leaderboard-raw.json": json.dumps(models, ensure_ascii=False, indent=1).encode("utf-8"),
        DATA / "models.csv": table.getvalue().encode("utf-8-sig"),
        DATA / "data.js": f"window.AA_DATA={compact};\n".encode("utf-8"),
        DATA / "last-update.json": json.dumps(summary, ensure_ascii=False, indent=1).encode("utf-8"),
        # 页面以它的时间戳判断有没有新数据，所以最后替换
        DATA / "models.json": json.dumps(payload, ensure_ascii=False, indent=1).encode("utf-8"),
    })


def run():
    with update_lock():
        old = read_previous()
        payload, models = scrape()
        progress("validate")
        validate(payload, old)
        carry_details(payload, old)
        payload["rows"].sort(key=lambda r: -r["iq"])
        summary = compare(payload, old)
        progress("save")
        ignore_interrupts()  # 从这里开始不可中断
        save(payload, models, summary)
    return payload, summary


def ignore_interrupts():
    for sig in INTERRUPTS:
        signal.signal(sig, signal.SIG_IGN)


def cancel(*_):
    ignore_interrupts()  # 关终端时信号会接连到达，不能打断收尾
    raise Cancelled


def main():
    parser = argparse.ArgumentParser(
        allow_abbrev=False,
        description="从 Artificial Analysis 抓取榜单并写入本机 data/。会访问原站并覆盖已有数据。",
    )
    parser.add_argument("--events", action="store_true", help="供本机服务使用：逐行输出 JSON 进度")
    parser.parse_args()  # 帮助与拼错的参数在任何请求、写入之前退出
    for sig in INTERRUPTS:
        signal.signal(sig, cancel)
    try:
        payload, summary = run()
    except Cancelled:
        emit("cancelled")
        sys.exit(130 if EVENTS else "已取消，原数据未改动")
    except ScrapeError as err:
        message = str(err)
        if "CERTIFICATE_VERIFY_FAILED" in message:
            message = "HTTPS 证书校验失败，请检查本机 Python 的根证书或代理设置"
    except OSError as err:
        message = f"读写文件失败：{err}"
    except (KeyError, IndexError, TypeError, AttributeError, ValueError) as err:
        message = f"原站数据结构已变化（{type(err).__name__}: {err}），未覆盖旧数据"
    else:
        emit("done")
        if not EVENTS:
            print(json.dumps({k: v for k, v in payload["meta"].items() if k != "evalNames"}, ensure_ascii=False, indent=1))
            print(f"新增 {len(summary['added'])}，移除 {len(summary['removed'])}，变化 {len(summary['changed'])}")
        return
    emit("error", message=message)
    sys.exit(1 if EVENTS else f"失败：{message}")


if __name__ == "__main__":
    main()
