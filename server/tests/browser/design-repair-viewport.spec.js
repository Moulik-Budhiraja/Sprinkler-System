import { expect, test } from "@playwright/test";
import { makeBusyZones, noHorizontalOverflow } from "./design-repair-utils.js";

test.afterEach(async ({ request }) => {
  await request.post("/__test/reset");
});

async function expectContained(page, label) {
  const geometry = await noHorizontalOverflow(page);
  expect(geometry.documentScrollWidth, `${label}: documentElement horizontal overflow`).toBe(geometry.documentClientWidth);
  expect(geometry.bodyScrollWidth, `${label}: body horizontal overflow`).toBe(geometry.bodyClientWidth);
}

for (const width of [320, 390, 430]) {
  test(`Today keeps exact horizontal containment through selection, running docks and scrolling at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await page.waitForSelector("[data-testid=field-zone-6]");
    await expectContained(page, `initial Today at ${width}`);
    // Idle selection with the Quick Task island open.
    await page.getByRole("button", { name: /Zone 3.*idle/i }).click();
    await expect(page.locator("[data-testid=quick-task-island]")).toBeVisible();
    await expectContained(page, `island open at ${width}`);
    await page.getByRole("button", { name: /Close Quick Task/i }).click();
    // Multiple running/queued zones with their own anchored controls.
    await makeBusyZones(page);
    await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(3);
    await expectContained(page, `running docks at ${width}`);
    // Scrolled through the document.
    await page.evaluate(() => window.scrollTo(0, Math.floor(document.documentElement.scrollHeight / 2)));
    await expectContained(page, `mid scroll at ${width}`);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expectContained(page, `bottom scroll at ${width}`);
  });

  for (const route of ["/activity", "/schedules"]) {
    test(`${route} keeps exact horizontal containment before and after scrolling at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      await expectContained(page, `${route} initial at ${width}`);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expectContained(page, `${route} scrolled at ${width}`);
    });
  }
}

for (const width of [1024, 1280, 1439]) {
  for (const route of ["/", "/status", "/schedules", "/activity"]) {
    test(`${route} keeps exact horizontal containment on narrow desktop at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      await expectContained(page, `${route} at ${width}`);
    });
  }
}

test("bottom navigation carries the safe area and pins to the visual viewport bottom", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  const nav = await page.locator(".mobile-nav").evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return { position: style.position, bottom: rect.bottom, height: rect.height, paddingBottom: style.paddingBottom };
  });
  expect(nav.position).toBe("fixed");
  expect(Math.abs(nav.bottom - 844)).toBeLessThanOrEqual(0.5);
  expect(nav.height).toBeGreaterThanOrEqual(58);
});

test("pinch zoom and accessibility zoom stay enabled", async ({ page }) => {
  await page.goto("/");
  const viewportMeta = await page.locator("meta[name=viewport]").getAttribute("content");
  expect(viewportMeta).not.toMatch(/user-scalable\s*=\s*(no|0)/i);
  expect(viewportMeta).not.toMatch(/maximum-scale\s*=\s*1(\.0+)?\b/i);
});

test("reduced motion keeps selection, docks and running truth in pose instead of animation", async ({ page }) => {
  // The whole suite runs with reducedMotion: "reduce".
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  await makeBusyZones(page);
  await page.getByRole("button", { name: /Zone 3.*idle/i }).click();
  const outline = page.locator("[data-testid=field-zone-3] [data-selection-outline]");
  await expect(outline).toHaveCount(1);
  const outlineStyle = await outline.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      opacity: Number.parseFloat(style.opacity),
      transitionDuration: style.transitionDuration,
      reduceActive: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    };
  });
  expect(outlineStyle.reduceActive, "reduced-motion emulation is active").toBe(true);
  expect(outlineStyle.opacity, "outline reveals instantly").toBeGreaterThanOrEqual(0.9);
  expect(outlineStyle.transitionDuration.split(",").every((value) => Number.parseFloat(value) === 0),
    "no outline transition under reduced motion").toBe(true);
  const running = await page.locator("[data-testid=field-zone-2] .char-spray").evaluate((node) => {
    const style = getComputedStyle(node);
    return { opacity: Number.parseFloat(style.opacity), animationName: style.animationName };
  });
  expect(running.opacity, "running truth lives in pose").toBe(1);
  const stopControl = await page.locator("[data-testid=field-zone-2] .zone-dock button").evaluate((node) => getComputedStyle(node).animationName);
  expect(stopControl === "none" || stopControl === "").toBe(true);
});
