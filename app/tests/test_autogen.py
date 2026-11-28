"""自動生成（材料・苦手テーマ・作り方の学習・追加と破棄）と、認知負荷を減らす機能（C1 C2 C3 C5 C6）。"""
import json
import unittest
from datetime import datetime

from tests.helpers import make_store
from flashcards import cloze, db, gen, io_json, past, srs

X, G = srs.AGAIN, srs.GOOD
THEME = ("薬理", "自律神経作用薬")


def seed_weak(st, clock, theme=THEME, n_again=3):
    """そのテーマのカードで ✖ を重ねて、演習結果のある苦手テーマにする。"""
    cid = st.add_card(theme[0], theme[1], "演習用のカード", "x")
    for _ in range(n_again):
        st.record_review(cid, X)
        clock.advance(days=1)
    return cid


class CandidateTest(unittest.TestCase):
    def test_candidates(self):
        text = "β1受容体を刺激すると心拍数は増加し、半減期は6時間、ジゴキシンを使う"
        spans = {text[s:e]: k for s, e, k in gen.candidates(text)}
        self.assertEqual(spans.get("β1受容体"), "compound")
        self.assertEqual(spans.get("6時間"), "num")
        self.assertEqual(spans.get("ジゴキシン"), "kata")
        self.assertEqual(spans.get("心拍数"), "kanji")

    def test_features(self):
        t = "有効半減期：1/Te"
        f = gen.features(t, 6, len(t), "latin")
        self.assertIn("after_sep", f)
        self.assertIn("pos=tail", f)


class StyleTest(unittest.TestCase):
    def setUp(self):
        self.st, self.clock = make_store()
        self.addCleanup(self.st.conn.close)

    def chosen_words(self, text, **kw):
        style = gen.Style(self.st.conn)
        return [text[s:e] for _, s, e, _, _ in style.choose(text, **kw)], style

    def test_prior_without_cards(self):
        words, style = self.chosen_words("テクネチウムの半減期は6時間")
        self.assertEqual((style.alpha, style.target_holes, style.n_pos), (0, 1, 0))
        self.assertEqual(len(words), 1)

    def test_learns_number_preference(self):
        for i in range(40):   # いつも数値を穴にする人
            self.st.add_card("物理", "", f"薬物{i}アミノの濃度は{{{{c1::{i + 2}mg}}}}で、作用はキナーゼ阻害", "")
        words, style = self.chosen_words("テクネチウムの半減期は6時間で、ガンマ線を出す")
        self.assertGreater(style.alpha, 0.5)
        self.assertEqual(words, ["6時間"])

    def test_learns_katakana_preference(self):
        for i in range(40):   # いつもカタカナの薬物名を穴にする人
            self.st.add_card("薬理", "", f"{{{{c1::アトロピン{chr(0x30A2 + i % 20)}}}}}は{i + 2}mgで使う", "")
        words, _ = self.chosen_words("テクネチウムの半減期は6時間")
        self.assertEqual(words, ["テクネチウム"])

    def test_alpha_grows_gradually(self):
        alphas = []
        for n in (0, 5, 30):
            while self.st.conn.execute("SELECT COUNT(*) FROM cards").fetchone()[0] < n:
                self.st.add_card("薬理", "", "{{c1::アトロピン}}を使う", "")
            alphas.append(gen.Style(self.st.conn).alpha)
        self.assertTrue(alphas[0] < alphas[1] < alphas[2] < 1)

    def test_holes_and_hints_follow_user(self):
        for _ in range(10):
            self.st.add_card("薬理", "", "{{c1::アトロピン::薬}}は{{c1::ムスカリン::受容体}}受容体を{{c1::遮断::作用}}", "")
        style = gen.Style(self.st.conn)
        self.assertEqual((style.target_holes, style.use_hints), (3, True))

    def test_answer_span_is_preferred(self):
        t = "Gi タンパク質共役型受容体：アドレナリン α2受容体"
        words, _ = self.chosen_words(t, answer=(t.index("：") + 1, len(t)))
        self.assertIn("アドレナリン α2受容体", words)


class FactsTest(unittest.TestCase):
    def test_facts(self):
        facts = gen.facts_for(*THEME)
        kinds = {f["kind"] for f in facts}
        self.assertTrue({"past_q", "past_rev", "note"} <= kinds)
        q = next(f for f in facts if f["kind"] == "past_q")
        s, e = q["answer"]
        self.assertEqual(q["text"][s - 1], "：")
        self.assertTrue(q["back"].startswith("出典：第"))
        for f in facts:   # 否定形の問題は使わない
            if f["kind"].startswith("past"):
                self.assertFalse(gen.NEG_RE.search(past.get(f["qid"])["stem"]))
        self.assertEqual(len({f["key"] for f in facts}), len(facts))


class RunTest(unittest.TestCase):
    def setUp(self):
        self.st, self.clock = make_store()
        self.addCleanup(self.st.conn.close)

    def run_gen(self, trigger="manual"):
        return gen.run(self.st.conn, self.st.now(), self.st.today(), trigger)

    def test_no_results_no_generation(self):
        self.st.add_card(*THEME, "未演習のカード", "x")
        self.assertEqual(self.run_gen()["skipped"], "no_results")

    def test_weak_themes(self):
        seed_weak(self.st, self.clock)
        other = self.st.add_card("衛生", "環境衛生", "得意なカード", "x")
        self.st.record_review(other, G)
        w = gen.weak_themes(self.st.conn, self.st.today())
        self.assertEqual((w[0]["subject"], w[0]["theme"]), THEME)
        self.assertEqual(w[0]["again"], 3)
        self.assertEqual({(x["subject"], x["theme"]) for x in w}, {THEME, ("衛生", "環境衛生")})

    def test_daily_and_limits(self):
        seed_weak(self.st, self.clock)
        r = self.run_gen("daily")
        self.assertTrue(0 < r["created"] <= gen.DAILY_LIMIT)
        self.assertEqual(self.run_gen("daily")["skipped"], "today")             # 1日1回
        made = r["created"]
        r2 = self.run_gen("session")
        self.assertEqual(made + r2["created"], min(gen.DAILY_LIMIT, made + r2["created"]))   # 1日10枚まで
        rows = self.st.list_generated()
        self.assertTrue(all(x["unit"] == THEME[1] and x["status"] == "pending" for x in rows))
        self.assertTrue(all(cloze.has_cloze(x["front"]) for x in rows))
        self.assertTrue(all(cloze.count_holes(x["front"]) <= gen.MAX_HOLES for x in rows))
        keys = [r[0] for r in self.st.conn.execute("SELECT fact_key FROM generated")]
        self.assertEqual(len(keys), len(set(keys)))                               # 同じ知識からは1枚
        before = gen.pending_count(self.st.conn)
        self.run_gen("manual")                                                    # ボタンは1日の上限なし
        self.assertGreater(gen.pending_count(self.st.conn), before)

    def test_pending_limit(self):
        seed_weak(self.st, self.clock)
        for _ in range(5):
            self.run_gen("manual")
        self.assertLessEqual(gen.pending_count(self.st.conn), gen.PENDING_LIMIT)
        if gen.pending_count(self.st.conn) == gen.PENDING_LIMIT:
            self.assertEqual(self.run_gen("manual")["skipped"], "pending_limit")

    def test_add_and_discard(self):
        seed_weak(self.st, self.clock)
        self.run_gen()
        rows = self.st.list_generated()
        a, b, c = rows[0], rows[1], rows[2]
        ids = self.st.add_generated(a["id"])
        card = self.st.get_card(ids[0])
        self.assertEqual((card["tags"], card["source"]), (["自動生成"], "gen:" + a["fact_key"]))
        edited = cloze.plain(b["front"]) + "（直した）"
        self.st.add_generated(b["id"], front="{{c1::" + edited + "}}", tags="頻出")
        self.st.discard_generated(c["id"], "position")
        with self.assertRaises(ValueError):
            self.st.discard_generated(c["id"], "easy")          # 2回は決められない
        with self.assertRaises(ValueError):
            self.st.discard_generated(rows[3]["id"], "bogus")
        status = dict(self.st.conn.execute("SELECT id, status FROM generated WHERE id IN (?, ?, ?)", (a["id"], b["id"], c["id"])).fetchall())
        self.assertEqual(status, {a["id"]: "added", b["id"]: "added", c["id"]: "discarded"})
        spans_b = json.loads(self.st.conn.execute("SELECT spans FROM generated WHERE id = ?", (b["id"],)).fetchone()[0])
        self.assertTrue(all(sp["kept"] is False for sp in spans_b))   # 直して外した穴は負例になる
        self.assertEqual(gen.pending_count(self.st.conn), len(rows) - 3)

    def test_position_discards_lower_score(self):
        seed_weak(self.st, self.clock)
        self.run_gen()
        rows = self.st.list_generated()
        sp = json.loads(self.st.conn.execute("SELECT spans FROM generated WHERE id = ?", (rows[0]["id"],)).fetchone()[0])[0]
        before = gen.Style(self.st.conn).score(sp["features"])
        for r in rows:
            self.st.discard_generated(r["id"], "position")
        self.assertLess(gen.Style(self.st.conn).score(sp["features"]), before)

    def test_skips_known_facts(self):
        seed_weak(self.st, self.clock)
        for f in gen.facts_for(*THEME):     # その知識のカードがすでにあれば作らない
            self.st.add_card(THEME[0], "", f["text"], "x")
        self.assertEqual(self.run_gen()["created"], 0)


class LoadTest(unittest.TestCase):
    def setUp(self):
        self.st, self.clock = make_store()
        self.addCleanup(self.st.conn.close)

    def test_c1_hint_fades(self):
        t = "{{c1::アトロピン::薬物名}}"
        self.assertIn("[薬物名]", cloze.render_front(t))
        self.assertIn("[薬物名]", cloze.render_front(t, stage=3))
        self.assertNotIn("薬物名", cloze.render_front(t, stage=4))
        m = {"1": [{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2, "hint": "OH"}]}
        self.assertNotIn("OH", cloze.render_front("[[img:1]]", m, stage=5))
        cid = self.st.add_card("薬理", "", t, "")
        self.st.conn.execute("UPDATE cards SET stage = 5 WHERE id = ?", (cid,))
        self.assertNotIn("薬物名", self.st.get_card(cid)["question_html"])

    def test_c5_steps(self):
        t = "問題\n{{s1::式を立てる}}\n{{s2::代入する}}\n{{s3::計算する}}"
        self.assertEqual([cloze.hidden_steps(3, s) for s in (0, 1, 2, 3, 4, 7)], [1, 1, 2, 2, 3, 3])
        h0 = cloze.render_front(t, stage=0)
        self.assertEqual(h0.count('class="cl step"'), 1)
        self.assertIn('<span class="step-shown">式を立てる</span>', h0)
        self.assertIn('<span class="cl-a">計算する</span>', h0)             # 最後の手順から隠す
        self.assertEqual(cloze.render_front(t, stage=4).count('class="cl step"'), 3)
        self.assertTrue(cloze.has_cloze(t))
        self.assertEqual(cloze.plain(t), "問題\n式を立てる\n代入する\n計算する")
        self.assertEqual(cloze.count_holes(t), 1)
        self.st.add_card("薬剤", "", t, "")                                   # 手順だけでも裏面は省略可

    def test_c2_split(self):
        t = "{{c1::A}}と{{c1::B}}と{{c1::C}}と{{c1::D}}"
        m = {"7": [{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}, {"x": 0.5, "y": 0.5, "w": 0.2, "h": 0.2}]}
        self.assertEqual(cloze.count_holes(t + "[[img:7]]", m), 6)
        parts = cloze.split_units(t + "[[img:7]]", m)
        self.assertEqual(len(parts), 6)
        self.assertEqual(parts[1][0], "Aと{{c1::B}}とCとD[[img:7]]")
        self.assertEqual(parts[4], ("AとBとCとD[[img:7]]", {"7": [m["7"][0]]}))
        ids = self.st.split_add("薬理", "u", t, "裏", None, "頻出")
        self.assertEqual(len(ids), 4)
        self.assertEqual(self.st.get_card(ids[3])["front"], "AとBとCと{{c1::D}}")
        self.assertEqual(self.st.get_card(ids[0])["tags"], ["頻出"])
        with self.assertRaises(ValueError):
            self.st.split_add("薬理", "", "{{c1::A}}だけ", "", None)

    def test_c3_grouped_order(self):
        old = self.st.add_card("衛生", "環境衛生", "復習1", "x")
        old2 = self.st.add_card("物理", "放射化学", "復習2", "x")
        n1 = self.st.add_card("薬理", "中枢", "新規・薬理中枢", "x")
        n2 = self.st.add_card("物理", "熱力学", "新規・物理熱力学", "x")
        n3 = self.st.add_card("薬理", "中枢", "新規・薬理中枢2", "x")
        n4 = self.st.add_card("物理", "放射化学", "新規・物理放射", "x")
        for cid in (old, old2):
            self.st.record_review(cid, X)
        self.clock.advance(days=1)
        order = [r["id"] for r in self.st.due_cards(order="grouped")]
        self.assertEqual(set(order[:2]), {old, old2})                      # 復習が先（混ぜる）
        self.assertEqual(order[2:], [n4, n2, n1, n3])                        # 新規は科目・系統ごと

    def test_c6_note(self):
        cid = self.st.add_card("薬理", "", "A", "裏面")
        c = self.st.append_note(cid, "β1とβ2を取り違えた")
        self.assertTrue(c["back"].startswith("裏面\n\n💡 "))
        self.assertIn("β1とβ2を取り違えた", c["back"])
        with self.assertRaises(ValueError):
            self.st.append_note(cid, "  ")


class GenJsonTest(unittest.TestCase):
    def test_roundtrip(self):
        st, clock = make_store()
        self.addCleanup(st.conn.close)
        seed_weak(st, clock)
        gen.run(st.conn, st.now(), st.today(), "manual")
        rows = st.list_generated()
        st.discard_generated(rows[0]["id"], "easy")
        data = json.loads(json.dumps(io_json.export_data(st.conn)))
        other, _ = make_store()
        self.addCleanup(other.conn.close)
        io_json.import_data(other.conn, data, "replace")
        self.assertEqual(gen.pending_count(other.conn), len(rows) - 1)
        self.assertEqual(other.conn.execute("SELECT reason FROM generated WHERE status='discarded'").fetchone()[0], "easy")


if __name__ == "__main__":
    unittest.main()
