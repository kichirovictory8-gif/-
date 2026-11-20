"""SQLite へのアクセス（カード・評価履歴・学習セッション）。"""
from __future__ import annotations

import base64
import hashlib
import json
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path

from . import cloze, srs
from .subjects import SUBJECTS, check_subject

SCHEMA_VERSION = 2

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cards (
    id              INTEGER PRIMARY KEY,
    subject         TEXT    NOT NULL,
    unit            TEXT    NOT NULL DEFAULT '',
    front           TEXT    NOT NULL,
    back            TEXT    NOT NULL DEFAULT '',
    stage           INTEGER NOT NULL DEFAULT 0,
    due             TEXT    NOT NULL,             -- YYYY-MM-DD
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL,
    reset_review_id INTEGER NOT NULL DEFAULT 0    -- これ以下の id の評価は集計に数えない
);
CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due);
CREATE INDEX IF NOT EXISTS idx_cards_subject ON cards(subject, unit);
CREATE TABLE IF NOT EXISTS reviews (
    id           INTEGER PRIMARY KEY,
    card_id      INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    reviewed_at  TEXT    NOT NULL,                -- 実際の日時
    review_date  TEXT    NOT NULL,                -- 学習上の日付（午前2時区切り）
    rating       TEXT    NOT NULL CHECK (rating IN ('good', 'fair', 'again')),
    stage_before INTEGER NOT NULL,
    stage_after  INTEGER NOT NULL,
    is_recheck   INTEGER NOT NULL DEFAULT 0       -- 1 = その日の再確認（間隔に影響しない）
);
CREATE INDEX IF NOT EXISTS idx_reviews_card ON reviews(card_id, id);
CREATE INDEX IF NOT EXISTS idx_reviews_date ON reviews(review_date);
CREATE TABLE IF NOT EXISTS images (
    id         INTEGER PRIMARY KEY,
    sha256     TEXT    NOT NULL UNIQUE,
    mime       TEXT    NOT NULL,
    width      INTEGER NOT NULL DEFAULT 0,
    height     INTEGER NOT NULL DEFAULT 0,
    data       BLOB    NOT NULL,
    thumb      BLOB,
    thumb_mime TEXT,
    created_at TEXT    NOT NULL
);
"""

IMAGE_MIMES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
MAX_IMAGE_BYTES = 15 * 1024 * 1024
MAX_THUMB_BYTES = 512 * 1024


def sniff_mime(data: bytes) -> str | None:
    """先頭のバイト列から画像の種類を判定する（拡張子や申告は信用しない）。"""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


def decode_data_url(value: str, max_bytes: int) -> tuple[bytes, str]:
    """data:image/png;base64,... または素の base64 を (バイト列, 種類) にする。"""
    value = str(value or "")
    if value.startswith("data:"):
        value = value.split(",", 1)[1] if "," in value else ""
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, base64.binascii.Error):
        raise ValueError("画像データを読み取れませんでした") from None
    if len(raw) > max_bytes:
        raise ValueError(f"画像が大きすぎます（{max_bytes // 1024 // 1024 or 1}MB まで）")
    mime = sniff_mime(raw)
    if mime not in IMAGE_MIMES:
        raise ValueError("対応していない画像形式です（PNG / JPEG / WebP / GIF）")
    return raw, mime

#: 集計対象の評価（再確認を除き、学習状況リセット後のもの）
COUNTED_CTE = """
counted AS (
    SELECT r.* FROM reviews r JOIN cards c ON c.id = r.card_id
    WHERE r.is_recheck = 0 AND r.id > c.reset_review_id
),
last_rating AS (
    SELECT card_id, rating FROM counted
    WHERE id IN (SELECT MAX(id) FROM counted GROUP BY card_id)
),
reps AS (
    SELECT card_id, COUNT(*) AS n FROM counted GROUP BY card_id
)
"""


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def connect(path: str | Path, threadsafe: bool = False) -> sqlite3.Connection:
    """threadsafe=True は複数スレッドから使う場合（呼び出し側でロックして直列化すること）。"""
    conn = sqlite3.connect(str(path), check_same_thread=not threadsafe)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    _migrate(conn)
    conn.execute(
        "INSERT INTO meta(key, value) VALUES ('schema_version', ?)"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value", (str(SCHEMA_VERSION),)
    )
    conn.commit()
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    """古い版で作ったファイルに、足りない列を追加する（データはそのまま）。"""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(cards)")}
    if "masks" not in cols:
        conn.execute("ALTER TABLE cards ADD COLUMN masks TEXT NOT NULL DEFAULT '{}'")


def _clean_text(value, name: str, required: bool) -> str:
    value = "" if value is None else str(value)
    value = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    if required and not value:
        raise ValueError(f"{name}を入力してください")
    return value


class Store:
    """カードと評価履歴の操作。now を渡せば時刻を固定できる（テスト用）。"""

    def __init__(self, conn: sqlite3.Connection, clock=None):
        self.conn = conn
        self.clock = clock or datetime.now

    # ---- 時刻 ----
    def now(self) -> datetime:
        return self.clock()

    def today(self) -> date:
        return srs.study_date(self.now())

    # ---- カード ----
    def add_card(self, subject: str, unit: str, front: str, back: str, masks=None) -> int:
        card_id = self._add_no_commit(subject, unit, front, back, masks)
        self.conn.commit()
        return card_id

    def add_many(self, subject: str, unit: str, pairs: list[tuple[str, str]]) -> list[int]:
        ids = []
        try:
            for front, back in pairs:
                ids.append(self._add_no_commit(subject, unit, front, back))
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise
        return ids

    def _add_no_commit(self, subject, unit, front, back, masks=None) -> int:
        subject, unit, front, back, masks = self._validate(subject, unit, front, back, masks)
        now = _iso(self.now())
        cur = self.conn.execute(
            "INSERT INTO cards(subject, unit, front, back, masks, stage, due, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)",
            (subject, unit, front, back, masks, self.today().isoformat(), now, now),
        )
        return cur.lastrowid

    def _validate(self, subject, unit, front, back, masks=None) -> tuple[str, str, str, str, str]:
        subject = check_subject(subject)
        unit = _clean_text(unit, "系統・単元", False)
        front = _clean_text(front, "表面", True)
        back = _clean_text(back, "裏面", False)
        masks = cloze.normalize_masks(masks, front)
        if not back and not cloze.has_cloze(front, masks):
            raise ValueError("裏面を入力してください（表面が穴埋めなら裏面は省略できます）")
        ids = set(cloze.image_ids(front)) | set(cloze.image_ids(back))
        if ids:
            marks = ",".join("?" * len(ids))
            found = {r[0] for r in self.conn.execute(f"SELECT id FROM images WHERE id IN ({marks})", list(ids))}
            missing = sorted(ids - found)
            if missing:
                raise ValueError(f"画像が見つかりません: {', '.join(f'[[img:{i}]]' for i in missing)}")
        return subject, unit, front, back, json.dumps(masks, ensure_ascii=False, separators=(",", ":"))

    def update_card(self, card_id: int, subject: str, unit: str, front: str, back: str, masks=None) -> None:
        self._require(card_id)
        subject, unit, front, back, masks = self._validate(subject, unit, front, back, masks)
        self.conn.execute(
            "UPDATE cards SET subject=?, unit=?, front=?, back=?, masks=?, updated_at=? WHERE id=?",
            (subject, unit, front, back, masks, _iso(self.now()), card_id),
        )
        self.conn.commit()

    def delete_card(self, card_id: int) -> None:
        self._require(card_id)
        self.conn.execute("DELETE FROM cards WHERE id=?", (card_id,))
        self.conn.commit()

    def reset_card(self, card_id: int) -> None:
        """学習状況のリセット: 新規に戻し今日を期日に。履歴は残すが集計からは外す。"""
        self._require(card_id)
        max_id = self.conn.execute("SELECT COALESCE(MAX(id), 0) FROM reviews").fetchone()[0]
        self.conn.execute(
            "UPDATE cards SET stage=0, due=?, reset_review_id=?, updated_at=? WHERE id=?",
            (self.today().isoformat(), max_id, _iso(self.now()), card_id),
        )
        self.conn.commit()

    def _require(self, card_id: int) -> sqlite3.Row:
        row = self.conn.execute("SELECT * FROM cards WHERE id=?", (card_id,)).fetchone()
        if row is None:
            raise KeyError(f"カードが見つかりません: {card_id}")
        return row

    def get_card(self, card_id: int) -> dict:
        rows = self._query_cards("WHERE c.id = ?", [card_id], "", 1, 0)
        if not rows:
            raise KeyError(f"カードが見つかりません: {card_id}")
        return rows[0]

    def card_history(self, card_id: int) -> list[dict]:
        self._require(card_id)
        rows = self.conn.execute(
            "SELECT r.*, (r.id <= c.reset_review_id) AS before_reset FROM reviews r"
            " JOIN cards c ON c.id = r.card_id WHERE r.card_id=? ORDER BY r.id DESC",
            (card_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def _query_cards(self, where: str, params: list, order: str, limit: int, offset: int) -> list[dict]:
        sql = (
            f"WITH {COUNTED_CTE} SELECT c.*, l.rating AS last_rating, COALESCE(reps.n, 0) AS reps"
            " FROM cards c LEFT JOIN last_rating l ON l.card_id = c.id"
            " LEFT JOIN reps ON reps.card_id = c.id "
            f"{where} {order} LIMIT ? OFFSET ?"
        )
        rows = self.conn.execute(sql, [*params, limit, offset]).fetchall()
        return [self._card_dict(r) for r in rows]

    @staticmethod
    def _card_dict(row: sqlite3.Row) -> dict:
        d = dict(row)
        try:
            d["masks"] = json.loads(d.get("masks") or "{}")
        except ValueError:
            d["masks"] = {}
        d["interval"] = srs.interval_for(d["stage"])
        d["front_plain"] = cloze.plain(d["front"])
        d["back_plain"] = cloze.plain(d["back"])
        d["question_html"] = cloze.render_front(d["front"], d["masks"])
        d["back_html"] = cloze.render_back(d["back"])
        d["is_cloze"] = cloze.has_cloze(d["front"], d["masks"])
        imgs = cloze.image_ids(d["front"]) or cloze.image_ids(d["back"])
        d["thumb_id"] = imgs[0] if imgs else None
        return d

    def list_cards(self, q: str = "", subject: str = "", unit: str | None = None, level: str = "",
                   due: str = "", sort: str = "due", limit: int = 50, offset: int = 0) -> dict:
        """カード一覧。level: new/good/fair/again/mature、due: due/next7/later。"""
        today = self.today()
        conds, params = [], []
        if q:
            like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            conds.append("(c.front LIKE ? ESCAPE '\\' OR c.back LIKE ? ESCAPE '\\' OR c.unit LIKE ? ESCAPE '\\')")
            params += [like, like, like]
        if subject:
            conds.append("c.subject = ?")
            params.append(check_subject(subject))
        if unit is not None:
            conds.append("c.unit = ?")
            params.append(unit)
        if level == "new":
            conds.append("l.rating IS NULL")
        elif level in srs.RATINGS:
            conds.append("l.rating = ?")
            params.append(level)
        elif level == "mature":
            conds.append("c.stage >= ?")
            params.append(srs.MATURE_STAGE)
        elif level:
            raise ValueError(f"理解度の指定が正しくありません: {level}")
        if due == "due":
            conds.append("c.due <= ?")
            params.append(today.isoformat())
        elif due == "next7":
            conds.append("c.due > ? AND c.due <= ?")
            params += [today.isoformat(), (today + timedelta(days=7)).isoformat()]
        elif due == "later":
            conds.append("c.due > ?")
            params.append((today + timedelta(days=7)).isoformat())
        elif due:
            raise ValueError(f"期日の指定が正しくありません: {due}")
        orders = {
            "due": "ORDER BY c.due, c.id",
            "new": "ORDER BY c.id DESC",
            "old": "ORDER BY c.id",
            "updated": "ORDER BY c.updated_at DESC, c.id DESC",
        }
        if sort not in orders:
            raise ValueError(f"並び順の指定が正しくありません: {sort}")
        where = ("WHERE " + " AND ".join(conds)) if conds else ""
        total = self.conn.execute(
            f"WITH {COUNTED_CTE} SELECT COUNT(*) FROM cards c LEFT JOIN last_rating l ON l.card_id = c.id {where}",
            params,
        ).fetchone()[0]
        items = self._query_cards(where, params, orders[sort], limit, offset)
        return {"total": total, "items": items}

    # ---- 画像 ----
    def add_image(self, data_url: str, thumb_url: str | None = None, width: int = 0, height: int = 0) -> dict:
        """画像を登録して id を返す。同じ画像がすでにあればその id を返す。"""
        raw, mime = decode_data_url(data_url, MAX_IMAGE_BYTES)
        thumb, thumb_mime = (None, None)
        if thumb_url:
            thumb, thumb_mime = decode_data_url(thumb_url, MAX_THUMB_BYTES)
        digest = hashlib.sha256(raw).hexdigest()
        row = self.conn.execute("SELECT id FROM images WHERE sha256 = ?", (digest,)).fetchone()
        if row:
            return {"id": row[0], "existing": True}
        w = max(0, min(int(width or 0), 100000))
        h = max(0, min(int(height or 0), 100000))
        cur = self.conn.execute(
            "INSERT INTO images(sha256, mime, width, height, data, thumb, thumb_mime, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (digest, mime, w, h, raw, thumb, thumb_mime, _iso(self.now())),
        )
        self.conn.commit()
        return {"id": cur.lastrowid, "existing": False}

    def get_image(self, image_id: int, thumb: bool = False) -> tuple[bytes, str]:
        row = self.conn.execute("SELECT data, mime, thumb, thumb_mime FROM images WHERE id = ?",
                                (image_id,)).fetchone()
        if row is None:
            raise KeyError(f"画像が見つかりません: {image_id}")
        if thumb and row["thumb"]:
            return row["thumb"], row["thumb_mime"]
        return row["data"], row["mime"]

    def cleanup_images(self, older_than_days: int = 2) -> int:
        """どのカードからも使われていない画像を消す。

        追加・編集の途中で貼った画像を消さないよう、作ってから older_than_days 日以上たったものだけ。
        """
        used: set[int] = set()
        for r in self.conn.execute("SELECT front, back FROM cards"):
            used.update(cloze.image_ids(r[0]))
            used.update(cloze.image_ids(r[1]))
        limit = _iso(self.now() - timedelta(days=older_than_days))
        rows = self.conn.execute("SELECT id FROM images WHERE created_at < ?", (limit,)).fetchall()
        stale = [r[0] for r in rows if r[0] not in used]
        for i in stale:
            self.conn.execute("DELETE FROM images WHERE id = ?", (i,))
        self.conn.commit()
        return len(stale)

    def units(self, subject: str = "") -> list[dict]:
        if subject:
            rows = self.conn.execute(
                "SELECT subject, unit, COUNT(*) AS n FROM cards WHERE subject=? GROUP BY subject, unit ORDER BY unit",
                (check_subject(subject),),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT subject, unit, COUNT(*) AS n FROM cards GROUP BY subject, unit ORDER BY unit"
            ).fetchall()
        return [dict(r) for r in rows]

    # ---- 学習セッション ----
    def due_cards(self, subject: str = "") -> list[sqlite3.Row]:
        today = self.today().isoformat()
        if subject:
            return self.conn.execute(
                "SELECT * FROM cards WHERE due <= ? AND subject = ? ORDER BY due, id",
                (today, check_subject(subject)),
            ).fetchall()
        return self.conn.execute("SELECT * FROM cards WHERE due <= ? ORDER BY due, id", (today,)).fetchall()

    def pending_rechecks(self, subject: str = "") -> list[sqlite3.Row]:
        """今日 ✖ にして、まだ再確認していないカード（✖ にした順）。"""
        params: list = [self.today().isoformat()]
        extra = ""
        if subject:
            extra = "AND c.subject = ?"
            params.append(check_subject(subject))
        return self.conn.execute(
            "SELECT c.*, MAX(r.id) AS fail_id FROM cards c JOIN reviews r ON r.card_id = c.id"
            " WHERE r.review_date = ? AND r.rating = 'again' AND r.is_recheck = 0"
            " AND NOT EXISTS (SELECT 1 FROM reviews r2 WHERE r2.card_id = c.id"
            "                 AND r2.is_recheck = 1 AND r2.id > r.id)"
            f" {extra} GROUP BY c.id ORDER BY fail_id",
            params,
        ).fetchall()

    def next_card(self, subject: str = "") -> dict:
        """次に出すカード。期日の古い順 → すべて終わったら今日の ✖ の再確認。"""
        due = self.due_cards(subject)
        rechecks = self.pending_rechecks(subject)
        due_ids = {r["id"] for r in due}
        rechecks = [r for r in rechecks if r["id"] not in due_ids]
        result = {"remaining_due": len(due), "remaining_recheck": len(rechecks), "card": None, "kind": None}
        if due:
            result["card"], result["kind"] = self.get_card(due[0]["id"]), "review"
        elif rechecks:
            result["card"], result["kind"] = self.get_card(rechecks[0]["id"]), "recheck"
        return result

    def record_review(self, card_id: int, rating: str) -> dict:
        """評価を記録する。期日のカードなら通常の評価、今日 ✖ にしたカードなら再確認として扱う。"""
        if rating not in srs.RATINGS:
            raise ValueError(f"不明な評価です: {rating!r}")
        card = self._require(card_id)
        now = self.now()
        today = srs.study_date(now)
        stage = card["stage"]
        if card["due"] <= today.isoformat():
            new_stage, new_due = srs.apply_rating(stage, rating, today)
            is_recheck = 0
            self.conn.execute(
                "UPDATE cards SET stage=?, due=? WHERE id=?", (new_stage, new_due.isoformat(), card_id)
            )
        elif any(r["id"] == card_id for r in self.pending_rechecks()):
            new_stage, new_due, is_recheck = stage, date.fromisoformat(card["due"]), 1
        else:
            raise ValueError("このカードは今日の学習対象ではありません")
        self.conn.execute(
            "INSERT INTO reviews(card_id, reviewed_at, review_date, rating, stage_before, stage_after, is_recheck)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (card_id, _iso(now), today.isoformat(), rating, stage, new_stage, is_recheck),
        )
        self.conn.commit()
        return {"card_id": card_id, "stage": new_stage, "due": new_due.isoformat(),
                "interval": srs.interval_for(new_stage), "recheck": bool(is_recheck)}


__all__ = ["connect", "Store", "SUBJECTS", "COUNTED_CTE"]
