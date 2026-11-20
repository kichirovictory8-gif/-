"""一括追加: 1行1枚（表面[Tab]裏面）の解析。"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class BulkResult:
    cards: list[tuple[str, str]] = field(default_factory=list)   # (表面, 裏面)
    errors: list[tuple[int, str]] = field(default_factory=list)  # (行番号, 理由)


def parse_bulk(text: str) -> BulkResult:
    """空行は無視。最初の Tab で表面と裏面に分ける（裏面に Tab が残ってもよい）。

    表面だけで Tab がない行は、穴埋め {{c1::…}} を含むときに限り裏面なしで受け付ける。
    """
    from .cloze import has_cloze

    result = BulkResult()
    for no, raw in enumerate(text.replace("\r\n", "\n").replace("\r", "\n").split("\n"), start=1):
        line = raw.strip(" 　")
        if not line.strip():
            continue
        if "\t" in line:
            front, back = line.split("\t", 1)
            front, back = front.strip(), back.strip()
        else:
            front, back = line.strip(), ""
            if not has_cloze(front):
                result.errors.append((no, "Tab がありません（表面[Tab]裏面 の形にしてください）"))
                continue
        if not front:
            result.errors.append((no, "表面が空です"))
            continue
        result.cards.append((front, back))
    return result
