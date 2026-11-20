import unittest

from tests import helpers  # noqa: F401
from flashcards import cloze
from flashcards.bulk import parse_bulk


class ClozeTest(unittest.TestCase):
    def test_question_hides_all(self):
        t = "{{c1::β1}}受容体刺激で心拍数は{{c2::増加::増減}}する"
        q = cloze.render_question(t)
        self.assertNotIn("β1", q)
        self.assertNotIn("増加", q)
        self.assertIn('<span class="cloze">[&hellip;]</span>', q)
        self.assertIn('<span class="cloze">[増減]</span>', q)

    def test_answer_shows_words(self):
        a = cloze.render_answer("{{c1::β1}}受容体は{{c1::心臓::臓器}}")
        self.assertIn('<span class="cloze-ans">β1</span>', a)
        self.assertIn('<span class="cloze-ans">心臓</span>', a)
        self.assertNotIn("臓器", a)

    def test_escape_and_newline(self):
        self.assertEqual(cloze.render_question("<b>\n{{c1::<i>}}"),
                         '&lt;b&gt;<br><span class="cloze">[&hellip;]</span>')
        self.assertEqual(cloze.render_answer("{{c1::a<b}}"), '<span class="cloze-ans">a&lt;b</span>')

    def test_plain_and_has(self):
        self.assertEqual(cloze.plain("{{c1::A::h}}と{{c2::B}}"), "AとB")
        self.assertTrue(cloze.has_cloze("x{{c3::y}}"))
        self.assertFalse(cloze.has_cloze("{{c::y}}"))
        self.assertFalse(cloze.has_cloze("ふつうの文"))


class BulkTest(unittest.TestCase):
    def test_parse(self):
        r = parse_bulk("表1\t裏1\n\n表2\t裏2\t続き\r\nタブなし\n{{c1::穴}}だけ\n\t裏だけ\n")
        self.assertEqual(r.cards, [("表1", "裏1"), ("表2", "裏2\t続き"), ("{{c1::穴}}だけ", "")])
        self.assertEqual([n for n, _ in r.errors], [4, 6])


if __name__ == "__main__":
    unittest.main()
