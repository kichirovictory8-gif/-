"""タグ（カテゴリ）。1枚のカードに複数付けられる自由な見出し。"""
from __future__ import annotations

import re

SPLIT_RE = re.compile(r"[\s,、，]+")
MAX_TAG_LEN = 30
MAX_TAGS = 20


def normalize_tags(value) -> list[str]:
    """文字列（スペース・カンマ・読点区切り）またはリストを、重複のないタグのリストにする。"""
    if value is None:
        return []
    if isinstance(value, str):
        items = SPLIT_RE.split(value)
    elif isinstance(value, (list, tuple)):
        items = []
        for v in value:
            items += SPLIT_RE.split(str(v))
    else:
        raise ValueError("タグの形式が正しくありません")
    out: list[str] = []
    for t in items:
        t = t.strip().lstrip("#＃").strip()
        if not t:
            continue
        if len(t) > MAX_TAG_LEN:
            raise ValueError(f"タグは{MAX_TAG_LEN}文字までです: {t[:MAX_TAG_LEN]}…")
        if t not in out:
            out.append(t)
    if len(out) > MAX_TAGS:
        raise ValueError(f"タグは1枚につき{MAX_TAGS}個までです")
    return out
