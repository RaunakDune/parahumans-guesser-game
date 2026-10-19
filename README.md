# Wormdle

A daily guessing game for Wildbow's *Worm* and *Ward*. Each day there's a redacted PRT file on a cape; every wrong
guess lifts another black bar until you name them. Players are greeted as WEDGDG (Watchdog) agents, each with their
own agent number.

**Play:** https://www.wormdle.me/

Three files a day, each with its own answer:

| File | How it plays |
|---|---|
| **Dossier** | Six clues start blacked out. Each wrong guess opens the next: disposition, type, gender, status, team, power class. Seven guesses. |
| **Lineup** | Guess any cape and see how they compare with the target on the same six details: match, close, or no match. Unlimited guesses. |
| **Power file** | A description of the cape's power with their names blacked out. Wrong guesses open notes on power class, team and disposition. Seven guesses. |

Players can also replay past days from the archive, play random practice files (filtered to *Worm* or *Ward*),
track streaks, and share a spoiler-free result grid. Progress is saved in the player's browser; there are no accounts.

## Updating the game from the spreadsheet

The workbook in [`data/parahumandle_design.xlsx`](data/parahumandle_design.xlsx) is the single source of truth.
To change capes, clues or settings:

1. Edit your copy of the workbook in Excel, Google Sheets or LibreOffice and save it as `.xlsx`.
2. On GitHub, open the `data` folder, choose **Add file → Upload files**, and drop in the workbook.
   Name it `parahumandle_design.xlsx` so it replaces the old one.
3. Commit. The **Build and deploy** action rebuilds the game and the site updates in about a minute.

The action's summary page shows what it read: how many capes, how many can be daily answers, and any rows it
skipped and why. If the workbook can't be used (a sheet or column is missing, or no cape qualifies), the build
stops and the live site keeps running the previous version.

### What the game reads

Columns are matched by their heading text, so you can add, remove or reorder other columns freely.

| Sheet | Used for |
|---|---|
| **Roster** | Every row with a **Cape name** can be guessed. **Aliases** (separated by `;`) and **Civilian name** are accepted as guesses too. **Power description** feeds the Power file, and **Hybrid / sub-ratings** feeds the "close" match in Lineup. |
| **Clue Ladder** | Which clues the Dossier shows, and in what order (the **Unlocked after wrong guess #** column). |
| **Settings** | **Free first clue?** (0 or 1), **Max guesses**, and **Reset time** (for example `Midnight CET`, `Midnight UTC-5`). |
| **Lists** | The allowed values for Disposition, Type, Gender, Status, Power class and Series. A value that isn't listed keeps that cape out of the answer pool. Disposition always accepts Unknown and Non-cape, and Status and Gender always accept Unknown, even if the sheet doesn't list them. |

A cape can be a **daily answer** when it has Series, Disposition, Type, Gender, Status, Team and Power class filled in,
isn't marked as a disputed rating, and has a single team (no `/`). For the Power file it also needs a power
description that still makes sense with its names blacked out. "Unknown" counts as a filled-in value.

People whose Disposition is **Non-cape** (Danny Hebert, Emily Piggot) can be guessed but are never daily answers, and
they don't need a Power class. Any row that's missing details shows "File incomplete" in the guess list and the
Lineup, and its blank details read "Not on file". Rows whose names differ only by accents or spacing
(Uber and Über) are merged into one cape. Capes that list each other as aliases (Skitter and Khepri) count as the
same answer.

### How the daily answers are picked

`scripts/build_data.py` draws a schedule about 400 days ahead and saves it to `data/schedule.json`. Today's and
tomorrow's answers, and all earlier ones, are frozen, so editing the sheet never changes a puzzle someone has
already played. Days further ahead are re-drawn from the current answer pool on each build, with no repeats inside
a window of half the pool. The answers are lightly scrambled in that file so they aren't readable at a glance.

To restart the numbering at puzzle #1 (for example, on launch day), delete `data/schedule.json` and push.

To see upcoming answers yourself:

```sh
python scripts/build_data.py --peek 7
```

## Running it on your computer

```sh
pip install -r scripts/requirements.txt
python scripts/build_data.py          # writes site/data/game.json
python -m http.server --directory site 8000
```

Then open http://localhost:8000. `python scripts/build_data.py --check` validates the workbook without writing
anything, and `python -m unittest discover -s tests` runs the tests.

## Changing the art

`site/assets/riverfront.svg` is an original placeholder illustration (CC0). See
[`site/assets/README.md`](site/assets/README.md) for how to swap in commissioned art and the social preview image.

## Project layout

```
data/parahumandle_design.xlsx   the spreadsheet you edit
data/schedule.json              daily answers (kept up to date by the build)
scripts/build_data.py           spreadsheet -> site/data/game.json
site/                           the static website that gets published
  index.html, css/, js/
  assets/                       art, favicon, social preview image
  fonts/                        Big Shoulders Display and Courier Prime (SIL Open Font License)
tests/                          checks for the data pipeline
.github/workflows/deploy.yml    build and publish on every push
HOSTING_NOTES.md                GitHub Pages and wormdle.me domain setup
```

## Hosting somewhere else

The site is plain HTML, CSS and JavaScript, so any static host works. On Cloudflare Pages or Netlify, use the build
command `pip install -r scripts/requirements.txt && python scripts/build_data.py` and the output folder `site`.
Those hosts don't save `data/schedule.json` back to the repo, so run the build locally and commit the schedule
whenever you change the sheet, or keep GitHub Actions as the builder.

## Credits

An unofficial fan project. *Worm* and *Ward* are written by Wildbow (J.C. McCrae) and free to read at
[parahumans.wordpress.com](https://parahumans.wordpress.com/) and [parahumans.net](https://www.parahumans.net/).
Cape details are adapted from the [Worm Wiki](https://worm.fandom.com/wiki/Worm_Wiki) (CC BY-SA).
Fonts are used under the SIL Open Font License; their license texts are in `site/fonts/`.
