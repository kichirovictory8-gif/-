"""SQLite へのアクセス（カード・評価履歴・学習セッション）。"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path

from . import cloze, srs
from .subjects import SUBJECTS, check_subject
from .tags import normalize_tags

SCHEMA_VERSION = 4

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
    is_recheck   INTEGER NOT NULL DEFAULT 0,      -- 1 = その日の再確認（間隔に影響しない）
    practice_session TEXT                         -- 練習（全カード）での評価なら練習の id。間隔・集計に影響しない
);
CREATE INDEX IF NOT EXISTS idx_reviews_card ON reviews(card_id, id);
CREATE INDEX IF NOT EXISTS idx_reviews_date ON reviews(review_date);
CREATE TABLE IF NOT EXISTS memos (
    id         INTEGER PRIMARY KEY,
    text       TEXT    NOT NULL,
    subject    TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS card_tags (
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    tag     TEXT    NOT NULL,
    PRIMARY KEY (card_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_card_tags_tag ON card_tags(tag);
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
    WHERE r.is_recheck = 0 AND r.practice_session IS NULL AND r.id > c.reset_review_id
),
last_rating AS (
    SELECT card_id, rating FROM counted
    WHERE id IN (SELECT MAX(id) FROM counted GROUP BY card_id)
),
reps AS (
    SELECT card_id, COUNT(*) AS n FROM counted GROUP BY card_id
)
"""


ORDERS = {
    "due": "c.due, c.id",          # 期日が古い順
    "random": "random()",          # ランダム
    "added": "c.id",               # 追加した順（古い → 新しい）
    "added_desc": "c.id DESC",     # 追加した順（新しい → 古い）
}
TAG_MODES = ("or", "and")
FLAG_TAG = "あとで直す"      # 学習中に F キーで付け外しするタグ
LEECH_TAG = "要見直し"       # ✖ が続いたカードに自動で付けるタグ
LEECH_THRESHOLD = 4          # 通算の ✖ の回数（再確認・練習は数えない）
MAX_MEMO = 2000
SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def card_filter(subject: str = "", tags=None, tag_mode: str = "or") -> tuple[str, list]:
    """科目・タグでの絞り込み条件（cards の別名は c）。"""
    conds, params = [], []
    if subject:
        conds.append("c.subject = ?")
        params.append(check_subject(subject))
    tags = normalize_tags(tags)
    if tags:
        if tag_mode not in TAG_MODES:
            raise ValueError(f"タグの条件が正しくありません: {tag_mode}")
        marks = ",".join("?" * len(tags))
        if tag_mode == "or":
            conds.append(f"c.id IN (SELECT card_id FROM card_tags WHERE tag IN ({marks}))")
            params += tags
        else:
            conds.append(f"c.id IN (SELECT card_id FROM card_tags WHERE tag IN ({marks})"
                         " GROUP BY card_id HAVING COUNT(DISTINCT tag) = ?)")
            params += [*tags, len(tags)]
    return (" AND ".join(conds) or "1"), params


def order_sql(order: str) -> str:
    if order not in ORDERS:
        raise ValueError(f"順番の指定が正しくありません: {order}")
    return ORDERS[order]


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
    if "source" not in cols:   # 過去問から作ったカードの出どころ（hissu:<回>-<問>）
        conn.execute("ALTER TABLE cards ADD COLUMN source TEXT NOT NULL DEFAULT ''")
    if "leech_after" not in cols:   # 「要見直し」を外した時点の評価 id（それ以降の ✖ を数え直す）
        conn.execute("ALTER TABLE cards ADD COLUMN leech_after INTEGER NOT NULL DEFAULT 0")
    rcols = {r[1] for r in conn.execute("PRAGMA table_info(reviews)")}
    if "practice_session" not in rcols:
        conn.execute("ALTER TABLE reviews ADD COLUMN practice_session TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_reviews_practice ON reviews(practice_session, card_id)")


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
    def add_card(self, subject: str, unit: str, front: str, back: str, masks=None, tags=None,
                 source: str = "") -> int:
        tags = normalize_tags(tags)
        card_id = self._add_no_commit(subject, unit, front, back, masks)
        self._set_tags(card_id, tags)
        source = str(source or "").strip()[:100]
        if source:
            self.conn.execute("UPDATE cards SET source = ? WHERE id = ?", (source, card_id))
        self.conn.commit()
        return card_id

    def add_many(self, subject: str, unit: str, pairs: list[tuple[str, str]], tags=None) -> list[int]:
        tags = normalize_tags(tags)
        ids = []
        try:
            for front, back in pairs:
                ids.append(self._add_no_commit(subject, unit, front, back))
                self._set_tags(ids[-1], tags)
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

    def update_card(self, card_id: int, subject: str, unit: str, front: str, back: str, masks=None,
                    tags=None) -> None:
        """tags=None ならタグは変えない。"""
        self._require(card_id)
        subject, unit, front, back, masks = self._validate(subject, unit, front, back, masks)
        if tags is not None:
            new = normalize_tags(tags)
            old = self._tags_of(card_id)
            if LEECH_TAG in old and LEECH_TAG not in new:
                self._clear_leech(card_id)
            self._set_tags(card_id, new)
        self.conn.execute(
            "UPDATE cards SET subject=?, unit=?, front=?, back=?, masks=?, updated_at=? WHERE id=?",
            (subject, unit, front, back, masks, _iso(self.now()), card_id),
        )
        self.conn.commit()

    def _set_tags(self, card_id: int, tags: list[str]) -> None:
        self.conn.execute("DELETE FROM card_tags WHERE card_id = ?", (card_id,))
        self.conn.executemany("INSERT INTO card_tags(card_id, tag) VALUES (?, ?)", [(card_id, t) for t in tags])

    def _tags_of(self, card_id: int) -> list[str]:
        return [r[0] for r in self.conn.execute("SELECT tag FROM card_tags WHERE card_id = ?", (card_id,))]

    def _clear_leech(self, card_id: int) -> None:
        """「要見直し」を外したので、ここから ✖ を数え直す。"""
        max_id = self.conn.execute("SELECT COALESCE(MAX(id), 0) FROM reviews").fetchone()[0]
        self.conn.execute("UPDATE cards SET leech_after = ? WHERE id = ?", (max_id, card_id))

    def set_flag(self, card_id: int, on: bool) -> list[str]:
        """「あとで直す」タグを付け外しする。"""
        self._require(card_id)
        if on:
            self.conn.execute("INSERT OR IGNORE INTO card_tags(card_id, tag) VALUES (?, ?)", (card_id, FLAG_TAG))
        else:
            self.conn.execute("DELETE FROM card_tags WHERE card_id = ? AND tag = ?", (card_id, FLAG_TAG))
        self.conn.commit()
        return sorted(self._tags_of(card_id))

    def again_count(self, card_id: int) -> int:
        """「要見直し」の判定に使う ✖ の回数（リセット後・要見直しを外した後、再確認・練習を除く）。"""
        return self.conn.execute(
            "SELECT COUNT(*) FROM reviews r JOIN cards c ON c.id = r.card_id"
            " WHERE r.card_id = ? AND r.rating = 'again' AND r.is_recheck = 0 AND r.practice_session IS NULL"
            " AND r.id > c.reset_review_id AND r.id > c.leech_after", (card_id,)
        ).fetchone()[0]

    # ---- メモ箱 ----
    def add_memo(self, text: str, subject: str = "") -> dict:
        text = _clean_text(text, "メモ", True)[:MAX_MEMO]
        subject = check_subject(subject) if subject else ""
        cur = self.conn.execute("INSERT INTO memos(text, subject, created_at) VALUES (?, ?, ?)",
                                (text, subject, _iso(self.now())))
        self.conn.commit()
        return self.get_memo(cur.lastrowid)

    def get_memo(self, memo_id: int) -> dict:
        row = self.conn.execute("SELECT * FROM memos WHERE id = ?", (memo_id,)).fetchone()
        if row is None:
            raise KeyError(f"メモが見つかりません: {memo_id}")
        return dict(row)

    def list_memos(self) -> list[dict]:
        return [dict(r) for r in self.conn.execute("SELECT * FROM memos ORDER BY id DESC")]

    def delete_memo(self, memo_id: int) -> None:
        self.get_memo(memo_id)
        self.conn.execute("DELETE FROM memos WHERE id = ?", (memo_id,))
        self.conn.commit()

    def all_tags(self) -> list[dict]:
        """使われているタグと枚数（多い順）。"""
        rows = self.conn.execute(
            "SELECT tag, COUNT(*) AS n FROM card_tags GROUP BY tag ORDER BY n DESC, tag"
        ).fetchall()
        return [dict(r) for r in rows]

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
            f"WITH {COUNTED_CTE} SELECT c.*, l.rating AS last_rating, COALESCE(reps.n, 0) AS reps,"
            " (SELECT group_concat(tag, char(31)) FROM card_tags t WHERE t.card_id = c.id) AS tags_joined"
            " FROM cards c LEFT JOIN last_rating l ON l.card_id = c.id"
            " LEFT JOIN reps ON reps.card_id = c.id "
            f"{where} {order} LIMIT ? OFFSET ?"
        )
        rows = self.conn.execute(sql, [*params, limit, offset]).fetchall()
        return [self._card_dict(r) for r in rows]

    @staticmethod
    def _card_dict(row: sqlite3.Row) -> dict:
        d = dict(row)
        joined = d.pop("tags_joined", None)
        d["tags"] = sorted(joined.split("\x1f")) if joined else []
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
                   due: str = "", sort: str = "due", limit: int = 50, offset: int = 0, tag: str = "") -> dict:
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
        if tag:
            conds.append("c.id IN (SELECT card_id FROM card_tags WHERE tag = ?)")
            params.append(tag)
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
    # 通常（期日のカード）: 期日が来たカードを選んだ順番で出し、最後に今日の ✖ を1回ずつ再確認。
    # 練習（全カード）: 条件に合う全カードを1回ずつ出し、最後に ✖ を1回ずつ再確認。
    #   練習の評価は session（練習の id）付きで記録し、間隔・集計には影響しない。

    def due_cards(self, subject: str = "", tags=None, tag_mode: str = "or", order: str = "due") -> list[sqlite3.Row]:
        where, params = card_filter(subject, tags, tag_mode)
        return self.conn.execute(
            f"SELECT * FROM cards c WHERE c.due <= ? AND {where} ORDER BY {order_sql(order)}",
            [self.today().isoformat(), *params],
        ).fetchall()

    def pending_rechecks(self, subject: str = "", tags=None, tag_mode: str = "or") -> list[sqlite3.Row]:
        """今日 ✖ にして、まだ再確認していないカード（✖ にした順）。練習の評価は含めない。"""
        where, params = card_filter(subject, tags, tag_mode)
        return self.conn.execute(
            "SELECT c.*, MAX(r.id) AS fail_id FROM cards c JOIN reviews r ON r.card_id = c.id"
            " WHERE r.review_date = ? AND r.rating = 'again' AND r.is_recheck = 0 AND r.practice_session IS NULL"
            " AND NOT EXISTS (SELECT 1 FROM reviews r2 WHERE r2.card_id = c.id AND r2.practice_session IS NULL"
            "                 AND r2.is_recheck = 1 AND r2.id > r.id)"
            f" AND {where} GROUP BY c.id ORDER BY fail_id",
            [self.today().isoformat(), *params],
        ).fetchall()

    @staticmethod
    def _check_session(session: str) -> str:
        if not SESSION_RE.match(session or ""):
            raise ValueError("練習の id が正しくありません")
        return session

    def practice_remaining(self, session: str, subject: str = "", tags=None, tag_mode: str = "or",
                           order: str = "due") -> list[sqlite3.Row]:
        """練習でまだ出していないカード。"""
        where, params = card_filter(subject, tags, tag_mode)
        return self.conn.execute(
            f"SELECT * FROM cards c WHERE {where} AND c.id NOT IN"
            " (SELECT card_id FROM reviews WHERE practice_session = ? AND is_recheck = 0)"
            f" ORDER BY {order_sql(order)}",
            [*params, self._check_session(session)],
        ).fetchall()

    def practice_rechecks(self, session: str) -> list[sqlite3.Row]:
        """練習で ✖ にして、まだ再確認していないカード。"""
        session = self._check_session(session)
        return self.conn.execute(
            "SELECT c.*, MAX(r.id) AS fail_id FROM cards c JOIN reviews r ON r.card_id = c.id"
            " WHERE r.practice_session = ? AND r.rating = 'again' AND r.is_recheck = 0"
            " AND NOT EXISTS (SELECT 1 FROM reviews r2 WHERE r2.card_id = c.id AND r2.practice_session = ?"
            "                 AND r2.is_recheck = 1 AND r2.id > r.id)"
            " GROUP BY c.id ORDER BY fail_id",
            (session, session),
        ).fetchall()

    def session_counts(self, subject: str = "", tags=None, tag_mode: str = "or") -> dict:
        """開始前の画面に出す枚数（期日のカード / 条件に合う全カード）。"""
        where, params = card_filter(subject, tags, tag_mode)
        total = self.conn.execute(f"SELECT COUNT(*) FROM cards c WHERE {where}", params).fetchone()[0]
        due = self.conn.execute(f"SELECT COUNT(*) FROM cards c WHERE c.due <= ? AND {where}",
                                [self.today().isoformat(), *params]).fetchone()[0]
        return {"due": due, "total": total}

    def next_card(self, subject: str = "", tags=None, tag_mode: str = "or", order: str = "due",
                  session: str | None = None) -> dict:
        """次に出すカード。session があれば練習、なければ通常（期日のカード）。"""
        if session:
            first = self.practice_remaining(session, subject, tags, tag_mode, order)
            rechecks = self.practice_rechecks(session)
            kind = "practice"
        else:
            first = self.due_cards(subject, tags, tag_mode, order)
            rechecks = self.pending_rechecks(subject, tags, tag_mode)
            kind = "review"
        first_ids = {r["id"] for r in first}
        rechecks = [r for r in rechecks if r["id"] not in first_ids]
        result = {"remaining_due": len(first), "remaining_recheck": len(rechecks), "card": None, "kind": None}
        if first:
            result["card"], result["kind"] = self.get_card(first[0]["id"]), kind
        elif rechecks:
            result["card"], result["kind"] = self.get_card(rechecks[0]["id"]), "recheck"
        return result

    def record_review(self, card_id: int, rating: str, session: str | None = None) -> dict:
        """評価を記録する。

        通常: 期日のカードなら間隔を進め、今日 ✖ にしたカードなら再確認として記録する。
        練習（session あり）: 間隔は変えずに記録する（✖ のカードは練習の最後に再確認）。
        """
        if rating not in srs.RATINGS:
            raise ValueError(f"不明な評価です: {rating!r}")
        card = self._require(card_id)
        now = self.now()
        today = srs.study_date(now)
        stage = card["stage"]
        new_stage, new_due = stage, date.fromisoformat(card["due"])
        if session:
            session = self._check_session(session)
            done = self.conn.execute(
                "SELECT 1 FROM reviews WHERE card_id = ? AND practice_session = ? AND is_recheck = 0",
                (card_id, session)).fetchone()
            if not done:
                is_recheck = 0
            elif any(r["id"] == card_id for r in self.practice_rechecks(session)):
                is_recheck = 1
            else:
                raise ValueError("このカードはこの練習ですでに解きました")
        elif card["due"] <= today.isoformat():
            new_stage, new_due = srs.apply_rating(stage, rating, today)
            is_recheck = 0
            self.conn.execute(
                "UPDATE cards SET stage=?, due=? WHERE id=?", (new_stage, new_due.isoformat(), card_id)
            )
        elif any(r["id"] == card_id for r in self.pending_rechecks()):
            is_recheck = 1
        else:
            raise ValueError("このカードは今日の学習対象ではありません")
        self.conn.execute(
            "INSERT INTO reviews(card_id, reviewed_at, review_date, rating, stage_before, stage_after, is_recheck,"
            " practice_session) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (card_id, _iso(now), today.isoformat(), rating, stage, new_stage, is_recheck, session or None),
        )
        leech = False
        if rating == srs.AGAIN and not is_recheck and not session and LEECH_TAG not in self._tags_of(card_id):
            if self.again_count(card_id) >= LEECH_THRESHOLD:
                self.conn.execute("INSERT OR IGNORE INTO card_tags(card_id, tag) VALUES (?, ?)", (card_id, LEECH_TAG))
                leech = True
        self.conn.commit()
        return {"card_id": card_id, "stage": new_stage, "due": new_due.isoformat(),
                "interval": srs.interval_for(new_stage), "recheck": bool(is_recheck),
                "practice": bool(session), "leech": leech}


__all__ = ["connect", "Store", "SUBJECTS", "COUNTED_CTE"]
