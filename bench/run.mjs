// Reproducible benchmark for the HN Who is Hiring frontend.
//
//   node run.mjs --record            # fetch real responses once, store as fixtures/
//   node run.mjs --label baseline    # replay fixtures with a synthetic network + CPU throttle
//   node run.mjs --label x --rtt 150 --mbps 4 --cpu 4 --runs 7
//
// Every network request (local files included, because GitHub Pages has latency too)
// is fulfilled after  RTT + bytes / bandwidth  milliseconds, so the metric is sensitive
// to request-chain depth and payload size and is not affected by the machine's network.

import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const INDEX_FILE = path.join(FIXTURES, "index.json");
const RESULTS = path.join(__dirname, "results");

// Largest recent thread (Feb 2026, 413 top-level posts) — used for the render benchmark.
const BIG_THREAD_ID = "46857488";

const args = parseArgs(process.argv.slice(2));
// --root lets you benchmark another checkout (e.g. a git worktree of an older commit).
const ROOT = args.root ? path.resolve(String(args.root)) : path.resolve(__dirname, "..");
const RECORD = !!args.record;
const LABEL = args.label || (RECORD ? "record" : `run-${Date.now()}`);
const RTT_MS = num(args.rtt, 100);
const MBPS = num(args.mbps, 5);
const CPU = num(args.cpu, 4);
const RUNS = num(args.runs, 1);
const HEADLESS = args.headed ? false : true;

const RENDER_QUERIES = [
  "",
  "python",
  "remote & ~us-based",
  "python | javascript & remote & ~us-based",
  '"machine learning"',
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

async function main() {
  const server = await startStaticServer(ROOT);
  const origin = `http://127.0.0.1:${server.port}`;
  const browser = await chromium.launch({ headless: HEADLESS });

  try {
    if (RECORD) {
      await record(browser, origin);
    } else {
      await benchmark(browser, origin);
    }
  } finally {
    await browser.close();
    server.close();
  }
}

// ---------------------------------------------------------------- record mode

async function record(browser, origin) {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const index = fs.existsSync(INDEX_FILE) ? readJson(INDEX_FILE) : {};
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.route("**/*", (route) => {
    if (isAnalytics(route.request().url())) return route.abort();
    return route.continue();
  });

  page.on("response", async (response) => {
    const url = response.url();
    if (url.startsWith(origin) || isAnalytics(url)) return;
    if (response.status() !== 200) return;
    try {
      const body = await response.body();
      const file = sha1(url) + ".gz";
      fs.writeFileSync(path.join(FIXTURES, file), zlib.gzipSync(body));
      index[url] = {
        file,
        contentType: response.headers()["content-type"] || "application/octet-stream",
        bytes: body.length,
        recordedAt: new Date().toISOString(),
      };
      console.log(`recorded ${body.length.toString().padStart(8)} B  ${url}`);
    } catch (e) {
      console.warn(`skip ${url}: ${e.message}`);
    }
  });

  await page.goto(`${origin}/`, { waitUntil: "load" });
  await page.waitForSelector("#jobs .job-card", { timeout: 60_000 });
  await waitForLoaded(page);

  // Also record the big thread so the render benchmark can load it offline.
  await page.evaluate(
    (id) => import("/js/thread-manager.js").then((m) => m.loadThread(id)),
    BIG_THREAD_ID
  );
  await waitForLoaded(page);

  // Let late resources (fonts) land.
  await page.waitForTimeout(1500);
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
  console.log(`\n${Object.keys(index).length} fixtures in ${FIXTURES}`);
  await context.close();
}

// ------------------------------------------------------------- benchmark mode

async function benchmark(browser, origin) {
  if (!fs.existsSync(INDEX_FILE)) {
    throw new Error("No fixtures. Run `node run.mjs --record` first.");
  }
  const index = readJson(INDEX_FILE);
  const fixtureCache = new Map();
  const missing = new Set();

  const config = { rtt_ms: RTT_MS, mbps: MBPS, cpu_throttle: CPU, runs: RUNS };
  console.log(`label=${LABEL}  ${JSON.stringify(config)}\n`);

  const cold = [];
  const warm = [];
  const renders = [];

  for (let i = 0; i < RUNS; i++) {
    const context = await browser.newContext();
    const netlog = attachNetwork(context, origin, index, fixtureCache, missing);

    // Cold: empty localStorage, first visit.
    const coldPage = await context.newPage();
    await throttleCpu(coldPage, CPU);
    await installObserver(coldPage);
    netlog.reset();
    await coldPage.goto(`${origin}/`);
    cold.push(await collectStartup(coldPage, netlog));

    // Warm: same context, app's own localStorage cache is populated now.
    await waitForLoaded(coldPage);
    await coldPage.close();

    const warmPage = await context.newPage();
    await throttleCpu(warmPage, CPU);
    await installObserver(warmPage);
    netlog.reset();
    await warmPage.goto(`${origin}/`);
    warm.push(await collectStartup(warmPage, netlog));
    await waitForLoaded(warmPage);

    renders.push(await collectRender(warmPage));

    await context.close();
    const c = cold[cold.length - 1], w = warm[warm.length - 1];
    console.log(
      `run ${i + 1}/${RUNS}: cold first card ${c.first_card_ms} ms (painted ${c.first_card_painted_ms}), ` +
        `warm ${w.first_card_ms} ms (painted ${w.first_card_painted_ms}), render done`
    );
  }

  const result = {
    label: LABEL,
    at: new Date().toISOString(),
    git: gitRev(),
    config,
    startup: {
      cold: summarizeStartup(cold),
      warm: summarizeStartup(warm),
    },
    render: summarizeRender(renders),
    missing_fixtures: [...missing],
    raw: { cold, warm, renders },
  };

  fs.mkdirSync(RESULTS, { recursive: true });
  const out = path.join(RESULTS, `${LABEL}.json`);
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  printReport(result);
  console.log(`\nsaved ${path.relative(process.cwd(), out)}`);
  if (missing.size) {
    console.log(`\nWARNING: ${missing.size} request(s) had no fixture and were aborted:`);
    for (const u of missing) console.log("  " + u);
  }
}

function attachNetwork(context, origin, index, fixtureCache, missing) {
  const log = { requests: [] };
  context.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    if (isAnalytics(url)) return route.abort();

    let body, contentType;
    if (url.startsWith(origin)) {
      const filePath = localPath(url, origin);
      if (!filePath) return route.fulfill({ status: 404, body: "not found" });
      body = fs.readFileSync(filePath);
      contentType = MIME[path.extname(filePath)] || "application/octet-stream";
    } else if (isNewerCommentsPoll(url)) {
      // "comments newer than <now>" — timestamp changes every run; the real API returns no hits.
      body = Buffer.from('{"hits":[],"nbHits":0,"page":0,"nbPages":0,"hitsPerPage":1000}');
      contentType = "application/json; charset=utf-8";
    } else {
      const entry = index[url] || findThreadListFixture(url, index);
      if (!entry) {
        missing.add(url);
        return route.abort();
      }
      if (!fixtureCache.has(url)) {
        let bytes = zlib.gunzipSync(fs.readFileSync(path.join(FIXTURES, entry.file)));
        if (entry.attributesToRetrieve) bytes = projectHits(bytes, entry.attributesToRetrieve);
        fixtureCache.set(url, bytes);
      }
      body = fixtureCache.get(url);
      contentType = entry.contentType;
    }

    const delay = RTT_MS + (body.length * 8) / (MBPS * 1000); // ms
    if (process.env.BENCH_DEBUG) console.log(`  ${String(body.length).padStart(8)} B  ${Math.round(delay)} ms  ${url}`);
    log.requests.push({ url, bytes: body.length, start: Date.now(), delay });
    await sleep(delay);
    await route.fulfill({ status: 200, body, headers: { "content-type": contentType } });
  });
  log.reset = () => {
    log.requests.length = 0;
  };
  return log;
}

async function collectStartup(page, netlog) {
  const t = await page.evaluate(async () => {
    const b = window.__bench;
    while (b.firstCardAt === null || b.firstCardPaintedAt === null)
      await new Promise((r) => setTimeout(r, 5));
    const nav = performance.getEntriesByType("navigation")[0];
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    return {
      first_card_ms: b.firstCardAt,
      first_card_painted_ms: b.firstCardPaintedAt,
      fcp_ms: fcp ? fcp.startTime : null,
      dcl_ms: nav ? nav.domContentLoadedEventEnd : null,
      first_card_wallclock: performance.timeOrigin + b.firstCardAt,
    };
  });
  const before = netlog.requests.filter((r) => r.start <= t.first_card_wallclock);
  return {
    first_card_ms: round(t.first_card_ms),
    first_card_painted_ms: round(t.first_card_painted_ms),
    fcp_ms: t.fcp_ms === null ? null : round(t.fcp_ms),
    dcl_ms: t.dcl_ms === null ? null : round(t.dcl_ms),
    requests_before_first_card: before.length,
    kb_before_first_card: round(before.reduce((s, r) => s + r.bytes, 0) / 1024),
  };
}

async function collectRender(page) {
  await page.evaluate(
    (id) => import("/js/thread-manager.js").then((m) => m.loadThread(id)),
    BIG_THREAD_ID
  );
  await waitForLoaded(page);
  await waitForCardsToSettle(page);

  return page.evaluate(async (queries) => {
    const ui = await import("/js/ui-render.js");
    const state = await import("/js/state.js");
    const input = document.getElementById("search");
    const REPEATS = 7;
    const nextFrame = () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const median = (a) => {
      const s = [...a].sort((x, y) => x - y);
      return s[Math.floor(s.length / 2)];
    };

    const out = { posts: state.allComments.length, queries: {} };
    for (const q of queries) {
      const js = [], frame = [];
      let matches = 0;
      for (let i = 0; i < REPEATS; i++) {
        // A real keystroke always changes the query, so reset to a different query first
        // (unmeasured) to make sure the measured render cannot reuse cached highlights.
        input.value = q === "" ? "reset" : "";
        ui.renderJobs(state.allComments);
        await nextFrame();

        input.value = q;
        const t0 = performance.now();
        ui.renderJobs(state.allComments);
        const t1 = performance.now();
        await nextFrame();
        const t2 = performance.now();
        js.push(t1 - t0);
        frame.push(t2 - t0);
        matches = document.querySelectorAll("#jobs .job-card:not([hidden])").length;
      }
      out.queries[q || "(empty)"] = {
        matches,
        js_ms: Math.round(median(js) * 10) / 10,
        frame_ms: Math.round(median(frame) * 10) / 10,
      };
    }
    input.value = "";
    return out;
  }, RENDER_QUERIES);
}

async function installObserver(page) {
  await page.addInitScript(() => {
    window.__bench = { firstCardAt: null, firstCardPaintedAt: null };
    const check = () => {
      if (window.__bench.firstCardAt === null && document.querySelector("#jobs .job-card")) {
        window.__bench.firstCardAt = performance.now();
        obs.disconnect();
        // rAF fires just before the next paint; a 0ms timeout after it lands just after.
        requestAnimationFrame(() =>
          setTimeout(() => (window.__bench.firstCardPaintedAt = performance.now()), 0)
        );
      }
    };
    const obs = new MutationObserver(check);
    const start = () => obs.observe(document.documentElement, { childList: true, subtree: true });
    if (document.documentElement) start();
    else document.addEventListener("readystatechange", start, { once: true });
  });
}

async function throttleCpu(page, rate) {
  if (!rate || rate <= 1) return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
}

// Cards may be mounted in chunks after "Loaded" is shown; wait until the count stops changing.
async function waitForCardsToSettle(page) {
  await page.waitForFunction(
    () =>
      new Promise((resolve) => {
        let last = -1;
        const tick = () => {
          const n = document.querySelectorAll("#jobs .job-card").length;
          if (n === last) return resolve(true);
          last = n;
          setTimeout(tick, 300);
        };
        tick();
      }),
    null,
    { timeout: 60_000 }
  );
}

async function waitForLoaded(page) {
  await page.waitForFunction(
    () => /^Loaded /.test(document.getElementById("load-time-info")?.textContent || ""),
    null,
    { timeout: 45_000 }
  );
}

// ------------------------------------------------------------------ reporting

function summarizeStartup(runs) {
  const keys = Object.keys(runs[0]);
  const out = {};
  for (const k of keys) {
    const vals = runs.map((r) => r[k]).filter((v) => v !== null);
    out[k] = vals.length ? median(vals) : null;
  }
  return out;
}

function summarizeRender(renders) {
  const out = { posts: renders[0].posts, queries: {} };
  for (const q of Object.keys(renders[0].queries)) {
    out.queries[q] = {
      matches: renders[0].queries[q].matches,
      js_ms: median(renders.map((r) => r.queries[q].js_ms)),
      frame_ms: median(renders.map((r) => r.queries[q].frame_ms)),
    };
  }
  return out;
}

function printReport(r) {
  console.log(`\n== startup (median of ${r.config.runs}) ==`);
  const rows = [["", "cold (first visit)", "warm (returning)"]];
  for (const k of ["first_card_ms", "first_card_painted_ms", "fcp_ms", "dcl_ms", "requests_before_first_card", "kb_before_first_card"]) {
    rows.push([k, fmt(r.startup.cold[k]), fmt(r.startup.warm[k])]);
  }
  table(rows);

  console.log(`\n== render (${r.render.posts} posts loaded, median of 7 x ${r.config.runs} runs) ==`);
  const rrows = [["query", "matches", "js ms", "to-frame ms"]];
  for (const [q, v] of Object.entries(r.render.queries)) {
    rrows.push([q, String(v.matches), fmt(v.js_ms), fmt(v.frame_ms)]);
  }
  table(rrows);
}

function table(rows) {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const r of rows) console.log("  " + r.map((c, i) => String(c).padEnd(w[i])).join("  "));
}

// -------------------------------------------------------------------- helpers

function startStaticServer(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const filePath = localPath(`http://x${req.url}`, "http://x");
      if (!filePath) {
        res.writeHead(404);
        return res.end("not found");
      }
      res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => {
      server.port = server.address().port;
      resolve(server);
    });
  });
}

function localPath(url, origin) {
  let p = decodeURIComponent(new URL(url).pathname);
  if (p.endsWith("/")) p += "index.html";
  const full = path.join(ROOT, p);
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return null;
  return full;
}

// A thread-list request whose exact URL was not recorded (e.g. the app added
// attributesToRetrieve) is served from the fixture with the same query+tags, and the
// hits are projected to the requested attributes the way Algolia would do it.
function findThreadListFixture(url, index) {
  const u = new URL(url);
  if (u.hostname !== "hn.algolia.com" || !u.pathname.endsWith("/search_by_date")) return null;
  const q = u.searchParams.get("query");
  const tags = u.searchParams.get("tags");
  if (!q || !tags) return null;
  for (const [recordedUrl, entry] of Object.entries(index)) {
    const r = new URL(recordedUrl);
    if (r.hostname === u.hostname && r.searchParams.get("query") === q && r.searchParams.get("tags") === tags) {
      const attrs = u.searchParams.get("attributesToRetrieve");
      // The HN proxy keeps _highlightResult unless attributesToHighlight is "none" or "[]"
      // (an empty value is ignored; a list keeps highlights for those attributes).
      const highlight = u.searchParams.get("attributesToHighlight");
      const keepHighlight = !(highlight === "none" || highlight === "[]");
      if (!attrs) return entry;
      const keep = attrs.split(",");
      if (keepHighlight) keep.push("_highlightResult");
      return { ...entry, attributesToRetrieve: keep };
    }
  }
  return null;
}

function projectHits(bytes, attrs) {
  const data = JSON.parse(bytes.toString("utf8"));
  const keep = new Set([...attrs, "objectID"]);
  data.hits = data.hits.map((h) => Object.fromEntries(Object.entries(h).filter(([k]) => keep.has(k))));
  return Buffer.from(JSON.stringify(data));
}

function isNewerCommentsPoll(url) {
  return url.includes("hn.algolia.com") && url.includes("numericFilters=created_at_i");
}

function isAnalytics(url) {
  return url.includes("goatcounter.com") || url.includes("gc.zgo.at");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined ? n : d;
}
function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function round(n) {
  return Math.round(n * 10) / 10;
}
function fmt(v) {
  return v === null || v === undefined ? "-" : String(v);
}
function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
function gitRev() {
  try {
    return (
      fs.readFileSync(path.join(ROOT, ".git", "HEAD"), "utf8").trim().replace("ref: ", "")
    );
  } catch {
    return null;
  }
}
