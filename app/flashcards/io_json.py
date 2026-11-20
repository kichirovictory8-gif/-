"""JSON での書き出し・取り込み。

形式（version 1）:
{
  "format": "yakushi-flash", "version": 1, "exported_at": "...",
  "cards": [
    {"id": 1, "subject": "薬理", "unit": "自律神経", "front": "...", "back": "...",
     "stage": 2, "due": "2026-11-23", "created_at": "...", "updated_at": "...",
     "reviews": [{"reviewed_at": "...", "review_date": "...", "rating": "good",
                  "stage_before": 0, "stage_after": 1, "is_recheck": false,
                  "counted": true}]}
  ]
}
"counted": false は「学習状況のリセット前の評価」（履歴としては残るが集計に数えない）。
"""
from __future__ import annotations

import sqlite3
from datetime import date, datetime

from . import APP_ID, srs
from .subjects import check_subject

FORMAT_VERSION = 1
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
    for c in conn.execute("SELECT * FROM cards ORDER BY id"):
        cards.append({
            "id": c["id"],
            "subject": c["subject"],
            "unit": c["unit"],
            "front": c["front"],
            "back": c["back"],
            "stage": c["stage"],
            "due": c["due"],
            "created_at": c["created_at"],
            "updated_at": c["updated_at"],
            "reviews": reviews_by_card.get(c["id"], []),
        })
    return {"format": APP_ID, "version": FORMAT_VERSION,
            "exported_at": now.isoformat(timespec="seconds"), "cards": cards}


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


def _validate(data) -> list[dict]:
    if not isinstance(data, dict) or data.get("format") != APP_ID:
        raise ValueError("このアプリで書き出した JSON ではありません（format が違います）")
    if data.get("version") != FORMAT_VERSION:
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
        out.append({
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
    n_reviews = 0
    try:
        if mode == "replace":
            conn.execute("DELETE FROM reviews")
            conn.execute("DELETE FROM cards")
        for c in cards:
            keep_id = c["id"] if mode == "replace" else None
            cur = conn.execute(
                "INSERT INTO cards(id, subject, unit, front, back, stage, due, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (keep_id, c["subject"], c["unit"], c["front"], c["back"], c["stage"], c["due"],
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
    return {"mode": mode, "cards": len(cards), "reviews": n_reviews}
