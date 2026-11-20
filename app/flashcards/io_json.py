"""JSON での書き出し・取り込み。

形式（version 2。version 1 = 画像なしの旧形式も読み込める）:
{
  "format": "yakushi-flash", "version": 2, "exported_at": "...",
  "images": [
    {"id": 3, "mime": "image/png", "width": 800, "height": 600,
     "data": "<base64>", "thumb": "<base64 または null>", "thumb_mime": "image/jpeg"}
  ],
  "cards": [
    {"id": 1, "subject": "薬理", "unit": "自律神経", "front": "...[[img:3]]", "back": "...",
     "masks": {"3": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.1, "hint": ""}]},
     "stage": 2, "due": "2026-11-23", "created_at": "...", "updated_at": "...",
     "reviews": [{"reviewed_at": "...", "review_date": "...", "rating": "good",
                  "stage_before": 0, "stage_after": 1, "is_recheck": false,
                  "counted": true}]}
  ]
}
"counted": false は「学習状況のリセット前の評価」（履歴としては残るが集計に数えない）。
"""
from __future__ import annotations

import base64
import hashlib
import json
import sqlite3
from datetime import date, datetime

from . import APP_ID, cloze, srs
from .db import MAX_IMAGE_BYTES, MAX_THUMB_BYTES, sniff_mime
from .subjects import check_subject

FORMAT_VERSION = 2
READABLE_VERSIONS = (1, 2)
MODES = ("append", "replace")


def export_data(conn: sqlite3.Connection, now: datetime | None = None) -> dict:
    now = now or datetime.now()
    cards = []
    reviews_by_card: dict[int, list[dict]] = {}
    for r in conn.execute(
        "SELECT r.*, (r.id > c.reset_review_id) AS counted FROM reviews r"
        " JOIN cards c ON c.id = r.card_id ORDER BY r.id"
    ):
        reviews_by_card.setdefault(r["card_id"], []).append({
            "reviewed_at": r["reviewed_at"],
            "review_date": r["review_date"],
            "rating": r["rating"],
            "stage_before": r["stage_before"],
            "stage_after": r["stage_after"],
            "is_recheck": bool(r["is_recheck"]),
            "counted": bool(r["counted"]),
        })
    images = []
    for im in conn.execute("SELECT * FROM images ORDER BY id"):
        images.append({
            "id": im["id"], "mime": im["mime"], "width": im["width"], "height": im["height"],
            "data": base64.b64encode(im["data"]).decode("ascii"),
            "thumb": base64.b64encode(im["thumb"]).decode("ascii") if im["thumb"] else None,
            "thumb_mime": im["thumb_mime"],
            "created_at": im["created_at"],
        })
    for c in conn.execute("SELECT * FROM cards ORDER BY id"):
        try:
            masks = json.loads(c["masks"] or "{}")
        except ValueError:
            masks = {}
        cards.append({
            "id": c["id"],
            "subject": c["subject"],
            "unit": c["unit"],
            "front": c["front"],
            "back": c["back"],
            "masks": masks,
            "stage": c["stage"],
            "due": c["due"],
            "created_at": c["created_at"],
            "updated_at": c["updated_at"],
            "reviews": reviews_by_card.get(c["id"], []),
        })
    return {"format": APP_ID, "version": FORMAT_VERSION,
            "exported_at": now.isoformat(timespec="seconds"), "images": images, "cards": cards}


def _check_date(value, name: str, idx: int) -> str:
    try:
        return date.fromisoformat(str(value)).isoformat()
    except ValueError:
        raise ValueError(f"{idx + 1}枚目: {name} の日付が正しくありません: {value!r}") from None


def _check_datetime(value, name: str, idx: int) -> str:
    try:
        return datetime.fromisoformat(str(value)).isoformat(timespec="seconds")
    except ValueError:
        raise ValueError(f"{idx + 1}枚目: {name} の日時が正しくありません: {value!r}") from None


def _b64(value, max_bytes: int, what: str) -> bytes:
    try:
        raw = base64.b64decode(str(value), validate=True)
    except (ValueError, base64.binascii.Error):
        raise ValueError(f"{what}のデータを読み取れませんでした") from None
    if len(raw) > max_bytes:
        raise ValueError(f"{what}が大きすぎます")
    return raw


def _validate_images(data) -> list[dict]:
    out = []
    for i, im in enumerate(data.get("images") or []):
        what = f"画像{i + 1}"
        if not isinstance(im, dict) or not isinstance(im.get("id"), int):
            raise ValueError(f"{what}: 形式が正しくありません")
        raw = _b64(im.get("data"), MAX_IMAGE_BYTES, what)
        mime = sniff_mime(raw)
        if mime is None:
            raise ValueError(f"{what}: 対応していない画像形式です")
        thumb = _b64(im["thumb"], MAX_THUMB_BYTES, what + "のサムネイル") if im.get("thumb") else None
        out.append({"id": im["id"], "mime": mime, "width": int(im.get("width") or 0),
                    "height": int(im.get("height") or 0), "data": raw, "thumb": thumb,
                    "thumb_mime": sniff_mime(thumb) if thumb else None,
                    "created_at": str(im.get("created_at") or datetime.now().isoformat(timespec="seconds"))})
    return out


def _validate(data) -> list[dict]:
    if not isinstance(data, dict) or data.get("format") != APP_ID:
        raise ValueError("このアプリで書き出した JSON ではありません（format が違います）")
    if data.get("version") not in READABLE_VERSIONS:
        raise ValueError(f"対応していない版です: version={data.get('version')!r}")
    cards = data.get("cards")
    if not isinstance(cards, list):
        raise ValueError("cards が見つかりません")
    out = []
    for i, c in enumerate(cards):
        if not isinstance(c, dict):
            raise ValueError(f"{i + 1}枚目: 形式が正しくありません")
        try:
            subject = check_subject(c.get("subject", ""))
        except ValueError as e:
            raise ValueError(f"{i + 1}枚目: {e}") from None
        front = str(c.get("front") or "").strip()
        if not front:
            raise ValueError(f"{i + 1}枚目: 表面が空です")
        stage = c.get("stage", 0)
        if not isinstance(stage, int) or not 0 <= stage <= srs.MAX_STAGE:
            raise ValueError(f"{i + 1}枚目: 段階が正しくありません: {stage!r}")
        reviews = []
        for rv in c.get("reviews") or []:
            if rv.get("rating") not in srs.RATINGS:
                raise ValueError(f"{i + 1}枚目: 評価が正しくありません: {rv.get('rating')!r}")
            reviews.append({
                "reviewed_at": _check_datetime(rv.get("reviewed_at"), "reviewed_at", i),
                "review_date": _check_date(rv.get("review_date"), "review_date", i),
                "rating": rv["rating"],
                "stage_before": int(rv.get("stage_before", 0)),
                "stage_after": int(rv.get("stage_after", 0)),
                "is_recheck": 1 if rv.get("is_recheck") else 0,
                "counted": rv.get("counted", True) is not False,
            })
        try:
            masks = cloze.normalize_masks(c.get("masks"), front)
        except ValueError as e:
            raise ValueError(f"{i + 1}枚目: {e}") from None
        out.append({
            "masks": masks,
            "id": c.get("id") if isinstance(c.get("id"), int) else None,
            "subject": subject,
            "unit": str(c.get("unit") or "").strip(),
            "front": front,
            "back": str(c.get("back") or "").strip(),
            "stage": stage,
            "due": _check_date(c.get("due"), "due", i),
            "created_at": _check_datetime(c.get("created_at"), "created_at", i),
            "updated_at": _check_datetime(c.get("updated_at") or c.get("created_at"), "updated_at", i),
            "reviews": reviews,
        })
    return out


def import_data(conn: sqlite3.Connection, data, mode: str) -> dict:
    """mode="append": 今のカードに追加（新しい id を振る）。mode="replace": 全カードを入れ替える。

    どちらも全件の検証に通ってから1つのトランザクションで書き込む（途中で失敗したら何も変わらない）。
    """
    if mode not in MODES:
        raise ValueError(f"取り込み方法が正しくありません: {mode!r}")
    cards = _validate(data)
    images = _validate_images(data)
    known = {im["id"] for im in images}
    for i, c in enumerate(cards):
        missing = (set(cloze.image_ids(c["front"])) | set(cloze.image_ids(c["back"]))) - known
        if missing:
            raise ValueError(f"{i + 1}枚目: JSON に含まれていない画像を使っています: {sorted(missing)}")
    n_reviews = 0
    try:
        if mode == "replace":
            conn.execute("DELETE FROM reviews")
            conn.execute("DELETE FROM cards")
            conn.execute("DELETE FROM images")
        mapping: dict[int, int] = {}
        for im in images:
            digest = hashlib.sha256(im["data"]).hexdigest()
            row = conn.execute("SELECT id FROM images WHERE sha256 = ?", (digest,)).fetchone()
            if row:   # 同じ画像がすでにある（追加モード）
                mapping[im["id"]] = row[0]
                continue
            cur = conn.execute(
                "INSERT INTO images(id, sha256, mime, width, height, data, thumb, thumb_mime, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (im["id"] if mode == "replace" else None, digest, im["mime"], im["width"], im["height"],
                 im["data"], im["thumb"], im["thumb_mime"], im["created_at"]),
            )
            mapping[im["id"]] = cur.lastrowid
        for c in cards:
            keep_id = c["id"] if mode == "replace" else None
            front = cloze.remap_images(c["front"], mapping)
            back = cloze.remap_images(c["back"], mapping)
            masks = {str(mapping.get(int(k), int(k))): v for k, v in c["masks"].items()}
            cur = conn.execute(
                "INSERT INTO cards(id, subject, unit, front, back, masks, stage, due, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (keep_id, c["subject"], c["unit"], front, back,
                 json.dumps(masks, ensure_ascii=False, separators=(",", ":")), c["stage"], c["due"],
                 c["created_at"], c["updated_at"]),
            )
            card_id = cur.lastrowid
            reset_id = 0
            for rv in c["reviews"]:
                rcur = conn.execute(
                    "INSERT INTO reviews(card_id, reviewed_at, review_date, rating, stage_before, stage_after, is_recheck)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (card_id, rv["reviewed_at"], rv["review_date"], rv["rating"], rv["stage_before"],
                     rv["stage_after"], rv["is_recheck"]),
                )
                n_reviews += 1
                if not rv["counted"]:
                    reset_id = rcur.lastrowid
            if reset_id:
                conn.execute("UPDATE cards SET reset_review_id=? WHERE id=?", (reset_id, card_id))
        conn.commit()
    except sqlite3.IntegrityError as e:
        conn.rollback()
        raise ValueError(f"取り込みに失敗しました（id の重複など）: {e}") from None
    except Exception:
        conn.rollback()
        raise
    return {"mode": mode, "cards": len(cards), "reviews": n_reviews, "images": len(images)}
