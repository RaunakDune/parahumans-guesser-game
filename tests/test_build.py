import datetime as dt
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import build_data as bd  # noqa: E402

UTC = dt.timezone.utc


class Helpers(unittest.TestCase):
    def test_fold_ignores_accents_and_spacing(self):
        self.assertEqual(bd.fold("Über"), bd.fold("Uber"))
        self.assertEqual(bd.fold("Silk Road"), bd.fold("Silkroad"))

    def test_offsets(self):
        self.assertEqual(bd.parse_offset("Midnight CET"), 60)
        self.assertEqual(bd.parse_offset("Midnight UTC"), 0)
        self.assertEqual(bd.parse_offset("Midnight UTC-5"), -300)
        self.assertEqual(bd.parse_offset("midnight cst"), -360)
        self.assertEqual(bd.parse_offset("whenever"), 60)

    def test_encoding_round_trip(self):
        for cid in ("accord", "glaistig-uaine", "p-hu-comti"):
            self.assertEqual(bd.decode_id(bd.encode_id(cid)), cid)
            self.assertNotIn(cid, bd.encode_id(cid))

    def test_scrub_hides_names(self):
        cape = {"name": "Butcher XIV", "aliases": ["Quarrel"], "civilian": "",
                "description": "All former Butcher abilities; Quarrel never misses"}
        out = bd.scrub_description(cape)
        self.assertNotIn("Butcher", out)
        self.assertNotIn("Quarrel", out)


class Schedule(unittest.TestCase):
    def test_history_is_frozen_when_pool_changes(self):
        today = dt.date(2026, 10, 18)
        pools = {m: [f"cape-{i}" for i in range(40)] for m in bd.MODES}
        first = bd.draw_schedule({}, pools, today, lambda w: None)
        later = today + dt.timedelta(days=10)
        smaller = {m: p[:20] for m, p in pools.items()}
        second = bd.draw_schedule(first, smaller, later, lambda w: None)
        for m in bd.MODES:
            # days 0..10 (+1 frozen ahead) keep their answers
            self.assertEqual(first["modes"][m][:12], second["modes"][m][:12])
            future = [bd.decode_id(t) for t in second["modes"][m][12:]]
            self.assertTrue(set(future) <= set(smaller[m]))
        self.assertEqual(second["launch"], "2026-10-18")

    def test_no_quick_repeats(self):
        pools = {m: [f"cape-{i}" for i in range(30)] for m in bd.MODES}
        s = bd.draw_schedule({}, pools, dt.date(2026, 1, 1), lambda w: None)
        days = [bd.decode_id(t) for t in s["modes"]["dossier"]]
        for i in range(15, len(days)):
            self.assertNotIn(days[i], days[i - 15:i])


class RealWorkbook(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self._paths = (bd.SCHEDULE_PATH, bd.OUT_PATH)
        bd.SCHEDULE_PATH = self.tmp / "schedule.json"
        bd.OUT_PATH = self.tmp / "game.json"

    def tearDown(self):
        bd.SCHEDULE_PATH, bd.OUT_PATH = self._paths
        shutil.rmtree(self.tmp)

    def test_builds_and_answers_are_complete(self):
        game = bd.build(bd.find_workbook(None), dt.datetime(2026, 10, 18, 12, tzinfo=UTC), quiet=True)
        data = json.loads(bd.OUT_PATH.read_text(encoding="utf-8"))
        self.assertEqual(data["title"], "Wormdle")
        by_id = {c["id"]: c for c in data["capes"]}
        fields = [c["field"] for c in data["clues"]]
        self.assertEqual(len(fields), 6)
        for mode, tokens in data["schedule"].items():
            self.assertGreater(len(tokens), 300)
            for t in tokens[:30]:
                cape = by_id[bd.decode_id(t)]
                self.assertIn(mode, cape["pool"])
                for f in fields:
                    self.assertTrue(cape.get(f), f"{cape['name']} lacks {f}")
        names = [bd.fold(c["name"]) for c in data["capes"]]
        self.assertEqual(len(names), len(set(names)), "duplicate cape names")
        self.assertIsInstance(game["_warnings"], list)


if __name__ == "__main__":
    unittest.main()
