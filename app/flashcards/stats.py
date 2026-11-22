"""集計（今日・科目別/系統別・苦手リスト）。

定義:
    周回数   … 再確認を除いた評価の回数（学習状況リセット後）
    ○/△/✖   … 各カードの最後の評価（再確認を除く）で分類
    未学習   … 一度も評価していない（リセット後を含む）カード
    定着率   … 間隔 30 日以上（段階 5 以上）のカード ÷ 全カード
    今日の復習数 … 今日の評価の回数（再確認を除く）
    練習（全カード）での評価は、どの集計にも数えない（履歴には残る）。
"""
from __future__ import annotations

import sqlite3
from datetime import date, timedelta

from . import srs
from .db import COUNTED_CTE
from .subjects import SUBJECTS, check_subject


def _daily_ratings(conn: sqlite3.Connection, start: date, end: date) -> dict[str, dict[str, int]]:
    rows = conn.execute(
        "SELECT review_date, rating, COUNT(*) AS n FROM reviews"
        " WHERE is_recheck = 0 AND practice_session IS NULL AND review_date BETWEEN ? AND ?"
        " GROUP BY review_date, rating",
        (start.isoformat(), end.isoformat()),
    ).fetchall()
    out: dict[str, dict[str, int]] = {}
    for r in rows:
        out.setdefault(r["review_date"], {})[r["rating"]] = r["n"]
    return out


def streak(conn: sqlite3.Connection, today: date) -> int:
    """連続学習日数。今日まだ学習していなければ昨日までの連続日数を返す。"""
    days = {r[0] for r in conn.execute(
        "SELECT DISTINCT review_date FROM reviews WHERE is_recheck = 0 AND practice_session IS NULL")}
    d = today if today.isoformat() in days else today - timedelta(days=1)
    n = 0
    while d.isoformat() in days:
        n += 1
        d -= timedelta(days=1)
    return n


def dashboard(conn: sqlite3.Connection, today: date, recent_days: int = 14, forecast_days: int = 7) -> dict:
    t = today.isoformat()
    due_today = conn.execute("SELECT COUNT(*) FROM cards WHERE due <= ?", (t,)).fetchone()[0]
    overdue = conn.execute("SELECT COUNT(*) FROM cards WHERE due < ?", (t,)).fetchone()[0]
    total = conn.execute("SELECT COUNT(*) FROM cards").fetchone()[0]
    reviewed_today = conn.execute(
        "SELECT COUNT(*) FROM reviews WHERE is_recheck = 0 AND practice_session IS NULL AND review_date = ?", (t,)
    ).fetchone()[0]

    stage_rows = dict(conn.execute("SELECT stage, COUNT(*) FROM cards GROUP BY stage").fetchall())
    stages = [
        {"stage": s, "interval": srs.interval_for(s), "count": stage_rows.get(s, 0)}
        for s in range(0, srs.MAX_STAGE + 1)
    ]
    unlearned = conn.execute(
        f"WITH {COUNTED_CTE} SELECT COUNT(*) FROM cards c LEFT JOIN reps ON reps.card_id = c.id WHERE reps.n IS NULL"
    ).fetchone()[0]

    start = today - timedelta(days=recent_days - 1)
    daily = _daily_ratings(conn, start, today)
    recent = []
    for i in range(recent_days):
        d = (start + timedelta(days=i)).isoformat()
        r = daily.get(d, {})
        recent.append({"date": d, **{k: r.get(k, 0) for k in srs.RATINGS}})

    forecast = []
    for i in range(forecast_days):
        d = today + timedelta(days=i)
        if i == 0:
            n = due_today
        else:
            n = conn.execute("SELECT COUNT(*) FROM cards WHERE due = ?", (d.isoformat(),)).fetchone()[0]
        forecast.append({"date": d.isoformat(), "count": n})

    due_rows = dict(conn.execute(
        "SELECT subject, COUNT(*) FROM cards WHERE due <= ? GROUP BY subject", (t,)
    ).fetchall())
    due_by_subject = [{"subject": s, "count": due_rows.get(s, 0)} for s in SUBJECTS]

    return {
        "today": t,
        "due_by_subject": due_by_subject,
        "total": total,
        "due_today": due_today,
        "overdue": overdue,
        "reviewed_today": reviewed_today,
        "streak": streak(conn, today),
        "unlearned": unlearned,
        "stages": stages,
        "recent": recent,
        "forecast": forecast,
    }


def _group_rows(conn: sqlite3.Connection, group_cols: str, where: str = "", params=()) -> list[dict]:
    """group_cols は "c.subject" や "c.subject, c.unit"。結果の列名は subject / unit。"""
    select_cols = ", ".join(f"{c.strip()} AS {c.strip().split('.')[-1]}" for c in group_cols.split(","))
    sql = (
        f"WITH {COUNTED_CTE} SELECT {select_cols}, COUNT(*) AS total,"
        " SUM(l.rating = 'good') AS good, SUM(l.rating = 'fair') AS fair, SUM(l.rating = 'again') AS again,"
        " SUM(l.rating IS NULL) AS unlearned, COALESCE(SUM(reps.n), 0) AS reps,"
        f" SUM(c.stage >= {srs.MATURE_STAGE}) AS mature"
        " FROM cards c LEFT JOIN last_rating l ON l.card_id = c.id LEFT JOIN reps ON reps.card_id = c.id"
        f" {where} GROUP BY {group_cols}"
    )
    out = []
    for r in conn.execute(sql, params).fetchall():
        out.append(_finish(dict(r)))
    return out


def _finish(d: dict) -> dict:
    total = d.get("total") or 0
    for k in ("good", "fair", "again", "unlearned", "reps", "mature"):
        d[k] = d.get(k) or 0
    d["total"] = total
    d["avg_reps"] = round(d["reps"] / total, 2) if total else 0.0
    d["mature_rate"] = round(d["mature"] / total, 4) if total else 0.0
    return d


def _empty(**keys) -> dict:
    return _finish({**keys, "total": 0})


def by_subject(conn: sqlite3.Connection) -> dict:
    """科目別の集計。カードのない科目も 0 で並べる。最後に合計。"""
    found = {r["subject"]: r for r in _group_rows(conn, "c.subject")}
    rows = [found.get(s) or _empty(subject=s) for s in SUBJECTS]
    known = set(SUBJECTS)
    rows += [r for s, r in found.items() if s not in known]  # 万一の科目外データ
    total = _finish({k: sum(r[k] for r in rows) for k in ("total", "good", "fair", "again", "unlearned", "reps", "mature")})
    total["subject"] = "合計"
    return {"rows": rows, "total": total}


def by_unit(conn: sqlite3.Connection, subject: str = "") -> list[dict]:
    """系統別の集計（科目の表示順 → 系統名順）。系統が空のカードは「（未設定）」。"""
    if subject:
        rows = _group_rows(conn, "c.subject, c.unit", "WHERE c.subject = ?",
                           (check_subject(subject),))
    else:
        rows = _group_rows(conn, "c.subject, c.unit")
    order = {s: i for i, s in enumerate(SUBJECTS)}
    rows.sort(key=lambda r: (order.get(r["subject"], 99), r["unit"] == "", r["unit"]))
    return rows


def weak(conn: sqlite3.Connection, today: date, days: int = 14, min_again: int = 2, limit: int = 100) -> dict:
    """苦手リスト: 直近 days 日（今日を含む）に ✖ が min_again 回以上のカードと、✖ の多い系統。

    再確認での ✖ は数えない。学習状況をリセットしたカードはリセット後の評価だけを数える。
    """
    start = (today - timedelta(days=days - 1)).isoformat()
    end = today.isoformat()
    base = (
        "FROM reviews r JOIN cards c ON c.id = r.card_id"
        " WHERE r.is_recheck = 0 AND r.practice_session IS NULL AND r.id > c.reset_review_id"
        " AND r.review_date BETWEEN ? AND ?"
    )
    cards = conn.execute(
        "SELECT c.id, c.subject, c.unit, c.front, c.back, c.stage, c.due,"
        " SUM(r.rating = 'again') AS again, COUNT(*) AS reviews, MAX(CASE WHEN r.rating='again' THEN r.review_date END) AS last_again "
        f"{base} GROUP BY c.id HAVING again >= ? ORDER BY again DESC, last_again DESC, c.id LIMIT ?",
        (start, end, min_again, limit),
    ).fetchall()
    units = conn.execute(
        "SELECT c.subject, c.unit, SUM(r.rating = 'again') AS again, COUNT(*) AS reviews,"
        " COUNT(DISTINCT CASE WHEN r.rating = 'again' THEN c.id END) AS again_cards "
        f"{base} GROUP BY c.subject, c.unit HAVING again >= 1 ORDER BY again DESC, reviews ASC LIMIT ?",
        (start, end, limit),
    ).fetchall()
    unit_rows = []
    for r in units:
        d = dict(r)
        d["again_rate"] = round(d["again"] / d["reviews"], 4) if d["reviews"] else 0.0
        unit_rows.append(d)
    return {"start": start, "end": end, "days": days, "min_again": min_again,
            "cards": [dict(r) for r in cards], "units": unit_rows}
