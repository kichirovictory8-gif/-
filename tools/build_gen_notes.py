"""docs/01・docs/03 の要点を「1つの知識 = 1件」に分け、自動生成の材料（app/flashcards/data/notes.json）を作る。

    python tools/build_gen_notes.py

- docs/03：各科目の表の「覚えるべき核」列を、読点・句点（かっこの外）で分ける
- docs/01：箇条書きを1件とし、「見出し：項目、項目」の形なら「見出し：項目」ごとに分ける
- 資料のテーマ名は、過去問（app/flashcards/data/hissu.json）の同じ科目の出題テーマ名のうち、
  文字の重なり（2文字ずつの一致）が最も大きいものに対応付ける（重なりが小さければ対応なし）
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SUBJECTS = ("物理", "化学", "生物", "衛生", "薬理", "薬剤", "病態・薬物治療", "法規・制度・倫理", "実務")


def subject_of(heading: str) -> str | None:
    for s in sorted(SUBJECTS, key=len, reverse=True):
        if heading.startswith(s):
            return s
    return None


def clean(t: str) -> str:
    t = re.sub(r"\*\*|`", "", t)
    t = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", t)
    return t.strip(" 　")


def split_top(text: str, seps: str) -> list[str]:
    """かっこの外にある区切り文字で分ける。"""
    out, buf, depth = [], "", 0
    for ch in text:
        if ch in "（(「【［[":
            depth += 1
        elif ch in "）)」】］]":
            depth = max(0, depth - 1)
        if ch in seps and depth == 0:
            out.append(buf)
            buf = ""
        else:
            buf += ch
    out.append(buf)
    return [x.strip(" 　") for x in out if x.strip(" 　")]


#: 文字の重なりでは対応が付かない／誤って付くテーマの手作業の対応（None = 対応なし）
OVERRIDES = {
    ("化学", "漢方処方と副作用"): "生薬・天然物", ("化学", "生薬の基原・成分・薬効"): "生薬・天然物",
    ("実務", "検査値・フィジカルアセスメント"): "TDM・検査値の活用", ("実務", "消毒薬の使い分け"): "消毒・感染対策",
    ("実務", "実務計算"): None,
    ("法規・制度・倫理", "医薬品医療機器等法"): "薬機法・医薬品の分類", ("法規・制度・倫理", "薬害・医療倫理"): "薬学史・薬害",
    ("法規・制度・倫理", "その他の規制法"): None,
    ("物理", "界面化学"): None, ("物理", "溶液・界面"): "溶液・束一的性質",
    ("生物", "ビタミンと補酵素"): "酵素", ("生物", "神経・筋の生理"): "人体の構造と機能",
    ("生物", "血液・凝固"): "人体の構造と機能", ("生物", "細胞生物学・生理"): "人体の構造と機能",
    ("病態・薬物治療", "妊婦・小児・高齢者"): "産婦人科・小児・皮膚眼科ほか",
    ("病態・薬物治療", "特殊集団の薬物療法"): "産婦人科・小児・皮膚眼科ほか",
    ("病態・薬物治療", "循環器・腎・呼吸器・消化器の病態"): "循環器疾患",
    ("病態・薬物治療", "心疾患・脳血管障害"): "循環器疾患", ("病態・薬物治療", "生活習慣病"): "代謝・内分泌疾患",
    ("病態・薬物治療", "がん疼痛"): "緩和・疼痛管理", ("病態・薬物治療", "アレルギー・膠原病"): "免疫・膠原病・血液疾患",
    ("薬剤", "分散系（乳剤・懸濁剤）"): "製剤材料の物性", ("薬剤", "溶解性と溶出"): "製剤材料の物性",
    ("薬剤", "粉体・レオロジー"): "製剤材料の物性", ("薬剤", "製剤の安定性"): "製剤材料の物性",
    ("薬剤", "注射剤・等張化"): "製剤各論・製剤総則", ("薬剤", "注射剤・輸液"): "製剤各論・製剤総則",
    ("薬剤", "添加剤の役割"): "製剤各論・製剤総則", ("薬剤", "製剤学"): "製剤各論・製剤総則",
    ("薬剤", "吸収・分布・代謝・排泄"): None,
    ("薬理", "中枢：パーキンソン・認知症"): "中枢神経作用薬", ("薬理", "中枢：抗精神病・抗うつ"): "中枢神経作用薬",
    ("薬理", "中枢：睡眠・抗不安・てんかん"): "中枢神経作用薬", ("薬理", "鎮痛薬"): "中枢神経作用薬",
    ("薬理", "心不全・抗不整脈"): "循環器作用薬", ("薬理", "抗血栓薬"): "血液・造血薬",
    ("薬理", "糖尿病治療薬"): "内分泌・代謝薬",
    ("衛生", "代謝的活性化・発がん"): "化学物質の毒性・解毒", ("衛生", "公害・環境汚染"): "環境衛生",
    ("衛生", "放射線の生体影響"): "放射線・物理的環境要因", ("衛生", "栄養"): "栄養・食事摂取基準",
    ("衛生", "自然毒"): "食中毒・食品衛生",
    ("化学", "生薬・漢方"): "生薬・天然物", ("法規・制度・倫理", "倫理・薬害"): "薬学史・薬害",
    ("病態・薬物治療", "がん薬物療法"): "がん", ("病態・薬物治療", "糖尿病"): "代謝・内分泌疾患",
    ("病態・薬物治療", "腎疾患"): "腎・泌尿器疾患", ("病態・薬物治療", "高血圧・脂質異常症"): "循環器疾患",
    ("薬剤", "代謝とCYP"): "代謝", ("衛生", "疫学"): "疫学・EBM", ("衛生", "疫学・統計"): "疫学・EBM",
}


def bigrams(s: str) -> set[str]:
    s = re.sub(r"[\s・／/（）()、。]", "", s)
    return {s[i:i + 2] for i in range(len(s) - 1)} or {s}


def best_theme(subject: str, name: str, themes: dict[str, list[str]]) -> str | None:
    if (subject, name) in OVERRIDES:
        return OVERRIDES[(subject, name)]
    if name in themes.get(subject, []):
        return name
    best, score, overlap = None, 0.0, 0
    a = bigrams(name)
    for t in themes.get(subject, []):
        b = bigrams(t)
        j = len(a & b) / len(a | b)
        if j > score:
            best, score, overlap = t, j, len(a & b)
    # 重なりが2か所以上、または割合が十分大きいときだけ対応付ける（「化学」だけ一致、などを避ける）
    return best if (overlap >= 2 and score >= 0.15) or score >= 0.3 else None


def simple(item: str) -> bool:
    """名前だけの短い項目か（「代表薬：A、B、C」の A など。1つずつではカードにならない）。"""
    return len(item) <= 12 and not re.search(r"[＝=−→：:（(]", item)


def split_items(head: str, rest: str) -> list[str]:
    """「見出し：項目、項目…」を分ける。項目に「：」があれば見出しを付けずに1件、名前だけの項目はまとめる。"""
    out, group = [], []

    def flush():
        for i in range(0, len(group), 4):
            out.append(f"{head}：" + "、".join(group[i:i + 4]))
        group.clear()

    for item in split_top(rest, "、"):
        if "：" in item:
            flush()
            out.append(item)
        elif simple(item):
            group.append(item)
        else:
            flush()
            out.append(f"{head}：{item}")
    flush()
    return out


def good(fact: str) -> bool:
    return 6 <= len(fact) <= 160 and not fact.startswith(("→", "例"))


def main():
    hissu = json.loads((ROOT / "app/flashcards/data/hissu.json").read_text(encoding="utf-8"))["questions"]
    themes: dict[str, list[str]] = {}
    for q in hissu:
        themes.setdefault(q["subject"], [])
        if q["theme"] not in themes[q["subject"]]:
            themes[q["subject"]].append(q["theme"])
    notes = []

    # docs/03：表の「覚えるべき核」
    subject = None
    for line in (ROOT / "docs/03_必須問題_テーマ別詳細.md").read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            subject = subject_of(line[3:].strip())
            continue
        if not subject or not line.startswith("|") or line.startswith("|---") or "覚えるべき核" in line:
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 4:
            continue
        theme_name, core = clean(cells[0]), clean(cells[3])
        for fact in split_top(core, "、。"):
            if good(fact):
                notes.append({"subject": subject, "doc_theme": theme_name, "text": fact, "src": "docs/03"})

    # docs/01：箇条書き
    subject, theme_name, parent = None, None, ""
    for line in (ROOT / "docs/01_科目別_覚えておくべきテーマ.md").read_text(encoding="utf-8").splitlines():
        if line.startswith("# "):
            subject = subject_of(line[2:].strip())
            theme_name = None
            continue
        if line.startswith("## "):
            theme_name = clean(re.sub(r"^[★☆\s]+", "", line[3:])).split("（")[0].strip()
            parent = ""
            continue
        m = re.match(r"^(\s*)[-*]\s+(.*)$", line)
        if not (subject and theme_name and m):
            continue
        indent, body = len(m.group(1)), clean(m.group(2))
        if indent == 0:   # 入れ子の親（「放射性医薬品と用途」など）は子の文脈として残す
            parent = body.split("（")[0].strip() if "：" not in body and len(body) <= 30 else ""
        ctx = parent if indent > 0 else ""
        head, sep, rest = body.partition("：")
        if sep and 1 < len(head) <= 20 and rest:
            items = split_items(head, rest)
        else:
            items = split_top(body, "。")
        for fact in items:
            if good(fact) and fact != parent:
                notes.append({"subject": subject, "doc_theme": theme_name, "ctx": ctx, "text": fact, "src": "docs/01"})

    for n in notes:
        n["theme"] = best_theme(n["subject"], n["doc_theme"], themes)
    out = ROOT / "app/flashcards/data/notes.json"
    out.write_text(json.dumps({"source": "docs/01・docs/03 の要点（tools/build_gen_notes.py で作成）", "notes": notes},
                              ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    mapped = sum(1 for n in notes if n["theme"])
    print(f"{len(notes)}件（テーマ対応あり {mapped}件） → {out}")
    for p in sorted({(n["subject"], n["doc_theme"], n["theme"]) for n in notes}):
        if p[2] is None or p[1] != p[2]:
            print("  ", p)


if __name__ == "__main__":
    main()
