"""タグ、学習の順番、練習（全カード）。"""
import json
import unittest

from tests.helpers import make_store
from flashcards import io_json, srs, stats
from flashcards.tags import normalize_tags

G, F, X = srs.GOOD, srs.FAIR, srs.AGAIN
SID = "practice-0001"


class NormalizeTest(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(normalize_tags("頻出  計算,第110回、頻出 #暗記"), ["頻出", "計算", "第110回", "暗記"])
        self.assertEqual(normalize_tags(["a b", "c"]), ["a", "b", "c"])
        self.assertEqual(normalize_tags(None), [])
        self.assertEqual(normalize_tags(""), [])
        with self.assertRaises(ValueError):
            normalize_tags("x" * 31)
        with self.assertRaises(ValueError):
            normalize_tags(" ".join(f"t{i}" for i in range(21)))


class TagStoreTest(unittest.TestCase):
    def setUp(self):
        self.st, self.clock = make_store()
        self.addCleanup(self.st.conn.close)
        self.a = self.st.add_card("薬理", "", "A", "a", tags="頻出 計算")
        self.b = self.st.add_card("薬理", "", "B", "b", tags=["頻出"])
        self.c = self.st.add_card("衛生", "", "C", "c")

    def test_tags_saved_and_listed(self):
        self.assertEqual(self.st.get_card(self.a)["tags"], ["計算", "頻出"])
        self.assertEqual(self.st.get_card(self.c)["tags"], [])
        self.assertEqual(self.st.all_tags(), [{"tag": "頻出", "n": 2}, {"tag": "計算", "n": 1}])
        self.assertEqual([c["id"] for c in self.st.list_cards(tag="計算")["items"]], [self.a])

    def test_update_tags(self):
        self.st.update_card(self.a, "薬理", "", "A2", "a")             # tags=None は変えない
        self.assertEqual(self.st.get_card(self.a)["tags"], ["計算", "頻出"])
        self.st.update_card(self.a, "薬理", "", "A2", "a", tags="暗記")
        self.assertEqual(self.st.get_card(self.a)["tags"], ["暗記"])
        self.st.update_card(self.a, "薬理", "", "A2", "a", tags="")
        self.assertEqual(self.st.get_card(self.a)["tags"], [])
        self.st.delete_card(self.b)
        self.assertEqual(self.st.all_tags(), [])

    def test_bulk_tags(self):
        ids = self.st.add_many("物理", "", [("x", "y"), ("z", "w")], tags="計算")
        self.assertTrue(all(self.st.get_card(i)["tags"] == ["計算"] for i in ids))

    def test_filter_or_and(self):
        ids = lambda **kw: [r["id"] for r in self.st.due_cards(order="added", **kw)]
        self.assertEqual(ids(tags="頻出 計算", tag_mode="or"), [self.a, self.b])
        self.assertEqual(ids(tags="頻出 計算", tag_mode="and"), [self.a])
        self.assertEqual(ids(tags="計算", subject="衛生"), [])
        self.assertEqual(ids(), [self.a, self.b, self.c])
        with self.assertRaises(ValueError):
            self.st.due_cards(tags="x", tag_mode="xor")
        self.assertEqual(self.st.session_counts(tags="頻出"), {"due": 2, "total": 2})


class OrderTest(unittest.TestCase):
    def setUp(self):
        self.st, self.clock = make_store()
        self.addCleanup(self.st.conn.close)
        self.ids = [self.st.add_card("薬理", "", f"{i}", "x") for i in range(6)]
        # 期日をばらばらに（id 順とは逆）
        for n, cid in enumerate(self.ids):
            self.st.conn.execute("UPDATE cards SET due = ? WHERE id = ?", (f"2026-11-{15 - n:02d}", cid))

    def order(self, o):
        return [r["id"] for r in self.st.due_cards(order=o)]

    def test_orders(self):
        self.assertEqual(self.order("due"), list(reversed(self.ids)))
        self.assertEqual(self.order("added"), self.ids)
        self.assertEqual(self.order("added_desc"), list(reversed(self.ids)))
        self.assertEqual(sorted(self.order("random")), self.ids)
        with self.assertRaises(ValueError):
            self.order("subject")
        self.assertEqual(self.st.next_card(order="added")["card"]["id"], self.ids[0])

    def test_recheck_still_last(self):
        self.st.record_review(self.ids[0], X)
        n = self.st.next_card(order="added")
        self.assertEqual((n["card"]["id"], n["kind"]), (self.ids[1], "review"))
        for cid in self.ids[1:]:
            self.st.record_review(cid, G)
        n = self.st.next_card(order="random")
        self.assertEqual((n["card"]["id"], n["kind"]), (self.ids[0], "recheck"))


class PracticeTest(unittest.TestCase):
    def setUp(self):
        self.st, self.clock = make_store()
        self.addCleanup(self.st.conn.close)
        self.a = self.st.add_card("薬理", "", "A", "a", tags="頻出")
        self.b = self.st.add_card("薬理", "", "B", "b", tags="頻出")
        self.c = self.st.add_card("薬理", "", "C", "c")
        self.st.record_review(self.a, G)   # a は期日が明日に（期日前のカード）

    def test_practice_flow(self):
        dash_before = stats.dashboard(self.st.conn, self.st.today())
        subj_before = stats.by_subject(self.st.conn)
        n = self.st.next_card(tags="頻出", order="added", session=SID)
        self.assertEqual((n["card"]["id"], n["kind"], n["remaining_due"]), (self.a, "practice", 2))  # 期日前も出る
        r = self.st.record_review(self.a, X, session=SID)
        self.assertEqual((r["stage"], r["due"], r["practice"]), (1, "2026-11-21", True))   # 間隔は変わらない
        with self.assertRaises(ValueError):
            self.st.record_review(self.b, G, session="bad id!")
        self.st.record_review(self.b, G, session=SID)
        n = self.st.next_card(tags="頻出", order="added", session=SID)
        self.assertEqual((n["card"]["id"], n["kind"]), (self.a, "recheck"))   # ✖ は最後に1回
        self.st.record_review(self.a, G, session=SID)
        self.assertIsNone(self.st.next_card(tags="頻出", session=SID)["card"])
        with self.assertRaises(ValueError):
            self.st.record_review(self.b, G, session=SID)
        # 集計・期日・通常の再確認には影響しない
        self.assertEqual(stats.dashboard(self.st.conn, self.st.today())["reviewed_today"], dash_before["reviewed_today"])
        self.assertEqual(stats.by_subject(self.st.conn), subj_before)
        self.assertEqual(self.st.get_card(self.b)["due"], "2026-11-20")
        self.assertEqual(self.st.pending_rechecks(), [])
        self.assertEqual(stats.weak(self.st.conn, self.st.today(), min_again=1)["cards"], [])
        hist = self.st.card_history(self.a)
        self.assertEqual([h["practice_session"] for h in hist], [SID, SID, None])

    def test_new_session_starts_over(self):
        self.st.record_review(self.a, G, session=SID)
        n = self.st.next_card(tags="頻出", order="added", session="practice-0002")
        self.assertEqual(n["remaining_due"], 2)

    def test_normal_review_after_practice(self):
        self.st.record_review(self.b, X, session=SID)   # 練習で ✖ にしても
        r = self.st.record_review(self.b, G)             # 通常の復習は普通にできる
        self.assertEqual((r["stage"], r["recheck"]), (1, False))


class TagJsonTest(unittest.TestCase):
    def test_roundtrip(self):
        st, _ = make_store()
        self.addCleanup(st.conn.close)
        a = st.add_card("薬理", "", "A", "a", tags="頻出 計算")
        st.record_review(a, G, session=SID)
        data = json.loads(json.dumps(io_json.export_data(st.conn)))
        self.assertEqual(data["cards"][0]["tags"], ["計算", "頻出"])
        self.assertEqual(data["cards"][0]["reviews"][0]["practice_session"], SID)
        other, _ = make_store()
        self.addCleanup(other.conn.close)
        io_json.import_data(other.conn, data, "append")
        c = other.list_cards()["items"][0]
        self.assertEqual((c["tags"], c["reps"]), (["計算", "頻出"], 0))   # 練習は周回に数えない
        self.assertEqual(other.card_history(c["id"])[0]["practice_session"], SID)
        data["cards"][0]["reviews"][0]["practice_session"] = "x y"
        with self.assertRaises(ValueError):
            io_json.import_data(other.conn, data, "append")


if __name__ == "__main__":
    unittest.main()
