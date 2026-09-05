// Functional smoke test of the job list UI against the live API (search, filters, exclude,
// favorites, applied, keyboard nav, thread switch). Run: npm run smoke
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
const ignorable = (t) => t.includes("ERR_FAILED"); // the analytics request we abort ourselves
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.route("**/*", (r) => (r.request().url().includes("goatcounter") || r.request().url().includes("zgo.at")) ? r.abort() : r.continue());

const results = [];
const check = (name, ok, extra = "") => { results.push(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`); };
const visibleCards = () => page.locator("#jobs .job-card:not([hidden])");
const settle = async () => { await page.waitForFunction(() => /^Loaded /.test(document.getElementById("load-time-info").textContent)); await page.waitForTimeout(1500); };

await page.goto(origin + "/");
await settle();
const total = await page.locator("#jobs .job-card").count();
check("all cards mounted after chunked build", total > 100, `(${total})`);
check("all visible with no query", (await visibleCards().count()) === total);

// search filters in place, cards persist
const firstCard = page.locator("#jobs .job-card").first();
const firstId = await firstCard.getAttribute("data-job-id");
await page.fill("#search", "remote");
await page.waitForTimeout(600);
const remoteCount = await visibleCards().count();
check("search reduces visible cards", remoteCount > 0 && remoteCount < total, `(${remoteCount}/${total})`);
check("cards not rebuilt (same total in DOM)", (await page.locator("#jobs .job-card").count()) === total);
check("highlight applied to visible cards", (await page.locator("#jobs .job-card:not([hidden]) .search-match").count()) > 0);
check("status shows search count", (await page.textContent("#load-time-info")).includes(`Search results: ${remoteCount}`));

// unsaved note text survives a search
await page.fill("#search", "");
await page.waitForTimeout(600);
await page.locator(`.job-card[data-job-id="${firstId}"] textarea.note`).fill("draft note");
await page.fill("#search", "python");
await page.waitForTimeout(600);
await page.fill("#search", "");
await page.waitForTimeout(600);
check("unsaved note text survives searching", (await page.inputValue(`.job-card[data-job-id="${firstId}"] textarea.note`)) === "draft note");
check("highlights removed when query cleared", (await page.locator("#jobs .search-match").count()) === 0);

// no matches -> empty state
await page.fill("#search", "zzzzqqqqxxxx");
await page.waitForTimeout(600);
check("empty state shown", (await page.locator("#jobs .loading:not([hidden])").count()) === 1 && (await visibleCards().count()) === 0);
await page.fill("#search", "");
await page.waitForTimeout(600);
check("empty state hidden again", (await page.locator("#jobs .loading:not([hidden])").count()) === 0);

// exclude hides the card and moves focus to the next visible one
const second = page.locator("#jobs .job-card:not([hidden])").nth(1);
const secondId = await second.getAttribute("data-job-id");
await page.locator(`.job-card[data-job-id="${firstId}"] .btn-remove`).click();
await page.waitForTimeout(300);
check("excluded card hidden", await page.locator(`.job-card[data-job-id="${firstId}"]`).evaluate((el) => el.hidden));
check("focus moved to next card", (await page.evaluate(() => document.activeElement?.dataset?.jobId)) === secondId);
check("visible count dropped by one", (await visibleCards().count()) === total - 1);

// Show Excluded -> only the excluded card, with a Restore button; restore brings it back
await page.click("#showHidden");
await page.waitForTimeout(300);
check("show-excluded lists only excluded", (await visibleCards().count()) === 1);
check("restore button present", (await page.locator(`.job-card[data-job-id="${firstId}"] .btn-unhide`).count()) === 1);
await page.locator(`.job-card[data-job-id="${firstId}"] .btn-unhide`).click();
await page.waitForTimeout(300);
check("restored card leaves excluded view", (await visibleCards().count()) === 0);
await page.click("#showHidden");
await page.waitForTimeout(300);
check("all visible after restore", (await visibleCards().count()) === total);
check("exclude button back on restored card", (await page.locator(`.job-card[data-job-id="${firstId}"] .btn-remove`).count()) === 1);

// favorites filter + unfavorite in place
await page.locator(`.job-card[data-job-id="${secondId}"] .star-btn`).click();
await page.click("#showFavorites");
await page.waitForTimeout(300);
check("favorites filter shows one", (await visibleCards().count()) === 1);
await page.locator(`.job-card[data-job-id="${secondId}"] .star-btn`).click();
await page.waitForTimeout(300);
check("unfavorite removes from favorites view", (await visibleCards().count()) === 0);
await page.click("#showFavorites");
await page.waitForTimeout(300);

// applied in place
await page.locator(`.job-card[data-job-id="${secondId}"] .btn-apply`).click();
await page.waitForTimeout(200);
check("applied badge shown", (await page.locator(`.job-card[data-job-id="${secondId}"] .badge-applied`).count()) === 1);
await page.click("#hideApplied");
await page.waitForTimeout(300);
check("hide-applied hides it", await page.locator(`.job-card[data-job-id="${secondId}"]`).evaluate((el) => el.hidden));
await page.click("#hideApplied");
await page.waitForTimeout(300);

// j/k skip hidden cards
await page.fill("#search", "remote");
await page.waitForTimeout(600);
await page.keyboard.press("Escape");
await page.evaluate(() => document.activeElement.blur());
await page.keyboard.press("j");
await page.keyboard.press("j");
check("j lands on a visible card", await page.evaluate(() => document.activeElement?.classList.contains("job-card") && !document.activeElement.hidden));

// switching thread rebuilds
await page.fill("#search", "");
await page.locator(".month-selector button").nth(1).click();
await settle();
const total2 = await page.locator("#jobs .job-card").count();
check("other month loads its own cards", total2 > 50 && total2 !== total, `(${total2})`);
const realErrors = errors.filter((e) => !ignorable(e));
check("no page errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

console.log(results.join("\n"));
await browser.close();
server.close();
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
