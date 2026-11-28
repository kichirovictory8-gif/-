"""過去問（第102〜111回 必須問題 900問）の検索、カードの下書き作成、出題テーマ別のカバー率。

データは flashcards/data/hissu.json（リポジトリの data/hissu_102-111.json から作成）。
カードの下書きは追加画面に入り、保存するまでカードにはならない。
過去問から作ったカードには source = "hissu:<回>-<問>" を記録する。
"""
from __future__ import annotations

import json
import re
import sqlite3
from functools import lru_cache
from pathlib import Path

from .subjects import SUBJECTS, check_subject

DATA = Path(__file__).resolve().parent / "data" / "hissu.json"
SOURCE_PREFIX = "hissu:"
STYLES = ("qa", "cloze")
PAST_TAG = "過去問"


@lru_cache(maxsize=1)
def _load() -> tuple[dict, ...]:
    try:
        data = json.loads(DATA.read_text(encoding="utf-8"))
    except OSError:
        return ()
    return tuple(data.get("questions", []))


def available() -> bool:
    return bool(_load())


@lru_cache(maxsize=1)
def _by_id() -> dict[str, dict]:
    return {x["id"]: x for x in _load()}


def get(qid: str) -> dict:
    q = _by_id().get(str(qid))
    if q is None:
        raise KeyError(f"過去問が見つかりません: {qid}")
    return q


def themes(subject: str = "") -> list[dict]:
    """テーマの一覧（科目の表示順 → 10年の出題数が多い順）。"""
    if subject:
        check_subject(subject)
    agg: dict[tuple[str, str], dict] = {}
    for x in _load():
        if subject and x["subject"] != subject:
            continue
        key = (x["subject"], x["theme"])
        t = agg.setdefault(key, {"subject": x["subject"], "theme": x["theme"], "questions": 0, "years": set()})
        t["questions"] += 1
        t["years"].add(x["kai"])
    order = {s: i for i, s in enumerate(SUBJECTS)}
    out = [{**t, "years": len(t["years"])} for t in agg.values()]
    out.sort(key=lambda t: (order.get(t["subject"], 99), -t["questions"], t["theme"]))
    return out


def made_sources(conn: sqlite3.Connection) -> dict[str, int]:
    """過去問 id → その問題から作ったカードの枚数。"""
    rows = conn.execute(
        "SELECT source, COUNT(*) FROM cards WHERE source LIKE ? GROUP BY source", (SOURCE_PREFIX + "%",)
    ).fetchall()
    return {r[0][len(SOURCE_PREFIX):]: r[1] for r in rows}


def search(conn: sqlite3.Connection, subject: str = "", theme: str = "", q: str = "",
           hide_made: bool = False, limit: int = 30, offset: int = 0) -> dict:
    if subject:
        check_subject(subject)
    made = made_sources(conn)
    words = [w for w in re.split(r"\s+", q.strip()) if w]
    hits = []
    for x in _load():
        if subject and x["subject"] != subject:
            continue
        if theme and x["theme"] != theme:
            continue
        if hide_made and x["id"] in made:
            continue
        if words:
            hay = " ".join([x["stem"], x["theme"], *x["options"]])
            if not all(w in hay for w in words):
                continue
        hits.append(x)
    # 新しい回から
    hits.sort(key=lambda x: (-x["kai"], x["q"]))
    page = [{**x, "made": made.get(x["id"], 0)} for x in hits[offset:offset + limit]]
    return {"total": len(hits), "items": page}


def _clean(text: str) -> str:
    # 穴埋め記法と衝突する文字列をくずしておく
    return str(text).replace("{{", "{ {").replace("}}", "} }").replace("::", ": :").strip()


def draft(qid: str, style: str = "qa") -> dict:
    """過去問1問からカードの下書きを作る。

    qa    … 表面 = 問題文＋選択肢、裏面 = 正答
    cloze … 表面 = 問題文 → {{c1::正答の選択肢}}（選択肢が読み取れていない問題では使えない）
    """
    if style not in STYLES:
        raise ValueError(f"下書きの形が正しくありません: {style}")
    x = get(qid)
    stem, opts = _clean(x["stem"]), [_clean(o) for o in x["options"]]
    nums = [int(n) for n in re.findall(r"\d+", x["answer"])]
    answers = [opts[n - 1] for n in nums if 1 <= n <= len(opts)]
    ref = f"（第{x['kai']}回 問{x['q']}）"
    notes = []
    if x["figure"]:
        notes.append("※ 図・構造式が必要な問題です。問題冊子の図を画像で貼ってください。")
    if "□" in x["stem"] or any("□" in o for o in x["options"]):
        notes.append("※ □ は、元の PDF の上付き・下付き文字などが読み取れなかった部分です。直してください。")
    if style == "cloze":
        if not answers:
            raise ValueError("この問題は選択肢が読み取れていないため、穴埋めの形では作れません")
        front = f"{stem}\n→ " + "、".join(f"{{{{c1::{a}}}}}" for a in answers)
        back = ref
    else:
        front = stem + ("\n" + "\n".join(f"{i}. {o}" for i, o in enumerate(opts, 1)) if opts else "")
        ans = "、".join(f"{n}. {opts[n - 1]}" if 1 <= n <= len(opts) else str(n) for n in nums)
        back = f"正答：{ans}\n{ref}"
    return {"subject": x["subject"], "unit": x["theme"], "front": front, "back": back,
            "tags": [PAST_TAG, f"第{x['kai']}回"], "source": SOURCE_PREFIX + x["id"],
            "notes": notes, "style": style, "question": x}


def coverage(conn: sqlite3.Connection, subject: str = "") -> dict:
    """出題テーマ別のカバー率。

    カードがそのテーマに属するとみなす条件（同じ科目のカードのみ）:
      系統 = テーマ名 / タグ = テーマ名 / そのテーマの過去問から作った（source）
    """
    ths = themes(subject)
    qtheme = {x["id"]: (x["subject"], x["theme"]) for x in _load()}
    cards = conn.execute("SELECT id, subject, unit, source FROM cards").fetchall()
    tags: dict[int, set[str]] = {}
    for r in conn.execute("SELECT card_id, tag FROM card_tags"):
        tags.setdefault(r[0], set()).add(r[1])
    count: dict[tuple[str, str], int] = {}
    names = {(t["subject"], t["theme"]) for t in ths}
    for c in cards:
        keys = set()
        if (c["subject"], c["unit"]) in names:
            keys.add((c["subject"], c["unit"]))
        for t in tags.get(c["id"], ()):
            if (c["subject"], t) in names:
                keys.add((c["subject"], t))
        src = c["source"] or ""
        if src.startswith(SOURCE_PREFIX) and src[len(SOURCE_PREFIX):] in qtheme:
            k = qtheme[src[len(SOURCE_PREFIX):]]
            if k[0] == c["subject"]:
                keys.add(k)
        for k in keys:
            count[k] = count.get(k, 0) + 1
    rows = [{**t, "cards": count.get((t["subject"], t["theme"]), 0)} for t in ths]
    total_q = sum(t["questions"] for t in rows)
    covered = [t for t in rows if t["cards"]]
    by_subject = []
    for s in SUBJECTS:
        rs = [t for t in rows if t["subject"] == s]
        if not rs:
            continue
        q_all = sum(t["questions"] for t in rs)
        q_cov = sum(t["questions"] for t in rs if t["cards"])
        by_subject.append({"subject": s, "themes": len(rs), "covered": sum(1 for t in rs if t["cards"]),
                           "questions": q_all, "rate": round(q_cov / q_all, 4) if q_all else 0.0})
    return {
        "themes": rows,
        "summary": {"themes": len(rows), "covered": len(covered), "questions": total_q,
                    "rate": round(sum(t["questions"] for t in covered) / total_q, 4) if total_q else 0.0},
        "by_subject": by_subject,
    }
