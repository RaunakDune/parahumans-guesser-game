// Anonymous, cookieless counts through GoatCounter (https://www.goatcounter.com).
//
// Page visits are counted by GoatCounter's own script in index.html. This module adds
// game events for *daily* files only (not archive or practice), each sent once per
// player per file:
//
//   lineup-12-finished          solved or revealed
//   lineup-12-solved            identified the subject
//   lineup-12-solved-in-5       ...in exactly 5 guesses (readable in the dashboard)
//   lineup-12-within-8          ...in 8 guesses or fewer
//   lineup-12-sum-1, -sum-4     the guess count split into powers of two (5 = 4 + 1),
//                               so the site can add up exactly how many guesses solvers used
//   lineup-12-revealed          gave up with the Reveal answer button
//   lineup-12-revealed-after-9
//   power-12-finished / -solved / -solved-in-3 / -failed
//   lineup-12-shared, power-12-shared
//
// GoatCounter's public counter endpoint (enable "Allow adding visitor counts on your
// website" in the GoatCounter settings) lets the page read these totals back to show
// players how everyone else did. Its numbers are cached for a few hours.

const SITE = "https://ronindune.goatcounter.com";
const SUM_BITS = 7;            // guess counts up to 127 add up exactly

const pending = [];
let flushing = false;

function send(path) {
  const gc = window.goatcounter;
  if (gc && typeof gc.count === "function") {
    try { gc.count({ path, title: path, event: true }); } catch { /* never let counting break the game */ }
    return;
  }
  // count.js loads asynchronously (and ad blockers may stop it): retry for a while, then drop.
  pending.push({ path, tries: 0 });
  if (!flushing) flush();
}

function flush() {
  flushing = true;
  setTimeout(() => {
    const gc = window.goatcounter;
    for (let i = pending.length - 1; i >= 0; i--) {
      const item = pending[i];
      if (gc && typeof gc.count === "function") {
        try { gc.count({ path: item.path, title: item.path, event: true }); } catch {}
        pending.splice(i, 1);
      } else if (++item.tries > 20) {
        pending.splice(i, 1);
      }
    }
    flushing = false;
    if (pending.length) flush();
  }, 500);
}

function prefix(mode, number, edition) {
  // Schedule edition 2 is the one that was live when tracking started; later re-draws
  // reuse puzzle numbers, so they get their own names.
  return `${edition > 2 ? `e${edition}-` : ""}${mode}-${number}`;
}

/** Call when a daily file ends. Sends its events once; remembers that in progress.t. */
export function trackFinish(puzzle, edition) {
  const { mode, number, progress, kind } = puzzle;
  if (kind !== "today" || progress.t) return;
  progress.t = 1;
  const p = prefix(mode, number, edition);
  const n = progress.g.length;
  send(`${p}-finished`);
  if (progress.won) {
    send(`${p}-solved`);
    send(`${p}-solved-in-${n}`);
    if (mode === "lineup") {
      if (n <= 8) send(`${p}-within-8`);
      for (let b = 0; b < SUM_BITS; b++) if (Math.min(n, 2 ** SUM_BITS - 1) & (1 << b)) send(`${p}-sum-${1 << b}`);
    }
  } else if (progress.revealed) {
    send(`${p}-revealed`);
    send(`${p}-revealed-after-${n}`);
  } else {
    send(`${p}-failed`);
  }
}

/** Call when the player presses Share on a daily file. Counted once per file. */
export function trackShare(puzzle, edition) {
  const { mode, number, progress, kind } = puzzle;
  if (kind !== "today" || progress.s) return;
  progress.s = 1;
  send(`${prefix(mode, number, edition)}-shared`);
}

// ---------------------------------------------------------------- reading totals back

const cache = new Map();

async function readCount(path) {
  const res = await fetch(`${SITE}/counter/${encodeURIComponent(path)}.json`);
  if (res.status === 404) return 0;                 // nobody has sent this event yet
  if (!res.ok) throw new Error(`counter ${res.status}`);
  const body = await res.json();
  return Number(String(body.count ?? "0").replace(/\D/g, "")) || 0;   // "1,234" -> 1234
}

/** How every agent did on a daily Lineup file. Resolves to null if the numbers can't be read. */
export function lineupRecord(number, edition) {
  const key = `${number}:${edition}`;
  if (!cache.has(key)) {
    const p = prefix("lineup", number, edition);
    const bits = Array.from({ length: SUM_BITS }, (_, b) => 1 << b);
    cache.set(key, Promise.all([
      readCount(`${p}-finished`),
      readCount(`${p}-solved`),
      readCount(`${p}-within-8`),
      ...bits.map((v) => readCount(`${p}-sum-${v}`)),
    ]).then(([finished, solved, within8, ...sums]) => ({
      finished,
      solved,
      within8,
      totalGuesses: sums.reduce((acc, c, i) => acc + c * bits[i], 0),
    })).catch(() => null));
  }
  return cache.get(key);
}
