"""穴埋め {{c1::語句}} / {{c1::語句::ヒント}} の解析と HTML 表示。

同じカード内の c1, c2 … はすべて同時に隠す（1枚のカードとして出す）。
"""
from __future__ import annotations

import html
import re

CLOZE_RE = re.compile(r"\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}", re.S)


def _esc(text: str) -> str:
    return html.escape(text, quote=True).replace("\n", "<br>")


def has_cloze(text: str) -> bool:
    return CLOZE_RE.search(text) is not None


def _render(text: str, repl) -> str:
    out, pos = [], 0
    for m in CLOZE_RE.finditer(text):
        out.append(_esc(text[pos:m.start()]))
        out.append(repl(m))
        pos = m.end()
    out.append(_esc(text[pos:]))
    return "".join(out)


def render_question(text: str) -> str:
    """表面（問題）: 穴埋め部分を [...] または [ヒント] で隠す。"""
    def repl(m):
        hint = m.group(3)
        label = _esc(hint) if hint else "&hellip;"
        return f'<span class="cloze">[{label}]</span>'
    return _render(text, repl)


def render_answer(text: str) -> str:
    """表面（答え表示後）: 穴埋め部分の語句を強調表示する。"""
    return _render(text, lambda m: f'<span class="cloze-ans">{_esc(m.group(2))}</span>')


def plain(text: str) -> str:
    """一覧表示用: 記法を取り除いた素の文字列。"""
    return CLOZE_RE.sub(lambda m: m.group(2), text)


def render_text(text: str) -> str:
    """裏面など記法のない文字列の HTML 化。"""
    return _esc(text)
