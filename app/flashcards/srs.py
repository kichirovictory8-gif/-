"""復習スケジュール（固定間隔＋自己評価）の計算。

段階 stage:
    0      … 新規（未学習、または ✖ で戻されたカード）
    1〜7   … 間隔 1 / 3 / 7 / 14 / 30 / 60 / 120 日

評価:
    good  (○) … 次の段階へ（最大 7 = 120日）。期日 = 評価日 + 新しい段階の間隔
    fair  (△) … 段階そのまま。期日 = 評価日 + 今の段階の間隔（新規なら翌日）
    again (✖) … 段階 0 に戻し、期日 = 翌日

1日の区切りは午前2時（0:00〜1:59 は前日扱い）。
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

INTERVALS: tuple[int, ...] = (1, 3, 7, 14, 30, 60, 120)
MAX_STAGE = len(INTERVALS)
MATURE_DAYS = 30
#: 間隔が 30 日以上になる最初の段階（定着の判定に使う）
MATURE_STAGE = next(i + 1 for i, d in enumerate(INTERVALS) if d >= MATURE_DAYS)
DAY_BOUNDARY_HOUR = 2

GOOD, FAIR, AGAIN = "good", "fair", "again"
RATINGS = (GOOD, FAIR, AGAIN)
RATING_SYMBOL = {GOOD: "○", FAIR: "△", AGAIN: "✖"}


def interval_for(stage: int) -> int:
    """段階に対応する間隔（日）。新規(0)は 0。"""
    if not 0 <= stage <= MAX_STAGE:
        raise ValueError(f"段階が範囲外です: {stage}")
    return 0 if stage == 0 else INTERVALS[stage - 1]


def study_date(now: datetime | None = None, boundary_hour: int = DAY_BOUNDARY_HOUR) -> date:
    """学習上の「今日」。午前 boundary_hour 時より前は前日として扱う。"""
    now = now or datetime.now()
    return (now - timedelta(hours=boundary_hour)).date()


def apply_rating(stage: int, rating: str, today: date) -> tuple[int, date]:
    """評価後の (新しい段階, 次の期日) を返す。"""
    interval_for(stage)  # 範囲チェック
    if rating == GOOD:
        new_stage = min(stage + 1, MAX_STAGE)
        return new_stage, today + timedelta(days=interval_for(new_stage))
    if rating == FAIR:
        days = interval_for(stage) if stage > 0 else 1
        return stage, today + timedelta(days=days)
    if rating == AGAIN:
        return 0, today + timedelta(days=1)
    raise ValueError(f"不明な評価です: {rating!r}")
