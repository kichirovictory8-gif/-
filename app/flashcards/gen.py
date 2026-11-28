"""カードの自動生成（外部の AI は使わず、手元の材料とあなたの作り方の傾向から作る）。

材料
    過去問（data/hissu.json）… 問題文の言い換え「〇〇：{{c1::正答}}」、逆向き「正答 → 〇〇」、
                               「正しい記述はどれか」の正答の記述そのもの
    要点まとめ（data/notes.json）… docs/01・docs/03 の要点を1件ずつに分けたもの

対象のテーマ（苦手な分野）
    演習した結果のある出題テーマだけ。直近30日の ✖ の割合（再確認・練習を除く）と「要見直し」の枚数から
    苦手度を出し、10年の出題数が多いほど少し優先する。「簡単すぎ」で破棄が多いテーマは控えめにする。

穴の場所（あなたの作り方を学習する）
    文中の語句の候補（カタカナ語・英字や記号・数値と単位・漢字の用語・それらの組み合わせ）に、
    種類・長さ・文中の位置・「：」「＝」の直後か・後ろが助詞か、などの特徴を付ける。
    あなたのカードで穴にした語句（正例）と穴にしなかった語句（負例）の特徴を数え、特徴ごとの重みを出す。
    標準の重み（prior）とあなたの重みを、学習に使えた穴の数に応じて混ぜる（少ないうちは標準寄り）。
    「穴の場所が違う」で破棄されたカードの穴は負例として強めに数える。
    1枚の穴の数とヒントを付けるかどうかも、あなたのカードの平均に合わせる（穴は最大3つ）。
"""
from __future__ import annotations

import hashlib
import json
import math
import random
import re
import sqlite3
from datetime import date, datetime, timedelta
from functools import lru_cache
from pathlib import Path

from . import cloze, past
from .subjects import SUBJECTS

NOTES = Path(__file__).resolve().parent / "data" / "notes.json"
GEN_TAG = "自動生成"
DAILY_LIMIT = 10
PENDING_LIMIT = 30
WINDOW_DAYS = 30
MAX_HOLES = 3
REASONS = {"easy": "簡単すぎ", "position": "穴の場所が違う", "wrong": "内容が不正確", "duplicate": "重複"}
KIND_LABELS = {"past_q": "過去問の言い換え", "past_rev": "過去問の逆向き", "past_stmt": "過去問の正しい記述",
               "note": "要点まとめ"}

# ---------------------------------------------------------------- 語句の候補と特徴
KATA = r"[ァ-ヴー・]{2,}"
LATIN = r"[⁰¹²³⁴⁵⁶⁷⁸⁹ᵐ]*[A-Za-zα-ωΑ-Ω][A-Za-zα-ωΑ-Ω0-9⁺⁻₀-₉¹²³⁰-⁹+\-/]*"   # ⁹⁹ᵐTc なども1語
NUM = (r"\d+(?:\.\d+)?(?:\s*(?:%|％|mg|μg|g|kg|mL|L|mmHg|mEq|mol|時間|日|週|年|歳|倍|回|分|秒|℃|度|個|本|kDa|nm|Bq|Gy|Sv|ppm|Hz))?")
KANJI = r"[一-龥々〆ヶ]{2,}"
TOKEN_RE = re.compile(f"(?P<kata>{KATA})|(?P<latin>{LATIN})|(?P<num>{NUM})|(?P<kanji>{KANJI})")
HINT_LABEL = {"kata": "名称", "latin": "記号", "num": "数値", "kanji": "用語", "compound": "用語"}
SEPS = "：:＝=→⇒"
PARTICLES = "はがをにでとのへも"

PRIOR = {
    "type=kata": 1.0, "type=latin": 0.8, "type=num": 0.9, "type=kanji": 0.1, "type=compound": 0.7,
    "len=1-2": -0.8, "len=3-4": 0.3, "len=5-8": 0.4, "len=9+": -0.3,
    "pos=head": -0.3, "pos=mid": 0.0, "pos=tail": 0.3,
    "after_sep": 1.0, "before_particle": 0.1, "in_paren": -0.4, "answer": 2.5, "digit": 0.2,
}


def classify(text: str) -> str:
    m = TOKEN_RE.fullmatch(text)
    if m:
        return m.lastgroup
    return "compound"


def _len_bucket(n: int) -> str:
    return "len=1-2" if n <= 2 else "len=3-4" if n <= 4 else "len=5-8" if n <= 8 else "len=9+"


def features(text: str, start: int, end: int, kind: str, is_answer: bool = False) -> list[str]:
    span = text[start:end]
    n = max(len(text), 1)
    prev = text[:start].rstrip(" 　")[-1:] if text[:start].strip(" 　") else ""
    nxt = text[end:end + 1]
    rel = (start + end) / 2 / n
    f = [f"type={kind}", _len_bucket(len(span)),
         "pos=head" if rel < 0.25 else "pos=tail" if rel > 0.7 else "pos=mid"]
    if prev and prev in SEPS:
        f.append("after_sep")
    if nxt and nxt in PARTICLES:
        f.append("before_particle")
    if prev in "（(" and nxt in "）)":
        f.append("in_paren")
    if any(ch.isdigit() for ch in span):
        f.append("digit")
    if is_answer:
        f.append("answer")
    return f


def candidates(text: str) -> list[tuple[int, int, str]]:
    """穴の候補 (開始, 終了, 種類)。隣り合う語句をつないだ候補（例：β1受容体）も含む。"""
    toks = [(m.start(), m.end(), m.lastgroup) for m in TOKEN_RE.finditer(text)]
    out = list(toks)
    for i in range(len(toks)):
        s, e, k = toks[i]
        kinds = {k}
        for j in range(i + 1, min(i + 3, len(toks))):
            if toks[j][0] != e:
                break
            e = toks[j][1]
            kinds.add(toks[j][2])
            if len(kinds) > 1 and e - s <= 15:
                out.append((s, e, "compound"))
    return out


# ---------------------------------------------------------------- 作り方の傾向（学習）
def _training_examples(conn: sqlite3.Connection):
    """あなたのカードから (特徴, 正例か) を取り出す。あわせて穴の数とヒントの使い方を数える。"""
    pos, neg = [], []
    holes, hints, cards = 0, 0, 0
    for (front,) in conn.execute("SELECT front FROM cards"):
        clozes = list(cloze.CLOZE_RE.finditer(front or ""))
        if not clozes:
            continue
        cards += 1
        # 穴を開けた状態の文（記法・画像を除く）と、穴の位置
        plain, spans, pos_i = "", [], 0
        for m in clozes:
            plain += cloze.IMG_RE.sub("", front[pos_i:m.start()])
            s = len(plain)
            plain += m.group(2)
            spans.append((s, len(plain)))
            holes += 1
            hints += 1 if m.group(3) else 0
            pos_i = m.end()
        plain += cloze.IMG_RE.sub("", front[pos_i:])
        for s, e in spans:
            if e > s:
                pos.append(features(plain, s, e, classify(plain[s:e])))
        for s, e, k in candidates(plain):
            if not any(s < pe and e > ps for ps, pe in spans):
                neg.append(features(plain, s, e, k))
    return pos, neg, {"cards": cards, "holes": holes, "hints": hints}


def _rejected_spans(conn: sqlite3.Connection):
    """「穴の場所が違う」で破棄された穴（負例・重み2）と、追加時に外された穴（負例・重み1）。"""
    out = []
    for row in conn.execute("SELECT status, reason, spans, text FROM generated WHERE status IN ('discarded', 'added')"):
        try:
            spans = json.loads(row["spans"] or "[]")
        except ValueError:
            continue
        weight = 2 if row["status"] == "discarded" and row["reason"] == "position" else 0
        for sp in spans:
            if row["status"] == "added" and sp.get("kept"):
                continue
            w = weight or (1 if row["status"] == "added" else 0)
            if w:
                out.append((sp.get("features", []), w))
    return out


class Style:
    """穴の選び方の重み。"""

    def __init__(self, conn: sqlite3.Connection):
        pos, neg, stats = _training_examples(conn)
        rejected = _rejected_spans(conn)
        self.n_pos = len(pos)
        self.stats = stats
        pc, nc = {}, {}
        for f in pos:
            for x in f:
                pc[x] = pc.get(x, 0) + 1
        n_neg = len(neg)
        for f in neg:
            for x in f:
                nc[x] = nc.get(x, 0) + 1
        for f, w in rejected:
            n_neg += w
            for x in f:
                nc[x] = nc.get(x, 0) + w
        vocab = set(PRIOR) | set(pc) | set(nc)
        v = max(len(vocab), 1)
        # 学習の手がかり = あなたが穴にした数 ＋ 破棄・外された穴の重み。多いほどあなたの傾向の比重を上げる
        evidence = self.n_pos + sum(w for _, w in rejected)
        self.learned = {x: math.log((pc.get(x, 0) + 1) / (self.n_pos + v)) - math.log((nc.get(x, 0) + 1) / (n_neg + v))
                        for x in vocab} if evidence else {}
        self.alpha = evidence / (evidence + 30)
        avg = stats["holes"] / stats["cards"] if stats["cards"] else 1.0
        self.target_holes = max(1, min(MAX_HOLES, round(avg)))
        self.use_hints = bool(stats["holes"]) and stats["hints"] / stats["holes"] >= 0.5

    def score(self, feats: list[str]) -> float:
        return sum((1 - self.alpha) * PRIOR.get(x, 0.0) + self.alpha * self.learned.get(x, 0.0) for x in feats)

    def summary(self) -> dict:
        top = sorted(((x, w) for x, w in self.learned.items() if x.startswith("type=")), key=lambda t: -t[1])
        return {"cards": self.stats["cards"], "holes": self.n_pos, "alpha": round(self.alpha, 3),
                "target_holes": self.target_holes, "use_hints": self.use_hints,
                "favorite_types": list(dict.fromkeys(HINT_LABEL.get(x.split("=")[1], x) for x, w in top if w > 0))[:3]}

    def choose(self, text: str, answer: tuple[int, int] | None = None, region: tuple[int, int] | None = None):
        """穴にする語句を選ぶ。answer = 必ず候補に入れる範囲（過去問の正答）、region = 候補を探す範囲。"""
        cands = []
        for s, e, k in candidates(text):
            if region and not (region[0] <= s and e <= region[1]):
                continue
            if e - s >= max(len(text) * 0.8, 3):
                continue
            cands.append((s, e, k, False))
        if answer:
            cands.append((answer[0], answer[1], classify(text[answer[0]:answer[1]]), True))
        scored = []
        for s, e, k, is_ans in cands:
            f = features(text, s, e, k, is_ans)
            scored.append((self.score(f), s, e, k, f))
        scored.sort(key=lambda t: (-t[0], t[1]))
        chosen = []
        for sc, s, e, k, f in scored:
            if len(chosen) >= self.target_holes:
                break
            if chosen and sc < 0.3:
                break
            if any(s < ce and e > cs for _, cs, ce, _, _ in chosen):
                continue
            chosen.append((sc, s, e, k, f))
        chosen.sort(key=lambda t: t[1])
        return chosen


def build_front(text: str, chosen, use_hints: bool) -> str:
    out, pos = "", 0
    for _, s, e, k, _ in chosen:
        word = text[s:e]
        hint = f"::{HINT_LABEL.get(k, '用語')}" if use_hints else ""
        out += text[pos:s] + "{{c1::" + word + hint + "}}"
        pos = e
    return out + text[pos:]


# ---------------------------------------------------------------- 材料（知識の候補）
NEG_RE = re.compile(r"誤っている|誤り|正しくない|適切でない|不適切|該当しない|含まれない|ないのはどれか|しないのはどれか")
TAIL_RE = re.compile(r"(?:のは|は)どれか[。．]?\s*(?:[1-9１-９]つ選べ。?)?\s*$")


def _norm(t: str) -> str:
    return re.sub(r"[\s　、。，．・：:（）()「」]", "", t or "")


@lru_cache(maxsize=1)
def _notes() -> tuple[dict, ...]:
    try:
        return tuple(json.loads(NOTES.read_text(encoding="utf-8")).get("notes", []))
    except OSError:
        return ()


def facts_for(subject: str, theme: str) -> list[dict]:
    """テーマの知識の候補。text = 穴を開ける前の文、answer = 正答の位置（過去問のみ）。"""
    out = []
    for x in past._load():
        if x["subject"] != subject or x["theme"] != theme or not x["options"] or x["figure"]:
            continue
        stem = x["stem"].strip()
        if NEG_RE.search(stem) or "□" in stem:
            continue
        nums = [int(n) for n in re.findall(r"\d+", x["answer"])]
        if len(nums) != 1 or not 1 <= nums[0] <= len(x["options"]):
            continue
        ans = x["options"][nums[0] - 1].strip()
        if not ans or "□" in ans:
            continue
        ref = f"出典：第{x['kai']}回 問{x['q']}（過去問から自動生成）"
        if "記述" in stem:
            if len(ans) >= 8:
                out.append({"key": f"past_stmt:{x['id']}", "kind": "past_stmt", "text": ans, "back": ref, "qid": x["id"]})
            continue
        core = TAIL_RE.sub("", re.sub(r"^次の(?:うち|中で)、?", "", stem)).strip(" 　、。")
        if not core or core == stem or len(core) > 60:
            continue
        t1 = f"{core}：{ans}"
        out.append({"key": f"past_q:{x['id']}", "kind": "past_q", "text": t1, "answer": (len(core) + 1, len(t1)),
                    "back": ref, "qid": x["id"]})
        t2 = f"{ans} → {core}"
        out.append({"key": f"past_rev:{x['id']}", "kind": "past_rev", "text": t2, "region": (len(ans) + 3, len(t2)),
                    "back": ref, "qid": x["id"]})
    for n in _notes():
        if n["subject"] == subject and n.get("theme") == theme:
            key = "note:" + hashlib.sha1(n["text"].encode("utf-8")).hexdigest()[:16]
            prefix = f"〔{n.get('ctx') or n['doc_theme']}〕"   # 文脈（ここは穴にしない）
            text = prefix + n["text"]
            out.append({"key": key, "kind": "note", "text": text, "region": (len(prefix), len(text)),
                        "back": f"出典：要点まとめ（{n['doc_theme']}・{n['src']}）"})
    return out


# ---------------------------------------------------------------- 苦手なテーマ
def weak_themes(conn: sqlite3.Connection, today: date) -> list[dict]:
    """演習した結果のあるテーマを、苦手な順に。"""
    mapping = past.card_themes(conn)
    if not mapping:
        return []
    start = (today - timedelta(days=WINDOW_DAYS - 1)).isoformat()
    stat: dict[tuple[str, str], dict] = {}
    for r in conn.execute(
        "SELECT r.card_id, SUM(r.rating = 'again') AS again, COUNT(*) AS n FROM reviews r JOIN cards c ON c.id = r.card_id"
        " WHERE r.is_recheck = 0 AND r.practice_session IS NULL AND r.id > c.reset_review_id AND r.review_date >= ?"
        " GROUP BY r.card_id", (start,)):
        for key in mapping.get(r["card_id"], ()):
            s = stat.setdefault(key, {"again": 0, "n": 0, "leech": 0})
            s["again"] += r["again"]
            s["n"] += r["n"]
    for (cid,) in conn.execute("SELECT card_id FROM card_tags WHERE tag = '要見直し'"):
        for key in mapping.get(cid, ()):
            if key in stat:
                stat[key]["leech"] += 1
    qcount = {(t["subject"], t["theme"]): t["questions"] for t in past.themes()}
    easy = {}
    for r in conn.execute("SELECT subject, unit, COUNT(*) FROM generated WHERE reason = 'easy' GROUP BY subject, unit"):
        easy[(r[0], r[1])] = r[2]
    out = []
    for (s, t), v in stat.items():
        if not v["n"]:
            continue
        weakness = (v["again"] + 1) / (v["n"] + 3) + 0.1 * v["leech"]
        priority = weakness * (1 + 0.15 * math.log1p(qcount.get((s, t), 0))) * (0.8 ** easy.get((s, t), 0))
        out.append({"subject": s, "theme": t, "reviews": v["n"], "again": v["again"], "leech": v["leech"],
                    "weakness": round(weakness, 4), "priority": round(priority, 4)})
    order = {x: i for i, x in enumerate(SUBJECTS)}
    out.sort(key=lambda x: (-x["priority"], order.get(x["subject"], 99), x["theme"]))
    return out


def _kind_pref(conn: sqlite3.Connection) -> dict[str, float]:
    """作り方の種類ごとの好み（追加されたほど上がり、「簡単すぎ」「内容が不正確」で下がる）。"""
    pref = {}
    for k in KIND_LABELS:
        added = conn.execute("SELECT COUNT(*) FROM generated WHERE kind = ? AND status = 'added'", (k,)).fetchone()[0]
        bad = conn.execute("SELECT COUNT(*) FROM generated WHERE kind = ? AND status = 'discarded'"
                           " AND reason IN ('easy', 'wrong')", (k,)).fetchone()[0]
        pref[k] = (added + 1) / (added + bad + 2)
    return pref


# ---------------------------------------------------------------- 生成
def pending_count(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM generated WHERE status = 'pending'").fetchone()[0]


def run(conn: sqlite3.Connection, now: datetime, today: date, trigger: str = "manual") -> dict:
    """自動生成を1回行う。trigger: daily（その日最初）/ session（学習の終わり）/ manual（ボタン）。"""
    t = today.isoformat()
    if trigger == "daily":
        row = conn.execute("SELECT value FROM meta WHERE key = 'gen_daily'").fetchone()
        if row and row[0] == t:
            return {"created": 0, "pending": pending_count(conn), "skipped": "today"}
        conn.execute("INSERT INTO meta(key, value) VALUES ('gen_daily', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (t,))
        conn.commit()
    pending = pending_count(conn)
    room = PENDING_LIMIT - pending
    if room <= 0:
        return {"created": 0, "pending": pending, "skipped": "pending_limit"}
    if trigger == "manual":
        limit = min(DAILY_LIMIT, room)
    else:
        made_today = conn.execute("SELECT COUNT(*) FROM generated WHERE created_date = ? AND trigger != 'manual'",
                                  (t,)).fetchone()[0]
        limit = min(DAILY_LIMIT - made_today, room)
    if limit <= 0:
        return {"created": 0, "pending": pending, "skipped": "daily_limit"}
    themes = weak_themes(conn, today)
    if not themes:
        return {"created": 0, "pending": pending, "skipped": "no_results"}

    style = Style(conn)
    pref = _kind_pref(conn)
    used = {r[0] for r in conn.execute("SELECT fact_key FROM generated")}
    sources = {r[0] for r in conn.execute("SELECT source FROM cards WHERE source != ''")}
    blob = "\n".join(_norm(cloze.plain(r[0])) + "\n" + _norm(cloze.plain(r[1]))
                     for r in conn.execute("SELECT front, back FROM cards"))
    rng = random.Random(f"{t}-{pending}-{len(used)}")
    per_theme = max(1, math.ceil(limit / min(len(themes), 3)))
    created = []
    for th in themes:
        if len(created) >= limit:
            break
        facts = [f for f in facts_for(th["subject"], th["theme"])
                 if f["key"] not in used and f"hissu:{f.get('qid', '')}" not in sources
                 and _norm(f["text"]) not in blob]
        rng.shuffle(facts)
        facts.sort(key=lambda f: -pref.get(f["kind"], 0.5))
        n_theme = 0
        for f in facts:
            if n_theme >= per_theme or len(created) >= limit:
                break
            chosen = style.choose(f["text"], f.get("answer"), f.get("region"))
            if not chosen:
                continue
            front = build_front(f["text"], chosen, style.use_hints)
            spans = [{"start": s, "end": e, "text": f["text"][s:e], "features": feats} for _, s, e, _, feats in chosen]
            cur = conn.execute(
                "INSERT INTO generated(fact_key, kind, subject, unit, front, back, text, spans, status, trigger,"
                " created_at, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
                (f["key"], f["kind"], th["subject"], th["theme"], front, f["back"], f["text"],
                 json.dumps(spans, ensure_ascii=False), trigger, now.isoformat(timespec="seconds"), t))
            created.append(cur.lastrowid)
            used.add(f["key"])
            n_theme += 1
    conn.commit()
    return {"created": len(created), "pending": pending_count(conn), "ids": created,
            "themes": [f"{x['subject']}／{x['theme']}" for x in themes[:3]]}


def mark_kept_spans(conn: sqlite3.Connection, gen_id: int, final_front: str) -> None:
    """追加したカードに残った穴を記録する（外された穴は次から負例として数える）。"""
    row = conn.execute("SELECT spans FROM generated WHERE id = ?", (gen_id,)).fetchone()
    try:
        spans = json.loads(row["spans"] or "[]")
    except (ValueError, TypeError):
        return
    kept_words = {m.group(2) for m in cloze.CLOZE_RE.finditer(final_front)}
    for sp in spans:
        sp["kept"] = sp.get("text") in kept_words
    conn.execute("UPDATE generated SET spans = ? WHERE id = ?", (json.dumps(spans, ensure_ascii=False), gen_id))
