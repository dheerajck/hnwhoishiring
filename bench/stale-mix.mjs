// Stale-cache mix check. GitHub Pages serves every file with max-age=600, so for up to
// ten minutes after a deploy a visitor can run NEW index.html with a cached OLD js/css set,
// or OLD index.html with fresh NEW assets. Both mixes must still boot and render jobs.
//
//   node stale-mix.mjs                 # working tree vs origin/main
//   node stale-mix.mjs --against main  # any git ref
//
// Files that exist only in the new tree are served from it in every mix, because the
// server always has them; only files the browser could have cached are "old".

import { chromium } from "playwright";
import { execSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NEW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const against = args[args.indexOf("--against") + 1] || (args.includes("--against") ? null : "origin/main");
if (!against) {
  console.error("usage: node stale-mix.mjs [--against <git ref>]");
  process.exit(2);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

const OLD = fs.mkdtempSync(path.join(os.tmpdir(), "hn-stale-old-"));
execSync(`git worktree add --detach "${OLD}" ${against}`, { cwd: NEW, stdio: "ignore" });

try {
  const results = [];
  results.push(await checkMix("new HTML + old cached JS/CSS", { html: NEW, assets: OLD }));
  results.push(await checkMix("old cached HTML + new JS/CSS", { html: OLD, assets: NEW }));
  console.log(results.map((r) => r.line).join("\n"));
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
} finally {
  execSync(`git worktree remove --force "${OLD}"`, { cwd: NEW, stdio: "ignore" });
}

async function checkMix(name, { html, assets }) {
  const server = await serve((reqPath) => {
    if (reqPath === "/index.html") return path.join(html, "index.html");
    const cached = path.join(assets, reqPath);
    if (fs.existsSync(cached) && !fs.statSync(cached).isDirectory()) return cached;
    return path.join(NEW, reqPath); // only in the new tree: the server has it
  });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);
  });
  await page.route("**/*", (r) =>
    /goatcounter|zgo\.at/.test(r.request().url()) ? r.abort() : r.continue()
  );

  let cards = 0, afterSearch = -1;
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/?search=python`);
    await page.waitForFunction(
      () => /^Loaded /.test(document.getElementById("load-time-info")?.textContent || ""),
      null,
      { timeout: 45_000 }
    );
    await page.waitForFunction(
      () => new Promise((res) => {
        let last = -1;
        const tick = () => {
          const n = document.querySelectorAll("#jobs .job-card").length;
          if (n === last) return res(true);
          last = n;
          setTimeout(tick, 300);
        };
        tick();
      })
    );
    cards = await page.locator("#jobs .job-card:not([hidden])").count();
    await page.fill("#search", "remote");
    await page.waitForTimeout(600);
    afterSearch = await page.locator("#jobs .job-card:not([hidden])").count();
  } catch (e) {
    errors.push(e.message.split("\n")[0]);
  }

  await browser.close();
  server.close();

  const ok = cards > 0 && afterSearch > 0 && afterSearch !== cards && errors.length === 0;
  return {
    ok,
    line: `${ok ? "PASS" : "FAIL"} ${name}: ${cards} cards, ${afterSearch} after search` +
      (errors.length ? ` | ${errors.slice(0, 3).join("; ")}` : ""),
  };
}

function serve(resolve) {
  return new Promise((done) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (p.endsWith("/")) p += "index.html";
      const file = resolve(p);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        return res.end("not found");
      }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => done(server));
  });
}
