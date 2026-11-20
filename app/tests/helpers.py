import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flashcards import db  # noqa: E402


class Clock:
    """テスト用の時計。advance() で日付を進める。"""

    def __init__(self, start: datetime):
        self.t = start

    def __call__(self) -> datetime:
        return self.t

    def advance(self, days=0, hours=0, minutes=0):
        self.t += timedelta(days=days, hours=hours, minutes=minutes)


def make_store(start=datetime(2026, 11, 20, 10, 0)):
    clock = Clock(start)
    conn = db.connect(":memory:")
    return db.Store(conn, clock), clock
