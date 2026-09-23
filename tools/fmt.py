# -*- coding: utf-8 -*-
import re
MARK=lambda d: re.compile(r'(?<=\s)'+d+r'(?=\s)')

def split_options(text, maxopt=90):
    """戻り値: (stem, [opt1..opt5]) / 失敗時 (text, None)
    「選べ。」以降にある標準の 1〜5 マーカーを探す。候補が複数ある場合は
    後ろ側の候補（本文中の数字ではなく実際の選択肢ブロック）を優先する。"""
    m=re.search(r'選べ。', text)
    start = m.end() if m else 0
    cands=[mm.start() for mm in MARK('1').finditer(text, start)]
    for p1 in reversed(cands):
        pos=[p1]; cur=p1+1; ok=True
        for d in '2345':
            mm=MARK(d).search(text, cur)
            if not mm: ok=False; break
            pos.append(mm.start()); cur=mm.end()
        if not ok: continue
        stem=text[:pos[0]].strip()
        opts=[text[pos[i]+1:(pos[i+1] if i<4 else len(text))].strip() for i in range(5)]
        if not stem: continue
        if any(len(o)==0 for o in opts): continue
        if max(len(o) for o in opts)>maxopt: continue
        return stem, opts
    return text, None

def wrap_stem(s, width=44):
    """句点・読点で適度に改行"""
    s=s.strip()
    parts=re.split(r'(?<=。)', s)
    out=[]; buf=''
    for p in parts:
        if not p: continue
        if len(buf)+len(p)>width and buf:
            out.append(buf); buf=p
        else:
            buf+=p
    if buf: out.append(buf)
    if len(out)>1 and len(out[-1])<12:
        out[-2]+=out[-1]; out.pop()
    return out

CJK=r'ぁ-んァ-ヶ一-龥々〆ヵヶ、。・ー「」『』（）：；？！〜～％，＋－'
SUB=str.maketrans('₀₁₂₃₄₅₆₇₈₉','0123456789')
def repair(s):
    """PDF由来の表記崩れのうち、機械的に確実に直せるものを修正"""
    s=s.translate(SUB)                       # 添字風の数字は通常の数字
    s=re.sub(r'(?<=\s)#(?=\s)','×',s)         # 乗算記号が # に化けている
    s=re.sub(r'(?<![0-9０-９])\s*つ選べ','1つ選べ',s)  # 先頭の「1」が欠落した「つ選べ」
    s=s.replace('１つ選べ','1つ選べ')
    return s

def dejoin(s):
    """PDF改行由来の、日本語文字間の不自然な空白を除去"""
    prev=None
    while prev!=s:
        prev=s
        s=re.sub(r'(?<=['+CJK+r'])[ 　]+(?=['+CJK+r'])','',s)
    return re.sub(r'\s{2,}',' ',s).strip()


def tighten(s):
    """dejoin に加え、数字と日本語の間の不自然な空白も除去（選択肢分割の後に適用すること）"""
    s=dejoin(s)
    s=re.sub(r'(?<=[0-9])[ ]+(?=['+CJK+r'])','',s)
    s=re.sub(r'(?<=['+CJK+r'])[ ]+(?=[0-9])','',s)
    return re.sub(r'\s{2,}',' ',s).strip()
