"""カード本文の表示（穴埋め・画像・画像の穴埋め）。

本文の記法:
    {{c1::語句}} / {{c1::語句::ヒント}}  … 文字の穴埋め
    {{s1::手順}} {{s2::手順}} …          … 計算の手順（慣れるほど後ろの手順から隠す数を増やす）
    [[img:12]]                           … 画像（images テーブルの id）

ヒントは、カードの間隔が HINT_FADE_DAYS 日以上になると表示しない（慣れたら手がかりを外す）。

画像の穴埋め（四角形）は本文ではなく、カードの masks に保存する:
    {"12": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.1, "hint": "官能基"}, ...]}
    x, y, w, h は画像の幅・高さに対する割合（0〜1）。hint は空でもよい（塗りつぶすだけ）。

学習では、穴（文字・四角形）を1つずつ開けていく。表示用 HTML では各穴を
    <span class="cl"><span class="cl-q">[ヒント]</span><span class="cl-a">語句</span></span>
    <span class="mask"><span class="mask-hint">ヒント</span></span>
とし、画面側で class="open" を付けて開ける。
"""
from __future__ import annotations

import html
import json
import re

CLOZE_RE = re.compile(r"\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}", re.S)
STEP_RE = re.compile(r"\{\{s(\d+)::(.*?)\}\}", re.S)
HOLE_RE = re.compile(r"\{\{([cs])(\d+)::(.*?)(?:::(.*?))?\}\}", re.S)
HINT_FADE_DAYS = 14
HINT_FADE_STAGE = 4          # 段階4 = 14日
IMG_RE = re.compile(r"\[\[img:(\d+)\]\]")
MAX_MASKS_PER_IMAGE = 60
MAX_HINT = 40


def _esc(text: str) -> str:
    return html.escape(text, quote=True).replace("\n", "<br>")


def image_ids(text: str) -> list[int]:
    """本文に出てくる画像 id（出てくる順・重複なし）。"""
    seen: list[int] = []
    for m in IMG_RE.finditer(text or ""):
        i = int(m.group(1))
        if i not in seen:
            seen.append(i)
    return seen


def hidden_steps(n_steps: int, stage: int | None) -> int:
    """隠す手順の数。新規・1日は最後の1つ、段階が2つ上がるごとに1つずつ増やし、最後は全部。"""
    if n_steps <= 0:
        return 0
    return min(n_steps, 1 + (stage or 0) // 2)


def has_cloze(text: str, masks: dict | None = None) -> bool:
    """穴（文字の穴埋め・計算の手順・画像の四角形）があるか。"""
    if CLOZE_RE.search(text or "") or STEP_RE.search(text or ""):
        return True
    return any(masks.get(str(i)) for i in image_ids(text)) if masks else False


def _img_tag(img_id: int) -> str:
    return f'<img class="card-img" src="/api/images/{img_id}" alt="画像" loading="lazy" data-img="{img_id}">'


def _render_images(text: str, masks: dict | None, show_hints: bool = True) -> str:
    """穴埋め以外の部分: 文字はエスケープ、[[img:N]] は画像（masks があれば四角形つき）。"""
    out, pos = [], 0
    for m in IMG_RE.finditer(text):
        out.append(_esc(text[pos:m.start()]))
        img_id = int(m.group(1))
        rects = (masks or {}).get(str(img_id)) or []
        if rects:
            parts = [f'<span class="occ" data-img="{img_id}">', _img_tag(img_id)]
            for r in rects:
                style = (f"left:{r['x'] * 100:.3f}%;top:{r['y'] * 100:.3f}%;"
                         f"width:{r['w'] * 100:.3f}%;height:{r['h'] * 100:.3f}%")
                hint = f'<span class="mask-hint">{_esc(r["hint"])}</span>' if r.get("hint") and show_hints else ""
                parts.append(f'<span class="mask" style="{style}">{hint}</span>')
            parts.append("</span>")
            out.append("".join(parts))
        else:
            out.append(_img_tag(img_id))
        pos = m.end()
    out.append(_esc(text[pos:]))
    return "".join(out)


def render_front(text: str, masks: dict | None = None, stage: int | None = None) -> str:
    """表面: 穴（文字・手順・四角形）は閉じた状態の HTML。答えも中に含み、画面側で開ける。

    stage を渡すと、間隔に応じてヒントを隠し（C1）、計算の手順を隠す数を決める（C5）。
    stage が None（プレビューなど）のときはヒントを表示し、手順は最後の1つだけ隠す。
    """
    show_hints = stage is None or stage < HINT_FADE_STAGE
    steps = [m for m in HOLE_RE.finditer(text) if m.group(1) == "s"]
    k = hidden_steps(len(steps), stage)
    hide = {m.start() for m in steps[len(steps) - k:]}
    out, pos = [], 0
    for m in HOLE_RE.finditer(text):
        out.append(_render_images(text[pos:m.start()], masks, show_hints))
        body = _render_images(m.group(3), None)
        if m.group(1) == "s":
            if m.start() in hide:
                out.append(f'<span class="cl step"><span class="cl-q">[手順]</span><span class="cl-a">{body}</span></span>')
            else:
                out.append(f'<span class="step-shown">{body}</span>')
        else:
            hint = m.group(4) if show_hints else None
            label = _esc(hint) if hint else "&hellip;"
            out.append(f'<span class="cl"><span class="cl-q">[{label}]</span><span class="cl-a">{body}</span></span>')
        pos = m.end()
    out.append(_render_images(text[pos:], masks, show_hints))
    return "".join(out)


def render_back(text: str) -> str:
    """裏面: 文字と画像（穴埋め記法はそのまま語句として表示）。"""
    t = CLOZE_RE.sub(lambda m: m.group(2), text or "")
    return _render_images(STEP_RE.sub(lambda m: m.group(2), t), None)


def plain(text: str) -> str:
    """一覧表示用: 記法を取り除いた素の文字列。画像は［画像］。"""
    t = CLOZE_RE.sub(lambda m: m.group(2), text or "")
    t = STEP_RE.sub(lambda m: m.group(2), t)
    return IMG_RE.sub("［画像］", t)


def normalize_masks(masks, front: str) -> dict:
    """masks を検証して整える。表面にない画像の分は捨て、四角形は上から順に並べる。"""
    if masks in (None, "", {}):
        return {}
    if isinstance(masks, str):
        try:
            masks = json.loads(masks)
        except ValueError:
            raise ValueError("画像の穴埋めのデータが正しくありません") from None
    if not isinstance(masks, dict):
        raise ValueError("画像の穴埋めのデータが正しくありません")
    present = {str(i) for i in image_ids(front)}
    out: dict[str, list[dict]] = {}
    for key, rects in masks.items():
        key = str(key)
        if key not in present or not rects:
            continue
        if not isinstance(rects, list) or len(rects) > MAX_MASKS_PER_IMAGE:
            raise ValueError("画像の穴埋めのデータが正しくありません")
        clean = []
        for r in rects:
            try:
                x, y, w, h = (float(r[k]) for k in ("x", "y", "w", "h"))
            except (KeyError, TypeError, ValueError):
                raise ValueError("画像の穴埋めのデータが正しくありません") from None
            x, y = min(max(x, 0.0), 1.0), min(max(y, 0.0), 1.0)
            w, h = min(max(w, 0.0), 1.0 - x), min(max(h, 0.0), 1.0 - y)
            if w < 0.005 or h < 0.005:
                continue
            hint = str(r.get("hint") or "").strip()[:MAX_HINT]
            clean.append({"x": round(x, 4), "y": round(y, 4), "w": round(w, 4), "h": round(h, 4), "hint": hint})
        clean.sort(key=lambda r: (round(r["y"], 2), r["x"]))
        if clean:
            out[key] = clean
    return out


def remap_images(text: str, mapping: dict[int, int]) -> str:
    """取り込み時に画像 id を付け替える。"""
    return IMG_RE.sub(lambda m: f"[[img:{mapping.get(int(m.group(1)), int(m.group(1)))}]]", text or "")


def count_holes(text: str, masks: dict | None = None) -> int:
    """穴の数（文字の穴埋め＋四角形。計算の手順はまとめて1つと数える）。"""
    n = len(CLOZE_RE.findall(text or ""))
    n += 1 if STEP_RE.search(text or "") else 0
    n += sum(len(v) for v in (masks or {}).values())
    return n


def split_units(front: str, masks: dict | None = None) -> list[tuple[str, dict]]:
    """1枚を「穴1つ = 1枚」に分ける（文字の穴埋め1つずつ、四角形1つずつ）。

    分けた各カードでは、ほかの文字の穴は答えの語句に戻し、ほかの四角形は外す。
    計算の手順はまとめて1つの穴として扱い、最初のカードに残す。
    """
    masks = masks or {}
    holes = list(CLOZE_RE.finditer(front))
    rects = [(k, i) for k, v in masks.items() for i in range(len(v))]
    out: list[tuple[str, dict]] = []
    for idx, keep in enumerate(holes):
        t = CLOZE_RE.sub(lambda m: m.group(0) if m.start() == keep.start() else m.group(2), front)
        if idx > 0:
            t = STEP_RE.sub(lambda m: m.group(2), t)
        out.append((t, {}))
    plain_text = CLOZE_RE.sub(lambda m: m.group(2), front)
    for n, (k, i) in enumerate(rects):
        # 手順は最初のカードにだけ残す
        t = STEP_RE.sub(lambda m: m.group(2), plain_text) if (holes or n > 0) else plain_text
        out.append((t, {k: [masks[k][i]]}))
    if not holes and not rects and STEP_RE.search(front):
        out.append((front, {}))
    return out
