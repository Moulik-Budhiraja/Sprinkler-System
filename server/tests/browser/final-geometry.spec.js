import { expect, test } from "@playwright/test";

const routes = [
  "/",
  "/status",
  "/schedules",
  "/create-schedule",
  "/edit-schedule?id=schedule-1",
  "/activity",
  "/controller",
  "/quick-task",
];

const viewports = [
  { width: 320, height: 844 },
  { width: 375, height: 844 },
  { width: 390, height: 844 },
  { width: 390, height: 1067 },
  { width: 393, height: 844 },
  { width: 430, height: 844 },
  { width: 1440, height: 900 },
];

const interactiveSelector = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "[role=button]",
  "[role=link]",
].join(",");

async function visibleInteractiveGeometry(page) {
  return page.locator(interactiveSelector).evaluateAll((nodes) => nodes.flatMap((node) => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0" || box.width === 0 || box.height === 0 || box.right <= 0 || box.bottom <= 0) return [];
    return [{
      tag: node.tagName.toLowerCase(),
      name: (node.getAttribute("aria-label") || node.textContent || node.getAttribute("name") || node.id).trim().replace(/\s+/g, " "),
      x: box.x,
      y: box.y,
      right: box.right,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
    }];
  }));
}

async function expectExactNoHorizontalOverflow(page, label) {
  const geometry = await page.evaluate(() => ({
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  expect(geometry.documentScrollWidth, `${label}: documentElement overflow`).toBe(geometry.documentClientWidth);
  expect(geometry.bodyScrollWidth, `${label}: body overflow`).toBe(geometry.bodyClientWidth);
}

async function expectTargets(page, label) {
  const controls = await visibleInteractiveGeometry(page);
  expect(controls.length, `${label}: visible controls were enumerated`).toBeGreaterThan(0);
  const undersized = controls.filter(({ width, height }) => width < 44 || height < 44);
  expect(undersized, `${label}: every visible interactive control must be at least 44x44 CSS px`).toEqual([]);
}

test.afterEach(async ({ request }) => {
  await request.post("/__test/reset");
});

for (const viewport of viewports) {
  test(`all routes have exact horizontal containment and 44px targets at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    for (const route of routes) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      const label = `${route} at ${viewport.width}x${viewport.height}`;
      await expectExactNoHorizontalOverflow(page, label);
      await expectTargets(page, label);
    }
  });
}

test("desktop Quick Task island controls are distinct 44px targets inside the island", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  await page.getByRole("button", { name: /Zone 1.*idle/i }).click();
  const panel = page.locator("[data-testid=quick-task-island]");
  await expect(panel).toBeVisible();
  const panelBox = await panel.boundingBox();
  const controls = await page.locator(".qt-duration,.qt-start,.qt-close").evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return { name: node.getAttribute("aria-label") || node.textContent.trim(), x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
  }));
  expect(controls).toHaveLength(6);
  expect(controls.filter(({ width, height }) => width < 44 || height < 44), "Quick Task undersized controls").toEqual([]);
  for (const control of controls) {
    expect(control.x, `${control.name}: left containment`).toBeGreaterThanOrEqual(panelBox.x);
    expect(control.y, `${control.name}: top containment`).toBeGreaterThanOrEqual(panelBox.y);
    expect(control.right, `${control.name}: right containment`).toBeLessThanOrEqual(panelBox.x + panelBox.width);
    expect(control.bottom, `${control.name}: bottom containment`).toBeLessThanOrEqual(panelBox.y + panelBox.height);
  }
  for (let left = 0; left < controls.length; left += 1) {
    for (let right = left + 1; right < controls.length; right += 1) {
      const a = controls[left];
      const b = controls[right];
      const overlaps = Math.min(a.right, b.right) - Math.max(a.x, b.x) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 0.5;
      expect(overlaps, `${a.name} overlaps ${b.name}`).toBe(false);
    }
  }
});

for (const viewport of viewports) {
  test(`key dashboard mutation states preserve targets and horizontal containment at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.waitForSelector("[data-testid=field-zone-6]");

    await page.getByRole("button", { name: /Zone 1.*idle/i }).click();
    await expect(page.locator("[data-testid=quick-task-island]")).toBeVisible();
    await page.getByRole("button", { name: "5 minutes", exact: true }).click();
    await expectTargets(page, `selected Quick Task at ${viewport.width}x${viewport.height}`);
    await expectExactNoHorizontalOverflow(page, `selected Quick Task at ${viewport.width}x${viewport.height}`);

    await page.getByRole("button", { name: /Zone 4.*watering/i }).click();
    await expect(page.getByRole("button", { name: /^Stop watering/i })).toBeVisible();
    await expectTargets(page, `Stop popover at ${viewport.width}x${viewport.height}`);
    await expectExactNoHorizontalOverflow(page, `Stop popover at ${viewport.width}x${viewport.height}`);

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /Zone 6.*queued/i }).click();
    await expect(page.getByRole("button", { name: /^Remove queued task/i })).toBeVisible();
    await expectTargets(page, `Remove popover at ${viewport.width}x${viewport.height}`);
    await expectExactNoHorizontalOverflow(page, `Remove popover at ${viewport.width}x${viewport.height}`);
  });
}
