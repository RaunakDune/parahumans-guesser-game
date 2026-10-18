// Small helpers shared by the game. No dependencies.

/** Accent-, case- and punctuation-insensitive key, matching scripts/build_data.py */
export function fold(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** h("p", {class: "x", onclick: fn}, "text", childNode) */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value == null) continue;
    if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "class") node.className = value;
    else if (key === "html") node.innerHTML = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// ---------------------------------------------------------------- storage
const KEY = "parahumandle:v1";
let memory = {};

export const store = {
  load() {
    try {
      const raw = window.localStorage.getItem(KEY);
      memory = raw ? JSON.parse(raw) : {};
    } catch {
      memory = memory || {};
    }
    return memory;
  },
  save() {
    try { window.localStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* private mode: keep in memory */ }
  },
  get data() { return memory; },
};

// ---------------------------------------------------------------- schedule
const SCHEDULE_KEY = new TextEncoder().encode("brockton-bay");

export function decodeId(token) {
  try {
    const bytes = Uint8Array.from(atob(token), (c) => c.charCodeAt(0));
    const plain = bytes.map((b, i) => b ^ SCHEDULE_KEY[i % SCHEDULE_KEY.length]);
    return new TextDecoder().decode(plain);
  } catch {
    return "";
  }
}

/** Stable small hash for fallbacks. */
export function hash(text) {
  let x = 2166136261;
  for (let i = 0; i < text.length; i++) {
    x ^= text.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return x >>> 0;
}

// ---------------------------------------------------------------- dates
const DAY = 86400000;

/** Today's game date (YYYY-MM-DD) in the reset time zone, as a UTC-midnight timestamp. */
export function gameDay(offsetMinutes, now = Date.now()) {
  const shifted = new Date(now + offsetMinutes * 60000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
}

export function puzzleNumberFor(launchIso, offsetMinutes, now = Date.now()) {
  const launch = Date.parse(launchIso + "T00:00:00Z");
  return Math.max(1, Math.floor((gameDay(offsetMinutes, now) - launch) / DAY) + 1);
}

export function dateOfPuzzle(launchIso, number) {
  return new Date(Date.parse(launchIso + "T00:00:00Z") + (number - 1) * DAY);
}

export function shortDate(date) {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export function msUntilReset(offsetMinutes, now = Date.now()) {
  return gameDay(offsetMinutes, now) + DAY - (now + offsetMinutes * 60000);
}

export function formatCountdown(ms) {
  const total = Math.max(0, Math.round(ms / 60000));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return hours ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}m`;
}
