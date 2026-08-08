import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productFiles = [
  "views/index.ejs",
  "views/quick-task.ejs",
  "views/create-schedule.ejs",
  "views/edit-schedule.ejs",
  "views/partials/topbar.ejs",
  "public/scripts/index.js",
  "public/scripts/quick-task.js",
  "public/scripts/create-schedule.js",
  "public/scripts/edit-schedule.js",
];
const forbidden = [
  /D0\d\s*[—-]\s*/i,
  /M0\d\s*[—-]\s*/i,
  /Dashboard\s*\/\s*Today/i,
  /QUICK\s*\/\s*TASK/i,
  /Sprinkler\s+sys(?!tem)/i,
  /Living\s+Ya(?!rd)/i,
  /Connecting…/u,
  /Loading (?:schedules|history)…/u,
];

test("product copy excludes malformed Paper and debug fragments", async () => {
  for (const relative of productFiles) {
    const text = await fs.readFile(path.join(root, relative), "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${relative} contains ${pattern}`);
    }
  }
});

test("primary UI avoids decorative gradients and raster design assets", async () => {
  const css = await fs.readFile(path.join(root, "public/styles/app.css"), "utf8");
  assert.doesNotMatch(css, /(?:linear|radial|conic)-gradient\s*\(/i);
  const view = await fs.readFile(path.join(root, "views/index.ejs"), "utf8");
  assert.doesNotMatch(view, /<img\b|\.png\b|\.jpe?g\b/i);
});

test("primary UI exposes six zones while preserving backend source", async () => {
  for (const relative of [
    "public/scripts/quick-task-contract.js",
    "public/scripts/create-schedule.js",
    "public/scripts/edit-schedule.js",
  ]) {
    const text = await fs.readFile(path.join(root, relative), "utf8");
    assert.match(text, /(?:(?:VISIBLE_)?ZONE_COUNT\s*=|visibleZoneCount:)\s*6/, relative);
  }
  const app = await fs.readFile(path.join(root, "app.js"), "utf8");
  assert.doesNotMatch(app, /zones\s*=\s*zones\.filter\([^)]*[78]/, "backend must not discard zones 7–8");
});

test("both Quick Task entry points share the approved visible contract", async () => {
  const [contract, dashboardView, dedicatedView] = await Promise.all([
    fs.readFile(path.join(root, "public/scripts/quick-task-contract.js"), "utf8"),
    fs.readFile(path.join(root, "views/index.ejs"), "utf8"),
    fs.readFile(path.join(root, "views/quick-task.ejs"), "utf8"),
  ]);
  assert.match(contract, /durations:\s*Object\.freeze\(\[5,\s*15,\s*30,\s*60\]\)/);
  assert.match(contract, /defaultDuration:\s*15/);
  for (const source of [dashboardView, dedicatedView]) {
    assert.match(source, /Runs once, right now/i);
    assert.match(source, /Pick at least one zone to start · durations in minutes/i);
  }
  assert.doesNotMatch(`${contract}\n${dedicatedView}`, /(?:10|20|45)\s*(?:m|min|minutes|,|\])/);
});
