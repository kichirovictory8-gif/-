import unittest

from tests.helpers import make_store
from flashcards import srs

G, F, X = srs.GOOD, srs.FAIR, srs.AGAIN


class CardTest(unittest.TestCase):
    def setUp(self):
        self.st, self.clock = make_store()
        self.addCleanup(self.st.conn.close)

    def test_new_card_due_today(self):
        cid = self.st.add_card("薬理", "自律神経", "表", "裏")
        c = self.st.get_card(cid)
        self.assertEqual((c["stage"], c["due"], c["reps"], c["last_rating"]), (0, "2026-11-20", 0, None))

    def test_new_card_after_midnight_belongs_to_previous_day(self):
        self.clock.advance(hours=15, minutes=30)  # 11/21 01:30
        cid = self.st.add_card("薬理", "", "表", "裏")
        self.assertEqual(self.st.get_card(cid)["due"], "2026-11-20")

    def test_validation(self):
        with self.assertRaises(ValueError):
            self.st.add_card("数学", "", "表", "裏")
        with self.assertRaises(ValueError):
            self.st.add_card("薬理", "", "  ", "裏")
        with self.assertRaises(ValueError):
            self.st.add_card("薬理", "", "表", "")
        self.st.add_card("薬理", "", "{{c1::表}}", "")  # 穴埋めなら裏面なしで可

    def test_edit_delete(self):
        cid = self.st.add_card("薬理", "", "表", "裏")
        self.st.update_card(cid, "薬剤", "製剤", "表2", "裏2")
        c = self.st.get_card(cid)
        self.assertEqual((c["subject"], c["unit"], c["front"]), ("薬剤", "製剤", "表2"))
        self.st.record_review(cid, G)
        self.st.delete_card(cid)
        with self.assertRaises(KeyError):
            self.st.get_card(cid)
        self.assertEqual(self.st.conn.execute("SELECT COUNT(*) FROM reviews").fetchone()[0], 0)


class SessionTest(unittest.TestCase):
    def setUp(self):
        self.st, self.clock = make_store()
        self.addCleanup(self.st.conn.close)

    def test_order_oldest_due_first(self):
        a = self.st.add_card("薬理", "", "A", "a")
        self.clock.advance(days=1)
        b = self.st.add_card("薬理", "", "B", "b")
        self.st.conn.execute("UPDATE cards SET due='2026-11-01' WHERE id=?", (b,))
        self.assertEqual([r["id"] for r in self.st.due_cards()], [b, a])
        self.assertEqual(self.st.next_card()["card"]["id"], b)

    def test_good_schedule_and_history(self):
        cid = self.st.add_card("薬理", "", "A", "a")
        r = self.st.record_review(cid, G)
        self.assertEqual((r["stage"], r["due"]), (1, "2026-11-21"))
        with self.assertRaises(ValueError):  # 期日前は評価できない
            self.st.record_review(cid, G)
        self.clock.advance(days=5)  # 遅れて復習 → 評価日から数える
        r = self.st.record_review(cid, G)
        self.assertEqual((r["stage"], r["due"]), (2, "2026-11-28"))
        hist = self.st.card_history(cid)
        self.assertEqual([(h["review_date"], h["rating"]) for h in hist],
                         [("2026-11-25", G), ("2026-11-20", G)])

    def test_again_recheck_once_at_end(self):
        a = self.st.add_card("薬理", "", "A", "a")
        b = self.st.add_card("薬理", "", "B", "b")
        self.st.record_review(a, X)
        n = self.st.next_card()
        self.assertEqual((n["card"]["id"], n["kind"], n["remaining_due"], n["remaining_recheck"]), (b, "review", 1, 1))
        self.st.record_review(b, G)
        n = self.st.next_card()
        self.assertEqual((n["card"]["id"], n["kind"]), (a, "recheck"))
        r = self.st.record_review(a, X)  # 再確認での評価は間隔に影響しない
        self.assertTrue(r["recheck"])
        c = self.st.get_card(a)
        self.assertEqual((c["stage"], c["due"], c["reps"], c["last_rating"]), (0, "2026-11-21", 1, X))
        n = self.st.next_card()
        self.assertIsNone(n["card"])  # 再確認は1回だけ
        with self.assertRaises(ValueError):
            self.st.record_review(a, G)

    def test_recheck_good_does_not_change_stage(self):
        a = self.st.add_card("薬理", "", "A", "a")
        self.st.record_review(a, X)
        self.st.record_review(a, G)  # 再確認で ○
        c = self.st.get_card(a)
        self.assertEqual((c["stage"], c["due"], c["last_rating"]), (0, "2026-11-21", X))
        self.clock.advance(days=1)
        r = self.st.record_review(a, G)
        self.assertEqual((r["stage"], r["due"], r["recheck"]), (1, "2026-11-22", False))

    def test_recheck_expires_next_day(self):
        a = self.st.add_card("薬理", "", "A", "a")
        self.st.record_review(a, X)
        self.clock.advance(days=1)
        n = self.st.next_card()
        self.assertEqual((n["kind"], n["remaining_recheck"]), ("review", 0))

    def test_subject_filter(self):
        a = self.st.add_card("薬理", "", "A", "a")
        b = self.st.add_card("衛生", "", "B", "b")
        self.assertEqual(self.st.next_card("衛生")["card"]["id"], b)
        self.st.record_review(b, X)
        n = self.st.next_card("衛生")
        self.assertEqual((n["kind"], n["card"]["id"]), ("recheck", b))
        self.assertEqual(self.st.next_card("薬理")["card"]["id"], a)

    def test_reset(self):
        a = self.st.add_card("薬理", "", "A", "a")
        self.st.record_review(a, G)
        self.clock.advance(days=1)
        self.st.record_review(a, G)
        self.st.reset_card(a)
        c = self.st.get_card(a)
        self.assertEqual((c["stage"], c["due"], c["reps"], c["last_rating"]), (0, "2026-11-21", 0, None))
        self.assertEqual(len(self.st.card_history(a)), 2)  # 履歴は残る
        self.st.record_review(a, F)
        self.assertEqual(self.st.get_card(a)["reps"], 1)


class ListTest(unittest.TestCase):
    def setUp(self):
        self.st, self.clock = make_store()
        self.addCleanup(self.st.conn.close)
        self.a = self.st.add_card("薬理", "自律神経", "アドレナリン {{c1::β1}}", "")
        self.b = self.st.add_card("薬理", "中枢", "ベンゾジアゼピン", "GABA_A")
        self.c = self.st.add_card("衛生", "栄養", "ビタミン 100%", "x")
        self.st.record_review(self.a, G)
        self.st.record_review(self.b, X)

    def ids(self, **kw):
        return [c["id"] for c in self.st.list_cards(**kw)["items"]]

    def test_filters(self):
        self.assertEqual(self.ids(subject="薬理", sort="old"), [self.a, self.b])
        self.assertEqual(self.ids(level="new"), [self.c])
        self.assertEqual(self.ids(level="good"), [self.a])
        self.assertEqual(self.ids(level="again"), [self.b])
        self.assertEqual(self.ids(due="due"), [self.c])
        self.assertEqual(sorted(self.ids(due="next7")), [self.a, self.b])
        self.assertEqual(self.ids(q="β1"), [self.a])
        self.assertEqual(self.ids(q="GABA_"), [self.b])
        self.assertEqual(self.ids(q="100%"), [self.c])
        self.assertEqual(self.ids(q="_"), [self.b])
        self.assertEqual(self.ids(q="中枢"), [self.b])
        self.assertEqual(self.ids(unit="栄養"), [self.c])
        self.assertEqual(self.st.list_cards(limit=1)["total"], 3)


if __name__ == "__main__":
    unittest.main()
