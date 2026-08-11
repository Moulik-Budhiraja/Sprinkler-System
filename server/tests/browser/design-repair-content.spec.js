import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { intersects, rectOf } from "./design-repair-utils.js";

test.afterEach(async ({ request }) => {
  await request.post("/__test/reset");
});

async function seedHistory(page, count) {
  const reasons = ["Remote", "Schedule", "Manual"];
  for (let i = 0; i < count; i += 1) {
    const response = await page.request.post("/api/history/create", {
      data: {
        zones: i % 3 === 0 ? [1, 4] : [(i % 6) + 1],
        event: i % 2 ? "Stopped" : "Started",
        reason: reasons[i % reasons.length],
      },
    });
    expect(response.ok()).toBe(true);
  }
}

const PRIMARY_PATTERN = /^Zones? [\d, and]+ (started|stopped|outcome unknown)$/i;
const META_PATTERN = /^(Remote|Schedule|Manual|Completed|Home Assistant|Controller) · .+$/;

for (const width of [320, 390, 430]) {
  test(`history rows read as one phrase with attached source metadata at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await page.waitForSelector("[data-history-row]");
    const rows = page.locator("[data-history-row]");
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const row = rows.nth(i);
      const primary = row.locator(".history-primary");
      const meta = row.locator(".history-meta");
      await expect(primary, `row ${i} has one coherent primary phrase`).toHaveCount(1);
      await expect(meta, `row ${i} keeps source and time attached`).toHaveCount(1);
      await expect(primary).toHaveText(PRIMARY_PATTERN);
      await expect(meta).toHaveText(META_PATTERN);
      // The source never orphans onto its own detached grid line: metadata
      // starts within the same visual row block, directly under or beside
      // the primary phrase.
      const primaryBox = await rectOf(primary);
      const metaBox = await rectOf(meta);
      const rowBox = await rectOf(row);
      expect(metaBox.y - primaryBox.y, `row ${i} metadata stays with its phrase`).toBeLessThanOrEqual(primaryBox.height + 12);
      expect(metaBox.bottom, `row ${i} metadata inside its row`).toBeLessThanOrEqual(rowBox.bottom + 0.5);
      const clipped = await row.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
      expect(clipped, `row ${i} clips horizontally`).toBe(false);
    }
    // The status glyph is decorative; the words carry the state.
    await expect(page.locator("[data-history-row] .history-icon[aria-hidden=true]").first()).toBeAttached();
    const scan = await new AxeBuilder({ page }).analyze();
    expect(scan.violations).toEqual([]);
  });
}

test("activity page groups by real date and keeps the same coherent row grammar", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedHistory(page, 24);
  await page.goto("/activity");
  await page.waitForSelector("[data-history-row]");
  await expect(page.locator("[data-history-date]").first()).toBeVisible();
  const rows = page.locator("[data-history-row]");
  expect(await rows.count()).toBeGreaterThanOrEqual(24);
  await expect(rows.first().locator(".history-primary")).toHaveText(PRIMARY_PATTERN);
  await expect(rows.first().locator(".history-meta")).toHaveText(META_PATTERN);
});

test("history text stays intact at a 200% zoom equivalent width", async ({ page }) => {
  await page.setViewportSize({ width: 195, height: 422 });
  await page.goto("/");
  await page.waitForSelector("[data-history-row]");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "no sideways scrolling at zoomed width").toBe(0);
  await expect(page.locator("[data-history-row] .history-primary").first()).toBeVisible();
  await expect(page.locator("[data-history-row] .history-meta").first()).toBeVisible();
});

test("Today schedule rows are 44px semantic links into the exact schedule", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.waitForSelector("#schedules [data-schedule-row]");
  const links = page.locator("#schedules a[data-schedule-link]");
  const count = await links.count();
  expect(count, "every Today schedule row navigates").toBeGreaterThanOrEqual(2);
  for (let i = 0; i < count; i += 1) {
    const link = links.nth(i);
    await expect(link).toHaveAttribute("href", /^\/schedules#.+/);
    const box = await rectOf(link);
    expect(box.height, `schedule row ${i} target height`).toBeGreaterThanOrEqual(44);
  }
  await expect(page.locator("[data-dashboard-section=schedules] a[href='/schedules']")).toHaveText("All schedules");
});

/* Back must restore the Today context — the linked Schedules section back
 * in view at the prior scroll offset — at DESKTOP widths too, where the
 * shorter document defeats native restoration (it runs against the
 * pre-hydration page). Two trials per viewport, both engines. */
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
]) {
  test(`activating a Today schedule row highlights it and Back restores the Today context at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    for (let trial = 0; trial < 2; trial += 1) {
      await page.goto("/");
      await page.waitForSelector("#schedules [data-schedule-row]");
      await page.evaluate(() => {
        const section = document.querySelector("[data-dashboard-section=schedules]");
        window.scrollTo(0, section.getBoundingClientRect().top + window.scrollY - 60);
      });
      await page.waitForTimeout(80);
      const beforeScroll = await page.evaluate(() => window.scrollY);
      expect(beforeScroll, `trial ${trial}: page actually scrolled before navigating`).toBeGreaterThan(50);
      const secondLink = page.locator("#schedules a[data-schedule-link]").nth(1);
      const href = await secondLink.getAttribute("href");
      const targetId = decodeURIComponent(href.split("#")[1]);
      await secondLink.click();
      await expect(page).toHaveURL(new RegExp(`/schedules#${targetId}$`));
      await page.waitForSelector(".schedule-data-row");
      const target = page.locator(`[data-schedule-row="${targetId}"]`);
      await expect(target).toHaveClass(/is-highlighted/);
      await expect.poll(() => page.evaluate((id) => document.activeElement?.id === id, targetId),
        { message: "the exact schedule row receives keyboard focus" }).toBe(true);
      const box = await rectOf(target);
      expect(box.y).toBeGreaterThanOrEqual(-1);
      expect(box.bottom).toBeLessThanOrEqual(viewport.height + 1);
      await page.goBack();
      await expect(page).toHaveURL(/\/$/);
      // The restored context must put the user back where they were: the
      // prior offset (±40px) with the Schedules section in the viewport.
      await expect.poll(() => page.evaluate(() => window.scrollY), {
        message: `trial ${trial}: Back restores the Today scroll offset`,
        timeout: 7000,
      }).toBeGreaterThan(beforeScroll - 40);
      const restoredScroll = await page.evaluate(() => window.scrollY);
      expect(Math.abs(restoredScroll - beforeScroll),
        `trial ${trial}: restored offset close to the original`).toBeLessThanOrEqual(40);
      const sectionBox = await rectOf(page.locator("[data-dashboard-section=schedules]"));
      expect(sectionBox.y < viewport.height && sectionBox.bottom > 0,
        `trial ${trial}: the linked Schedules section is back in view`).toBe(true);
    }
  });
}

test("keyboard users can reach and activate a Today schedule link", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.waitForSelector("#schedules [data-schedule-row]");
  const first = page.locator("#schedules a[data-schedule-link]").first();
  await first.focus();
  await expect(first).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/schedules#/);
});

for (const width of [320, 390, 430]) {
  test(`Today scrolls as one document with history reachable above the fixed navigation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await page.waitForSelector("[data-history-row]");
    const model = await page.evaluate(() => ({
      bodyOverflowY: getComputedStyle(document.body).overflowY,
      mainOverflowY: getComputedStyle(document.querySelector("main")).overflowY,
      navPosition: getComputedStyle(document.querySelector(".mobile-nav")).position,
      documentScrollable: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    }));
    expect(model.bodyOverflowY, "body is not an overflow trap").not.toBe("hidden");
    expect(model.mainOverflowY, "main is not a nested scroll pane").toBe("visible");
    expect(model.navPosition, "bottom navigation stays fixed above the document").toBe("fixed");
    expect(model.documentScrollable, "the document itself scrolls").toBe(true);
    // Scrolling the document reaches every history row and the refresh
    // control, all clear of the fixed navigation band.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(50);
    const nav = await rectOf(page.locator(".mobile-nav"));
    const lastRow = await rectOf(page.locator("[data-history-row]").last());
    expect(lastRow.bottom, "history rows never hide under the navigation").toBeLessThanOrEqual(nav.y + 0.5);
    const refresh = await rectOf(page.getByRole("button", { name: "Refresh controller status" }));
    expect(refresh.bottom, "refresh control never hides under the navigation").toBeLessThanOrEqual(nav.y + 0.5);
  });
}

test("activity route scrolls the whole feed within the document and survives reload", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedHistory(page, 24);
  await page.goto("/activity");
  await page.waitForSelector("[data-history-row]");
  const model = await page.evaluate(() => ({
    mainOverflowY: getComputedStyle(document.querySelector("main")).overflowY,
    documentScrollable: document.documentElement.scrollHeight > document.documentElement.clientHeight,
  }));
  expect(model.mainOverflowY).toBe("visible");
  expect(model.documentScrollable, "the full feed makes the document scrollable").toBe(true);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(50);
  const nav = await rectOf(page.locator(".mobile-nav"));
  const lastRow = await rectOf(page.locator("[data-history-row]").last());
  expect(lastRow.bottom, "the oldest visible event stays reachable").toBeLessThanOrEqual(nav.y + 0.5);
  await page.reload();
  await page.waitForSelector("[data-history-row]");
  expect(await page.locator("[data-history-row]").count()).toBeGreaterThanOrEqual(24);
});

test("history error state stays truthful", async ({ page }) => {
  await page.route("**/api/history*", (route) => route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: "synthetic history failure" }),
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("#history")).toContainText("History unavailable");
});

test("desktop Quick Task island reserves scroll clearance only while open and never traps History metadata", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  await page.waitForSelector("[data-history-row]");
  const paddingOf = () => page.locator(".shell.dashboard")
    .evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingBottom));
  // Closed: only the shell's ordinary 48px base padding — no island-sized
  // dead gap.
  expect(await paddingOf(), "closed island leaves no dead scroll gap").toBeLessThanOrEqual(60);
  // Open: the reserved clearance matches the island so every non-field row
  // — including History source/time metadata and the refresh control — can
  // scroll fully clear of it.
  await page.getByRole("button", { name: /Zone 3.*idle/i }).click();
  const island = page.locator("[data-testid=quick-task-island]");
  await expect(island).toBeVisible();
  const islandBox = await rectOf(island);
  expect(await paddingOf(), "open island reserves at least its own height")
    .toBeGreaterThanOrEqual(900 - islandBox.y - 4);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(50);
  const islandTop = (await rectOf(island)).y;
  const lastMeta = await rectOf(page.locator("[data-history-row] .history-meta").last());
  expect(lastMeta.bottom, "History source/time metadata scrolls clear of the open island")
    .toBeLessThanOrEqual(islandTop + 0.5);
  const refresh = await rectOf(page.getByRole("button", { name: "Refresh controller status" }));
  expect(refresh.bottom, "refresh control scrolls clear of the open island").toBeLessThanOrEqual(islandTop + 0.5);
  // Closed again: the clearance is released.
  await page.getByRole("button", { name: /Close Quick Task/i }).click();
  await expect(island).toBeHidden();
  expect(await paddingOf(), "closing the island releases the clearance").toBeLessThanOrEqual(60);
});

for (const layout of [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "mobile", viewport: { width: 390, height: 844 } },
]) {
  test(`skip link presents a 44px target and lands on main content at ${layout.name}`, async ({ page }) => {
    await page.setViewportSize(layout.viewport);
    await page.goto("/");
    const skip = page.locator(".skip-link");
    await expect(skip).toHaveCount(1);
    // Target size holds in every state, not only under :focus styling.
    const resting = await rectOf(skip);
    expect(resting.height, `${layout.name} skip link resting target height`).toBeGreaterThanOrEqual(44);
    expect(resting.width, `${layout.name} skip link resting target width`).toBeGreaterThanOrEqual(44);
    await skip.focus();
    const focused = await rectOf(skip);
    expect(focused.height, `${layout.name} skip link focused target height`).toBeGreaterThanOrEqual(44);
    expect(focused.width, `${layout.name} skip link focused target width`).toBeGreaterThanOrEqual(44);
    expect(focused.x, `${layout.name} focused skip link is on-screen`).toBeGreaterThanOrEqual(0);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main$/);
  });
}

/* Short desktop windows (≈150% browser zoom on a laptop): the fixed Quick
 * Task island must NEVER cover the field, any silhouette, activation
 * region, or an anchored Stop/Remove dock — at any window height. The
 * audited failure: at 900×520 the island swallowed 54/81 hit-test points
 * of the queued zone-6 Remove control. */

/* Every essential Quick Task element must be visibly rendered, fully on
 * screen, inside the island's visible box, pointer-reachable, readable,
 * and (for controls) a 44px target. Returns violations so the sliver
 * sensitivity control can drive the SAME predicate. */
async function islandUsabilityViolations(page) {
  return page.evaluate(() => {
    const island = document.querySelector("[data-testid=quick-task-island]");
    if (!island || island.hidden) return ["island missing or hidden"];
    const violations = [];
    const rect = island.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 130: just under the island's natural ~139px height; the sliver was ~10-40px.
    if (rect.height < 130) violations.push(`island squeezed to ${rect.height.toFixed(1)}px`);
    if (rect.top < -0.5 || rect.bottom > vh + 0.5 || rect.left < -0.5 || rect.right > vw + 0.5) {
      violations.push("island not fully on screen");
    }
    const essentials = [
      ["heading", island.querySelector(".qt-heading")],
      ["context", island.querySelector(".qt-context")],
      ["zone summary", island.querySelector("[data-testid=quick-task-zones]")],
      ["hint", island.querySelector(".qt-hint")],
      ["Close", island.querySelector(".qt-close")],
      ...[...island.querySelectorAll(".qt-duration")].map((el, i) => [`duration ${i}`, el]),
      ["Start", island.querySelector(".qt-start")],
    ];
    for (const [name, el] of essentials) {
      if (!el) { violations.push(`${name} missing`); continue; }
      const r = el.getBoundingClientRect();
      if (r.height < 10 || r.width < 10) { violations.push(`${name} collapsed`); continue; }
      if (r.top < -0.5 || r.bottom > vh + 0.5 || r.left < -0.5 || r.right > vw + 0.5) {
        violations.push(`${name} off screen`);
        continue;
      }
      if (r.top < rect.top - 0.5 || r.bottom > rect.bottom + 0.5) {
        violations.push(`${name} clipped out of the island box`);
        continue;
      }
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !island.contains(hit)) violations.push(`${name} not pointer-reachable`);
      const fontSize = Number.parseFloat(getComputedStyle(el).fontSize);
      if (fontSize && fontSize < 9.5) violations.push(`${name} text too small (${fontSize}px)`);
    }
    for (const [name, el] of [["Close", island.querySelector(".qt-close")], ["Start", island.querySelector(".qt-start")]]) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 43.5 || r.height < 43.5) violations.push(`${name} target ${r.width.toFixed(0)}x${r.height.toFixed(0)} below 44px`);
    }
    return violations;
  });
}

for (const size of [
  { width: 900, height: 520 },
  { width: 900, height: 560 },
  { width: 900, height: 600 },
  { width: 1000, height: 560 },
  { width: 1280, height: 720 },
  { width: 1440, height: 700 },
  { width: 1440, height: 900 },
]) {
  test(`open island never covers the field or its docks at ${size.width}x${size.height}`, async ({ page, browserName }) => {
    await page.setViewportSize(size);
    await page.goto("/");
    await page.waitForSelector("[data-testid=field-zone-6]");
    const now = Math.floor(Date.now() / 1000);
    await page.request.post("/__test/controller", { data: { mode: "online", tasks: [
      { id: "shared-14", zones: [1, 4], runTime: 20, startTime: now - 240 },
      { id: "run-2", zones: [2], runTime: 15, startTime: now - 60 },
      { id: "run-5", zones: [5], runTime: 15, startTime: now - 120 },
      { id: "queued-6", zones: [6], runTime: 10, startTime: 0 },
    ] } });
    await page.getByRole("button", { name: "Refresh controller status" }).click();
    await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(4);
    await expect(page.locator("[data-testid=zone-remove]")).toHaveCount(1);
    await page.getByRole("button", { name: /Zone 3.*idle/i }).click();
    const island = page.locator("[data-testid=quick-task-island]");
    await expect(island).toBeVisible();
    await page.waitForTimeout(120);
    // Geometry: the island stays strictly clear of the whole field.
    const islandBox = await rectOf(island);
    const fieldBox = await rectOf(page.locator("[data-testid=field]"));
    expect(intersects(islandBox, fieldBox),
      `island covers the field at ${size.width}x${size.height}`).toBe(false);
    // Hit-testing: every sampled point of the queued Remove control resolves
    // to the control, never to the island.
    const hitGrid = async () => page.evaluate(() => {
      const control = document.querySelector("[data-testid=zone-remove]");
      const rect = control.getBoundingClientRect();
      let islandHits = 0;
      let controlHits = 0;
      for (let ix = 0; ix < 9; ix += 1) {
        for (let iy = 0; iy < 9; iy += 1) {
          const x = rect.left + ((ix + 0.5) / 9) * rect.width;
          const y = rect.top + ((iy + 0.5) / 9) * rect.height;
          const node = document.elementFromPoint(x, y);
          if (!node) continue;
          if (node.closest("[data-testid=quick-task-island]")) islandHits += 1;
          else if (node.closest("[data-testid=zone-remove]")) controlHits += 1;
        }
      }
      return { islandHits, controlHits };
    });
    const hits = await hitGrid();
    expect(hits.islandHits, `island occludes Remove hit points at ${size.width}x${size.height}`).toBe(0);
    expect(hits.controlHits, "the Remove control receives its own hit points").toBeGreaterThanOrEqual(60);
    // Usability is absolute alongside never-cover: every essential island
    // element visibly rendered, on screen, reachable and readable — a thin
    // empty sliver is a failure even though it covers nothing.
    expect(await islandUsabilityViolations(page), `island fully usable at ${size.width}x${size.height}`)
      .toEqual([]);
    // Interaction works while open: choosing a duration reflects
    // immediately, and Start is keyboard reachable.
    const thirty = island.getByRole("button", { name: "30 minutes" });
    await thirty.click();
    await expect(thirty).toHaveAttribute("aria-pressed", "true");
    const start = island.getByRole("button", { name: "Start", exact: true });
    await start.focus();
    await expect(start).toBeFocused();
    // Scroll and focus freedom while open (WCAG 2.4.11): nothing may pin
    // the viewport. scrollTo/Home/wheel-up must genuinely reach the top,
    // revealing the heading and the top zone row.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.scrollY),
      `scrollTo(0,0) reaches the top while open at ${size.width}x${size.height}`).toBeLessThanOrEqual(1);
    const h1Box = await rectOf(page.getByRole("heading", { name: "Today" }));
    expect(h1Box.y, "Today heading on screen at the top").toBeGreaterThanOrEqual(-0.5);
    const zone1Box = await rectOf(page.locator("[data-testid=field-zone-1]"));
    expect(zone1Box.y, "zone 1 fully on screen at the top").toBeGreaterThanOrEqual(-0.5);
    if (browserName === "chromium") {
      // Wheel-up freedom from a scrolled position (wheel input is
      // Chromium-only in this harness; scrollTo/focus cover WebKit).
      await page.evaluate(() => window.scrollTo(0, 300));
      await page.waitForTimeout(100);
      await page.mouse.move(size.width / 2, 200);
      for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, -400);
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => window.scrollY), "wheel-up reaches the top").toBeLessThanOrEqual(1);
      await page.evaluate(() => { window.scrollTo(0, 300); document.activeElement?.blur?.(); });
      // Give the document real keyboard focus context (the heading is
      // non-interactive), then Home must reach the top.
      await page.getByRole("heading", { name: "Today" }).click();
      await page.keyboard.press("Home");
      await page.waitForTimeout(150);
      expect(await page.evaluate(() => window.scrollY), "Home reaches the top").toBeLessThanOrEqual(1);
    }
    // Focus reachability: focusing a top-row zone brings it fully into
    // view instead of leaving it clipped above the viewport.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.locator("[data-testid=field-zone-2] .field-zone").evaluate((node) => node.focus());
    await page.waitForTimeout(150);
    const zone2Box = await rectOf(page.locator("[data-testid=field-zone-2]"));
    expect(zone2Box.y, "focused zone 2 never clipped above the viewport").toBeGreaterThanOrEqual(-0.5);
    // Never-cover still true wherever the user scrolled to.
    expect(intersects(await rectOf(island), await rectOf(page.locator("[data-testid=field]"))),
      "island never covers the field after free scrolling").toBe(false);
    // The open island stays discoverable/usable: scrolling back to it
    // restores full usability with no-cover intact.
    await island.evaluate((node) => node.scrollIntoView({ block: "nearest" }));
    await page.waitForTimeout(150);
    expect(await islandUsabilityViolations(page), "island usable again after returning to it").toEqual([]);
    expect(intersects(await rectOf(island), await rectOf(page.locator("[data-testid=field]"))),
      "no-cover after returning to the island").toBe(false);
    // Sensitivity control: reintroduce a scroll floor and prove the same
    // free-scroll probe detects the trap; then remove it.
    await page.evaluate(() => {
      window.__scrollTrap = () => { if (window.scrollY < 120) window.scrollTo(0, 120); };
      window.addEventListener("scroll", window.__scrollTrap);
      window.scrollTo(0, 120);
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.scrollY),
      "the free-scroll probe detects a reintroduced trap").toBeGreaterThan(1);
    await page.evaluate(() => {
      window.removeEventListener("scroll", window.__scrollTrap);
      delete window.__scrollTrap;
      window.scrollTo(0, 0);
    });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "no horizontal overflow with the island open").toBe(0);
    expect((await rectOf(island)).right, "island inside the viewport").toBeLessThanOrEqual(size.width + 0.5);
    // Sensitivity control: translate the island directly over the Remove
    // control (transform is outside the placement clamp's management, so
    // the production auto-correction cannot silently undo the fault) and
    // prove the same hit-grid predicate detects the occlusion; restore.
    const removeBox = await rectOf(page.locator("[data-testid=zone-remove]"));
    const currentIsland = await rectOf(island);
    await island.evaluate((node, delta) => {
      node.style.transform = `translate(${delta.dx}px, ${delta.dy}px)`;
    }, { dx: removeBox.x - 20 - currentIsland.x, dy: removeBox.y - 10 - currentIsland.y });
    const forced = await hitGrid();
    expect(forced.islandHits, "the hit-grid predicate detects a forced occlusion").toBeGreaterThan(0);
    await island.evaluate((node) => { node.style.transform = ""; });
    // Sensitivity control 2: recreate the pre-repair bottom-edge sliver and
    // prove the SAME usability predicate detects it, then restore.
    await island.evaluate((node) => {
      const r = node.getBoundingClientRect();
      node.style.transform = `translateY(${Math.max(0, window.innerHeight - r.top - 10)}px)`;
    });
    expect((await islandUsabilityViolations(page)).length,
      "the usability predicate detects the sliver state").toBeGreaterThan(0);
    await island.evaluate((node) => { node.style.transform = ""; });
  });
}

/* Mobile / short-layout island occlusion (audited P1): below 900px the
 * island previously stayed FIXED above the nav and, at rest, fully
 * covered running zones' Stop valves and the queued Remove — the
 * never-cover contract applies at every width. These scenarios pin the
 * page at scroll 0 (no scrolling the defect away) and hit-test every
 * anchored control. */
for (const size of [
  { width: 195, height: 422 },
  { width: 390, height: 400 },
  { width: 844, height: 390 },
  { width: 720, height: 450 },
]) {
  test(`open island never covers field or docks on mobile/short layout ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/");
    await page.waitForSelector("[data-testid=field-zone-6]");
    const now = Math.floor(Date.now() / 1000);
    await page.request.post("/__test/controller", { data: { mode: "online", tasks: [
      { id: "shared-14", zones: [1, 4], runTime: 20, startTime: now - 240 },
      { id: "run-2", zones: [2], runTime: 15, startTime: now - 60 },
      { id: "run-5", zones: [5], runTime: 15, startTime: now - 120 },
      { id: "queued-6", zones: [6], runTime: 10, startTime: 0 },
    ] } });
    await page.getByRole("button", { name: "Refresh controller status" }).click();
    await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(4);
    await expect(page.locator("[data-testid=zone-remove]")).toHaveCount(1);
    await page.getByRole("button", { name: /Zone 3.*idle/i }).click();
    const island = page.locator("[data-testid=quick-task-island]");
    await expect(island).toBeVisible();
    await page.waitForTimeout(150);
    // Pin the audited scenario: page at scroll 0.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.scrollY), "scroll pinned to 0 for the occlusion check")
      .toBeLessThanOrEqual(1);
    // Every anchored Stop/Remove control receives its own hit points; the
    // island steals none of them at rest.
    const controlGrid = async (zone) => page.evaluate((zone) => {
      const control = document.querySelector(`[data-testid=field-zone-${zone}] .zone-dock button`);
      const rect = control.getBoundingClientRect();
      const navRect = document.querySelector(".mobile-nav")?.getBoundingClientRect();
      let islandHits = 0;
      let selfHits = 0;
      let offscreen = 0;
      for (let ix = 0; ix < 9; ix += 1) {
        for (let iy = 0; iy < 9; iy += 1) {
          const x = rect.left + ((ix + 0.5) / 9) * rect.width;
          const y = rect.top + ((iy + 0.5) / 9) * rect.height;
          if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
            offscreen += 1;
            continue;
          }
          // Points under the fixed bottom nav are reachable by scrolling
          // (asserted by the nav-clearance contracts) — like offscreen,
          // they are not island occlusion.
          if (navRect && x >= navRect.left && x <= navRect.right && y >= navRect.top && y <= navRect.bottom) {
            offscreen += 1;
            continue;
          }
          const node = document.elementFromPoint(x, y);
          if (!node) continue;
          if (node.closest("[data-testid=quick-task-island]")) islandHits += 1;
          else if (node.closest(".zone-dock")) selfHits += 1;
        }
      }
      return { islandHits, selfHits, offscreen };
    }, zone);
    for (const zone of [1, 2, 4, 5, 6]) {
      const hits = await controlGrid(zone);
      expect(hits.islandHits, `zone ${zone} control occluded by the island at ${size.width}x${size.height}`)
        .toBe(0);
      // On-screen portions of the control must actually be the control.
      expect(hits.selfHits + hits.offscreen, `zone ${zone} control hit integrity`)
        .toBeGreaterThanOrEqual(60);
    }
    // The island never intersects the field at rest.
    expect(intersects(await rectOf(island), await rectOf(page.locator("[data-testid=field]"))),
      "island never covers the field at rest").toBe(false);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "no horizontal overflow").toBe(0);
    // The open island stays reachable and usable via natural scrolling.
    await island.evaluate((node) => node.scrollIntoView({ block: "nearest" }));
    await page.waitForTimeout(150);
    expect(await islandUsabilityViolations(page), "island usable after scrolling to it").toEqual([]);
    // No trap: the top is freely reachable again.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.scrollY), "no scroll trap while open").toBeLessThanOrEqual(1);
    // Sensitivity control: translate the island over zone 2's Stop control
    // (measured geometry) and prove the same grid predicate detects it.
    const stopBox = await rectOf(page.locator("[data-testid=field-zone-2] .zone-dock button"));
    const islandBox = await rectOf(island);
    await island.evaluate((node, delta) => {
      node.style.transform = `translate(${delta.dx}px, ${delta.dy}px)`;
    }, { dx: stopBox.x - islandBox.x, dy: stopBox.y - islandBox.y });
    const forced = await controlGrid(2);
    expect(forced.islandHits, "the grid predicate detects a forced island occlusion").toBeGreaterThan(0);
    await island.evaluate((node) => { node.style.transform = ""; });
  });
}

/* Docked-island vs fixed mobile nav layering (audited P3): at short mobile
 * heights the document-anchored island's z-index outranked the fixed nav,
 * painting over the destinations whenever ordinary scrolling brought the
 * island across the nav band. The nav must always stay on top of scrolling
 * document content, and every destination must remain pointer-reachable. */
for (const size of [
  { width: 390, height: 568 },
  { width: 390, height: 640 },
  { width: 320, height: 700 },
  { width: 430, height: 740 },
]) {
  test(`docked island never paints over the fixed mobile nav at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/");
    await page.waitForSelector("[data-testid=field-zone-6]");
    const now = Math.floor(Date.now() / 1000);
    await page.request.post("/__test/controller", { data: { mode: "online", tasks: [
      { id: "shared-14", zones: [1, 4], runTime: 20, startTime: now - 240 },
      { id: "run-2", zones: [2], runTime: 15, startTime: now - 60 },
      { id: "queued-6", zones: [6], runTime: 10, startTime: 0 },
    ] } });
    await page.getByRole("button", { name: "Refresh controller status" }).click();
    await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(3);
    await page.getByRole("button", { name: /Zone 3.*idle/i }).click();
    const island = page.locator("[data-testid=quick-task-island]");
    await expect(island).toBeVisible();
    await page.waitForTimeout(150);
    // These heights cannot fit the fixed island above the nav: docked mode
    // must be active, so the island scrolls with the document.
    await expect(island, `island is document-anchored at ${size.width}x${size.height}`)
      .toHaveClass(/qt-island-docked/);
    const navBox = await rectOf(page.locator(".mobile-nav"));
    // Ordinary scrolling: position the page so the island crosses the nav
    // band (this is exactly what happens while scrolling back to the top).
    const islandDocTop = await island.evaluate((node) => node.getBoundingClientRect().top + window.scrollY);
    const overlapScroll = Math.max(0, Math.round(islandDocTop - size.height + 58 + 30));
    await page.evaluate((y) => window.scrollTo(0, y), overlapScroll);
    await page.waitForTimeout(120);
    expect(intersects(await rectOf(island), navBox),
      "scenario: the island crosses the nav band at this scroll position").toBe(true);
    // Every destination stays painted on top and pointer-reachable.
    const stolen = await page.evaluate(() => {
      const results = [];
      for (const link of document.querySelectorAll(".mobile-nav a")) {
        const rect = link.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        if (!hit || !hit.closest(".mobile-nav")) results.push(link.textContent.trim() || "link");
      }
      return results;
    });
    expect(stolen, "nav destinations never hidden behind the docked island").toEqual([]);
    // Scroll-to-top variant: if the island still crosses the nav band at
    // the top, the same contract holds there.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(120);
    if (intersects(await rectOf(island), navBox)) {
      const stolenAtTop = await page.evaluate(() => {
        const results = [];
        for (const link of document.querySelectorAll(".mobile-nav a")) {
          const rect = link.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          if (!hit || !hit.closest(".mobile-nav")) results.push(link.textContent.trim() || "link");
        }
        return results;
      });
      expect(stolenAtTop, "nav destinations stay on top at scroll 0 too").toEqual([]);
    }
    // Navigation genuinely works from the overlap state.
    await page.evaluate((y) => window.scrollTo(0, y), overlapScroll);
    await page.waitForTimeout(120);
    await page.locator(".mobile-nav").getByRole("link", { name: "Status", exact: true }).click({ timeout: 3000 });
    await expect(page).toHaveURL(/\/status$/);
  });
}
