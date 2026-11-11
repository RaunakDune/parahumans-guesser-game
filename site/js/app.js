// Wormdle — guess the cape from a redacted PRT file.
// Data comes from data/game.json, which scripts/build_data.py builds from the Excel workbook.

import {
  fold, h, store, decodeId, hash, puzzleNumberFor, dateOfPuzzle, shortDate,
  msUntilReset, formatCountdown,
} from "./util.js";
import { trackFinish, trackShare, lineupRecord } from "./analytics.js";

const MODES = {
  lineup: { tab: "Lineup", file: "Identification lineup", limited: false },
  power: { tab: "Power file", file: "Power assessment", limited: true },
};
// Power file: notes that open after this many wrong guesses.
const POWER_HINTS = [
  { after: 2, field: "power" },
  { after: 4, field: "team" },
  { after: 6, field: "disposition" },
];
// Lineup: notes that open after this many wrong guesses (the Reveal answer button comes at 8).
const LINEUP_HINTS = [
  { after: 2, label: "Introduced in", width: 6, value: (c) => seriesText(c) },
  { after: 4, label: "Cluster cape", width: 4, value: (c) => clusterText(c) },
];
const MARK = { match: "✓", near: "≈", miss: "✗" };
const MARK_WORD = { match: "matches", near: "partly matches, sharing a power class", miss: "doesn't match" };
const SHARE_TILE = { match: "🟩", near: "🟨", miss: "🟥" };
// Redaction bars have a fixed width per clue so their length never hints at the answer.
const BAR_WIDTH = { disposition: 8, type: 9, gender: 7, status: 6, team: 13, power: 9 };

const $ = (sel) => document.querySelector(sel);
const sheet = $("#sheet");
const after = $("#after");

let game = null;            // contents of game.json
let byId = new Map();
let searchIndex = [];       // [{cape, key, label, isAlias}]
let today = 1;              // today's puzzle number
const state = {
  mode: "lineup",
  pick: "today",            // "today" | "archive:<n>" | "practice"
  practice: {},             // mode -> { answerId, guesses: [], series }
  fresh: null,              // what changed on the last guess, for one-off motion
  error: "",
  confirmReveal: null,      // Lineup: key of the file whose "Reveal answer" was pressed once, awaiting confirmation
};

// Lineup has no guess limit, so a stuck player can reveal the answer after this many guesses.
const REVEAL_AFTER = 8;
// GoatCounter reads this hash to stop (or restart) counting your own visits; leave it in place.
const GC_TOGGLE = "toggle-goatcounter";

// ---------------------------------------------------------------- data

async function load() {
  store.load();
  try {
    const res = await fetch("data/game.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(res.status);
    game = await res.json();
  } catch {
    sheet.replaceChildren(h("p", { class: "loading" },
      "The case files didn't load. Check your connection and refresh the page."));
    return;
  }
  byId = new Map(game.capes.map((c) => [c.id, c]));
  for (const cape of game.capes) {
    searchIndex.push({ cape, key: fold(cape.name), label: cape.name, isAlias: false });
    for (const alias of cape.aliases || []) {
      searchIndex.push({ cape, key: fold(alias), label: alias, isAlias: true });
    }
    if (cape.civilian) searchIndex.push({ cape, key: fold(cape.civilian), label: cape.civilian, isAlias: true });
  }
  today = puzzleNumberFor(game.config.launch, game.config.resetOffsetMinutes);
  const refiled = checkEdition();

  const fromHash = location.hash.replace("#", "");
  if (MODES[fromHash]) state.mode = fromHash;
  else if (fromHash && fromHash !== GC_TOGGLE) history.replaceState(null, "", `#${state.mode}`);   // e.g. old #dossier links

  fillHelp();
  greetAgent();
  const updated = new Date(game.generated);
  $("#data-stamp").textContent =
    `Files updated ${updated.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}. ` +
    `${game.capes.length} capes on record.`;

  wireChrome();
  render();
  const returning = Boolean(store.data.spoilersOk || store.data.betaNoticeSeen);
  if (maybeWelcome()) markNewsSeen();          // new players learn the current rules from the welcome + How to play
  else if (refiled) {
    const d = $("#dialog-refiled");
    d.addEventListener("close", () => maybeNews(returning), { once: true });
    openDialog(d);
  } else maybeNews(returning);
  setInterval(tick, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
}

function poolFor(mode) {
  return game.capes.filter((c) => (c.pool || []).includes(mode));
}

function answerFor(mode, number) {
  const tokens = game.schedule[mode] || [];
  const id = decodeId(tokens[number - 1] || "");
  const cape = byId.get(id);
  if (cape && (cape.pool || []).includes(mode)) return cape;
  // Beyond the drawn schedule, or the cape was removed from the sheet: stable stand-in.
  const pool = poolFor(mode);
  return pool[hash(`${mode}:${number}`) % pool.length];
}

// ---------------------------------------------------------------- progress

// When the schedule is re-drawn from scratch (a new "edition"), every saved result
// belongs to answers that no longer exist, so they're cleared. Returns true if the
// player had results that were cleared.
function checkEdition() {
  const edition = game.config.edition || 1;
  const had = store.data.edition || 1;
  if (had === edition) {
    if (!store.data.edition) { store.data.edition = edition; store.save(); }
    return false;
  }
  const lost = Object.values(store.data.progress || {}).some((m) => Object.keys(m).length);
  store.data.progress = {};
  store.data.edition = edition;
  store.save();
  return lost;
}

function progressFor(mode, number) {
  const all = (store.data.progress ||= {});
  const forMode = (all[mode] ||= {});
  return (forMode[number] ||= { g: [], done: false, won: false, onDay: number === today });
}

function currentPuzzle() {
  const mode = state.mode;
  if (state.pick === "practice") {
    const p = (state.practice[mode] ||= { series: "any", guesses: [] });
    if (!p.answerId) p.answerId = randomAnswer(mode, p.series).id;
    const answer = byId.get(p.answerId);
    return {
      mode, kind: "practice", answer, number: null,
      progress: p.progress ||= { g: [], done: false, won: false },
      save() {},
    };
  }
  const number = state.pick.startsWith("archive:") ? Number(state.pick.split(":")[1]) : today;
  const progress = progressFor(mode, number);
  return {
    mode, number, kind: number === today ? "today" : "archive",
    answer: answerFor(mode, number), progress,
    save: () => store.save(),
  };
}

// Practice "From" filter: the story the cape first appears in, as in the "Introduced in" note.
const PRACTICE_STORIES = ["Worm", "PRT Quest", "Glow-worm", "Ward", "PHO Sunday"];

function randomAnswer(mode, series) {
  let pool = poolFor(mode);
  if (PRACTICE_STORIES.includes(series)) {
    const narrowed = pool.filter((c) => c.introduced === series);
    if (narrowed.length) pool = narrowed;
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

function maxGuesses(mode) {
  return MODES[mode].limited ? game.config.maxGuesses : Infinity;
}

// A cape's file is complete when it qualifies as a daily answer: every clue filled in and checked
// by scripts/build_data.py. This is recomputed from the spreadsheet on every build.
// A file is complete when every detail is filled in (people marked Non-cape need no power class).
// Recomputed from the spreadsheet on every build by scripts/build_data.py.
function isIncomplete(cape) {
  return !cape.complete;
}

function sameCape(a, b) {
  return a && b && (a.id === b.id || a.group === b.group);
}

// ---------------------------------------------------------------- comparing

function compareField(field, guess, answer) {
  if (field === "arc") {
    // Arc of first appearance, numbered across Worm, PRT Quest, Glow-worm and Ward in reading order.
    if (guess.arcOrder == null || answer.arcOrder == null) return "miss";
    const gap = Math.abs(guess.arcOrder - answer.arcOrder);
    return gap === 0 ? "match" : gap <= (game.config.arcClose ?? 2) ? "near" : "miss";
  }
  if (field === "power") {
    if (guess.power === answer.power) return "match";
    const g = new Set([guess.power, ...(guess.hybrid || [])]);
    const a = [answer.power, ...(answer.hybrid || [])];
    return a.some((x) => g.has(x)) ? "near" : "miss";
  }
  return fold(guess[field]) && fold(guess[field]) === fold(answer[field]) ? "match" : "miss";
}

// For First appearance: does the subject first appear later or earlier than this guess?
function arcDirection(guess, answer) {
  if (guess.arcOrder == null || answer.arcOrder == null || guess.arcOrder === answer.arcOrder) return null;
  return answer.arcOrder > guess.arcOrder ? "later" : "earlier";
}

function tileMark(field, result, guess, answer) {
  const dir = field === "arc" ? arcDirection(guess, answer) : null;
  return dir ? (dir === "later" ? "▲" : "▼") : MARK[result];
}

function tileWord(field, result, guess, answer) {
  if (field !== "arc") return MARK_WORD[result];
  const dir = arcDirection(guess, answer);
  if (!dir) return result === "match" ? "matches" : "doesn't match";
  const where = `the subject first appears ${dir}`;
  return result === "near" ? `close, ${where}` : where;
}

function display(field, cape) {
  const value = cape[field];
  // "Unknown" is a real answer in the sheet, so a blank detail reads differently.
  if (!value) return field === "power" && cape.disposition === "Non-cape" ? "No powers" : "Not on file";
  if (field === "team" && fold(value) === "noteam") return "No team";
  return value;
}

// Power file hint: the main class plus the secondary ones from "Hybrid / sub-ratings",
// e.g. "Breaker" with "also Changer, Blaster, Striker and Mover" underneath.
function powerWithSubRatings(cape) {
  const main = display("power", cape);
  const extra = (cape.hybrid || []).filter((x) => x && x !== cape.power);
  if (!cape.power || !extra.length) return main;
  const list = extra.length === 1 ? extra[0] : `${extra.slice(0, -1).join(", ")} and ${extra.at(-1)}`;
  return [main, h("span", { class: "also" }, `also ${list}`)];
}

// ---------------------------------------------------------------- guessing

function submitGuess(cape) {
  const puzzle = currentPuzzle();
  const { progress, answer, mode } = puzzle;
  if (progress.done || !cape) return;
  if (progress.g.includes(cape.id)) {
    state.error = `${cape.name} is already ruled out.`;
    render();
    return;
  }
  state.error = "";
  progress.g.push(cape.id);
  const won = sameCape(cape, answer);
  const misses = progress.g.length - (won ? 1 : 0);
  if (won || progress.g.length >= maxGuesses(mode)) {
    progress.done = true;
    progress.won = won;
    progress.onDay = puzzle.kind === "today";
    state.fresh = { stamp: true };
    announce(won ? `Identified: ${answer.name}.` : `Out of guesses. The cape was ${answer.name}.`);
    trackFinish(puzzle, game.config.edition || 1);
  } else {
    state.fresh = { clue: misses };
    announce(`${cape.name} is wrong. ${describeOpened(mode, misses, answer)}`);
  }
  puzzle.save();
  render();
}

function revealAnswer() {
  const puzzle = currentPuzzle();
  const { progress, answer } = puzzle;
  if (progress.done || progress.g.length < REVEAL_AFTER) return;
  progress.done = true;
  progress.won = false;
  progress.revealed = true;
  progress.onDay = puzzle.kind === "today";
  state.confirmReveal = null;
  state.fresh = { stamp: true };
  announce(`Answer revealed: ${answer.name}.`);
  trackFinish(puzzle, game.config.edition || 1);
  puzzle.save();
  render();
}

function revealControl(puzzle) {
  const used = puzzle.progress.g.length;
  const left = REVEAL_AFTER - used;
  if (left > 0) {
    return h("div", { class: "reveal" },
      h("button", { type: "button", class: "button button-small", disabled: true }, "Reveal answer"),
      h("span", { class: "reveal-note" }, `Stuck? You can reveal the answer in ${left} more ${left === 1 ? "guess" : "guesses"}.`));
  }
  const key = `${puzzle.mode}:${puzzle.kind}:${puzzle.number}`;
  if (state.confirmReveal === key) {
    return h("div", { class: "reveal", role: "group", "aria-label": "Confirm reveal" },
      h("span", { class: "reveal-note" }, "Reveal the answer? This file will count as unsolved in your stats."),
      h("button", { type: "button", class: "button button-small button-primary", id: "reveal-yes", onclick: revealAnswer }, "Yes, reveal it"),
      h("button", { type: "button", class: "button button-small",
        onclick: () => { state.confirmReveal = null; render(); } }, "Keep guessing"));
  }
  return h("div", { class: "reveal" },
    h("button", { type: "button", class: "button button-small",
      onclick: () => { state.confirmReveal = key; render(); $("#reveal-yes")?.focus({ preventScroll: true }); } }, "Reveal answer"),
    h("span", { class: "reveal-note" }, "Stuck? You can reveal the answer now."));
}

function describeOpened(mode, misses, answer) {
  if (mode === "power") {
    const hint = POWER_HINTS.find((x) => x.after === misses);
    if (!hint) return "";
    const value = hint.field === "power" ? [powerWithSubRatings(answer)].flat().map((x) => x.textContent ?? x).join(", ") : display(hint.field, answer);
    return `New note, ${labelFor(hint.field)}: ${value}.`;
  }
  const guess = byId.get(currentPuzzle().progress.g.at(-1));
  const note = LINEUP_HINTS.find((x) => x.after === misses);
  return game.clues.map((c) => `${c.label} ${tileWord(c.field, compareField(c.field, guess, answer), guess, answer)}`).join(", ") + "."
    + (note ? ` New note, ${note.label}: ${note.value(answer)}.` : "");
}

// The story the cape first appears in (the build works it out from Series and First mentioned).
function seriesText(cape) {
  return cape.introduced || "Not on file";
}

// Cluster column: a cluster's name, or NONE; blank means it hasn't been checked yet.
function clusterText(cape) {
  if (!cape.cluster) return "Not on file";
  return cape.cluster === "NONE" ? "No" : "Yes";
}

function notesList(hints, misses, done, valueOf, label) {
  return h("ol", { class: "clues", "aria-label": "Notes" }, hints.map((hint, i) => {
    const isOpen = done || misses >= hint.after;
    const isFresh = state.fresh?.clue && misses === hint.after;
    return h("li", { class: "clue" },
      h("span", { class: "clue-no" }, i + 1),
      h("span", { class: "clue-label" }, label(hint)),
      h("span", { class: "clue-value" },
        isOpen
          ? h("span", { class: "reveal-text" + (isFresh ? " is-fresh" : "") }, valueOf(hint))
          : [redaction(hint.width, `${label(hint)}, hidden`),
             h("span", { class: "hint" }, `opens after ${hint.after} misses`)]));
  }));
}

function labelFor(field) {
  return (game.clues.find((c) => c.field === field) || { label: field }).label;
}

function resolveTyped(text) {
  const key = fold(text);
  if (!key) return null;
  const exactName = game.capes.find((c) => fold(c.name) === key);
  if (exactName) return exactName;
  const aliasHits = searchIndex.filter((e) => e.key === key);
  const unique = new Set(aliasHits.map((e) => e.cape.id));
  return unique.size === 1 ? aliasHits[0].cape : null;
}

function suggestions(text, exclude) {
  const key = fold(text);
  if (!key) return [];
  const seen = new Set();
  const ranked = [];
  for (const entry of searchIndex) {
    if (exclude.has(entry.cape.id)) continue;
    const at = entry.key.indexOf(key);
    if (at < 0) continue;
    const rank = (at === 0 ? 0 : 2) + (entry.isAlias ? 1 : 0);
    ranked.push({ ...entry, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  const out = [];
  for (const r of ranked) {
    if (seen.has(r.cape.id)) continue;
    seen.add(r.cape.id);
    out.push(r);
    if (out.length === 8) break;
  }
  return out;
}

// ---------------------------------------------------------------- rendering

function render() {
  const puzzle = currentPuzzle();
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.mode === state.mode));
    tab.tabIndex = 0;   // both tabs are in the Tab order; arrow keys also switch
  });
  sheet.setAttribute("aria-labelledby", `tab-${state.mode}`);

  // Redrawing replaces the controls, so remember which one had keyboard focus and put it back.
  const focusedId = (sheet.contains(document.activeElement) || after.contains(document.activeElement))
    ? document.activeElement.id : "";
  const body = { lineup: renderLineup, power: renderPower }[state.mode](puzzle);
  sheet.replaceChildren(...[
    renderHead(puzzle),
    renderSubject(puzzle),
    ...body,
    puzzle.progress.done ? renderStamp(puzzle) : null,
  ].filter(Boolean));
  after.replaceChildren(...(puzzle.progress.done ? [renderReport(puzzle)] : []));
  state.fresh = null;
  if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- archive calendar
// A month-by-month calendar of daily files for the current mode, coloured by the
// player's result. Weeks start on Monday. Arrow keys move between days.

const archive = { year: 0, month: 0 };   // month on show (UTC calendar of puzzle dates)

function fileResult(mode, n) {
  const p = (store.data.progress?.[mode] || {})[n];
  if (p?.done) return p.won ? "solved" : p.revealed ? "revealed" : "unsolved";
  return p?.g?.length ? "started" : "unplayed";
}
const RESULT_MARK = { solved: "✓", revealed: "⚑", unsolved: "✗", started: "…", unplayed: "" };
const RESULT_WORD = { solved: "solved", revealed: "answer revealed", unsolved: "unsolved", started: "in progress", unplayed: "not played" };

function numberOnDate(y, m, d) {
  return Math.round((Date.UTC(y, m, d) - Date.parse(game.config.launch + "T00:00:00Z")) / 86400000) + 1;
}

function openArchive() {
  const current = currentPuzzle();
  const shown = dateOfPuzzle(game.config.launch, current.kind === "archive" ? current.number : today);
  archive.year = shown.getUTCFullYear();
  archive.month = shown.getUTCMonth();
  renderArchive();
  const dialog = $("#dialog-archive");
  dialog.addEventListener("close", () => $("#archive-open")?.focus({ preventScroll: true }), { once: true });
  openDialog(dialog);
  ($("#archive-grid [aria-current=true]") || $("#archive-grid .day-today") || $("#archive-grid button:not([disabled])"))?.focus();
}

function renderArchive(focusNumber) {
  const mode = state.mode;
  const current = currentPuzzle();
  const first = dateOfPuzzle(game.config.launch, 1), last = dateOfPuzzle(game.config.launch, today);
  const monthStart = Date.UTC(archive.year, archive.month, 1);
  const label = new Date(monthStart).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });

  const counts = { solved: 0, revealed: 0, unsolved: 0 };
  for (let n = 1; n <= today; n++) { const r = fileResult(mode, n); if (r in counts) counts[r]++; }
  const closed = counts.solved + counts.revealed + counts.unsolved;
  $("#archive-title").textContent = `${MODES[mode].tab} archive`;
  $("#archive-summary").textContent = `${closed} of ${today} files closed: ${counts.solved} solved`
    + (counts.revealed ? `, ${counts.revealed} revealed` : "") + (counts.unsolved ? `, ${counts.unsolved} unsolved` : "") + ".";

  const canPrev = monthStart > Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1);
  const canNext = monthStart < Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), 1);
  const step = (delta) => {
    const d = new Date(Date.UTC(archive.year, archive.month + delta, 1));
    archive.year = d.getUTCFullYear(); archive.month = d.getUTCMonth();
    renderArchive();
  };

  const days = new Date(Date.UTC(archive.year, archive.month + 1, 0)).getUTCDate();
  const lead = (new Date(monthStart).getUTCDay() + 6) % 7;   // Monday first
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(h("span", { class: "day day-blank", "aria-hidden": "true" }));
  for (let d = 1; d <= days; d++) {
    const n = numberOnDate(archive.year, archive.month, d);
    if (n < 1 || n > today) {
      cells.push(h("span", { class: "day day-off", "aria-hidden": "true" }, h("span", { class: "day-num" }, d)));
      continue;
    }
    const result = fileResult(mode, n);
    const isCurrent = current.kind !== "practice" && current.number === n;
    cells.push(h("button", {
      type: "button", class: `day day-${result}${n === today ? " day-today" : ""}`,
      "data-n": n, "aria-current": isCurrent ? "true" : null, tabindex: "-1",
      "aria-label": `${MODES[mode].tab} #${n}, ${shortDate(dateOfPuzzle(game.config.launch, n))}${n === today ? ", today" : ""}, ${RESULT_WORD[result]}`,
      onclick: () => { $("#dialog-archive").close(); pickFile(n === today ? "today" : `archive:${n}`); },
    }, h("span", { class: "day-num" }, d), h("span", { class: "day-file" }, `#${n}`),
      h("span", { class: "day-mark", "aria-hidden": "true" }, RESULT_MARK[result])));
  }
  const grid = h("div", { class: "archive-grid", id: "archive-grid", role: "group", "aria-label": label, onkeydown: archiveKeys },
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((w) => h("span", { class: "weekday", "aria-hidden": "true" }, w)), cells);
  $("#archive-body").replaceChildren(
    h("div", { class: "archive-nav" },
      h("button", { type: "button", class: "button button-small", "aria-label": "Previous month", disabled: !canPrev, onclick: () => step(-1) }, "◀"),
      h("h3", { "aria-live": "polite" }, label),
      h("button", { type: "button", class: "button button-small", "aria-label": "Next month", disabled: !canNext, onclick: () => step(1) }, "▶")),
    grid);
  // one day button is in the Tab order (the current file, today, or the last day shown)
  const tabStop = grid.querySelector(`[data-n="${focusNumber}"]`) || grid.querySelector("[aria-current=true]")
    || grid.querySelector(".day-today") || [...grid.querySelectorAll("button")].at(-1);
  if (tabStop) tabStop.tabIndex = 0;
  if (focusNumber && tabStop) tabStop.focus();
}

function archiveKeys(e) {
  const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
  const from = Number(e.target.dataset?.n);
  if (!move || !from) return;
  e.preventDefault();
  const to = Math.min(today, Math.max(1, from + move));
  const date = dateOfPuzzle(game.config.launch, to);
  if (date.getUTCFullYear() !== archive.year || date.getUTCMonth() !== archive.month) {
    archive.year = date.getUTCFullYear(); archive.month = date.getUTCMonth();
  }
  renderArchive(to);
}

// Closed drop-down menus: Enter (and Space) open the list, as players expect.
function openMenuOnEnter(e) {
  if ((e.key === "Enter" || e.key === " ") && typeof e.currentTarget.showPicker === "function") {
    try { e.preventDefault(); e.currentTarget.showPicker(); } catch { /* not allowed here: keep the browser's default */ }
  }
}

function pickFile(value) {
  state.pick = value;
  state.error = "";
  render();
}

function renderHead(puzzle) {
  // Today / Archive / Practice buttons; the archive opens a calendar (see openArchive).
  const button = (id, label, onclick, extra = {}) =>
    h("button", { type: "button", id, class: "button button-small", onclick, ...extra }, label);
  const actions = [
    // Away from today's file: a solid button that stands out from Archive / Practice.
    puzzle.kind !== "today" ? button("back-today", `◂ Today's file #${today}`, () => pickFile("today"), { class: "button button-small button-primary back-today" }) : null,
    today > 1 ? button("archive-open", "Archive", () => openArchive(), { "aria-haspopup": "dialog" }) : null,
    puzzle.kind !== "practice" ? button("practice-toggle", "Practice", () => pickFile("practice")) : null,
  ];
  const kids = [
    h("p", { class: "file-title" },
      `${MODES[puzzle.mode].file}, `,
      puzzle.kind === "practice" ? "practice file" : `file ${String(puzzle.number).padStart(4, "0")}`,
      puzzle.kind === "archive" ? h("span", { class: "file-date" }, ` (${shortDate(dateOfPuzzle(game.config.launch, puzzle.number))})`) : null),
    h("div", { class: "file-actions" }, actions),
  ];
  if (puzzle.kind === "practice") {
    const p = state.practice[puzzle.mode];
    const series = h("select", {
      id: "series-pick",
      onchange: (e) => { p.series = e.target.value; newPractice(); },
      onkeydown: openMenuOnEnter,
    }, h("option", { value: "any" }, "Every story"),
      PRACTICE_STORIES.filter((s) => poolFor(puzzle.mode).some((c) => c.introduced === s))
        .map((s) => h("option", { value: s }, `${s} only`)));
    series.value = p.series;
    kids.push(h("div", { class: "file-pick" }, h("label", { for: "series-pick" }, "From"), series));
  }
  return h("div", { class: "file-head" }, kids);
}

function renderSubject(puzzle) {
  const { progress, answer } = puzzle;
  return h("div", { class: "subject" },
    h("span", { class: "subject-label" }, "Subject"),
    h("p", { class: "subject-name" },
      progress.done
        ? h("span", { class: "reveal-text" + (state.fresh?.stamp ? " is-fresh" : "") }, answer.name)
        : redaction(12, "Subject's name, hidden")));
}

function redaction(chars, label) {
  const width = Math.max(4, Math.min(22, chars));
  return h("span", { class: "redaction", style: `width:${width}ch`, role: "img", "aria-label": label });
}

function renderPower(puzzle) {
  const { progress, answer } = puzzle;
  const misses = progress.g.length - (progress.won ? 1 : 0);
  const pieces = (answer.powerClue || "").split("▇▇▇▇");
  const text = [];
  pieces.forEach((piece, i) => {
    text.push(piece);
    if (i < pieces.length - 1) text.push(redaction(7, "a name, blacked out"));
  });
  const hints = notesList(POWER_HINTS.map((x) => ({ ...x, width: BAR_WIDTH[x.field] || 8 })), misses, progress.done,
    (hint) => hint.field === "power" ? powerWithSubRatings(answer) : display(hint.field, answer),
    (hint) => labelFor(hint.field));
  return [
    h("p", { class: "power-text" }, text),
    hints,
    ...guessArea(puzzle),
    ruledOut(puzzle),
  ];
}

function renderLineup(puzzle) {
  const { progress, answer } = puzzle;
  const rows = [...progress.g].reverse().map((id) => {
    const guess = byId.get(id);
    if (!guess) return null;
    return h("tr", {},
      h("td", { class: "who" }, guess.name,
        isIncomplete(guess) ? h("span", { class: "who-note" }, "File incomplete") : ""),
      game.clues.map((clue) => {
        const result = compareField(clue.field, guess, answer);
        // Allow a line break after each "/" in multi-team names.
        const value = display(clue.field, guess).replace(/\//g, "/\u200b");
        const longest = Math.max(...value.split(/[\s/]+/).map((w) => w.replace(/\u200b/g, "").length));
        const total = value.replace(/\u200b/g, "").length;
        // Long values step down a size so they fit the fixed tile height.
        const size = clue.field === "arc" && /( Arc \d+| Eclipse)$/.test(value) ? " tile-arc"   // "Worm Arc 14" stays on one line
          : total > 20 || longest > 10 ? " tile-xlong" : longest > 8 ? " tile-long" : "";
        return h("td", {},
          h("div", { class: `tile tile-${result}${size}`, title: `${clue.label}: ${value.replace(/\u200b/g, "")} (${tileWord(clue.field, result, guess, answer)})` },
            h("span", { class: "tile-mark" + (clue.field === "arc" && arcDirection(guess, answer) ? " tile-mark-arrow" : ""), "aria-hidden": "true" }, tileMark(clue.field, result, guess, answer)),
            h("span", { class: "tile-value" }, value),
            h("span", { class: "sr-only" }, `, ${tileWord(clue.field, result, guess, answer)}`)));
      }));
  });
  const table = progress.g.length
    ? h("div", { class: "lineup-scroll" },
        h("table", { class: "lineup" },
          h("caption", { class: "sr-only" }, "Your guesses compared with the target"),
          h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Cape"), game.clues.map((c) => h("th", { scope: "col" }, headingButton(c))))),
          h("tbody", {}, rows)),
        h("p", { class: "lineup-legend" },
          h("span", { class: "k-match" }, "✓ matches"),
          h("span", { class: "k-near" }, game.clues.some((c) => c.field === "arc")
            ? `≈ close: shares a power class, or within ${game.config.arcClose ?? 2} arcs` : "≈ partly right: shares a power class"),
          game.clues.some((c) => c.field === "arc") ? h("span", { class: "k-arrow" }, "▲ ▼ subject first appears later / earlier") : null,
          h("span", { class: "k-miss" }, "✗ no match"),
          h("span", { class: "k-arrow k-tip" }, "Tap a heading to see its possible values")))
    : h("p", { class: "ruled-out" }, "Name any cape to put them in the lineup and compare them with the subject.");
  const misses = progress.g.length - (progress.won ? 1 : 0);
  const notes = notesList(LINEUP_HINTS, misses, progress.done, (hint) => hint.value(answer), (hint) => hint.label);
  return [notes, ...guessArea(puzzle), table];
}

function guessArea(puzzle) {
  const { progress, mode } = puzzle;
  const limit = maxGuesses(mode);
  const parts = [];
  if (!progress.done) parts.push(guessForm(puzzle));
  if (Number.isFinite(limit)) {
    const used = progress.g.length;
    const pips = Array.from({ length: limit }, (_, i) => {
      const hit = progress.won && i === used - 1;
      return h("span", { class: "pip" + (i < used ? (hit ? " is-hit" : " is-used") : "") });
    });
    const left = limit - used;
    parts.push(h("div", { class: "meter" },
      h("span", { class: "meter-pips", role: "img", "aria-label": `${used} of ${limit} guesses used` }, pips),
      progress.done ? "" : `${left} ${left === 1 ? "guess" : "guesses"} left`));
  } else if (progress.g.length) {
    parts.push(h("div", { class: "meter" }, `${progress.g.length} ${progress.g.length === 1 ? "guess" : "guesses"} so far`));
  }
  if (mode === "lineup" && !progress.done) parts.push(revealControl(puzzle));
  return parts;
}

function ruledOut(puzzle) {
  const wrong = puzzle.progress.g.filter((id) => !sameCape(byId.get(id), puzzle.answer));
  if (!wrong.length) return null;
  return h("div", { class: "ruled-out" }, "Ruled out: ",
    h("ol", {}, wrong.map((id) => h("li", {}, h("s", {}, byId.get(id)?.name || id)))));
}

function guessForm(puzzle) {
  const exclude = new Set(puzzle.progress.g);
  const input = h("input", {
    id: "guess-input", type: "text", autocomplete: "off", spellcheck: "false",
    role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": "guess-options",
    placeholder: "Start typing a cape name",
  });
  const list = h("ul", { id: "guess-options", class: "listbox", role: "listbox", hidden: true, "aria-label": "Matching capes" });
  const error = h("p", { class: "form-error", id: "guess-error", role: "alert" }, state.error);
  let options = [];
  let active = -1;

  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); active = -1; };
  const paint = () => {
    list.replaceChildren(...options.map((o, i) => h("li", {
      id: `opt-${i}`, role: "option", class: "option", "aria-selected": String(i === active),
      onmousedown: (e) => { e.preventDefault(); choose(i); },
    }, h("span", {}, o.cape.name),
       h("span", { class: "option-notes" },
         o.isAlias && fold(o.label) !== fold(o.cape.name) ? h("small", {}, o.label) : "",
         isIncomplete(o.cape) ? h("small", { class: "incomplete" }, "File incomplete") : ""))));
    list.hidden = !options.length;
    input.setAttribute("aria-expanded", String(!!options.length));
    if (active >= 0) {
      input.setAttribute("aria-activedescendant", `opt-${active}`);
      document.getElementById(`opt-${active}`)?.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  };
  const choose = (i) => { const pick = options[i]; close(); if (pick) submitGuess(pick.cape); };

  input.addEventListener("input", () => {
    options = suggestions(input.value, exclude);
    active = options.length ? 0 : -1;
    error.textContent = "";
    paint();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && options.length) { e.preventDefault(); active = (active + 1) % options.length; paint(); }
    else if (e.key === "ArrowUp" && options.length) { e.preventDefault(); active = (active - 1 + options.length) % options.length; paint(); }
    else if (e.key === "Escape") close();
    else if (e.key === "Enter" && !list.hidden && active >= 0) { e.preventDefault(); choose(active); }
  });
  input.addEventListener("blur", () => setTimeout(close, 120));

  const form = h("form", {
    class: "guess-form", novalidate: true,
    onsubmit: (e) => {
      e.preventDefault();
      const cape = resolveTyped(input.value);
      if (cape) { submitGuess(cape); return; }
      error.textContent = input.value.trim()
        ? `There's no cape called "${input.value.trim()}" on file. Pick a name from the list.`
        : "Type a cape's name, then pick it from the list.";
    },
  },
    h("label", { for: "guess-input" }, "Who is the subject?"),
    h("div", { class: "guess-row" },
      h("div", { class: "combo" }, input, list),
      h("button", { type: "submit", class: "button button-primary" }, "Guess")),
    error);

  // Keep typing flow on desktop, but never steal focus from a tab or menu the player is using.
  queueMicrotask(() => {
    const here = document.activeElement;
    if (matchMedia("(hover: none)").matches) return;
    if (!here || here === document.body) input.focus({ preventScroll: true });
  });
  return form;
}

function renderStamp(puzzle) {
  const won = puzzle.progress.won;
  return h("div", { class: `stamp ${won ? "stamp-won" : "stamp-lost"}` + (state.fresh?.stamp ? " is-fresh" : ""), "aria-hidden": "true" },
    won ? "Identified" : puzzle.progress.revealed ? "Revealed" : "Unresolved");
}

function renderReport(puzzle) {
  const { answer, progress } = puzzle;
  const aka = [...(answer.aliases || [])];
  const facts = game.clues.map((c) => [c.label, display(c.field, answer)]);
  if (answer.hybrid?.length) facts.push(["Also rated", answer.hybrid.join(", ")]);
  if (answer.introduced || answer.series) facts.push(["Introduced in", answer.introduced || (answer.series === "Canon (unspecified)" ? "Worm or Ward" : answer.series)]);
  // "Yes" in the Cluster column: they were in a cluster, but its name isn't known.
  if (answer.cluster && answer.cluster !== "NONE") {
    facts.push(["Cluster", answer.cluster === "Yes" ? "Yes (name not on file)" : answer.cluster]);
  }
  if (answer.civilian) facts.push(["Civilian name", answer.civilian]);

  const wiki = `https://worm.fandom.com/wiki/Special:Search?query=${encodeURIComponent(answer.name)}`;
  const toast = h("span", { class: "toast", role: "status" });
  const result = progress.won
    ? `You identified the subject in ${progress.g.length} ${progress.g.length === 1 ? "guess" : "guesses"}.`
    : progress.revealed
      ? `Answer revealed after ${progress.g.length} ${progress.g.length === 1 ? "guess" : "guesses"}. Better luck tomorrow.`
      : "The file stays open. Better luck tomorrow.";
  const next = puzzle.kind === "practice"
    ? h("button", { type: "button", class: "button button-primary", onclick: newPractice }, "Open another practice file")
    : h("button", { type: "button", class: "button button-primary", onclick: () => share(puzzle, toast) }, "Share result");

  return h("article", { class: "report", "aria-labelledby": "report-name" },
    h("p", { class: "aka" }, result),
    h("h2", { id: "report-name" }, answer.name),
    aka.length ? h("p", { class: "aka" }, "Also known as ", aka.join(", ")) : null,
    h("dl", { class: "facts" }, facts.map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
    answer.description ? h("p", { class: "report-power" }, answer.description) : null,
    h("div", { class: "report-actions" },
      next,
      h("a", { class: "button", href: wiki, target: "_blank", rel: "noopener" }, "Look them up on the Worm Wiki"),
      toast),
    agentsRecord(puzzle),
    puzzle.kind === "practice" ? null : h("p", { class: "next-file", id: "next-file" }, nextFileText()));
}

// "How other agents did" on today's Lineup file, read back from the anonymous counts.
// Shown only once enough players have finished for the numbers to mean something.
const RECORD_MIN_PLAYERS = 5;

function agentsRecord(puzzle) {
  if (puzzle.mode !== "lineup" || puzzle.kind !== "today") return null;
  const box = h("section", { class: "agents-record", hidden: true, "aria-labelledby": "agents-record-title" });
  lineupRecord(puzzle.number, game.config.edition || 1).then((r) => {
    if (!r || r.finished < RECORD_MIN_PLAYERS || !box.isConnected) return;
    const pct = Math.round((100 * Math.min(r.within8, r.finished)) / r.finished);
    const avg = r.solved ? (r.totalGuesses / r.solved).toFixed(1) : null;
    box.replaceChildren(
      h("h3", { id: "agents-record-title" }, "How other agents did"),
      h("dl", { class: "record-stats" },
        h("div", {}, h("dt", {}, "Identified within 8 guesses"), h("dd", {}, `${pct}%`)),
        avg ? h("div", {}, h("dt", {}, "Average guesses to identify"), h("dd", {}, avg)) : null,
        h("div", {}, h("dt", {}, "Agents who closed this file"), h("dd", {}, r.finished.toLocaleString()))),
      h("p", { class: "record-note" }, "Anonymous counts, updated every few hours."));
    box.hidden = false;
  });
  return box;
}

function nextFileText() {
  const ms = msUntilReset(game.config.resetOffsetMinutes);
  return [ "Next file in ", h("strong", {}, formatCountdown(ms)), ". Missed a day? Open older files from the menu at the top of the sheet." ];
}

// ---------------------------------------------------------------- sharing

function shareText(puzzle) {
  const { mode, progress, answer, number } = puzzle;
  const title = `Wormdle ${MODES[mode].tab} #${number}`;
  let grid;
  let score;
  if (mode === "lineup") {
    const n = `${progress.g.length} ${progress.g.length === 1 ? "guess" : "guesses"}`;
    score = progress.won ? n : progress.revealed ? `revealed after ${n} 🏳️` : "unsolved";
    const rows = progress.g.map((id) => game.clues.map((c) => SHARE_TILE[compareField(c.field, byId.get(id), answer)]).join(""));
    // Games of more than 6 guesses keep the first 3 and last 3 rows (the run-up to the
    // answer, with its close tiles and the solving row); the middle is folded away.
    const HEAD = 3, TAIL = 3;
    if (rows.length > HEAD + TAIL) {
      const hidden = rows.length - HEAD - TAIL;
      rows.splice(HEAD, hidden, `⋮ ${hidden} more ${hidden === 1 ? "guess" : "guesses"}`);
    }
    grid = rows.join("\n");
  } else {
    const limit = maxGuesses(mode);
    score = `${progress.won ? progress.g.length : "X"}/${limit}`;
    grid = progress.g.map((id) => (sameCape(byId.get(id), answer) ? "🟩" : "🟥")).join("")
      + "⬛".repeat(Math.max(0, limit - progress.g.length));
  }
  return `${title} ${score}\n${grid}\n${location.origin}${location.pathname}`;
}

async function share(puzzle, toast) {
  const text = shareText(puzzle);
  trackShare(puzzle, game.config.edition || 1);
  puzzle.save();
  try {
    if (navigator.share && matchMedia("(hover: none)").matches) {
      await navigator.share({ text });
      return;
    }
    await navigator.clipboard.writeText(text);
    toast.textContent = "Result copied. Paste it anywhere.";
  } catch {
    toast.textContent = "Couldn't copy automatically. Select the text below to copy it.";
    toast.after(h("pre", { class: "toast" }, text));
  }
}

// ---------------------------------------------------------------- stats

function statsFor(mode) {
  const results = store.data.progress?.[mode] || {};
  const days = Object.entries(results)
    .filter(([, p]) => p.done && p.onDay)
    .map(([n, p]) => ({ n: Number(n), won: p.won, guesses: p.g.length }))
    .sort((a, b) => a.n - b.n);
  const wins = days.filter((d) => d.won);
  let max = 0;
  let run = 0;
  let prev = null;
  for (const d of days) {
    run = d.won && prev !== null && d.n === prev + 1 && run > 0 ? run + 1 : d.won ? 1 : 0;
    max = Math.max(max, run);
    prev = d.n;
  }
  // The current streak survives until a day is missed or lost.
  let current = 0;
  const wonOn = new Set(wins.map((d) => d.n));
  let n = wonOn.has(today) ? today : today - 1;
  while (wonOn.has(n)) { current++; n--; }
  const dist = new Map();
  for (const d of wins) dist.set(d.guesses, (dist.get(d.guesses) || 0) + 1);
  return { played: days.length, wins: wins.length, current, max, dist, todays: results[today] };
}

function renderStats(mode) {
  const s = statsFor(mode);
  const body = $("#stats-body");
  const switcher = h("div", { class: "stats-mode", role: "group", "aria-label": "Which file" },
    Object.entries(MODES).map(([key, m]) => h("button", {
      type: "button", "aria-pressed": String(key === mode), onclick: () => renderStats(key),
    }, m.tab)));
  const pct = s.played ? Math.round((s.wins / s.played) * 100) : 0;
  const tiles = h("div", { class: "stat-row" },
    [[s.played, "played"], [`${pct}%`, "solved"], [s.current, "current streak"], [s.max, "longest streak"]]
      .map(([v, label]) => h("div", { class: "stat" }, h("b", {}, v), h("span", {}, label))));
  let chart;
  if (!s.wins) {
    chart = h("p", { class: "stats-empty" }, "Solve a daily file to start your record. Archive and practice files don't count.");
  } else {
    const limit = Number.isFinite(maxGuesses(mode)) ? maxGuesses(mode) : Math.max(...s.dist.keys());
    const peak = Math.max(...s.dist.values());
    const todayGuesses = s.todays?.won && s.todays.onDay ? s.todays.g.length : null;
    chart = [
      h("h3", {}, "Guesses needed"),
      h("ol", { class: "dist", "aria-label": "Solved files by number of guesses" },
        Array.from({ length: limit }, (_, i) => {
          const count = s.dist.get(i + 1) || 0;
          return h("li", {},
            h("span", {}, i + 1),
            h("span", {
              class: "bar" + (todayGuesses === i + 1 ? " is-today" : ""),
              style: `width:${Math.max(8, (count / peak) * 100)}%`,
              title: `${count} solved in ${i + 1}`,
            }, count));
        })),
    ];
  }
  body.replaceChildren(switcher, tiles, ...[chart].flat());
}

// ---------------------------------------------------------------- chrome

function wireChrome() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchMode(tab.dataset.mode));
    tab.addEventListener("keydown", (e) => {
      const keys = Object.keys(MODES);
      const i = keys.indexOf(state.mode);
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const next = keys[(i + (e.key === "ArrowRight" ? 1 : keys.length - 1)) % keys.length];
        switchMode(next);
        document.getElementById(`tab-${next}`).focus();
      }
    });
  });
  document.querySelectorAll("[data-open]").forEach((btn) => btn.addEventListener("click", () => {
    const which = btn.dataset.open;
    if (which === "stats") renderStats(state.mode);
    openDialog($(`#dialog-${which}`));
  }));
  window.addEventListener("hashchange", () => {
    const mode = location.hash.replace("#", "");
    if (MODES[mode] && mode !== state.mode) switchMode(mode);
    else if (!MODES[mode] && mode !== GC_TOGGLE) history.replaceState(null, "", `#${state.mode}`);
  });
}

function switchMode(mode) {
  state.mode = mode;
  state.error = "";
  if (location.hash !== `#${mode}`) history.replaceState(null, "", `#${mode}`);
  render();
}

function newPractice() {
  const p = state.practice[state.mode];
  p.answerId = randomAnswer(state.mode, p.series).id;
  p.progress = { g: [], done: false, won: false };
  state.error = "";
  render();
}

function openDialog(dialog) {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

// First visit: one pop-up with the beta notice and, if not yet accepted, the spoiler warning.
// Players who accepted spoilers before the beta notice existed see the beta part once on its own.
// "What's new" pop-up: shown once to returning players for each NEWS_ID.
// For the next round of changes, rewrite #dialog-news in index.html and bump NEWS_ID.
const NEWS_ID = "2026-10-29";

function markNewsSeen() {
  if (store.data.newsSeen === NEWS_ID) return;
  store.data.newsSeen = NEWS_ID;
  store.save();
}

function maybeNews(returning) {
  if (!returning || store.data.newsSeen === NEWS_ID) return;
  markNewsSeen();
  const dialog = $("#dialog-news");
  dialog.addEventListener("close", () => $("#guess-input")?.focus({ preventScroll: true }), { once: true });
  openDialog(dialog);
}

function maybeWelcome() {
  const needSpoilers = !store.data.spoilersOk;
  const needBeta = !store.data.betaNoticeSeen;
  if (!needSpoilers && !needBeta) return false;
  $("#welcome-beta").hidden = !needBeta;
  $("#welcome-spoilers").hidden = !needSpoilers;
  $("#welcome-ok").textContent = needSpoilers ? "I've read them, let me play" : "Got it, let me play";
  const dialog = $("#dialog-welcome");
  if (!needBeta) dialog.setAttribute("aria-labelledby", "welcome-spoilers");
  dialog.addEventListener("close", () => {
    store.data.spoilersOk = true;
    store.data.betaNoticeSeen = true;
    store.save();
    $("#guess-input")?.focus({ preventScroll: true });
  }, { once: true });
  openDialog(dialog);
  return true;
}

// How to play: every value each Lineup detail can take, read from the current data so the
// list stays right as the spreadsheet changes. Unusual values get a short explanation.
const VALUE_NOTES = {
  status: { Unknown: "fate never confirmed by the end of Ward" },
  disposition: { Rogue: "neither hero nor villain", Unknown: "side never made clear", "Non-cape": "no powers; never an answer" },
  type: { "Case 53": "Cauldron-made capes with altered bodies and lost memories", "Other (Entity/AI)": "Entities, shards and AIs" },
  team: { "No team": "not on a team at the end" },
};
const DETAIL_INTROS = {
  disposition: "which side they ended up on",
  status: "where things stand at the end of Ward",
  team: "the last team they belonged to",
  power: "their main class; amber if they share any class",
  arc: "the arc where they first appear",
};

// One sentence explaining a Lineup detail and its possible values (How to play + column headings).
function detailText(field) {
  const answers = game.capes.filter((c) => c.complete);
  const clue = game.clues.find((c) => c.field === field) || { field };
  {
    const intro = DETAIL_INTROS[clue.field];
    let text;
    if (clue.field === "team") {
      const teams = new Set(answers.map((c) => c.team).filter(Boolean));
      text = `${teams.size} teams, or "No team" (${VALUE_NOTES.team["No team"]})`;
    } else if (clue.field === "arc") {
      text = "Worm Arc 1 to 30, PRT Quest, Glow-worm P.1 onwards, Ward Arc 1 onwards (with Eclipse between 7 and 8), then PHO Sunday";
    } else {
      const counts = new Map();
      for (const c of answers) if (c[clue.field]) counts.set(c[clue.field], (counts.get(c[clue.field]) || 0) + 1);
      const values = [...counts.keys()].sort((a, b) => clue.field === "power" ? a.localeCompare(b) : counts.get(b) - counts.get(a));
      text = values.map((v) => (VALUE_NOTES[clue.field]?.[v] ? `${v} (${VALUE_NOTES[clue.field][v]})` : v)).join(", ");
    }
    return intro ? `${intro[0].toUpperCase()}${intro.slice(1)}: ${text}.` : `${text}.`;
  }
}

function fillValues() {
  $("#help-values").replaceChildren(...game.clues.map((clue) =>
    h("div", {}, h("dt", {}, clue.label), h("dd", {}, detailText(clue.field)))));
}

// Lineup column headings are buttons: tapping one shows what that detail means and its values.
function headingButton(clue) {
  return h("button", {
    type: "button", class: "th-info", "aria-expanded": "false", "aria-controls": "detail-pop",
    onclick: (e) => { e.stopPropagation(); toggleDetail(e.currentTarget, clue); },
  }, clue.label);
}

function closeDetail() {
  const pop = $("#detail-pop");
  if (!pop) return;
  document.querySelectorAll(".th-info[aria-expanded=true]").forEach((b) => b.setAttribute("aria-expanded", "false"));
  pop.remove();
}

function toggleDetail(button, clue) {
  const wasOpen = button.getAttribute("aria-expanded") === "true";
  closeDetail();
  if (wasOpen) return;
  const sheet = $("#sheet");
  const pop = h("div", { id: "detail-pop", class: "detail-pop", role: "note" },
    h("strong", {}, clue.label), " ", detailText(clue.field));
  sheet.append(pop);
  button.setAttribute("aria-expanded", "true");
  const s = sheet.getBoundingClientRect(), b = button.getBoundingClientRect();
  const width = Math.min(280, s.width - 24);
  const left = Math.max(12, Math.min(b.left - s.left, s.width - width - 12));
  pop.style.width = `${width}px`;
  pop.style.left = `${left}px`;
  pop.style.top = `${b.bottom - s.top + 6}px`;
}

document.addEventListener("click", (e) => { if (!e.target.closest?.("#detail-pop")) closeDetail(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });

function fillHelp() {
  fillValues();
  const ready = game.capes.filter((c) => (c.pool || []).includes("lineup")).length;
  $("#beta-ready").textContent = `${ready}`;
  $("#beta-total").textContent = `${game.capes.length} capes`;
  $("#help-beta").textContent = `${ready} of ${game.capes.length} capes have complete files so far`;
  $("#help-guesses").textContent = game.config.maxGuesses;
  $("#help-reset").textContent = game.config.resetOffsetMinutes == null
    ? "midnight, your local time" : game.config.resetLabel.toLowerCase();
}

// Each player gets a Watchdog (WEDGDG) agent number that stays the same between visits.
function greetAgent() {
  if (!store.data.agent) {
    store.data.agent = 1000 + Math.floor(Math.random() * 9000);
    store.save();
  }
  $("#agent-line").textContent = `Welcome, WEDGDG Agent #${store.data.agent}.`;
}

function announce(text) {
  const box = $("#announcer");
  box.textContent = "";
  setTimeout(() => { box.textContent = text; }, 30);
}

function tick() {
  const now = puzzleNumberFor(game.config.launch, game.config.resetOffsetMinutes);
  if (now !== today) {
    today = now;
    if (state.pick === "today") render();
  }
  const next = $("#next-file");
  if (next) next.replaceChildren(...nextFileText());
}

load();
