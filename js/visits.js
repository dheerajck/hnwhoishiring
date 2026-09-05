import { lastVisitKey } from "./config.js";

// Per-thread "last visited" timestamps, used to badge posts that appeared since the user
// last had that thread open. The threshold is frozen for the whole page session, so badges
// stay put while the app refreshes in the background and reset on the next visit.

let lastVisit = {};
try {
  lastVisit = JSON.parse(localStorage.getItem(lastVisitKey) || "{}") || {};
} catch {
  lastVisit = {};
}

const sessionThresholds = new Map(); // threadId -> ms timestamp of the previous visit, or null
let lastPersistAt = 0;

function persist() {
  try {
    localStorage.setItem(lastVisitKey, JSON.stringify(lastVisit));
    lastPersistAt = Date.now();
  } catch {
    /* storage full or disabled: badges simply will not persist */
  }
}

window.addEventListener("pagehide", persist);

export function getNewThreshold(threadId) {
  const key = String(threadId);
  if (!sessionThresholds.has(key)) {
    sessionThresholds.set(key, lastVisit[key] || null);
  }
  return sessionThresholds.get(key);
}

export function markThreadVisited(threadId) {
  if (!threadId) return;
  getNewThreshold(threadId); // freeze the pre-visit threshold before overwriting it
  lastVisit[String(threadId)] = Date.now();
  if (Date.now() - lastPersistAt > 30_000) persist();
}

export function isNewSinceLastVisit(comment, threadId) {
  const threshold = getNewThreshold(threadId);
  if (!threshold || !comment?.created_at_i) return false;
  return comment.created_at_i * 1000 > threshold;
}

export function countNewSinceLastVisit(comments, threadId) {
  if (!getNewThreshold(threadId)) return 0;
  let n = 0;
  for (const c of comments) if (isNewSinceLastVisit(c, threadId)) n++;
  return n;
}
