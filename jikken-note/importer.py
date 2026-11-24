# -*- coding: utf-8 -*-
"""Word（.docx）ファイルの読み取り（Python 標準機能だけで動く）

文書を「段落」「表」「画像」の並びに変換して返す。
段落の文字には、このツールの書式記法を付ける:
  太字 **..**  下線 __..__  黄色の強調 ==..==  赤字 !!..!!
  灰色の網かけ → 可変欄 [[=..]]（空白だけなら [[ ]]）  上付き ^{..}  下付き _{..}
プロトコルへの組み立て（見出し・操作手順の判定など）は画面側（app.js）で行う。
"""
import base64
import io
import posixpath
import re
import zipfile
from collections import Counter
import xml.etree.ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
V = "{urn:schemas-microsoft-com:vml}"
PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"

IMG_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".bmp": "image/bmp"}


def _val(el, tag, attr="val"):
    if el is None:
        return None
    x = el.find(W + tag)
    if x is None:
        return None
    return x.get(W + attr, "true")


def _on(v):
    return v is not None and v not in ("0", "false", "none")


def _is_red(hexv):
    if not hexv or len(hexv) != 6:
        return False
    try:
        r, g, b = int(hexv[0:2], 16), int(hexv[2:4], 16), int(hexv[4:6], 16)
    except ValueError:
        return False
    return r >= 0xC0 and g <= 0x60 and b <= 0x60


class Docx:
    def __init__(self, data):
        self.z = zipfile.ZipFile(io.BytesIO(data))
        self.rels = {}
        try:
            rels = ET.fromstring(self.z.read("word/_rels/document.xml.rels"))
            for r in rels.iter(PKG_REL + "Relationship"):
                self.rels[r.get("Id")] = r.get("Target")
        except KeyError:
            pass
        self.styles = {}       # styleId -> (name, basedOn, rPr, outlineLvl)
        try:
            st = ET.fromstring(self.z.read("word/styles.xml"))
            for s in st.iter(W + "style"):
                sid = s.get(W + "styleId")
                name = _val(s, "name") or ""
                based = _val(s, "basedOn")
                ppr = s.find(W + "pPr")
                lvl = _val(ppr, "outlineLvl") if ppr is not None else None
                self.styles[sid] = (name, based, s.find(W + "rPr"), lvl)
        except KeyError:
            pass

    # ---------- 書式 ----------
    def _style_chain(self, sid):
        out, seen = [], set()
        while sid and sid in self.styles and sid not in seen:
            seen.add(sid)
            out.append(self.styles[sid])
            sid = self.styles[sid][1]
        return out

    def run_fmt(self, r, pstyle):
        rpr = r.find(W + "rPr")
        layers = [st[2] for st in reversed(self._style_chain(pstyle)) if st[2] is not None]
        rs = _val(rpr, "rStyle") if rpr is not None else None
        layers += [st[2] for st in reversed(self._style_chain(rs)) if st[2] is not None]
        if rpr is not None:
            layers.append(rpr)
        f = {"b": False, "u": False, "hl": False, "red": False, "var": False, "sup": False, "sub": False}
        for L in layers:
            b = _val(L, "b")
            if b is not None:
                f["b"] = _on(b)
            u = _val(L, "u")
            if u is not None:
                f["u"] = _on(u)
            col = _val(L, "color")
            if col is not None:
                f["red"] = _is_red(col)
            hl = _val(L, "highlight")
            if hl is not None:
                if hl in ("lightGray", "darkGray"):
                    f["var"] = True
                else:
                    f["hl"] = _on(hl)
            shd = L.find(W + "shd")
            if shd is not None:
                v = shd.get(W + "val", "")
                fill = (shd.get(W + "fill") or "").upper()
                gray = len(fill) == 6 and fill[0:2] == fill[2:4] == fill[4:6] and fill not in ("FFFFFF", "000000")
                if v.startswith("pct") or (v in ("clear", "solid") and gray):
                    f["var"] = True
            va = _val(L, "vertAlign")
            if va is not None:
                f["sup"] = va == "superscript"
                f["sub"] = va == "subscript"
        return f

    # ---------- 段落 ----------
    def para(self, p):
        ppr = p.find(W + "pPr")
        pstyle = _val(ppr, "pStyle") if ppr is not None else None
        chain = self._style_chain(pstyle)
        style_name = chain[0][0] if chain else ""
        level = None
        for st in chain:
            if st[3] is not None:
                level = int(st[3]) + 1
                break
        m = re.match(r"(?i)(heading|見出し)\s*(\d)", style_name)
        if level is None and m:
            level = int(m.group(2))
        ind_left = 0
        if ppr is not None:
            ind = ppr.find(W + "ind")
            if ind is not None:
                try:
                    ind_left = int(ind.get(W + "left") or ind.get(W + "start") or 0)
                except ValueError:
                    ind_left = 0
        numbered = ppr is not None and ppr.find(W + "numPr") is not None
        pieces, images = [], []
        for r in p.iter():
            if r.tag == W + "r":
                f = self.run_fmt(r, pstyle)
                txt = ""
                for c in r:
                    if c.tag == W + "t":
                        txt += c.text or ""
                    elif c.tag == W + "tab":
                        txt += "\t"
                    elif c.tag in (W + "br", W + "cr"):
                        if c.get(W + "type") != "page":
                            txt += "\n"
                    elif c.tag == W + "sym":
                        try:
                            txt += chr(int(c.get(W + "char"), 16))
                        except Exception:
                            pass
                if txt:
                    pieces.append((txt, f))
            elif r.tag == A + "blip":
                rid = r.get(R + "embed")
                if rid:
                    images.append(rid)
            elif r.tag == V + "imagedata":
                rid = r.get(R + "id")
                if rid:
                    images.append(rid)
        text = self.markup(pieces)
        plain = "".join(t for t, _ in pieces)
        nonblank = [(t, f) for t, f in pieces if t.strip()]
        return {
            "type": "p",
            "text": text,
            "plain": plain,
            "ind_twips": ind_left,
            "numbered": numbered,
            "level": level,
            "all_bold": bool(nonblank) and all(f["b"] for _, f in nonblank),
            "any_underline": any(f["u"] for _, f in nonblank),
        }, images

    @staticmethod
    def markup(pieces):
        # 同じ書式の続きをまとめてから記号を付ける
        merged = []
        for t, f in pieces:
            key = tuple(sorted(k for k, v in f.items() if v))
            if merged and merged[-1][1] == key:
                merged[-1][0] += t
            else:
                merged.append([t, key])
        out = []
        for t, key in merged:
            if "var" in key:
                v = t.strip()
                out.append("[[ ]]" if not v else "[[=" + v.replace("]]", "] ]") + "]]")
                continue
            lead = t[: len(t) - len(t.lstrip())]
            trail = t[len(t.rstrip()):]
            core = t.strip()
            if not core:
                out.append(t)
                continue
            for k, (a, b) in (("sup", ("^{", "}")), ("sub", ("_{", "}")), ("u", ("__", "__")),
                              ("b", ("**", "**")), ("hl", ("==", "==")), ("red", ("!!", "!!"))):
                if k in key:
                    core = a + core + b
            out.append(lead + core + trail)
        return "".join(out)

    def image(self, rid):
        target = self.rels.get(rid)
        if not target:
            return None
        path = posixpath.normpath(posixpath.join("word", target)) if not target.startswith("/") else target.lstrip("/")
        ext = posixpath.splitext(path)[1].lower()
        if ext not in IMG_TYPES:
            return None   # EMF などは表示できないので飛ばす
        try:
            data = self.z.read(path)
        except KeyError:
            return None
        return "data:%s;base64,%s" % (IMG_TYPES[ext], base64.b64encode(data).decode("ascii"))

    def cell_text(self, tc):
        lines = []
        for p in tc.iter(W + "p"):
            d, _ = self.para(p)
            if d["text"].strip():
                lines.append(d["text"].strip())
        return " ".join(lines)

    def read(self):
        doc = ET.fromstring(self.z.read("word/document.xml"))
        body = doc.find(W + "body")
        items = []
        for el in body:
            if el.tag == W + "p":
                d, imgs = self.para(el)
                items.append(d)
                for rid in imgs:
                    src = self.image(rid)
                    if src:
                        items.append({"type": "image", "src": src})
            elif el.tag == W + "tbl":
                rows = []
                for tr in el.findall(W + "tr"):
                    rows.append([self.cell_text(tc) for tc in tr.findall(W + "tc")])
                if rows:
                    width = max(len(r) for r in rows)
                    rows = [r + [""] * (width - len(r)) for r in rows]
                    items.append({"type": "table", "rows": rows})
        # 字下げ：いちばん多い左インデントを基準(0)にして、全角1文字≒210twips で数える
        base = Counter(i["ind_twips"] for i in items if i["type"] == "p" and i["plain"].strip()).most_common(1)
        base = base[0][0] if base else 0
        for i in items:
            if i["type"] == "p":
                i["ind"] = max(0, round((i.pop("ind_twips") - base) / 210))
        return items


def read_docx(data):
    return Docx(data).read()
