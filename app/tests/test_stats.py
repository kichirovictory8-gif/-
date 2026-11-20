import unittest
from datetime import date

from tests.helpers import make_store
from flashcards import srs, stats

G, F, X = srs.GOOD, srs.FAIR, srs.AGAIN


class DashboardTest(unittest.TestCase):
    def setUp(self):
        self.st, self.clock = make_store()
        self.addCleanup(self.st.conn.close)

    def dash(self):
        return stats.dashboard(self.st.conn, self.st.today())

    def test_empty(self):
        d = self.dash()
        self.assertEqual((d["total"], d["due_today"], d["reviewed_today"], d["streak"]), (0, 0, 0, 0))
        self.assertEqual(len(d["recent"]), 14)
        self.assertEqual([f["date"] for f in d["forecast"]][:2], ["2026-11-20", "2026-11-21"])
        self.assertEqual([s["interval"] for s in d["stages"]], [0, 1, 3, 7, 14, 30, 60, 120])

    def test_counts(self):
        a = self.st.add_card("薬理", "", "A", "a")
        b = self.st.add_card("薬理", "", "B", "b")
        c = self.st.add_card("薬理", "", "C", "c")
        self.st.add_card("薬理", "", "D", "d")
        self.st.conn.execute("UPDATE cards SET due='2026-11-10' WHERE id=?", (c,))
        self.st.record_review(a, G)   # → 11/21
        self.st.record_review(b, X)   # → 11/21, 再確認待ち
        self.st.record_review(b, X)   # 再確認（数えない）
        d = self.dash()
        self.assertEqual(d["due_today"], 2)        # c（期限切れ）と D
        self.assertEqual(d["overdue"], 1)
        self.assertEqual(d["reviewed_today"], 2)   # 再確認は含めない
        self.assertEqual(d["unlearned"], 2)
        self.assertEqual(d["streak"], 1)
        self.assertEqual({s["stage"]: s["count"] for s in d["stages"]}[0], 3)
        self.assertEqual({s["stage"]: s["count"] for s in d["stages"]}[1], 1)
        self.assertEqual(d["recent"][-1], {"date": "2026-11-20", G: 1, F: 0, X: 1})
        self.assertEqual([f["count"] for f in d["forecast"]], [2, 2, 0, 0, 0, 0, 0])
        due = {x["subject"]: x["count"] for x in d["due_by_subject"]}
        self.assertEqual((due["薬理"], due["物理"], len(due)), (2, 0, 9))

    def test_streak(self):
        a = self.st.add_card("薬理", "", "A", "a")
        for _ in range(3):  # 11/20, 11/21, 11/22 に毎日学習（✖ で毎日期日にする）
            self.st.record_review(a, X)
            self.clock.advance(days=1)
        # 11/23: まだ今日は学習していない → 昨日までの 3 日
        self.assertEqual(stats.streak(self.st.conn, self.st.today()), 3)
        self.st.record_review(a, X)
        self.assertEqual(stats.streak(self.st.conn, self.st.today()), 4)
        self.clock.advance(days=2)  # 1日空いた
        self.assertEqual(stats.streak(self.st.conn, self.st.today()), 0)

    def test_streak_ignores_recheck_only_day_boundary(self):
        a = self.st.add_card("薬理", "", "A", "a")
        self.clock.advance(hours=15)          # 11/21 01:00 → 学習日は 11/20
        self.st.record_review(a, X)
        self.assertEqual(self.st.today(), date(2026, 11, 20))
        self.assertEqual(stats.streak(self.st.conn, self.st.today()), 1)


class GroupTest(unittest.TestCase):
    def setUp(self):
        self.st, self.clock = make_store()
        self.addCleanup(self.st.conn.close)
        st = self.st
        self.p1 = st.add_card("薬理", "自律神経", "1", "x")
        self.p2 = st.add_card("薬理", "自律神経", "2", "x")
        self.p3 = st.add_card("薬理", "中枢", "3", "x")
        self.p4 = st.add_card("薬理", "", "4", "x")
        self.h1 = st.add_card("衛生", "栄養", "5", "x")
        st.record_review(self.p1, G)
        st.record_review(self.p2, F)
        st.record_review(self.p3, X)
        st.record_review(self.p3, G)  # 再確認（数えない）
        # p1 を ○ で段階 5（30日）まで上げる
        for _ in range(4):
            self.clock.advance(days=srs.interval_for(st.get_card(self.p1)["stage"]))
            st.record_review(self.p1, G)

    def test_by_subject(self):
        res = stats.by_subject(self.st.conn)
        rows = {r["subject"]: r for r in res["rows"]}
        self.assertEqual([r["subject"] for r in res["rows"]][:3], ["物理", "化学", "生物"])
        self.assertEqual(len(res["rows"]), 9)
        p = rows["薬理"]
        self.assertEqual((p["total"], p["good"], p["fair"], p["again"], p["unlearned"]), (4, 1, 1, 1, 1))
        self.assertEqual(p["reps"], 7)          # p1:5 + p2:1 + p3:1
        self.assertEqual(p["avg_reps"], 1.75)
        self.assertEqual(p["mature"], 1)
        self.assertEqual(p["mature_rate"], 0.25)
        self.assertEqual(rows["物理"]["total"], 0)
        self.assertEqual(rows["物理"]["mature_rate"], 0.0)
        t = res["total"]
        self.assertEqual((t["total"], t["unlearned"], t["reps"], t["mature_rate"]), (5, 2, 7, 0.2))

    def test_by_unit(self):
        rows = stats.by_unit(self.st.conn, "薬理")
        self.assertEqual([r["unit"] for r in rows], ["中枢", "自律神経", ""])
        auto = rows[1]
        self.assertEqual((auto["total"], auto["good"], auto["fair"], auto["avg_reps"], auto["mature_rate"]),
                         (2, 1, 1, 3.0, 0.5))
        all_rows = stats.by_unit(self.st.conn)
        self.assertEqual([r["subject"] for r in all_rows][-1], "薬理")  # 衛生 → 薬理 の順
        self.assertEqual(all_rows[0]["subject"], "衛生")

    def test_reset_excluded(self):
        self.st.reset_card(self.p1)
        p = {r["subject"]: r for r in stats.by_subject(self.st.conn)["rows"]}["薬理"]
        self.assertEqual((p["good"], p["unlearned"], p["reps"], p["mature"]), (0, 2, 2, 0))


class WeakTest(unittest.TestCase):
    def setUp(self):
        self.st, self.clock = make_store()
        self.addCleanup(self.st.conn.close)

    def fail_days(self, cid, n):
        for _ in range(n):
            self.st.record_review(cid, X)
            self.clock.advance(days=1)

    def test_weak_cards_and_units(self):
        st = self.st
        a = st.add_card("薬理", "自律神経", "A", "a")
        b = st.add_card("薬理", "自律神経", "B", "b")
        c = st.add_card("衛生", "栄養", "C", "c")
        st.record_review(c, X)
        st.record_review(c, X)   # 再確認の ✖ は数えない
        self.fail_days(a, 3)     # 11/20〜22 に ✖ ×3（その後 11/23 に）
        self.clock.t = self.clock.t.replace(day=20)
        self.clock.advance(days=1)
        st.record_review(b, X)   # 11/21
        self.clock.advance(days=1)
        st.record_review(b, X)   # 11/22
        self.clock.t = self.clock.t.replace(day=23)
        w = stats.weak(st.conn, st.today(), days=14, min_again=2)
        self.assertEqual([x["id"] for x in w["cards"]], [a, b])
        self.assertEqual(w["cards"][0]["again"], 3)
        units = {(u["subject"], u["unit"]): u for u in w["units"]}
        self.assertEqual(units[("薬理", "自律神経")]["again"], 5)
        self.assertEqual(units[("薬理", "自律神経")]["again_cards"], 2)
        self.assertEqual(units[("衛生", "栄養")]["again"], 1)
        self.assertEqual(w["units"][0]["unit"], "自律神経")
        self.assertEqual(len(stats.weak(st.conn, st.today(), min_again=1)["cards"]), 3)

    def test_window(self):
        a = self.st.add_card("薬理", "", "A", "a")
        self.fail_days(a, 2)   # 11/20, 11/21
        self.clock.advance(days=12)  # 今日 = 12/4 → 14日の窓は 11/21〜12/4
        w = stats.weak(self.st.conn, self.st.today(), days=14, min_again=2)
        self.assertEqual(w["start"], "2026-11-21")
        self.assertEqual(w["cards"], [])
        self.assertEqual(stats.weak(self.st.conn, self.st.today(), days=14, min_again=1)["cards"][0]["again"], 1)


if __name__ == "__main__":
    unittest.main()
