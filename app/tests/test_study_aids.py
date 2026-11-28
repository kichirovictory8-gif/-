"""過去問からのカード作成・テーマ別カバー率・メモ箱・あとで直す・要見直し。"""
import json
import unittest

from tests.helpers import make_store
from flashcards import db, io_json, past, srs

G, X = srs.GOOD, srs.AGAIN


class PastTest(unittest.TestCase):
    def setUp(self):
        self.st, self.clock = make_store()
        self.addCleanup(self.st.conn.close)

    def test_data_loaded(self):
        self.assertTrue(past.available())
        self.assertEqual(len(past._load()), 900)
        q = past.get("102-1")
        self.assertEqual((q["subject"], q["answer"]), ("物理", "2"))
        with self.assertRaises(KeyError):
            past.get("999-1")

    def test_themes(self):
        ts = past.themes("物理")
        self.assertTrue(all(t["subject"] == "物理" for t in ts))
        self.assertEqual(ts[0]["questions"], max(t["questions"] for t in ts))   # 出題数が多い順
        self.assertEqual(sum(t["questions"] for t in past.themes()), 900)
        self.assertEqual(past.themes()[0]["subject"], "物理")

    def test_search(self):
        r = past.search(self.st.conn, subject="物理", limit=5)
        self.assertEqual((r["total"], len(r["items"])), (50, 5))
        self.assertEqual(r["items"][0]["kai"], 111)                 # 新しい回から
        r = past.search(self.st.conn, q="ファクター")
        self.assertTrue(r["total"] >= 1 and all("ファクター" in (x["stem"] + "".join(x["options"]) + x["theme"]) for x in r["items"]))
        theme = past.get("102-1")["theme"]
        self.assertTrue(all(x["theme"] == theme for x in past.search(self.st.conn, theme=theme)["items"]))

    def test_draft_qa_and_made(self):
        d = past.draft("102-1", "qa")
        self.assertEqual((d["subject"], d["unit"], d["source"]), ("物理", past.get("102-1")["theme"], "hissu:102-1"))
        self.assertIn("1. ", d["front"])
        self.assertTrue(d["back"].startswith("正答：2. "))
        self.assertIn("（第102回 問1）", d["back"])
        self.assertEqual(d["tags"], ["過去問", "第102回"])
        self.assertTrue(any("□" in n for n in d["notes"]))
        cid = self.st.add_card(d["subject"], d["unit"], d["front"], d["back"], tags=d["tags"], source=d["source"])
        self.assertEqual(self.st.get_card(cid)["source"], "hissu:102-1")
        made = [x for x in past.search(self.st.conn, subject="物理", limit=100)["items"] if x["id"] == "102-1"][0]
        self.assertEqual(made["made"], 1)
        self.assertNotIn("102-1", [x["id"] for x in past.search(self.st.conn, subject="物理", hide_made=True, limit=100)["items"]])

    def test_draft_cloze(self):
        d = past.draft("102-4", "cloze")
        q = past.get("102-4")
        self.assertIn("{{c1::" + q["options"][int(q["answer"]) - 1], d["front"])
        self.assertNotIn("1. ", d["front"])
        no_opts = next(x for x in past._load() if not x["options"])
        with self.assertRaises(ValueError):
            past.draft(no_opts["id"], "cloze")
        d = past.draft(no_opts["id"], "qa")             # 選択肢がなくても qa は作れる
        self.assertTrue(d["back"].startswith("正答："))
        if no_opts["figure"]:
            self.assertTrue(any("図" in n for n in d["notes"]))
        with self.assertRaises(ValueError):
            past.draft("102-1", "other")

    def test_coverage(self):
        theme = past.get("102-1")["theme"]          # 物理のテーマ
        other = past.get("102-4")["theme"]
        self.st.add_card("物理", theme, "系統が一致", "x")
        self.st.add_card("物理", "", "タグが一致", "x", tags=[other])
        self.st.add_card("化学", theme, "科目が違うので数えない", "x")
        d = past.draft("103-5", "qa")
        self.st.add_card(d["subject"], "", d["front"], d["back"], source=d["source"])   # 過去問由来
        cov = past.coverage(self.st.conn, "物理")
        by = {t["theme"]: t["cards"] for t in cov["themes"]}
        self.assertEqual(by[theme], 2 if past.get("103-5")["theme"] == theme else 1)
        self.assertGreaterEqual(by[other], 1)
        s = cov["summary"]
        self.assertEqual(s["questions"], 50)
        self.assertGreater(s["rate"], 0)
        self.assertEqual(cov["by_subject"][0]["subject"], "物理")
        self.assertEqual(past.coverage(self.st.conn)["summary"]["questions"], 900)


class MemoFlagTest(unittest.TestCase):
    def setUp(self):
        self.st, self.clock = make_store()
        self.addCleanup(self.st.conn.close)

    def test_memos(self):
        a = self.st.add_memo("  β遮断薬の禁忌を確認  ", "薬理")
        b = self.st.add_memo("ヘンダーソン式")
        self.assertEqual(a["text"], "β遮断薬の禁忌を確認")
        self.assertEqual([m["id"] for m in self.st.list_memos()], [b["id"], a["id"]])
        with self.assertRaises(ValueError):
            self.st.add_memo("   ")
        with self.assertRaises(ValueError):
            self.st.add_memo("x", "数学")
        self.st.delete_memo(a["id"])
        with self.assertRaises(KeyError):
            self.st.get_memo(a["id"])

    def test_flag(self):
        cid = self.st.add_card("薬理", "", "A", "a", tags="頻出")
        self.assertEqual(self.st.set_flag(cid, True), ["あとで直す", "頻出"])
        self.assertEqual(self.st.set_flag(cid, True), ["あとで直す", "頻出"])   # 2回付けても1つ
        self.assertEqual(self.st.set_flag(cid, False), ["頻出"])


class LeechTest(unittest.TestCase):
    def setUp(self):
        self.st, self.clock = make_store()
        self.addCleanup(self.st.conn.close)
        self.cid = self.st.add_card("薬理", "", "A", "a")

    def fail(self, recheck_too=False):
        r = self.st.record_review(self.cid, X)
        if recheck_too:
            self.st.record_review(self.cid, X)    # 再確認の ✖（数えない）
        self.clock.advance(days=1)
        return r

    def tags(self):
        return self.st.get_card(self.cid)["tags"]

    def test_tag_after_threshold(self):
        self.assertEqual(db.LEECH_THRESHOLD, 4)
        for _ in range(3):
            self.assertFalse(self.fail(recheck_too=True)["leech"])
        self.st.record_review(self.cid, X, session="practice-0001")   # 練習の ✖（数えない）
        self.assertNotIn("要見直し", self.tags())
        self.assertTrue(self.fail()["leech"])
        self.assertIn("要見直し", self.tags())
        self.assertFalse(self.fail()["leech"])                          # 付いたあとは何もしない

    def test_removing_tag_restarts_count(self):
        for _ in range(4):
            self.fail()
        self.st.update_card(self.cid, "薬理", "", "A（作り直し）", "a", tags="")
        self.assertEqual(self.st.again_count(self.cid), 0)
        for _ in range(3):
            self.fail()
        self.assertNotIn("要見直し", self.tags())
        self.fail()
        self.assertIn("要見直し", self.tags())

    def test_reset_restarts_count(self):
        for _ in range(3):
            self.fail()
        self.st.reset_card(self.cid)
        self.assertEqual(self.st.again_count(self.cid), 0)

    def test_good_does_not_count(self):
        for _ in range(3):
            self.fail()
        self.st.record_review(self.cid, G)
        self.assertEqual(self.st.again_count(self.cid), 3)


class JsonTest(unittest.TestCase):
    def test_roundtrip(self):
        st, clock = make_store()
        self.addCleanup(st.conn.close)
        cid = st.add_card("物理", "", "A", "a", source="hissu:102-1")
        for _ in range(4):
            st.record_review(cid, X)
            clock.advance(days=1)
        st.update_card(cid, "物理", "", "A", "a", tags="")   # 要見直しを外す → 数え直し
        st.record_review(cid, X)
        st.add_memo("メモ1", "物理")
        data = json.loads(json.dumps(io_json.export_data(st.conn)))
        self.assertEqual(data["cards"][0]["leech_after_reviews"], 4)
        self.assertEqual(data["memos"][0]["text"], "メモ1")
        other, _ = make_store()
        self.addCleanup(other.conn.close)
        io_json.import_data(other.conn, data, "append")
        c = other.list_cards()["items"][0]
        self.assertEqual(c["source"], "hissu:102-1")
        self.assertEqual(other.again_count(c["id"]), 1)
        self.assertEqual(other.list_memos()[0]["subject"], "物理")
        io_json.import_data(other.conn, data, "replace")
        self.assertEqual(len(other.list_memos()), 1)


if __name__ == "__main__":
    unittest.main()
