import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

function intersects(a, b) {
  return Math.min(a.right, b.right) - Math.max(a.x, b.x) > 0.5 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 0.5;
}

async function rect(locator) {
  return locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
  });
}

test.afterEach(async ({ request }) => {
  await request.post("/__test/reset");
});

const viewports = [
  { width: 1440, height: 900 },
  { width: 320, height: 844 },
  { width: 390, height: 844 },
  { width: 390, height: 1067 },
];

for (const viewport of viewports) {
  test(`Today shows no Quick Task controls before a field selection at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.waitForSelector("[data-testid=field-zone-6]");
    // No in-flow Quick Task section participates in the document flow.
    const order = await page.locator("main > [data-dashboard-section]").evaluateAll((nodes) => nodes.map((node) => node.dataset.dashboardSection));
    expect(order).toEqual(["field", "schedules", "history"]);
    // The contextual island exists only as a hidden overlay with zero flow participation.
    const island = page.locator("[data-testid=quick-task-island]");
    await expect(island).toBeHidden();
    await expect(page.getByRole("button", { name: "Start", exact: true })).toBeHidden();
    await expect(page.getByText("Runs once, right now", { exact: true })).toBeHidden();
    await expect(page.getByText("Pick at least one zone to start · durations in minutes", { exact: true })).toBeHidden();
    // The island never sits in normal flow, hidden or not.
    const overlayPosition = await island.evaluate((node) => getComputedStyle(node).position);
    expect(["absolute", "fixed"]).toContain(overlayPosition);
  });
}

async function sectionGeometry(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    };
    return {
      field: rect("[data-testid=field]"),
      schedules: rect("[data-dashboard-section=schedules]"),
      history: rect("[data-dashboard-section=history]"),
      mobileNav: rect(".mobile-nav"),
      main: rect("main"),
      zoneWraps: [...document.querySelectorAll("[data-zone-wrapper]")].map((wrap) => {
        const r = wrap.getBoundingClientRect();
        return [wrap.dataset.zoneWrapper, r.x, r.y, r.width, r.height];
      }),
    };
  });
}

for (const viewport of viewports) {
  test(`island reveal and dismiss never shift visible sections at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.waitForSelector("[data-testid=field-zone-6]");
    // Every visible section keeps its exact position and size while the
    // island opens and closes. The document may grow only at its very end,
    // and by EXACTLY the dashboard's own reserved open-state clearance (the
    // padding delta the .quick-task-open class applies — 162px on desktop,
    // 0 on mobile): nothing else may add height anywhere.
    const stable = ({ main, ...sections }) => ({ ...sections, mainTop: main && [main[0], main[1], main[2]] });
    const mainHeight = (geometry) => geometry.main?.[3] ?? 0;
    const paddingOf = () => page.locator(".shell.dashboard")
      .evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingBottom));
    const hidden = await sectionGeometry(page);
    const closedPadding = await paddingOf();
    await page.getByRole("button", { name: /Zone 1.*idle/i }).click();
    await expect(page.locator("[data-testid=quick-task-island]")).toBeVisible();
    const visible = await sectionGeometry(page);
    const openPadding = await paddingOf();
    const reserved = openPadding - closedPadding;
    expect(stable(visible)).toEqual(stable(hidden));
    expect(reserved, "reserved clearance is bounded").toBeLessThanOrEqual(220);
    expect(reserved, "reserved clearance never shrinks the document").toBeGreaterThanOrEqual(0);
    expect(Math.abs(mainHeight(visible) - mainHeight(hidden) - reserved),
      "open island grows the document tail by exactly the reserved clearance")
      .toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: /Zone 3.*idle/i }).click();
    const multi = await sectionGeometry(page);
    expect(stable(multi)).toEqual(stable(hidden));
    expect(Math.abs(mainHeight(multi) - mainHeight(hidden) - reserved),
      "multi selection never adds further height").toBeLessThanOrEqual(1);
    // Sensitivity control: rogue extra clearance breaks the exact bound
    // (the old >= check accepted any growth at all).
    const rogueGrowth = await page.evaluate(() => {
      const dashboard = document.querySelector(".shell.dashboard");
      const main = document.querySelector("main");
      const before = main.getBoundingClientRect().height;
      dashboard.style.paddingBottom = `${Number.parseFloat(getComputedStyle(dashboard).paddingBottom) + 300}px`;
      const after = main.getBoundingClientRect().height;
      dashboard.style.paddingBottom = "";
      return after - before;
    });
    expect(Math.abs(rogueGrowth), "the exact-growth bound detects rogue clearance").toBeGreaterThan(220);
    await page.getByRole("button", { name: /Close Quick Task/i }).click();
    await expect(page.locator("[data-testid=quick-task-island]")).toBeHidden();
    const dismissed = await sectionGeometry(page);
    expect(dismissed).toEqual(hidden);
    expect(await paddingOf(), "dismissal releases the reserved clearance").toBeCloseTo(closedPadding, 0);
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`selecting an idle field sprinkler reveals the Quick Task island at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.waitForSelector("[data-testid=field-zone-6]");
    await page.getByRole("button", { name: /Zone 1.*idle/i }).click();
    const island = page.locator("[data-testid=quick-task-island]");
    await expect(island).toBeVisible();
    await expect(island.locator("[data-testid=quick-task-zones]")).toHaveText("Zone 1");
    await expect(island.getByText("Runs once, right now", { exact: true })).toBeVisible();
    const presets = await island.locator(".qt-duration").allTextContents();
    expect(presets.map((text) => Number.parseInt(text, 10))).toEqual([5, 15, 30, 60]);
    await expect(island.getByRole("button", { name: "15 minutes" })).toHaveAttribute("aria-pressed", "true");
    const start = island.getByRole("button", { name: "Start", exact: true });
    await expect(start).toBeEnabled();
    await expect(island.getByRole("button", { name: /Close Quick Task/i })).toBeVisible();
    // Selection is exposed as a truthful toggle on the real field control.
    await expect(page.getByRole("button", { name: /Zone 1.*idle/i })).toHaveAttribute("aria-pressed", "true");
  });
}

test("selection highlight hugs each sprinkler silhouette, not a rectangular card", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  await page.getByRole("button", { name: /Zone 1.*idle/i }).click();
  await page.getByRole("button", { name: /Zone 5.*idle/i }).click();
  for (const zone of [1, 5]) {
    const wrap = page.locator(`[data-testid=field-zone-${zone}]`);
    await expect(wrap).toHaveClass(/is-selected/);
    await expect.poll(() => wrap.locator("[data-selection-outline]").evaluate((node) => Number.parseFloat(getComputedStyle(node).opacity))).toBeGreaterThanOrEqual(0.9);
    const styling = await wrap.evaluate((node) => {
      const outline = node.querySelector("[data-selection-outline]");
      const button = node.querySelector(".field-zone");
      const wrapStyle = getComputedStyle(node);
      const buttonStyle = getComputedStyle(button);
      return {
        outlineOpacity: Number.parseFloat(getComputedStyle(outline).opacity),
        // The outline is built from the exact silhouette shapes, dilated by
        // stroke — never a standalone rectangle, card or hand-drawn blob.
        outlineShapeCount: outline.querySelectorAll(".outline-keyline rect, .outline-keyline polygon").length,
        bodyShapeCount: node.querySelectorAll(".c-riser,.c-collar,.c-head,.c-nozzle,.c-skirt").length,
        forbiddenContent: outline.querySelectorAll("text,.char-spray,.c-shadow").length,
        wrapBackground: wrapStyle.backgroundColor,
        wrapOutline: wrapStyle.outlineStyle,
        wrapBorder: wrapStyle.borderStyle,
        buttonBackground: buttonStyle.backgroundColor,
        buttonOutline: buttonStyle.outlineStyle,
        buttonBorder: buttonStyle.borderStyle,
      };
    });
    expect(styling.outlineOpacity, `zone ${zone} outline traces the silhouette`).toBeGreaterThanOrEqual(0.9);
    expect(styling.outlineShapeCount, `zone ${zone} outline derives from the silhouette parts`).toBe(styling.bodyShapeCount);
    expect(styling.forbiddenContent, `zone ${zone} outline excludes spray, shadow and labels`).toBe(0);
    // Nothing rectangular carries the highlight.
    expect(styling.wrapBackground).toBe("rgba(0, 0, 0, 0)");
    expect(styling.wrapOutline).toBe("none");
    expect(styling.wrapBorder).toBe("none");
    expect(styling.buttonBackground).toBe("rgba(0, 0, 0, 0)");
    expect(styling.buttonOutline).toBe("none");
    expect(styling.buttonBorder).toBe("none");
  }
  const unselected = page.locator("[data-testid=field-zone-2]");
  await expect(unselected).not.toHaveClass(/is-selected/);
  expect(await unselected.locator("[data-selection-outline]").evaluate((node) => Number.parseFloat(getComputedStyle(node).opacity))).toBe(0);
});

test("multiple idle sprinklers toggle into and out of one truthful selection", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  const summary = page.locator("[data-testid=quick-task-zones]");
  await page.getByRole("button", { name: /Zone 1.*idle/i }).click();
  await expect(summary).toHaveText("Zone 1");
  await page.getByRole("button", { name: /Zone 3.*idle/i }).click();
  await expect(summary).toHaveText("Zones 1 and 3");
  await page.getByRole("button", { name: /Zone 5.*idle/i }).click();
  await expect(summary).toHaveText("Zones 1, 3 and 5");
  // Toggling an already-selected sprinkler removes only that zone.
  await page.getByRole("button", { name: /Zone 3.*idle/i }).click();
  await expect(summary).toHaveText("Zones 1 and 5");
  await expect(page.getByRole("button", { name: /Zone 3.*idle/i })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: /Zone 1.*idle/i }).click();
  await page.getByRole("button", { name: /Zone 5.*idle/i }).click();
  await expect(page.locator("[data-testid=quick-task-island]")).toBeHidden();
});

test("running and queued zones keep Stop/Remove semantics and never join the contextual selection", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  // Activating the running zone traces its status — never the island; its
  // own anchored Stop control is already present.
  await page.getByRole("button", { name: /Zone 4.*watering/i }).click();
  await expect(page.getByRole("button", { name: /^Stop watering/i })).toBeVisible();
  await expect(page.locator("[data-testid=quick-task-island]")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-testid=field-zone-4]")).not.toHaveClass(/is-selected/);
  // With an idle selection active, the running/queued zones still answer with
  // their own truthful controls and the selection is unchanged.
  await page.getByRole("button", { name: /Zone 1.*idle/i }).click();
  const summary = page.locator("[data-testid=quick-task-zones]");
  await expect(summary).toHaveText("Zone 1");
  await page.getByRole("button", { name: /Zone 4.*watering/i }).click();
  await expect(page.getByRole("button", { name: /^Stop watering/i })).toBeVisible();
  await expect(summary).toHaveText("Zone 1");
  await expect(page.getByRole("button", { name: /Zone 4.*watering/i })).not.toHaveAttribute("aria-pressed", /.*/);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Zone 6.*queued/i }).click();
  await expect(page.getByRole("button", { name: /^Remove queued task/i })).toBeVisible();
  await expect(summary).toHaveText("Zone 1");
  await expect(page.locator("[data-testid=quick-task-island]")).toBeVisible();
});

for (const viewport of [{ width: 320, height: 844 }, { width: 390, height: 844 }, { width: 390, height: 1067 }]) {
  test(`mobile island clears navigation and safe area without obscuring field controls at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.waitForSelector("[data-testid=field-zone-6]");
    await page.getByRole("button", { name: /Zone 2.*idle/i }).click();
    await page.getByRole("button", { name: /Zone 3.*idle/i }).click();
    const island = page.locator("[data-testid=quick-task-island]");
    await expect(island).toBeVisible();
    const islandBox = await rect(island);
    const nav = await rect(page.locator(".mobile-nav"));
    const field = await rect(page.locator("[data-testid=field]"));
    // Fully on screen, above the bottom navigation (which carries the
    // safe-area inset), and clear of the whole field surface.
    expect(islandBox.x).toBeGreaterThanOrEqual(0);
    expect(islandBox.right).toBeLessThanOrEqual(viewport.width);
    expect(islandBox.y).toBeGreaterThanOrEqual(0);
    expect(islandBox.bottom).toBeLessThanOrEqual(nav.y - 8);
    expect(intersects(islandBox, field), "island must not cover the field").toBe(false);
    for (const zone of [2, 3]) {
      expect(intersects(islandBox, await rect(page.locator(`[data-testid=field-zone-${zone}]`))), `island must not cover selected zone ${zone}`).toBe(false);
    }
    // Island controls stay usable targets with no clipped content.
    for (const control of await island.locator("button").all()) {
      const bounds = await rect(control);
      expect(bounds.width, "island control width").toBeGreaterThanOrEqual(44);
      expect(bounds.height, "island control height").toBeGreaterThanOrEqual(44);
      expect(bounds.x).toBeGreaterThanOrEqual(islandBox.x);
      expect(bounds.right).toBeLessThanOrEqual(islandBox.right);
    }
    const clips = await island.evaluate((node) => [...node.querySelectorAll("*")]
      .filter((child) => child.scrollWidth > child.clientWidth + 1 || child.scrollHeight > child.clientHeight + 1).length);
    expect(clips, "island content unclipped").toBe(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "no horizontal overflow with island open").toBe(0);
    // Stop control for the running zone remains fully usable alongside the island.
    await page.getByRole("button", { name: /Zone 4.*watering/i }).click();
    const stop = page.getByRole("button", { name: /^Stop watering/i });
    await expect(stop).toBeVisible();
    expect(intersects(islandBox, await rect(stop)), "island must not cover the Stop valve").toBe(false);
    // The controller status Refresh control must stay reachable while the
    // island floats: auto-scroll has to land it clear of the island band.
    const refresh = page.getByRole("button", { name: "Refresh controller status" });
    await refresh.click();
    const refreshBox = await rect(refresh);
    expect(intersects(islandBox, refreshBox), "island must not trap the Refresh control").toBe(false);
  });
}

test("desktop island floats on the viewport clear of the field, sprinklers and their controls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  await page.getByRole("button", { name: /Zone 1.*idle/i }).click();
  await page.getByRole("button", { name: /Zone 5.*idle/i }).click();
  const island = page.locator("[data-testid=quick-task-island]");
  await expect(island).toBeVisible();
  const islandBox = await rect(island);
  const field = await rect(page.locator("[data-testid=field]"));
  // The island never covers the lawn: every sprinkler and every anchored
  // Stop/Remove control stays fully interactive while it is open.
  expect(islandBox.x).toBeGreaterThanOrEqual(0);
  expect(islandBox.right).toBeLessThanOrEqual(1440);
  expect(islandBox.y).toBeGreaterThanOrEqual(0);
  expect(islandBox.bottom).toBeLessThanOrEqual(900);
  expect(intersects(islandBox, field), "island clear of the whole field").toBe(false);
  for (let zone = 1; zone <= 6; zone += 1) {
    expect(intersects(islandBox, await rect(page.locator(`[data-testid=field-zone-${zone}]`))), `island clear of zone ${zone}`).toBe(false);
  }
  // Active Stop and queued Remove controls coexist with the island untouched.
  await page.getByRole("button", { name: /Zone 4.*watering/i }).click();
  const stop = page.getByRole("button", { name: /^Stop watering/i });
  await expect(stop).toBeVisible();
  expect(intersects(islandBox, await rect(stop)), "island clear of Stop valve").toBe(false);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Zone 6.*queued/i }).click();
  const remove = page.getByRole("button", { name: /^Remove queued task/i });
  await expect(remove).toBeVisible();
  expect(intersects(islandBox, await rect(remove)), "island clear of Remove control").toBe(false);
  await expect(island.locator("[data-testid=quick-task-zones]")).toHaveText("Zones 1 and 5");
});

test("dedicated /quick-task page keeps its full form behavior", async ({ page }) => {
  await page.goto("/quick-task");
  await expect(page.locator("#zoneGrid input[type=checkbox]")).toHaveCount(6);
  await expect(page.locator(".preset")).toHaveCount(4);
  await expect(page.locator("#duration")).toHaveValue("15");
  await expect(page.locator("[data-testid=quick-task-island]")).toHaveCount(0);
  const start = page.getByRole("button", { name: "Start watering", exact: true });
  await expect(start).toBeDisabled();
  await page.locator("#zone1").check();
  await expect(start).toBeEnabled();
});

test("dashboard stays axe-clean and announces through live regions in hidden and visible island states", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  const hiddenScan = await new AxeBuilder({ page }).analyze();
  expect(hiddenScan.violations).toEqual([]);
  await page.getByRole("button", { name: /Zone 1.*idle/i }).click();
  await expect(page.locator("[data-testid=quick-task-island]")).toBeVisible();
  const liveRegions = await page.evaluate(() => ({
    zones: document.getElementById("quickTaskZones")?.tagName,
    message: document.getElementById("quickMessage")?.getAttribute("aria-live"),
    fieldFeedback: document.getElementById("fieldMutationFeedback")?.getAttribute("aria-live"),
  }));
  expect(liveRegions.zones).toBe("OUTPUT");
  expect(liveRegions.message).toBe("polite");
  expect(liveRegions.fieldFeedback).toBe("polite");
  const visibleScan = await new AxeBuilder({ page }).analyze();
  expect(visibleScan.violations).toEqual([]);
});

test("keyboard activation, Escape and explicit close manage selection and focus truthfully", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  const island = page.locator("[data-testid=quick-task-island]");
  const zone2 = page.getByRole("button", { name: /Zone 2.*idle/i });
  // Keyboard activation of the real field control reveals the island and
  // keeps focus where the user is working.
  await zone2.focus();
  await page.keyboard.press("Enter");
  await expect(island).toBeVisible();
  await expect(zone2).toHaveAttribute("aria-pressed", "true");
  await expect(zone2).toBeFocused();
  // Escape while working inside the island deselects and returns focus to
  // the first selected sprinkler.
  await island.getByRole("button", { name: "5 minutes", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(island).toBeHidden();
  await expect(zone2).toHaveAttribute("aria-pressed", "false");
  await expect(zone2).toBeFocused();
  // Explicit close does the same from a pointer flow.
  await zone2.click();
  await page.getByRole("button", { name: /Zone 3.*idle/i }).click();
  await expect(island).toBeVisible();
  await island.getByRole("button", { name: /Close Quick Task/i }).click();
  await expect(island).toBeHidden();
  await expect(zone2).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: /Zone 3.*idle/i })).toHaveAttribute("aria-pressed", "false");
  await expect(zone2).toBeFocused();
});

test("offline controller keeps the selection truthful and never enables Start", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  const island = page.locator("[data-testid=quick-task-island]");
  const start = island.getByRole("button", { name: "Start", exact: true });
  await page.getByRole("button", { name: /Zone 1.*idle/i }).click();
  await expect(start).toBeEnabled();
  await page.request.post("/__test/controller", { data: { mode: "offline" } });
  await page.getByRole("button", { name: /Refresh controller status/i }).click();
  await expect(page.locator("[data-testid=controller-freshness]")).toContainText(/offline|stale/i);
  await expect(start).toBeDisabled();
  // The selection survives the outage but no further zones can be toggled.
  await expect(island.locator("[data-testid=quick-task-zones]")).toHaveText("Zone 1");
  await expect(page.locator("[data-testid=field-zone-2] .field-zone")).toBeDisabled();
  // Recovery restores Start from real state only.
  await page.request.post("/__test/controller", { data: { mode: "online" } });
  await page.getByRole("button", { name: /Refresh controller status/i }).click();
  await expect(start).toBeEnabled();
});

test("a selected zone that the controller reports busy is pruned from the selection", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  await page.getByRole("button", { name: /Zone 1.*idle/i }).click();
  await page.getByRole("button", { name: /Zone 2.*idle/i }).click();
  await expect(page.locator("[data-testid=quick-task-zones]")).toHaveText("Zones 1 and 2");
  // A schedule (or anyone else) starts zone 1 behind our back.
  await page.request.post("/__test/controller", { data: { mode: "online", tasks: [
    { id: "running", zones: [4], runTime: 20, startTime: Math.floor(Date.now() / 1000) - 240 },
    { id: "queued", zones: [6], runTime: 10, startTime: 0 },
    { id: "external", zones: [1], runTime: 10, startTime: Math.floor(Date.now() / 1000) },
  ] } });
  await page.getByRole("button", { name: /Refresh controller status/i }).click();
  await expect(page.locator("[data-testid=quick-task-zones]")).toHaveText("Zone 2");
  await expect(page.getByRole("button", { name: /Zone 1.*watering/i })).toBeVisible();
  await expect(page.locator("[data-testid=field-zone-1]")).not.toHaveClass(/is-selected/);
});

test("same-key 503 recovery keeps a partially pruned payload truthful until every zone returns idle", async ({ page }) => {
  const requests = [];
  await page.route("**/api/tasks/create", async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) return route.fulfill({
      status: 503,
      headers: { "Retry-After": "1" },
      contentType: "application/json",
      body: JSON.stringify({ error: "datastore busy", outcome: "not_applied" }),
    });
    return route.continue();
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Zone 1.*idle/i }).click();
  await page.getByRole("button", { name: /Zone 2.*idle/i }).click();
  const island = page.locator("[data-testid=quick-task-island]");
  const start = island.getByRole("button", { name: "Start", exact: true });
  await start.click();
  await expect(page.locator("#quickMessage")).toContainText(/not applied.*same request/i);

  await page.request.post("/__test/controller", { data: { mode: "online", tasks: [
    { id: "running", zones: [4], runTime: 20, startTime: Math.floor(Date.now() / 1000) - 240 },
    { id: "queued", zones: [6], runTime: 10, startTime: 0 },
    { id: "external", zones: [1], runTime: 10, startTime: Math.floor(Date.now() / 1000) },
  ] } });
  await page.getByRole("button", { name: /Refresh controller status/i }).click();
  await expect(island).toBeVisible();
  await expect(island.locator("[data-testid=quick-task-zones]")).toHaveText("Zones 1 and 2");
  await expect(page.locator("[data-testid=field-zone-1]")).not.toHaveClass(/is-selected/);
  await expect(page.getByRole("button", { name: /Zone 2.*idle/i })).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(1100);
  await expect(start).toBeDisabled();

  await page.request.post("/__test/controller", { data: { mode: "online", tasks: [
    { id: "running", zones: [4], runTime: 20, startTime: Math.floor(Date.now() / 1000) - 240 },
    { id: "queued", zones: [6], runTime: 10, startTime: 0 },
  ] } });
  await page.getByRole("button", { name: /Refresh controller status/i }).click();
  await expect(page.getByRole("button", { name: /Zone 1.*idle/i })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /Zone 2.*idle/i })).toHaveAttribute("aria-pressed", "true");
  await expect(start).toBeEnabled({ timeout: 2500 });
  await start.click();
  await expect(page.locator("#fieldMutationFeedback")).toHaveText("Task added");
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
});

test("terminal conflict hides a pending island after its only zone was pruned", async ({ page }) => {
  let releaseCreate;
  let markCreateSeen;
  const createSeen = new Promise((resolve) => { markCreateSeen = resolve; });
  const createGate = new Promise((resolve) => { releaseCreate = resolve; });
  await page.route("**/api/tasks/create", async (route) => {
    markCreateSeen();
    await createGate;
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "requestId was already used for another operation" }),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Zone 1.*idle/i }).click();
  const island = page.locator("[data-testid=quick-task-island]");
  const startPromise = island.getByRole("button", { name: "Start", exact: true }).click();
  await createSeen;

  await page.request.post("/__test/controller", { data: { mode: "online", tasks: [
    { id: "running", zones: [4], runTime: 20, startTime: Math.floor(Date.now() / 1000) - 240 },
    { id: "queued", zones: [6], runTime: 10, startTime: 0 },
    { id: "external", zones: [1], runTime: 10, startTime: Math.floor(Date.now() / 1000) },
  ] } });
  await page.getByRole("button", { name: /Refresh controller status/i }).click();
  await expect(page.locator("[data-testid=field-zone-1]")).not.toHaveClass(/is-selected/);
  await expect(island).toBeVisible();

  releaseCreate();
  await startPromise;
  await expect(page.locator("#fieldMutationFeedback")).toContainText(/conflict.*refresh.*edit/i);
  await expect(island).toBeHidden();
});
