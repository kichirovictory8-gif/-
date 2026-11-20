import unittest
from datetime import date, datetime

from tests import helpers  # noqa: F401  (パス設定)
from flashcards import srs

D = date(2026, 11, 20)


class IntervalTest(unittest.TestCase):
    def test_intervals(self):
        self.assertEqual(srs.INTERVALS, (1, 3, 7, 14, 30, 60, 120))
        self.assertEqual([srs.interval_for(s) for s in range(8)], [0, 1, 3, 7, 14, 30, 60, 120])
        self.assertEqual(srs.MATURE_STAGE, 5)
        with self.assertRaises(ValueError):
            srs.interval_for(8)

    def test_good_climbs_all_stages(self):
        stage, today, dues = 0, D, []
        for _ in range(9):
            stage, due = srs.apply_rating(stage, srs.GOOD, today)
            dues.append((due - today).days)
            today = due
        self.assertEqual(dues, [1, 3, 7, 14, 30, 60, 120, 120, 120])
        self.assertEqual(stage, 7)

    def test_fair_repeats_same_interval(self):
        self.assertEqual(srs.apply_rating(3, srs.FAIR, D), (3, date(2026, 11, 27)))
        self.assertEqual(srs.apply_rating(7, srs.FAIR, D), (7, date(2027, 3, 20)))

    def test_fair_on_new_is_tomorrow(self):
        self.assertEqual(srs.apply_rating(0, srs.FAIR, D), (0, date(2026, 11, 21)))

    def test_again_resets_to_new_tomorrow(self):
        for stage in range(8):
            self.assertEqual(srs.apply_rating(stage, srs.AGAIN, D), (0, date(2026, 11, 21)))

    def test_after_again_restarts_from_one_day(self):
        stage, due = srs.apply_rating(6, srs.AGAIN, D)
        stage, due = srs.apply_rating(stage, srs.GOOD, due)
        self.assertEqual((stage, (due - date(2026, 11, 21)).days), (1, 1))

    def test_unknown_rating(self):
        with self.assertRaises(ValueError):
            srs.apply_rating(0, "easy", D)

    def test_study_date_boundary_2am(self):
        self.assertEqual(srs.study_date(datetime(2026, 11, 21, 1, 59)), date(2026, 11, 20))
        self.assertEqual(srs.study_date(datetime(2026, 11, 21, 2, 0)), date(2026, 11, 21))
        self.assertEqual(srs.study_date(datetime(2026, 11, 20, 23, 59)), date(2026, 11, 20))
        self.assertEqual(srs.study_date(datetime(2027, 1, 1, 0, 30)), date(2026, 12, 31))


if __name__ == "__main__":
    unittest.main()
