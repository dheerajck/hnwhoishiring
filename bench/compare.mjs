// node compare.mjs baseline after   -> side-by-side table with % change
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");
const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error("usage: node compare.mjs <labelA> <labelB>");
  process.exit(1);
}
const A = JSON.parse(fs.readFileSync(path.join(dir, `${a}.json`), "utf8"));
const B = JSON.parse(fs.readFileSync(path.join(dir, `${b}.json`), "utf8"));

const rows = [["metric", a, b, "change"]];
for (const mode of ["cold", "warm"]) {
  for (const k of Object.keys(A.startup[mode])) {
    rows.push([`startup.${mode}.${k}`, ...delta(A.startup[mode][k], B.startup[mode][k])]);
  }
}
for (const q of Object.keys(A.render.queries)) {
  for (const k of ["js_ms", "frame_ms"]) {
    rows.push([`render[${q}].${k}`, ...delta(A.render.queries[q]?.[k], B.render.queries[q]?.[k])]);
  }
}
const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(w[i])).join("  "));
console.log(`\nconfig A: ${JSON.stringify(A.config)}\nconfig B: ${JSON.stringify(B.config)}`);
if (JSON.stringify(A.config) !== JSON.stringify(B.config)) console.log("WARNING: configs differ");

function delta(x, y) {
  if (x == null || y == null) return ["-", "-", "-"];
  const pct = x === 0 ? 0 : ((y - x) / x) * 100;
  const sign = pct > 0 ? "+" : "";
  return [String(x), String(y), `${sign}${pct.toFixed(1)}%`];
}
