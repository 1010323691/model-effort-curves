#!/usr/bin/env python3
"""生成完全虚构的测试数据：不访问外网，不含任何真实榜单数值。

只借用厂商名来覆盖配色、别名与地区归类；模型名和全部数值都按固定种子随机生成。
数据走 scripts/update_data.py 的真实解析、校验与写入流程。

用法：python3 -I tests/fixture.py <项目副本目录>
"""
import datetime
import importlib.util
import json
import random
import sys
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True

PROJECT = Path(__file__).resolve().parent.parent
VENDORS = ("OpenAI", "Google", "Anthropic", "Meta", "Alibaba", "DeepSeek", "SpaceXAI", "Z AI",
           "Mistral", "NVIDIA", "Kimi", "Xiaomi", "IBM", "Upstage", "Example Lab")
EVALS = ("fx-elo", "fx-coding", "fx-science", "fx-long-benchmark-name", "fx-agents",
         "fx-math", "fx-docs", "fx-terminal", "omniscience")
NAMED = ("Atlas Prime", "Nova", "Terra", "Comet", "Luna")  # 测试按名字引用这几个
EFFORTS = ("Non-reasoning", "Low", "Medium", "High", "Xhigh", "Max")
COST_SHARE = {"nonCacheInput": 0.05, "cacheRead": 0.3, "cacheWrite": 0.25, "reasoning": 0.25, "answer": 0.15}
GROUPS, PRICED_GROUPS = 69, 55


def efforts_of(group):
    if group in (2, 4):
        return EFFORTS
    if group < 10:
        return EFFORTS[1:]
    if group < 21:
        return EFFORTS[2:4] if group % 2 else EFFORTS[1:4]
    return (None,)


def build():
    rng = random.Random(20261122)
    newest = datetime.date(2026, 11, 20)
    models, releases, details = [], [], {}
    for g in range(GROUPS):
        title = "Test " + (NAMED[g] if g < len(NAMED) else f"Model {g:02d}")
        slug = title.lower().replace(" ", "-")
        efforts = efforts_of(g)
        top = max(3.0, 66 - g * 0.9 + rng.uniform(-2, 2))
        cheapest = 0.04 * 2.5 ** rng.uniform(0, 4.5)
        days = (g * 5) % 110 if g < 66 else (200, 300, 450)[g - 66]
        releases.append({"slug": slug, "releaseDate": (newest - datetime.timedelta(days=days)).isoformat()})
        for i, effort in enumerate(efforts):
            progress = (i + 1) / len(efforts)
            iq = top * (0.55 + 0.45 * progress ** 0.6)
            cost = cheapest * 1.9 ** i * rng.uniform(0.85, 1.15)
            if g == 0 and i == len(efforts) - 1:
                cost = 24.0  # 远离人群，用来触发局部图
            if 40 <= g < 43:
                cost = 0
            if g >= PRICED_GROUPS:
                cost = None
            measured = cost is not None
            key = f"fx-{g:02d}-{i}"
            scores = {name: min(0.97, max(0.02, iq / 80 + rng.uniform(-0.1, 0.1))) for name in EVALS[1:-1]}
            scores["fx-elo"] = round(900 + iq * 13)
            models.append({
                "id": key,
                "release": {"slug": slug, "name": title},
                "name": f"{title} ({effort})" if effort else title,
                "suffix": effort,
                "modelCreatorName": VENDORS[g % len(VENDORS)],
                "isReasoning": effort != "Non-reasoning" and g != 50,
                "isOpenWeights": g % 3 == 0,
                "paramClass": ("tiny", "small", "medium", "large", None)[g % 5],
                "priceClass": ("low", "medium", "high")[g % 3] if measured else None,
                "contextWindowTokens": (128000, 262144, 1000000)[g % 3],
                "intelligenceIndex": iq,
                "omniscience": iq - 22,
                "scores": scores,
                "intelligenceIndexCostPerTask": cost,
                "intelligenceIndexTimePerTask": 60 * rng.uniform(0.8, 6) * 1.5 ** i if measured else None,
                "outputSpeed": rng.uniform(30, 420) if measured else None,
                "timeToFirstAnswerToken": rng.uniform(1, 25) * 1.6 ** i if measured else None,
                "price1mInputTokens": rng.uniform(0.2, 6) if cost else cost,
                "price1mOutputTokens": rng.uniform(1, 30) if cost else cost,
                "cacheHitPrice": rng.uniform(0.02, 0.6) if cost else cost,
                "cacheWritePrice": rng.uniform(0.5, 7) if cost and g % 2 else None,
            })
            reasoning, answer = rng.uniform(4000, 60000) * progress, rng.uniform(3000, 20000)
            default = {"slug": efforts[len(efforts) // 2].lower()} if effort else None
            detail = {
                "id": key,
                "inputModalityImage": g % 4 != 1,
                "release": {"slug": slug, "defaultEffort": default},
                "intelligenceIndexOutputTokensPerTask": {
                    "reasoning": reasoning, "answer": answer, "output": reasoning + answer,
                },
            }
            if measured:
                parts = {name: cost * share for name, share in COST_SHARE.items()}
                parts.update(total=cost, input=cost * 0.6, output=cost * 0.4)
                detail["intelligenceIndexCostPerTask"] = {
                    "cost": parts,
                    "evaluations": [{"slug": name, "weightedCostPerTask": cost / len(EVALS)} for name in EVALS],
                }
            details.setdefault(slug, []).append(detail)
    evaluations = [{"href": f"/evaluations/{name}", "name": f"{name} Benchmark"} for name in EVALS]
    index = (f'"initialModels":{json.dumps(models)},"releases":{json.dumps(releases)},'
             f'"generalEvaluations":{json.dumps(evaluations)},'
             '"title":"Artificial Analysis Intelligence Index v0.0.1"')
    return index, details


def write(root):
    """在 root/data 下写出一整套数据文件。"""
    spec = importlib.util.spec_from_file_location("fixture_update", PROJECT / "scripts" / "update_data.py")
    update = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(update)
    update.DATA = Path(root) / "data"
    index, details = build()

    def fetch(url, tries=3):
        if url == update.SOURCE:
            return index
        return "".join(json.dumps(d, separators=(",", ":")) for d in details[url.rsplit("/", 1)[-1]])

    update.fetch = fetch
    with mock.patch.object(update.time, "sleep"), mock.patch.object(update.signal, "signal"):
        return update.run()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    target = Path(sys.argv[1]).resolve()
    # 已有数据时拒绝写入，避免测试数据盖掉使用者抓取的真实数据
    if target == PROJECT or (target / "data" / "data.js").exists():
        sys.exit(f"{target} 是项目本身或已有数据，未写入")
    write(target)
