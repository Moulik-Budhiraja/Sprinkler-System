import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(serverRoot, "..");
const trackedDirectory = path.join(repositoryRoot, "screenshots", "v4-local");
const writeArtifacts = process.argv.includes("--write");
const outputArgument = process.argv.find((value) => value.startsWith("--output="));
const outputDirectory = writeArtifacts
  ? trackedDirectory
  : outputArgument?.slice("--output=".length) || await fs.mkdtemp(path.join(os.tmpdir(), "sprinkler-release-screenshots-"));
const port = 4289;
const origin = `http://127.0.0.1:${port}`;
/* Five semantically distinct artifacts: every entry declares its own
 * (view, state, dimensions) tuple and captures a genuinely different image.
 * - full-window: the desktop viewport as rendered.
 * - full-document: the complete mobile document with the nav made static.
 * - device-fold: the real above-the-fold device view with the live fixed
 *   navigation, at that device's own viewport height.
 * - state "zone-selected": the lowest idle zone selected, so the selection
 *   outline, check badge and contextual Quick Task island are visible. */
/* Each artifact declares the text that is actually visible INSIDE its own
 * captured region — verified per capture, so the manifest never claims
 * content (e.g. the desktop-only "Living Yard" brand, or below-the-fold
 * "History") that a device-fold image cannot contain. */
const artifactSpecs = [
  { name: "desktop-1440-copy.png", viewport: { width: 1440, height: 900 }, dimensions: { width: 1440, height: 900 }, view: "full-window", state: "default",
    requiredVisibleText: ["Living Yard", "Sprinkler system", "Today", "Status", "Schedules", "History", "Morning lawn", "Zones 1, 2 started"] },
  { name: "desktop-1440-standalone.png", viewport: { width: 1440, height: 900 }, dimensions: { width: 1440, height: 900 }, view: "full-window", state: "zone-selected",
    requiredVisibleText: ["Living Yard", "Sprinkler system", "Today", "Schedules", "History", "Quick Task", "Start"] },
  { name: "mobile-844-copy.png", viewport: { width: 390, height: 844 }, dimensions: { width: 390, height: 1135 }, view: "full-document", state: "default",
    requiredVisibleText: ["Sprinkler system", "Today", "Status", "Schedules", "History", "Morning lawn", "Zones 1, 2 started"] },
  { name: "mobile-1067-copy.png", viewport: { width: 390, height: 1067 }, dimensions: { width: 390, height: 1067 }, view: "device-fold", state: "default",
    requiredVisibleText: ["Sprinkler system", "Today", "Status", "Schedules", "Morning lawn"] },
  { name: "mobile-390x844-standalone.png", viewport: { width: 390, height: 844 }, dimensions: { width: 390, height: 844 }, view: "device-fold", state: "zone-selected",
    requiredVisibleText: ["Sprinkler system", "Quick Task", "Start", "Schedules", "Today"] },
];
const forbiddenText = ["10m", "20m", "Morning lawnEnabled", "Started · Zones 1, 2Schedule", "Living YardSprinkler system", "D01 — Dashboard"];

async function waitForHealth(child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assert.equal(child.exitCode, null, "demo server exited before readiness");
    try {
      const response = await fetch(`${origin}/healthz`, { cache: "no-store" });
      if (response.ok) {
        assert.deepEqual(await response.json(), { ok: true, mode: "synthetic" });
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("demo server did not become ready");
}

async function post(pathname, body) {
  const response = await fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
  assert.ok(response.ok, `${pathname} seed returned ${response.status}: ${await response.text()}`);
}

function intersect(a, b) {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
}

const child = spawn(process.execPath, ["app.js"], {
  cwd: serverRoot,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "production",
    SPRINKLER_DEMO: "1",
    SPRINKLER_PUBLIC_ORIGIN: origin,
    HOST: "127.0.0.1",
    PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
child.stdout.on("data", (chunk) => { serverOutput += chunk; });
child.stderr.on("data", (chunk) => { serverOutput += chunk; });
let browser;
try {
  await waitForHealth(child);
  await post("/api/schedules/create", {
    requestId: "00000000-0000-4000-8000-000000000001",
    name: "Morning lawn",
    days: [1, 3, 5],
    startTime: "06:30",
    tasks: [{ zones: [1, 2], runTime: 15 }],
  });
  await post("/api/history/create", { zones: [1, 2], event: "Started", reason: "Schedule" });
  const controllerResponse = await fetch(`${origin}/api/tasks`, { cache: "no-store" });
  assert.ok(controllerResponse.ok, `controller snapshot returned ${controllerResponse.status}`);
  const controllerSnapshot = await controllerResponse.json();
  const runningTask = controllerSnapshot.tasks.find((task) => task.startTime > 0);
  assert.ok(runningTask, "deterministic capture requires one running synthetic task");
  const fixedNowMs = (runningTask.startTime + 240) * 1000;
  await fs.mkdir(outputDirectory, { recursive: true });
  browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-gpu",
      "--disable-lcd-text",
      "--font-render-hinting=none",
      "--force-color-profile=srgb",
      "--hide-scrollbars",
    ],
  });
  const results = [];
  for (const spec of artifactSpecs) {
    const context = await browser.newContext({
      viewport: spec.viewport,
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "dark",
      serviceWorkers: "block",
    });
    await context.addInitScript((fixedNowMs) => {
      Date.now = () => fixedNowMs;
    }, fixedNowMs);
    const page = await context.newPage();
    const runtimeProblems = [];
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type())) runtimeProblems.push(`console ${message.type()}: ${message.text()}`);
    });
    page.on("pageerror", (error) => runtimeProblems.push(`pageerror: ${error.message}`));
    page.on("requestfailed", (request) => runtimeProblems.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));
    await page.goto(`${origin}/`, { waitUntil: "networkidle" });
    await page.addStyleTag({ content: `
      *, *::before, *::after {
        animation: none !important;
        caret-color: transparent !important;
        transition: none !important;
      }
      input, textarea, [contenteditable="true"] { caret-color: transparent !important; }
      html { font-synthesis: none; }
      ` });
    if (spec.view === "full-document") {
      // Only the full-document capture linearizes the page; device-fold
      // artifacts keep the real fixed navigation.
      await page.addStyleTag({ content: `
      @media (max-width: 899px) {
        body { display: block !important; height: auto !important; min-height: 100% !important; overflow: visible !important; }
        .shell { overflow: visible !important; }
        .mobile-nav { position: static !important; }
      }
      ` });
    }
    await page.locator("[data-testid=field-zone-6]").waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.querySelector("#mobileControllerStatus")?.textContent === "Controller online");
    await page.waitForFunction(() => document.querySelector("#schedules")?.innerText.includes("Morning lawn") && /started/i.test(document.querySelector("#history")?.innerText || ""));
    if (spec.state === "zone-selected") {
      // Deterministic selection: the lowest idle zone (frozen demo state).
      await page.locator(".field-zone[aria-label*='idle']").first().click();
      await page.locator("[data-testid=quick-task-island]").waitFor({ state: "visible" });
      await page.waitForFunction(() => {
        const anchor = document.querySelector(".field-zone-wrap.is-selected .char-anchor");
        return anchor && Number.parseFloat(getComputedStyle(anchor).opacity) === 1;
      });
    }
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });

    const semantic = await page.evaluate(({ requiredText, forbiddenText }) => {
      const bodyText = document.body.innerText;
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const clipping = [...document.querySelectorAll("h1,h2,a,button,label,.schedule-row > *, .history-row > *")]
        .filter(visible)
        .filter((element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
        .map((element) => element.textContent.trim());
      const textBoxes = [...document.querySelectorAll("#schedules .schedule-row > *, #history .history-row > *")]
        .filter(visible)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { text: element.textContent.trim(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        });
      return {
        bodyText,
        forbidden: forbiddenText.filter((text) => bodyText.includes(text)),
        clipping,
        textBoxes,
        presets: [...document.querySelectorAll("#quickDurations button")].map((button) => button.textContent.trim()),
        quickTaskIslandHidden: document.querySelector("[data-testid=quick-task-island]")?.hidden === true,
        statusLinks: [...document.querySelectorAll('a[href="/status"]')].filter(visible).length,
        navigationOverlap: (() => {
          const main = document.querySelector("main")?.getBoundingClientRect();
          const nav = document.querySelector(".mobile-nav")?.getBoundingClientRect();
          if (!main || !nav || getComputedStyle(document.querySelector(".mobile-nav")).display === "none") return false;
          return Math.min(main.right, nav.right) - Math.max(main.left, nav.left) > 0.5 &&
            Math.min(main.bottom, nav.bottom) - Math.max(main.top, nav.top) > 0.5;
        })(),
      };
    }, { forbiddenText });
    assert.deepEqual(semantic.forbidden, [], `${spec.name} stale or malformed text`);
    // Per-artifact truth: every declared string must be visibly rendered
    // INSIDE this artifact's clip region, and the checker itself must be
    // able to detect absence (decoy control).
    const missingWithinClip = (texts) => page.evaluate(({ texts, clip }) => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const withinClip = (rect) => rect.right > clip.x + 1 && rect.left < clip.x + clip.width - 1 &&
        rect.bottom > clip.y + 1 && rect.top < clip.y + clip.height - 1;
      // Deepest element containing the full string (icons/spans inside
      // links keep the parent as the match target).
      const matches = (element, text) => {
        if (!(element.textContent || "").includes(text)) return false;
        for (const child of element.children) {
          if ((child.textContent || "").includes(text)) return false;
        }
        return true;
      };
      return texts.filter((text) => ![...document.querySelectorAll("body *")]
        .some((element) => matches(element, text) &&
          visible(element) && withinClip(element.getBoundingClientRect())));
    }, { texts, clip: { x: 0, y: 0, width: spec.dimensions.width, height: spec.dimensions.height } });
    assert.deepEqual(await missingWithinClip(spec.requiredVisibleText), [],
      `${spec.name} declared text visible within its captured region`);
    const decoy = await missingWithinClip(["__DECOY_TEXT_NEVER_PRESENT__"]);
    assert.equal(decoy.length, 1, `${spec.name} in-clip checker detects absent text (DECOY control)`);
    assert.deepEqual(semantic.clipping, [], `${spec.name} clipped visible text`);
    assert.deepEqual(semantic.presets, ["5m", "15m", "30m", "60m"], `${spec.name} authoritative presets`);
    assert.equal(semantic.quickTaskIslandHidden, spec.state === "default",
      `${spec.name} contextual Quick Task island matches its declared state`);
    assert.ok(semantic.statusLinks >= 1, `${spec.name} visible Status navigation`);
    if (spec.view === "device-fold") {
      const nav = await page.evaluate(() => {
        const node = document.querySelector(".mobile-nav");
        const rect = node.getBoundingClientRect();
        return { position: getComputedStyle(node).position, bottom: rect.bottom };
      });
      assert.equal(nav.position, "fixed", `${spec.name} device-fold keeps the live fixed navigation`);
      assert.ok(Math.abs(nav.bottom - spec.viewport.height) <= 0.5, `${spec.name} navigation pinned to the fold`);
    } else {
      assert.equal(semantic.navigationOverlap, false, `${spec.name} mobile navigation outside content flow`);
    }
    if (spec.view === "full-document") {
      const documentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      assert.equal(spec.dimensions.height, documentHeight, `${spec.name} complete mobile document height`);
    }
    for (let left = 0; left < semantic.textBoxes.length; left += 1) {
      for (let right = left + 1; right < semantic.textBoxes.length; right += 1) {
        assert.equal(intersect(semantic.textBoxes[left], semantic.textBoxes[right]), false,
          `${spec.name} copy overlap: ${semantic.textBoxes[left].text} / ${semantic.textBoxes[right].text}`);
      }
    }
    assert.deepEqual(runtimeProblems, [], `${spec.name} clean runtime`);

    const session = await context.newCDPSession(page);
    const capture = await session.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: spec.dimensions.width, height: spec.dimensions.height, scale: 1 },
    });
    const bytes = Buffer.from(capture.data, "base64");
    const destination = path.join(outputDirectory, spec.name);
    await fs.writeFile(destination, bytes);
    results.push({
      name: spec.name,
      route: "/",
      view: spec.view,
      state: spec.state,
      requiredVisibleText: spec.requiredVisibleText,
      viewport: spec.viewport,
      dimensions: spec.dimensions,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
    await context.close();
  }
  console.log(JSON.stringify({ mode: writeArtifacts ? "write" : "read-only output", origin, outputDirectory, artifacts: results }, null, 2));
} finally {
  await browser?.close();
  if (child.exitCode === null) child.kill("SIGTERM");
  // The losing timeout must not keep the event loop alive after a clean
  // child exit: clear it once the race settles either way.
  let cleanupTimer;
  try {
    await Promise.race([
      new Promise((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once("exit", resolve);
      }),
      new Promise((_, reject) => {
        cleanupTimer = setTimeout(() => reject(new Error(`demo server cleanup timed out: ${serverOutput}`)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(cleanupTimer);
  }
}
