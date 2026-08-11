import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

function watchRuntime(page) {
  const problems = [];
  page.on("console", (msg) => {
    if (["error", "warning"].includes(msg.type())) problems.push(`console ${msg.type()}: ${msg.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => problems.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));
  return problems;
}

async function box(page, selector) {
  return page.locator(selector).evaluate((node) => {
    const r = node.getBoundingClientRect();
    const cs = getComputedStyle(node);
    const range = document.createRange();
    range.selectNodeContents(node);
    const lines = [...range.getClientRects()].filter((x) => x.width && x.height);
    return {
      text: node.textContent.trim(), x: r.x, y: r.y, right: r.right, bottom: r.bottom,
      width: r.width, height: r.height, scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight,
      lines: lines.length, overflow: cs.overflow, textOverflow: cs.textOverflow, whiteSpace: cs.whiteSpace,
    };
  });
}

function inside(inner, outer, label) {
  expect(inner.x, `${label} left`).toBeGreaterThanOrEqual(outer.x - 0.5);
  expect(inner.y, `${label} top`).toBeGreaterThanOrEqual(outer.y - 0.5);
  expect(inner.right, `${label} right`).toBeLessThanOrEqual(outer.right + 0.5);
  expect(inner.bottom, `${label} bottom`).toBeLessThanOrEqual(outer.bottom + 0.5);
  expect(inner.scrollWidth, `${label} horizontal clipping`).toBeLessThanOrEqual(inner.width + 1);
  expect(inner.scrollHeight, `${label} vertical clipping`).toBeLessThanOrEqual(inner.height + 1);
}

function separate(a, b, label) {
  const overlap = Math.min(a.right, b.right) - Math.max(a.x, b.x) > 0.5 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 0.5;
  expect(overlap, label).toBe(false);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`keyboard skip link is visible, unclipped and at least 44x44 at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    const rect = await skip.boundingBox();
    expect(rect.width).toBeGreaterThanOrEqual(44);
    expect(rect.height).toBeGreaterThanOrEqual(44);
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width);
    expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height);
    await expect(skip).toHaveCSS("outline-style", "solid");
  });
}

for (const width of [320, 375, 390, 393, 430]) {
  test(`mobile scroll viewport keeps all functional content outside bottom navigation at ${width}x844`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await page.waitForSelector("[data-testid=field-zone-6]");
    const geometry = async (stage) => {
      const result = await page.evaluate(() => {
        const main = document.querySelector("main");
        const nav = document.querySelector(".mobile-nav");
        const mainRect = main.getBoundingClientRect();
        const navRect = nav.getBoundingClientRect();
        const overlap = Math.min(mainRect.bottom, navRect.bottom) - Math.max(mainRect.top, navRect.top) > 0.5 &&
          Math.min(mainRect.right, navRect.right) - Math.max(mainRect.left, navRect.left) > 0.5;
        return {
          overlap,
          mainBottom: mainRect.bottom,
          navTop: navRect.top,
          overflowY: getComputedStyle(main).overflowY,
          scrollHeight: main.scrollHeight,
          clientHeight: main.clientHeight,
        };
      });
      expect(result.overlap, `${stage}: main viewport intersects navigation`).toBe(false);
      expect(result.mainBottom, `${stage}: main ends above navigation`).toBeLessThanOrEqual(result.navTop + 0.5);
      expect(result.overflowY, `${stage}: content uses its own reachable flow`).toBe("auto");
      expect(result.scrollHeight, `${stage}: dashboard remains scrollable`).toBeGreaterThan(result.clientHeight);
    };
    await geometry("initial");
    await page.locator("main").evaluate((main) => { main.scrollTop = Math.floor(main.scrollHeight / 2); });
    await geometry("mid-scroll");
    const refresh = page.getByRole("button", { name: "Refresh controller status" });
    await refresh.focus();
    await refresh.evaluate((node) => node.scrollIntoView({ block: "nearest" }));
    await expect(refresh).toBeFocused();
    await geometry("keyboard-focus");
    await page.locator("#fieldMutationFeedback").evaluate((node) => {
      node.textContent = "Mutation outcome unknown · check Status";
      node.scrollIntoView({ block: "nearest" });
    });
    await geometry("mutation-feedback");
  });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 390, height: 1067 }]) {
  test(`mobile header and Quick Task copy are intact at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    const problems = watchRuntime(page);
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.waitForSelector("[data-testid=field-zone-6]");
    const header = await box(page, "[data-testid=mobile-header]");
    const product = await box(page, "[data-testid=mobile-product-heading]");
    const controller = await box(page, "[data-testid=controller-status]");
    const divider = await box(page, "[data-testid=header-divider]");
    expect(product.text).toBe("Sprinkler system");
    expect(product.lines).toBe(1);
    inside(product, header, "product name");
    inside(controller, header, "controller status");
    separate(product, controller, "header text overlaps controller status");
    separate(controller, divider, "controller status overlaps divider");
    await expect(page.locator("[data-testid=field] .field-status-copy, [data-testid=field] time")).toHaveCount(0);
    await expect(page.locator("[data-testid=field-zone]")).toHaveCount(6);
    expect(problems).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`mobile-${viewport.height}-copy.png`), fullPage: true });
    // The contextual Quick Task island keeps its heading intact once revealed.
    await page.getByRole("button", { name: /Zone 1.*idle/i }).click();
    const quick = await box(page, "[data-testid=quick-task-heading]");
    const island = await box(page, "[data-testid=quick-task-island]");
    expect(quick.text).toBe("Quick Task");
    expect(quick.lines).toBe(1);
    inside(quick, island, "Quick Task heading");
    await page.getByRole("button", { name: /Close Quick Task/i }).click();
    expect(problems).toEqual([]);
  });
}

test("desktop sidebar branding is complete and separated at 1440x900", async ({ page }, testInfo) => {
  const problems = watchRuntime(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  const sidebar = await box(page, "[data-testid=sidebar]");
  const brand = await box(page, "[data-testid=sidebar-brand]");
  const title = await box(page, "[data-testid=brand-title]");
  const sub = await box(page, "[data-testid=brand-subtitle]");
  const today = await box(page, "[data-testid=nav-today]");
  expect(title.text).toBe("Living Yard");
  expect(sub.text).toBe("Sprinkler system");
  expect(title.lines).toBe(1);
  expect(sub.lines).toBe(1);
  inside(brand, sidebar, "sidebar brand");
  separate(brand, today, "brand overlaps Today navigation");
  await expect(page.getByText(/D01\s*[—-]\s*Dashboard/i)).toHaveCount(0);
  expect(problems).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("desktop-1440-copy.png"), fullPage: true });
});

test("dashboard order, field geometry, interactions and accessibility", async ({ page }) => {
  const problems = watchRuntime(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  const order = await page.locator("main > [data-dashboard-section]").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-dashboard-section")));
  expect(order).toEqual(["field", "schedules", "history"]);
  const field = await box(page, "[data-testid=field]");
  expect(field.height).toBeGreaterThanOrEqual(380);
  expect(field.height).toBeLessThanOrEqual(465);
  const nums = await page.locator("[data-testid=field-zone] .sprinkler-number").allTextContents();
  expect(nums).toEqual(["1", "2", "3", "4", "5", "6"]);
  await page.getByRole("button", { name: /Zone 4.*Stop watering task/i }).click();
  await expect(page.locator("[data-testid=zone-action-popover]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-testid=zone-action-popover]")).toBeHidden();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
  const navLinks = page.locator(".mobile-nav a");
  await expect(navLinks).toHaveCount(5);
  for (const link of await navLinks.all()) {
    const rect = await link.boundingBox();
    expect(rect.height).toBeGreaterThanOrEqual(44);
  }
  expect(problems).toEqual([]);
});

test("all six sprinkler controls remain fully inside the desktop field", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  const field = await box(page, "[data-testid=field]");
  const controls = await page.locator("[data-testid=field-zone]").evaluateAll((nodes) => nodes.map((node) => {
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
      scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight };
  }));
  controls.forEach((control, index) => inside(control, field, `Zone ${index + 1}`));
});

for (const route of ["/status", "/schedules", "/create-schedule", "/edit-schedule?id=schedule-1", "/activity", "/controller", "/quick-task"]) {
  test(`${route} renders cleanly with accessible six-zone controls`, async ({ page }) => {
    const problems = watchRuntime(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    if (route.includes("schedule") || route === "/quick-task") {
      const zoneControls = page.locator("#zoneGrid input[type=checkbox]");
      if (await zoneControls.count()) expect(await zoneControls.count()).toBe(6);
    }
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
    expect(problems).toEqual([]);
  });
}
