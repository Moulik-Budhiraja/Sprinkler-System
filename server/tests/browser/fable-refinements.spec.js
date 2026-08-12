import { expect, test } from "@playwright/test";

test.afterEach(async ({ request }) => {
  await request.post("/__test/reset");
});

test("a never-run schedule states Not yet run without a concatenated prefix", async ({ page }) => {
  await page.goto("/schedules");
  await expect(page.locator("[data-schedule-row]")).toHaveCount(5);
  const neverRun = page.locator('[data-schedule-row="schedule-5"]');
  await expect(neverRun.locator("[data-schedule-last-run]")).toHaveText("Not yet run");
  const hasRun = page.locator('[data-schedule-row="schedule-1"]');
  await expect(hasRun.locator("[data-schedule-last-run]")).toHaveText(/^Last run .+/);
  await expect(page.getByText(/Last run Not yet run/)).toHaveCount(0);
});

async function fontSize(locator) {
  return locator.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
}

test("desktop Quick Task island copy is legible operator type, not sub-9px smudge", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  await page.getByRole("button", { name: /Zone 1.*idle/i }).click();
  const island = page.locator("[data-testid=quick-task-island]");
  await expect(island).toBeVisible();
  const heading = page.locator("[data-testid=quick-task-heading]");
  const context = page.getByText("Runs once, right now", { exact: true });
  const hint = page.getByText("Pick at least one zone to start · durations in minutes", { exact: true });
  await expect(heading).toBeVisible();
  await expect(context).toBeVisible();
  await expect(hint).toBeVisible();
  expect(await fontSize(heading), "heading legibility").toBeGreaterThanOrEqual(11);
  expect(await fontSize(context), "context legibility").toBeGreaterThanOrEqual(10);
  expect(await fontSize(hint), "hint legibility").toBeGreaterThanOrEqual(11);

  // The compact island stays dense and its legible copy stays inside it.
  const islandBox = await island.evaluate((node) => node.getBoundingClientRect().toJSON());
  expect(islandBox.width).toBeGreaterThanOrEqual(300);
  expect(islandBox.width).toBeLessThanOrEqual(342);
  expect(islandBox.height).toBeGreaterThanOrEqual(110);
  expect(islandBox.height).toBeLessThanOrEqual(160);
  const hintBox = await hint.evaluate((node) => node.getBoundingClientRect().toJSON());
  expect(hintBox.right, "hint stays inside the island").toBeLessThanOrEqual(islandBox.right + 0.5);
  expect(hintBox.bottom, "hint stays inside the island").toBeLessThanOrEqual(islandBox.bottom + 0.5);
  const copyClips = await page.locator(".qt-copy").evaluate((node) => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1);
  expect(copyClips, "copy block unclipped").toBe(false);
});

for (const width of [320, 390]) {
  test(`mobile Quick Task island hint is legible and unclipped at ${width}x844`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await page.waitForSelector("[data-testid=field-zone-6]");
    await page.getByRole("button", { name: /Zone 1.*idle/i }).click();
    await expect(page.locator("[data-testid=quick-task-island]")).toBeVisible();
    const hint = page.getByText("Pick at least one zone to start · durations in minutes", { exact: true });
    await expect(hint).toBeVisible();
    expect(await fontSize(hint), "mobile hint legibility").toBeGreaterThanOrEqual(10);
    const geometry = await hint.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const controls = document.querySelector(".qt-island-controls").getBoundingClientRect();
      return {
        clipped: node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1,
        bottom: rect.bottom,
        controlsTop: controls.top,
      };
    });
    expect(geometry.clipped, "hint unclipped").toBe(false);
    expect(geometry.bottom, "hint clear of the duration controls").toBeLessThanOrEqual(geometry.controlsTop + 0.5);
    const islandHeight = await page.locator("[data-testid=quick-task-island]").evaluate((node) => node.getBoundingClientRect().height);
    expect(islandHeight).toBeGreaterThanOrEqual(110);
    expect(islandHeight).toBeLessThanOrEqual(180);
  });
}

for (const route of ["/", "/status"]) {
  test(`${route} zone numerals are glanceable against lawn and sprinkler bodies`, async ({ page }) => {
    await page.goto(route);
    await page.waitForSelector("[data-testid=field-zone-6]");
    const numerals = await page.locator(".sprinkler-number").evaluateAll((nodes) => nodes.map((node) => {
      const style = getComputedStyle(node);
      return { text: node.textContent, fill: style.fill, stroke: style.stroke, paintOrder: style.paintOrder };
    }));
    expect(numerals.map((n) => n.text)).toEqual(["1", "2", "3", "4", "5", "6"]);
    const parse = (color) => {
      const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
      return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
    };
    const luminance = ([r, g, b]) => {
      const [lr, lg, lb] = [r, g, b].map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    };
    const contrast = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const lawn = [13, 24, 21]; // #0d1815 field ground
    for (const numeral of numerals) {
      const fill = parse(numeral.fill);
      expect(fill, `numeral ${numeral.text} has a parseable fill`).not.toBeNull();
      expect(contrast(fill, lawn), `numeral ${numeral.text} ink reads on the lawn`).toBeGreaterThanOrEqual(8);
      const stroke = parse(numeral.stroke);
      expect(stroke, `numeral ${numeral.text} carries a halo stroke`).not.toBeNull();
      expect(contrast(fill, stroke), `numeral ${numeral.text} halo separates ink from any body tone`).toBeGreaterThanOrEqual(8);
      expect(numeral.paintOrder, `numeral ${numeral.text} halo painted behind the ink`).toContain("stroke");
    }
  });
}

test("multi-task schedule sequences separate steps instead of running minutes into the next step number", async ({ page, request }) => {
  const created = await request.post("/api/schedules/create", {
    data: {
      requestId: "00000000-0000-4000-8000-00000000fab1",
      name: "Two step sequence",
      days: [1],
      startTime: "05:10",
      tasks: [{ zones: [1], runTime: 5 }, { zones: [2, 3], runTime: 10 }],
    },
  });
  expect(created.ok()).toBe(true);
  await page.goto("/schedules");
  const row = page.locator("[data-schedule-row]", { hasText: "Two step sequence" });
  const sequence = row.locator("[data-schedule-sequence]");
  await expect(sequence).toContainText("1. Zone 1 · 5 min");
  await expect(sequence).toContainText("2. Zones 2, 3 · 10 min");
  await expect(sequence).not.toHaveText(/min\s+2\./);
});
