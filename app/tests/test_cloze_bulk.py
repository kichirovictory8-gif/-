import unittest

from tests import helpers  # noqa: F401
from flashcards import cloze
from flashcards.bulk import parse_bulk

M = {"3": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.1, "hint": "官能基"}]}


class ClozeTest(unittest.TestCase):
    def test_front_has_closed_clozes_with_answers(self):
        q = cloze.render_front("{{c1::β1}}受容体刺激で心拍数は{{c2::増加::増減}}する")
        self.assertEqual(q.count('class="cl"'), 2)
        self.assertIn('<span class="cl-q">[&hellip;]</span><span class="cl-a">β1</span>', q)
        self.assertIn('<span class="cl-q">[増減]</span><span class="cl-a">増加</span>', q)

    def test_escape_and_newline(self):
        q = cloze.render_front("<b>\n{{c1::<i>}}")
        self.assertTrue(q.startswith("&lt;b&gt;<br>"))
        self.assertIn('<span class="cl-a">&lt;i&gt;</span>', q)

    def test_images_and_masks(self):
        q = cloze.render_front("図\n[[img:3]]と[[img:4]]", M)
        self.assertIn('<span class="occ" data-img="3">', q)
        self.assertIn('left:10.000%;top:20.000%;width:30.000%;height:10.000%', q)
        self.assertIn('<span class="mask-hint">官能基</span>', q)
        self.assertIn('src="/api/images/4"', q)
        self.assertEqual(q.count('class="mask"'), 1)

    def test_back(self):
        b = cloze.render_back("説明 {{c1::語}}\n[[img:5]]")
        self.assertIn("説明 語<br>", b)
        self.assertIn('src="/api/images/5"', b)
        self.assertNotIn("mask", b)

    def test_plain_has_ids(self):
        self.assertEqual(cloze.plain("{{c1::A::h}}と{{c2::B}}[[img:9]]"), "AとB［画像］")
        self.assertTrue(cloze.has_cloze("x{{c3::y}}"))
        self.assertFalse(cloze.has_cloze("{{c::y}}"))
        self.assertFalse(cloze.has_cloze("[[img:3]]"))
        self.assertTrue(cloze.has_cloze("[[img:3]]", M))
        self.assertFalse(cloze.has_cloze("[[img:4]]", M))
        self.assertEqual(cloze.image_ids("[[img:2]]a[[img:1]][[img:2]]"), [2, 1])

    def test_normalize_masks(self):
        raw = {"3": [{"x": 0.5, "y": 0.5, "w": 0.2, "h": 0.2},
                     {"x": -1, "y": 0.1, "w": 3, "h": 0.1, "hint": " ヒ "},
                     {"x": 0.1, "y": 0.1, "w": 0.001, "h": 0.1}],
               "7": [{"x": 0, "y": 0, "w": 1, "h": 1}]}
        n = cloze.normalize_masks(raw, "[[img:3]]")
        self.assertEqual(list(n), ["3"])                 # 表面にない画像は捨てる
        self.assertEqual(n["3"][0], {"x": 0.0, "y": 0.1, "w": 1.0, "h": 0.1, "hint": "ヒ"})  # 上から順・範囲内に
        self.assertEqual(len(n["3"]), 2)                 # 小さすぎるものは捨てる
        self.assertEqual(cloze.normalize_masks('{"3": []}', "[[img:3]]"), {})
        with self.assertRaises(ValueError):
            cloze.normalize_masks({"3": [{"x": "a"}]}, "[[img:3]]")
        with self.assertRaises(ValueError):
            cloze.normalize_masks("[1]", "[[img:3]]")

    def test_remap(self):
        self.assertEqual(cloze.remap_images("[[img:1]]x[[img:2]]", {1: 10}), "[[img:10]]x[[img:2]]")


class BulkTest(unittest.TestCase):
    def test_parse(self):
        r = parse_bulk("表1\t裏1\n\n表2\t裏2\t続き\r\nタブなし\n{{c1::穴}}だけ\n\t裏だけ\n")
        self.assertEqual(r.cards, [("表1", "裏1"), ("表2", "裏2\t続き"), ("{{c1::穴}}だけ", "")])
        self.assertEqual([n for n, _ in r.errors], [4, 6])


if __name__ == "__main__":
    unittest.main()
