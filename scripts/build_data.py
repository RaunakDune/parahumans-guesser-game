#!/usr/bin/env python3
"""Build Wormdle's data file from the Excel workbook in data/.

    python scripts/build_data.py            # build site/data/game.json
    python scripts/build_data.py --check    # validate only, write nothing
    python scripts/build_data.py --peek 7   # print the next 7 daily answers
    python scripts/build_data.py --redraw   # throw away every drawn day, past ones too,
                                            # and start a new edition of the schedule

The workbook in data/ is the single source of truth. Columns are found by
their heading text, so columns can be added or reordered freely.

The daily schedule is kept in data/schedule.json. Puzzles up to two days past
today (UTC) are frozen there, so updating the spreadsheet never changes an
answer that a player anywhere in the world may already be looking at. Days
further ahead are re-drawn from the current answer pool on every build.

--redraw is for when the sheet changes so much that past answers no longer
hold up. It bumps the schedule's edition number; the site sees the new
edition and clears players' old results.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import random
import re
import sys
import unicodedata
import warnings
from pathlib import Path

from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
SCHEDULE_PATH = DATA_DIR / "schedule.json"
OUT_PATH = ROOT / "site" / "data" / "game.json"

PREFERRED_WORKBOOK = "parahumandle_design.xlsx"
HORIZON_DAYS = 400          # how far ahead the schedule is drawn
FREEZE_DAYS_AHEAD = 2       # with local-midnight resets, players up to UTC+14 are a day ahead of UTC
SCHEDULE_KEY = b"brockton-bay"  # light obfuscation so answers aren't readable at a glance
MODES = ("lineup", "power")

# Logical field -> heading prefix in the Roster sheet (first matching column wins).
ROSTER_FIELDS = {
    "name": "cape name",
    "aliases": "aliases",
    "series": "series",
    "disposition": "disposition",
    "type": "type",
    "gender": "gender",
    "status": "status",
    "team": "team",
    "power": "power class",
    "hybrid": "hybrid",
    "rating": "prt rating",
    "disputed": "disputed",
    "civilian": "civilian name",
    "description": "power description",
}
REQUIRED_FIELDS = ("name", "series", "disposition", "type", "gender", "status", "team", "power")

# Clue Ladder label prefix -> roster field.
CLUE_FIELDS = {
    "disposition": "disposition",
    "type": "type",
    "gender": "gender",
    "status": "status",
    "team": "team",
    "power": "power",
}

# Lists sheet heading -> roster field whose values it constrains.
LIST_FIELDS = {
    "disposition": "disposition",
    "type": "type",
    "gender": "gender",
    "status": "status",
    "power class": "power",
    "series": "series",
}

# Values the game always accepts, on top of whatever the Lists sheet allows.
ALWAYS_ALLOWED = {
    "disposition": {"Unknown", "Non-cape"},
    "status": {"Unknown"},
    "gender": {"Unknown"},
}
NON_CAPE = "Non-cape"

POWER_CLASSES = ["Mover", "Shaker", "Brute", "Breaker", "Master", "Tinker",
                 "Blaster", "Thinker", "Striker", "Changer", "Trump", "Stranger"]

TZ_ABBREVIATIONS = {
    "UTC": 0, "GMT": 0, "CET": 60, "CEST": 120, "EET": 120, "BST": 60,
    "EST": -300, "EDT": -240, "CST": -360, "CDT": -300,
    "MST": -420, "MDT": -360, "PST": -480, "PDT": -420,
}


class BuildError(Exception):
    pass


# ---------------------------------------------------------------- helpers

def fold(text: str) -> str:
    """Accent-, case- and punctuation-insensitive key used for matching names."""
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", text.lower())


def clean(value) -> str:
    if value is None:
        return ""
    text = str(value).replace(" ", " ")
    text = re.sub(r"\s*\|\s*", " ", text)          # artefacts from PDF line breaks
    return re.sub(r"\s+", " ", text).strip()


def slug(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "cape"


def split_list(text: str) -> list[str]:
    return [p.strip() for p in re.split(r"[;,]", text) if p.strip()]


def find_workbook(explicit: str | None) -> Path:
    if explicit:
        path = Path(explicit)
        if not path.exists():
            raise BuildError(f"Workbook not found: {path}")
        return path
    books = sorted(p for p in DATA_DIR.glob("*.xlsx") if not p.name.startswith("~$"))
    if not books:
        raise BuildError(f"No .xlsx workbook found in {DATA_DIR}")
    preferred = DATA_DIR / PREFERRED_WORKBOOK
    if preferred in books:
        if len(books) > 1:
            print(f"note: using {preferred.name}; ignoring {[b.name for b in books if b != preferred]}")
        return preferred

    def version(p: Path):
        m = re.search(r"v(\d+)", p.stem)
        return (int(m.group(1)) if m else -1, p.stat().st_mtime)

    chosen = max(books, key=version)
    if len(books) > 1:
        print(f"note: several workbooks found, using the highest version: {chosen.name}")
    return chosen


def sheet(wb, name):
    for ws in wb.worksheets:
        if ws.title.strip().lower() == name.lower():
            return ws
    raise BuildError(f"The workbook has no '{name}' sheet")


def parse_offset(label: str) -> int | None:
    """'Midnight CET' -> 60, 'Midnight UTC-5' -> -300 (minutes east of UTC).
    'Midnight local time' (or anything unrecognised) -> None: each player's own midnight."""
    text = (label or "").upper()
    if "LOCAL" in text:
        return None
    m = re.search(r"(UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?", text)
    if m:
        minutes = int(m.group(3)) * 60 + int(m.group(4) or 0)
        return minutes if m.group(2) == "+" else -minutes
    for abbr, minutes in TZ_ABBREVIATIONS.items():
        if re.search(rf"\b{abbr}\b", text):
            return minutes
    return None


def game_date(now_utc: dt.datetime, offset_minutes: int | None) -> dt.date:
    """The puzzle date. With local resets, UTC stands in (the freeze window covers the spread)."""
    return (now_utc + dt.timedelta(minutes=offset_minutes or 0)).date()


def encode_id(cape_id: str) -> str:
    raw = cape_id.encode()
    mixed = bytes(b ^ SCHEDULE_KEY[i % len(SCHEDULE_KEY)] for i, b in enumerate(raw))
    return base64.b64encode(mixed).decode()


def decode_id(token: str) -> str:
    mixed = base64.b64decode(token)
    return bytes(b ^ SCHEDULE_KEY[i % len(SCHEDULE_KEY)] for i, b in enumerate(mixed)).decode()


# ---------------------------------------------------------------- reading

def read_lists(wb) -> dict[str, set[str]]:
    try:
        ws = sheet(wb, "Lists")
    except BuildError:
        return {}
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return {}
    allowed: dict[str, set[str]] = {}
    for col, heading in enumerate(rows[0]):
        field = LIST_FIELDS.get(clean(heading).lower())
        if not field:
            continue
        values = {clean(r[col]) for r in rows[1:] if col < len(r) and clean(r[col])}
        if values:
            allowed[field] = values
    for field, extra in ALWAYS_ALLOWED.items():
        if field in allowed:
            allowed[field] |= extra
    return allowed


def read_settings(wb, clue_count: int) -> dict:
    settings = {"free_first_clue": False, "max_guesses": clue_count + 1, "reset_label": "Midnight local time"}
    try:
        ws = sheet(wb, "Settings")
    except BuildError:
        return settings
    for row in ws.iter_rows(min_row=2, values_only=True):
        label = clean(row[0]).lower() if row else ""
        value = row[1] if len(row) > 1 else None
        if label.startswith("free first clue"):
            settings["free_first_clue"] = str(value).strip() in ("1", "1.0", "True", "Yes", "Y")
        elif label.startswith("max guesses") and isinstance(value, (int, float)) and value >= 1:
            settings["max_guesses"] = int(value)
        elif label.startswith("reset time") and clean(value):
            settings["reset_label"] = clean(value)
    # A free first clue doesn't change the guess count; the guess count can't be
    # smaller than the clues it has to carry.
    settings["max_guesses"] = max(settings["max_guesses"], 2)
    return settings


def read_clues(wb) -> list[dict]:
    ws = sheet(wb, "Clue Ladder")
    rows = list(ws.iter_rows(values_only=True))
    header = [clean(h).lower() for h in rows[0]]
    try:
        i_label = next(i for i, h in enumerate(header) if h == "clue")
    except StopIteration:
        raise BuildError("The 'Clue Ladder' sheet needs a 'Clue' column")
    i_order = next((i for i, h in enumerate(header) if h.startswith("unlocked")), None)
    i_rule = next((i for i, h in enumerate(header) if h.startswith("rule")), None)
    clues = []
    for r in rows[1:]:
        label = clean(r[i_label]) if i_label < len(r) else ""
        if not label:
            continue
        field = next((f for prefix, f in CLUE_FIELDS.items() if label.lower().startswith(prefix)), None)
        if not field:
            raise BuildError(f"Clue '{label}' doesn't match a Roster column "
                             f"(expected one of {', '.join(CLUE_FIELDS)})")
        order = r[i_order] if i_order is not None and isinstance(r[i_order], (int, float)) else len(clues) + 1
        clues.append({"field": field, "label": label, "order": float(order),
                      "rule": clean(r[i_rule]) if i_rule is not None else ""})
    clues.sort(key=lambda c: c["order"])
    for c in clues:
        del c["order"]
    if not clues:
        raise BuildError("The 'Clue Ladder' sheet has no clues")
    return clues


def read_roster(wb, allowed: dict[str, set[str]], warn) -> list[dict]:
    ws = sheet(wb, "Roster")
    rows = ws.iter_rows(values_only=True)
    header = [clean(h).lower() for h in next(rows)]
    cols = {}
    for field, prefix in ROSTER_FIELDS.items():
        idx = next((i for i, h in enumerate(header) if h.startswith(prefix)), None)
        if idx is not None:
            cols[field] = idx
    missing = [f for f in REQUIRED_FIELDS if f not in cols]
    if missing:
        raise BuildError("Roster is missing columns: " + ", ".join(ROSTER_FIELDS[m] for m in missing))

    capes = []
    for line, row in enumerate(rows, start=2):
        get = lambda f: clean(row[cols[f]]) if f in cols and cols[f] < len(row) else ""
        name = get("name")
        if not name or fold(name) in ("", "unknown"):
            continue
        cape = {
            "name": name,
            "aliases": [a for a in split_list(get("aliases")) if fold(a) != fold(name)],
            "series": get("series"),
            "disposition": NON_CAPE if fold(get("disposition")) == "noncape" else get("disposition"),
            "type": get("type"),
            "gender": get("gender"),
            "status": get("status"),
            "team": get("team"),
            "power": get("power"),
            "hybrid": [h for h in split_list(get("hybrid")) if h in POWER_CLASSES],
            "rating": get("rating"),
            "civilian": get("civilian").strip("?").strip() if get("civilian") not in ("-", "?") else "",
            "description": get("description"),
            "disputed": get("disputed").upper().startswith("Y"),
            "_row": line,
        }
        problems = []
        for field in REQUIRED_FIELDS[1:]:
            value = cape[field]
            if value and field in allowed and value not in allowed[field]:
                problems.append(f"{field} '{value}' isn't in the Lists sheet")
        if "/" in cape["team"]:
            problems.append(f"team '{cape['team']}' still has more than one team")
        cape["_problems"] = problems
        capes.append(cape)
    return capes


# ---------------------------------------------------------------- shaping

def merge_duplicates(capes: list[dict], warn) -> list[dict]:
    """Rows whose names only differ by accents/spacing (Uber/Über) become one cape."""
    by_key: dict[str, dict] = {}
    for cape in capes:
        key = fold(cape["name"])
        if key not in by_key:
            by_key[key] = cape
            continue
        keep = by_key[key]
        filled = lambda c: sum(bool(c[f]) for f in REQUIRED_FIELDS)
        winner, loser = (keep, cape) if filled(keep) >= filled(cape) else (cape, keep)
        for f in REQUIRED_FIELDS + ("civilian", "description", "rating"):
            if not winner[f] and loser[f]:
                winner[f] = loser[f]
        if fold(loser["name"]) != fold(winner["name"]) or loser["name"] != winner["name"]:
            winner["aliases"].append(loser["name"])
        winner["aliases"] += [a for a in loser["aliases"] if a not in winner["aliases"]]
        warn(f"rows {keep['_row']} and {cape['_row']} ('{keep['name']}' / '{cape['name']}') "
             f"look like the same cape; merged as '{winner['name']}'")
        by_key[key] = winner
    return list(by_key.values())


def assign_ids_and_groups(capes: list[dict]) -> None:
    used = set()
    for cape in sorted(capes, key=lambda c: c["_row"]):
        base = slug(cape["name"])
        cid, n = base, 2
        while cid in used:
            cid, n = f"{base}-{n}", n + 1
        used.add(cid)
        cape["id"] = cid

    # Capes that list each other as aliases (Skitter / Khepri) are one identity.
    parent = {c["id"]: c["id"] for c in capes}

    def root(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    name_index = {fold(c["name"]): c["id"] for c in capes}
    for cape in capes:
        for alias in cape["aliases"]:
            other = name_index.get(fold(alias))
            if other:
                parent[root(other)] = root(cape["id"])
    for cape in capes:
        cape["group"] = root(cape["id"])


def scrub_description(cape: dict) -> str:
    """Hide the cape's own names inside its power description."""
    text = cape["description"]
    names = [cape["name"], *cape["aliases"], cape["civilian"]]
    words = set()
    for n in names:
        if not n:
            continue
        words.add(n)
        words.update(w for w in re.split(r"[\s/]+", n) if len(w) >= 4)
    for w in sorted(words, key=len, reverse=True):
        text = re.sub(rf"(?i)\b{re.escape(w)}\b", "▇▇▇▇", text)
    return text


def mark_pools(capes: list[dict], warn) -> None:
    for cape in capes:
        reasons = []
        non_cape = cape["disposition"] == NON_CAPE
        for f in REQUIRED_FIELDS[1:]:
            if f == "power" and non_cape:
                continue                    # people without powers need no power class
            if not cape[f]:
                reasons.append(f"no {f}")
        if cape["disputed"]:
            reasons.append("disputed rating")
        reasons += cape["_problems"]
        # "complete": every detail is filled in, so guesses with this person compare properly.
        # "eligible": complete AND a cape, so they can be a daily answer.
        cape["complete"] = not reasons
        if non_cape:
            reasons.append("not a cape")
        cape["eligible"] = not reasons
        cape["_why_not"] = reasons
        for p in cape["_problems"]:
            warn(f"row {cape['_row']} {cape['name']}: {p}; left out of the answer pool")

        clue = scrub_description(cape) if cape["description"] else ""
        cape["powerClue"] = clue
        hidden = fold(cape["name"]) in fold(clue)
        cape["powerEligible"] = cape["eligible"] and len(clue) >= 25 and not hidden


# ---------------------------------------------------------------- schedule

def load_schedule() -> dict:
    if SCHEDULE_PATH.exists():
        return json.loads(SCHEDULE_PATH.read_text(encoding="utf-8"))
    return {}


def draw_schedule(previous: dict, pools: dict[str, list[str]], today: dt.date, warn,
                  redraw: bool = False) -> dict:
    launch = dt.date.fromisoformat(previous["launch"]) if previous.get("launch") else today
    edition = int(previous.get("edition", 1)) + (1 if redraw and previous else 0)
    today_index = (today - launch).days
    freeze_until = today_index + FREEZE_DAYS_AHEAD   # inclusive
    out = {"launch": launch.isoformat(), "edition": edition, "modes": {}}
    salt = "" if edition == 1 else f":e{edition}"
    for mode in MODES:
        pool = sorted(pools[mode])
        old = [] if redraw else [decode_id(t) for t in previous.get("modes", {}).get(mode, [])]
        days = old[: max(0, freeze_until + 1)]
        if not pool:
            out["modes"][mode] = [encode_id(x) for x in days]
            continue
        recent_window = max(1, min(len(pool) // 2, 120))
        while len(days) <= today_index + HORIZON_DAYS:
            index = len(days)
            seed = int(hashlib.sha256(f"{mode}:{launch}:{index}{salt}".encode()).hexdigest(), 16)
            rng = random.Random(seed)
            recent = set(days[-recent_window:])
            choices = [c for c in pool if c not in recent] or pool
            days.append(rng.choice(choices))
        out["modes"][mode] = [encode_id(x) for x in days]
    return out


# ---------------------------------------------------------------- main

def build(workbook: Path, now_utc: dt.datetime, write: bool = True, quiet: bool = False,
          redraw: bool = False) -> dict:
    warnings_seen: list[str] = []
    warn = warnings_seen.append

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")      # openpyxl: "Data Validation extension is not supported"
        wb = load_workbook(workbook, data_only=True, read_only=False)

    clues = read_clues(wb)
    settings = read_settings(wb, len(clues))
    allowed = read_lists(wb)
    capes = read_roster(wb, allowed, warn)
    capes = merge_duplicates(capes, warn)
    assign_ids_and_groups(capes)
    mark_pools(capes, warn)

    if not any(c["eligible"] for c in capes):
        raise BuildError("No cape has all six clue fields filled, so there's nothing to play. "
                         "Fill Disposition, Type, Gender, Status, Team, Power class and Series for some capes.")

    offset = parse_offset(settings["reset_label"])
    today = game_date(now_utc, offset)
    pools = {
        "lineup": [c["id"] for c in capes if c["eligible"]],
        "power": [c["id"] for c in capes if c["powerEligible"]],
    }
    known_ids = {c["id"] for c in capes}
    schedule = draw_schedule(load_schedule(), pools, today, warn, redraw=redraw)
    for mode, tokens in schedule["modes"].items():
        for i, t in enumerate(tokens[: (today - dt.date.fromisoformat(schedule["launch"])).days + 2]):
            if decode_id(t) not in known_ids:
                warn(f"{mode} puzzle #{i + 1} was '{decode_id(t)}', which is no longer in the Roster; "
                     "players will see a stand-in for that day")

    game = {
        "title": "Wormdle",
        "generated": now_utc.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "source": workbook.name,
        "config": {
            "maxGuesses": settings["max_guesses"],
            "resetLabel": settings["reset_label"],
            "resetOffsetMinutes": offset,
            "launch": schedule["launch"],
            "edition": schedule["edition"],
        },
        "clues": clues,
        "powerClasses": POWER_CLASSES,
        "capes": [
            {k: v for k, v in {
                "id": c["id"], "group": c["group"], "name": c["name"], "aliases": c["aliases"],
                "series": c["series"], "disposition": c["disposition"], "type": c["type"],
                "gender": c["gender"], "status": c["status"], "team": c["team"], "power": c["power"],
                "hybrid": c["hybrid"], "rating": c["rating"], "civilian": c["civilian"],
                "description": c["description"], "powerClue": c["powerClue"] if c["powerEligible"] else "",
                "pool": [m for m in MODES if c["id"] in pools[m]],
                "complete": c["complete"] or None,
            }.items() if v not in ("", [], None)}
            for c in sorted(capes, key=lambda c: fold(c["name"]))
        ],
        "schedule": schedule["modes"],
    }

    if not quiet:
        print(f"workbook   {workbook.name}")
        print(f"capes      {len(capes)} guessable")
        print(f"pools      lineup {len(pools['lineup'])}, power {len(pools['power'])}")
        print(f"clues      {' > '.join(c['label'] for c in clues)}")
        print(f"guesses    {settings['max_guesses']} in the Power file (Lineup is unlimited)")
        zone = "each player's local time" if offset is None else f"UTC{offset / 60:+g}"
        print(f"reset      {settings['reset_label']} ({zone}), today is puzzle "
              f"#{(today - dt.date.fromisoformat(schedule['launch'])).days + 1} (launched {schedule['launch']}, "
              f"schedule edition {schedule['edition']})")
        for w in warnings_seen:
            print(f"warning    {w}")

    if write:
        OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        OUT_PATH.write_text(json.dumps(game, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        SCHEDULE_PATH.write_text(json.dumps(schedule, indent=1) + "\n", encoding="utf-8")
        if not quiet:
            print(f"wrote      {OUT_PATH.relative_to(ROOT)} ({OUT_PATH.stat().st_size // 1024} KB) "
                  f"and {SCHEDULE_PATH.relative_to(ROOT)}")
    game["_warnings"] = warnings_seen
    return game


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--workbook", help="path to the .xlsx (default: the workbook in data/)")
    ap.add_argument("--check", action="store_true", help="validate only; write nothing")
    ap.add_argument("--peek", type=int, metavar="DAYS", help="print upcoming daily answers")
    ap.add_argument("--redraw", action="store_true",
                    help="re-draw every day, past ones included, as a new schedule edition")
    args = ap.parse_args(argv)
    try:
        game = build(find_workbook(args.workbook), dt.datetime.now(dt.timezone.utc), write=not args.check,
                     redraw=args.redraw)
    except BuildError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    if args.peek:
        names = {c["id"]: c["name"] for c in game["capes"]}
        launch = dt.date.fromisoformat(game["config"]["launch"])
        today = game_date(dt.datetime.now(dt.timezone.utc), game["config"]["resetOffsetMinutes"])
        start = (today - launch).days
        print("\nupcoming answers (spoilers!)")
        for i in range(start, start + args.peek):
            row = [names.get(decode_id(game["schedule"][m][i]), "?") if i < len(game["schedule"][m]) else "-"
                   for m in MODES]
            print(f"  #{i + 1:<4} {launch + dt.timedelta(days=i)}  " + "  |  ".join(row))
    return 0


if __name__ == "__main__":
    sys.exit(main())
