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
        self.assertIsNone(bd.parse_offset("whenever"))
        self.assertIsNone(bd.parse_offset("Midnight local time"))

    def test_encoding_round_trip(self):
        for cid in ("accord", "glaistig-uaine", "p-hu-comti"):
            self.assertEqual(bd.decode_id(bd.encode_id(cid)), cid)
            self.assertNotIn(cid, bd.encode_id(cid))

    def test_cluster_values(self):
        self.assertEqual(bd.clean_cluster("The Mall Cluster"), "The Mall Cluster")
        for v in ("NONE", "none", "No", "-", "N/A"):
            self.assertEqual(bd.clean_cluster(v), bd.NO_CLUSTER)
        self.assertEqual(bd.clean_cluster(""), "")
        for v in ("Yes", "yes", "Y"):
            self.assertEqual(bd.clean_cluster(v), bd.UNNAMED_CLUSTER)

    def test_scrub_hides_names(self):
        cape = {"name": "Butcher XIV", "aliases": ["Quarrel"], "civilian": "",
                "description": "All former Butcher abilities; Quarrel never misses"}
        out = bd.scrub_description(cape)
        self.assertNotIn("Butcher", out)
        self.assertNotIn("Quarrel", out)


class Arcs(unittest.TestCase):
    def test_user_rules(self):
        P = bd.parse_first_seen
        self.assertEqual(P("Worm", "Interlude 12"), ("Worm", 12))
        self.assertEqual(P("Worm", "8.01"), ("Worm", 8))
        self.assertEqual(P("Worm", "Interlude 11h"), ("Worm", 11))
        self.assertEqual(P("Worm", "16.z"), ("Worm", 16))
        self.assertEqual(P("Ward", "Interlude 5x II "), ("Ward", 5))
        self.assertEqual(P("Glow-Worm", "P.3"), ("Glow-worm", 3))
        self.assertEqual(P("Ward", "P.2"), ("Glow-worm", 2))      # Glow-worm chapters filed under Ward
        self.assertEqual(P("Worm", "e.1"), ("Worm", "epilogue"))
        self.assertIsNone(P("Canon (unspecified)", "3.1"))
        self.assertIsNone(P("Worm", "sometime"))
        self.assertIsNone(P("Worm", ""))

    def test_order_runs_across_stories(self):
        rows = [("Worm", "30.1"), ("Worm", "e.2"), ("PRT Quest", "2.1"), ("Glow-worm", "P.1"), ("Ward", "1.1")]
        capes = [dict(id=str(i), name=str(i), _row=i, series=s, firstseen=f) for i, (s, f) in enumerate(rows)]
        bd.assign_arcs(capes, lambda w: None)
        orders = [c["arcOrder"] for c in capes]
        self.assertEqual(orders, sorted(orders))
        self.assertEqual(len(set(orders)), len(orders))
        self.assertEqual([c["arc"] for c in capes], ["Worm 30", "Worm epilogue", "PRT Quest 2", "Glow-worm P.1", "Ward 1"])


class Completeness(unittest.TestCase):
    def cape(self, **over):
        base = dict(name="Test", aliases=[], civilian="", description="", series="Worm", disposition="Hero",
                    type="Human", gender="Female", status="Alive", team="Wards", power="Thinker",
                    disputed=False, _problems=[], _row=2)
        base.update(over)
        return base

    def test_unknown_values_count_as_filled(self):
        c = self.cape(status="Unknown", disposition="Unknown")
        bd.mark_pools([c], lambda w: None)
        self.assertTrue(c["complete"])
        self.assertTrue(c["eligible"])

    def test_non_cape_is_complete_without_power_but_never_an_answer(self):
        c = self.cape(disposition="Non-cape", power="")
        bd.mark_pools([c], lambda w: None)
        self.assertTrue(c["complete"])
        self.assertFalse(c["eligible"])

    def test_missing_detail_is_incomplete(self):
        c = self.cape(gender="")
        bd.mark_pools([c], lambda w: None)
        self.assertFalse(c["complete"])
        self.assertFalse(c["eligible"])

    def test_lists_always_allow_unknown_and_non_cape(self):
        from openpyxl import Workbook
        wb = Workbook()
        ws = wb.active
        ws.title = "Lists"
        ws.append(["Disposition", "Status"])
        ws.append(["Hero", "Alive"])
        allowed = bd.read_lists(wb)
        self.assertTrue({"Unknown", "Non-cape"} <= allowed["disposition"])
        self.assertIn("Unknown", allowed["status"])


class LookAlikes(unittest.TestCase):
    FIELDS = ["disposition", "type", "gender", "status", "team", "power"]

    def cape(self, cid, group=None, **over):
        base = dict(id=cid, group=group or cid, name=cid.title(), disposition="Villain", type="Human",
                    gender="Male", status="Dead", team="Slaughterhouse Nine", power="Brute")
        base.update(over)
        return base

    def test_identical_capes_are_flagged(self):
        twins = bd.find_lineup_twins([self.cape("a"), self.cape("b"), self.cape("c", team="No team")], self.FIELDS)
        self.assertEqual(twins, {"a": ["B"], "b": ["A"]})

    def test_aliases_of_one_person_and_blanks_are_not_flagged(self):
        twins = bd.find_lineup_twins([self.cape("a"), self.cape("a2", group="a"),
                                      self.cape("x", gender=""), self.cape("y", gender="")], self.FIELDS)
        self.assertEqual(twins, {})

    def test_comparison_ignores_case_and_accents(self):
        twins = bd.find_lineup_twins([self.cape("a"), self.cape("b", team="slaughterhouse nine")], self.FIELDS)
        self.assertIn("a", twins)

    def test_real_workbook_lineup_pool_has_no_look_alikes(self):
        game = bd.build(bd.find_workbook(None), dt.datetime(2026, 10, 21, 12, tzinfo=UTC), write=False, quiet=True)
        fields = [c["field"] for c in game["clues"]]
        pool = [c for c in game["capes"] if "lineup" in c.get("pool", [])]
        twins = bd.find_lineup_twins([dict(c, group=c["group"]) for c in game["capes"]], fields)
        self.assertFalse([c["name"] for c in pool if c["id"] in twins])


class Schedule(unittest.TestCase):
    def test_history_is_frozen_when_pool_changes(self):
        today = dt.date(2026, 10, 18)
        pools = {m: [f"cape-{i}" for i in range(40)] for m in bd.MODES}
        first = bd.draw_schedule({}, pools, today, lambda w: None)
        later = today + dt.timedelta(days=10)
        smaller = {m: p[:20] for m, p in pools.items()}
        second = bd.draw_schedule(first, smaller, later, lambda w: None)
        for m in bd.MODES:
            # days 0..10, plus the frozen days ahead, keep their answers
            kept = 11 + bd.FREEZE_DAYS_AHEAD
            self.assertEqual(first["modes"][m][:kept], second["modes"][m][:kept])
            future = [bd.decode_id(t) for t in second["modes"][m][kept:]]
            self.assertTrue(set(future) <= set(smaller[m]))
        self.assertEqual(second["launch"], "2026-10-18")

    def test_redraw_replaces_past_days_and_bumps_edition(self):
        today = dt.date(2026, 10, 18)
        pools = {m: [f"cape-{i}" for i in range(40)] for m in bd.MODES}
        first = bd.draw_schedule({}, pools, today, lambda w: None)
        self.assertEqual(first["edition"], 1)
        later = today + dt.timedelta(days=2)
        again = bd.draw_schedule(first, pools, later, lambda w: None, redraw=True)
        self.assertEqual(again["edition"], 2)
        self.assertEqual(again["launch"], first["launch"])
        for m in bd.MODES:
            self.assertNotEqual(first["modes"][m][:10], again["modes"][m][:10])
        # a normal build afterwards keeps the new edition and its frozen days
        after = bd.draw_schedule(again, pools, later, lambda w: None)
        self.assertEqual(after["edition"], 2)
        for m in bd.MODES:
            self.assertEqual(after["modes"][m][:5], again["modes"][m][:5])

    def test_keep_through_redraws_only_later_days(self):
        today = dt.date(2026, 10, 18)
        pools = {m: [f"cape-{i}" for i in range(40)] for m in bd.MODES}
        first = bd.draw_schedule({}, pools, today, lambda w: None)
        later = today + dt.timedelta(days=3)
        again = bd.draw_schedule(first, pools, later, lambda w: None, keep_through=later)
        self.assertEqual(again["edition"], first["edition"])
        for m in bd.MODES:
            self.assertEqual(first["modes"][m][:4], again["modes"][m][:4])
            self.assertNotEqual(first["modes"][m][4:14], again["modes"][m][4:14])

    def test_no_quick_repeats(self):
        pools = {m: [f"cape-{i}" for i in range(30)] for m in bd.MODES}
        s = bd.draw_schedule({}, pools, dt.date(2026, 1, 1), lambda w: None)
        days = [bd.decode_id(t) for t in s["modes"]["lineup"]]
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
        self.assertEqual(fields[:6], ["disposition", "type", "gender", "status", "team", "power"])
        self.assertEqual(fields[6:], ["arc"])
        for mode, tokens in data["schedule"].items():
            self.assertGreater(len(tokens), 300)
            for t in tokens[:30]:
                cape = by_id[bd.decode_id(t)]
                self.assertIn(mode, cape["pool"])
                for f in (fields if mode == "lineup" else fields[:6]):   # Power file doesn't need the arc
                    self.assertTrue(cape.get(f), f"{cape['name']} lacks {f}")
        names = [bd.fold(c["name"]) for c in data["capes"]]
        self.assertEqual(len(names), len(set(names)), "duplicate cape names")
        self.assertIsInstance(game["_warnings"], list)


if __name__ == "__main__":
    unittest.main()
