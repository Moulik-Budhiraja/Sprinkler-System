import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const mobileViewports = [{ width: 390, height: 844 }, { width: 390, height: 1067 }];

test.afterEach(async ({ request }) => {
  await request.post("/__test/reset");
});

async function rect(locator) {
  return locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
  });
}

test("approved status route is a status-and-stop surface at desktop and mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/status");
  await page.waitForSelector("[data-testid=field-zone-6]");
  await expect(page.getByRole("button", { name: /Refresh controller status/i })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Sprinkler Status" })).toBeVisible();
  await expect(page.locator("[data-testid=status-field]")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^Start/i })).toHaveCount(0);
  await expect(page.locator("input[type=number], .qt-duration, .qt-zones")).toHaveCount(0);
  const desktop = await rect(page.locator("[data-testid=status-field]"));
  expect(desktop.width).toBeCloseTo(1140, 0);
  expect(desktop.height).toBeCloseTo(700, 0);
  await expect(page.locator(".sidebar-nav a[href='/status']")).toHaveClass(/active/);

  for (const viewport of mobileViewports) {
    await page.setViewportSize(viewport);
    await page.reload();
    await page.waitForSelector("[data-testid=field-zone-6]");
    const mobile = await rect(page.locator("[data-testid=status-field]"));
    const nav = await rect(page.locator(".mobile-nav"));
    await expect(page.locator("h1:visible")).toHaveCount(1);
    expect(mobile.width).toBeCloseTo(390, 0);
    expect(mobile.y).toBeCloseTo(114, 0);
    expect(mobile.height).toBeGreaterThanOrEqual(650);
    expect(mobile.height).toBeLessThanOrEqual(738);
    expect(mobile.bottom).toBeLessThanOrEqual(nav.y + 0.5);
    for (const control of await page.locator(".field-zone").all()) {
      const bounds = await rect(control);
      expect(bounds.bottom).toBeLessThanOrEqual(nav.y + 0.5);
    }
    await expect(page.locator(".mobile-nav a[href='/status']")).toHaveClass(/active/);
  }
});

test("mobile controller state resolves on every route instead of remaining in checking state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ["/schedules", "/create-schedule", "/edit-schedule?id=schedule-1", "/activity", "/controller", "/quick-task"]) {
    await page.goto(route);
    await expect(page.locator("#mobileControllerStatus")).toHaveText(/Controller (online|offline)/);
  }
});

test("dashboard geometry follows approved desktop and mobile hierarchy", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  const quickDesktop = await rect(page.locator("[data-testid=quick-task]"));
  expect(quickDesktop.width).toBeGreaterThanOrEqual(598);
  expect(quickDesktop.width).toBeLessThanOrEqual(608);
  expect(quickDesktop.height).toBeGreaterThanOrEqual(50);
  expect(quickDesktop.height).toBeLessThanOrEqual(56);
  const fieldDesktop = await rect(page.locator("[data-testid=field]"));
  expect(fieldDesktop.width).toBeCloseTo(1140, 0);
  expect(fieldDesktop.height).toBeCloseTo(524, 0);
  await expect(page.locator("fieldset.qt-zones, fieldset.qt-durations")).toHaveCount(0);

  for (const viewport of mobileViewports) {
    await page.setViewportSize(viewport);
    await page.reload();
    await page.waitForSelector("[data-testid=field-zone-6]");
    const order = await page.locator("main > [data-dashboard-section]").evaluateAll((nodes) => nodes.map((node) => node.dataset.dashboardSection));
    expect(order).toEqual(["quick-task", "field", "schedules", "history"]);
    const quick = await rect(page.locator("[data-testid=quick-task]"));
    const field = await rect(page.locator("[data-testid=field]"));
    const nav = await rect(page.locator(".mobile-nav"));
    expect(quick.x).toBeCloseTo(0, 0);
    expect(quick.width).toBeCloseTo(390, 0);
    expect(quick.height).toBeGreaterThanOrEqual(176);
    expect(quick.height).toBeLessThanOrEqual(184);
    expect(field.x).toBeCloseTo(0, 0);
    expect(field.width).toBeCloseTo(390, 0);
    expect(field.height).toBeCloseTo(400, 0);
    expect(field.y).toBeGreaterThanOrEqual(288);
    expect(field.y).toBeLessThanOrEqual(304);
    expect(nav.height).toBeGreaterThanOrEqual(58);
    await expect(page.locator("[data-testid=mobile-product-heading]")).toHaveText("Sprinkler system");
  }
});

test("dedicated schedules and activity render complete truthful structured datasets", async ({ page }) => {
  await page.goto("/schedules");
  await expect(page.locator("[data-schedule-row]")).toHaveCount(5);
  const first = page.locator("[data-schedule-row]").first();
  for (const selector of ["[data-schedule-state]", "[data-schedule-days]", "[data-schedule-sequence]", "[data-schedule-last-run]"]) {
    await expect(first.locator(selector)).not.toBeEmpty();
  }
  await expect(first.getByRole("link", { name: /^Edit / })).toBeVisible();
  await expect(first.getByRole("button", { name: /^Delete / })).toBeVisible();

  await page.goto("/activity");
  await expect(page.locator("[data-history-row]")).toHaveCount(7);
  await expect(page.locator("[data-history-date]").first()).not.toBeEmpty();
  await expect(page.locator("[data-history-row]").first()).toContainText(/Started|Stopped/);
});

test("schedule deletion requires confirmation and removes exactly one schedule", async ({ page }) => {
  await page.goto("/schedules");
  const rows = page.locator("[data-schedule-row]");
  await expect(rows).toHaveCount(5);
  page.once("dialog", (dialog) => dialog.dismiss());
  await rows.first().getByRole("button", { name: /^Delete / }).click();
  await expect(rows).toHaveCount(5);
  page.once("dialog", (dialog) => dialog.accept());
  await rows.first().getByRole("button", { name: /^Delete / }).click();
  await expect(rows).toHaveCount(4);
});

test("editor schedule deletion lost response reports unknown and disables blind retry", async ({ page }) => {
  await page.route("**/api/schedules/delete", async (route) => {
    await route.fetch();
    await route.abort("connectionreset");
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/edit-schedule?id=schedule-2");
  const remove = page.getByRole("button", { name: "Delete schedule" });
  await remove.click();
  await expect(page.locator("#formFeedback")).toContainText(/outcome unknown/i);
  await expect(remove).toBeDisabled();
});

test("schedule create locks semantic input after a committed lost response and reconciles durable success", async ({ page }) => {
  let releaseStatus;
  const statusGate = new Promise((resolve) => { releaseStatus = resolve; });
  await page.route("**/api/operations/**", async (route) => {
    await statusGate;
    await route.continue();
  });
  await page.route("**/api/schedules/create", async (route) => {
    await route.fetch();
    await route.abort("connectionreset");
  });
  await page.goto("/create-schedule");
  await page.locator("#scheduleName").fill("Lost response schedule");
  await page.locator("#startTime").fill("08:15");
  await page.locator("#day1").check();
  await page.locator("#zone1").check();
  await page.locator("#duration").fill("10");
  await page.locator("#addTaskBtn").click();
  await page.locator("#saveBtn").click();
  await expect(page.locator("#formFeedback")).toContainText(/outcome unknown/i);
  await expect(page.locator("#saveBtn")).toBeDisabled();
  await expect(page.locator("#scheduleName")).toBeDisabled();
  releaseStatus();
  await expect(page).toHaveURL(/\/schedules$/, { timeout: 5000 });
  await expect(page.getByText("Lost response schedule", { exact: true })).toBeVisible();
});

test("schedule create retries only the same stable key after reconciliation confirms no commit", async ({ page }) => {
  const requestIds = [];
  let attempts = 0;
  await page.route("**/api/schedules/create", async (route) => {
    const body = route.request().postDataJSON();
    requestIds.push(body.requestId);
    attempts += 1;
    if (attempts === 1) return route.abort("connectionreset");
    return route.continue();
  });
  await page.goto("/create-schedule");
  await page.locator("#scheduleName").fill("Same key retry");
  await page.locator("#startTime").fill("08:20");
  await page.locator("#day2").check();
  await page.locator("#zone2").check();
  await page.locator("#duration").fill("11");
  await page.locator("#addTaskBtn").click();
  await page.locator("#saveBtn").click();
  await expect(page.locator("#formFeedback")).toContainText(/outcome unknown/i);
  await expect(page.locator("#scheduleName")).toBeDisabled();
  await expect(page.locator("#saveBtn")).toBeEnabled({ timeout: 5000 });
  await expect(page.locator("#saveBtn")).toHaveText(/retry/i);
  await page.reload();
  await expect(page.locator("#scheduleName")).toHaveValue("Same key retry");
  await expect(page.locator("#scheduleName")).toBeDisabled();
  await expect(page.locator("#saveBtn")).toBeEnabled({ timeout: 5000 });
  await expect(page.locator("#saveBtn")).toHaveText(/retry/i);
  await page.locator("#saveBtn").click();
  await expect(page).toHaveURL(/\/schedules$/, { timeout: 5000 });
  expect(requestIds).toHaveLength(2);
  expect(requestIds[0]).toBe(requestIds[1]);
});

test("all mobile interactive targets meet 44 by 44 CSS pixels", async ({ page }) => {
  for (const viewport of mobileViewports) {
    await page.setViewportSize(viewport);
    for (const route of ["/", "/status", "/schedules", "/create-schedule", "/edit-schedule?id=schedule-1", "/activity", "/controller", "/quick-task"]) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      const failures = await page.locator("a,button,input,select,textarea,label[for]").evaluateAll((nodes) => nodes.flatMap((node) => {
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || !box.width || !box.height) return [];
        return box.width < 44 || box.height < 44 ? [{ tag: node.tagName, text: (node.textContent || node.getAttribute("aria-label") || "").trim(), width: box.width, height: box.height }] : [];
      }));
      expect(failures, `${route} at ${viewport.width}x${viewport.height}`).toEqual([]);
    }
  }
});

test("only actually running zones expose progressbars", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  await expect(page.getByRole("progressbar")).toHaveCount(1);
  await expect(page.getByRole("progressbar", { name: "Zone 4 watering progress" })).toBeVisible();
});

test("task state reconciles by polling while preserving stale last-known state", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  await expect(page.getByRole("button", { name: /Zone 4.*watering/i })).toBeVisible();
  await page.request.post("/__test/controller", { data: { mode: "online", tasks: [] } });
  await expect(page.getByRole("button", { name: /Zone 4.*idle/i })).toBeVisible({ timeout: 5000 });

  await page.request.post("/__test/controller", { data: { mode: "online", tasks: [{ id: "running-2", zones: [4], runTime: 20, startTime: Math.floor(Date.now() / 1000) }] } });
  await page.getByRole("button", { name: /Refresh controller status/i }).click();
  await expect(page.getByRole("button", { name: /Zone 4.*watering/i })).toBeVisible();
  await page.getByRole("button", { name: /Zone 4.*watering/i }).click();
  await expect(page.getByRole("button", { name: /^Stop watering/i })).toBeVisible();
  await page.request.post("/__test/controller", { data: { mode: "offline" } });
  await page.waitForTimeout(2500);
  await expect(page.locator("[data-testid=controller-freshness]")).toContainText(/stale|offline/i);
  await expect(page.getByRole("button", { name: /Zone 4.*watering/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Stop watering/i })).toHaveCount(0);
});

test("lost manual response is explicit outcome unknown and never invites blind retry", async ({ page }) => {
  await page.goto("/");
  await page.request.post("/__test/controller", { data: { mode: "lost-response", tasks: [] } });
  await page.getByRole("button", { name: "Zone 1", exact: true }).click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.locator("#quickMessage")).toContainText(/outcome unknown/i);
  await expect(page.locator("#quickMessage")).not.toContainText(/try again|retry/i);
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
});

for (const route of ["/", "/quick-task"]) {
  for (const viewport of [{ width: 1440, height: 900 }, ...mobileViewports]) {
    test(`${route} Quick Task enforces the shared contract at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      await expect(page.getByText("Runs once, right now", { exact: true })).toBeVisible();
      await expect(page.getByText("Pick at least one zone to start · durations in minutes", { exact: true })).toBeVisible();

      const presetNames = await page.locator(route === "/" ? ".qt-duration" : ".preset").allTextContents();
      expect(presetNames.map((text) => Number.parseInt(text, 10))).toEqual([5, 15, 30, 60]);
      if (route === "/") {
        const panel = await rect(page.locator("[data-testid=quick-task]"));
        for (const control of await page.locator(".qt-zone,.qt-duration,.qt-start").all()) {
          const bounds = await rect(control);
          expect(bounds.x).toBeGreaterThanOrEqual(panel.x);
          expect(bounds.y).toBeGreaterThanOrEqual(panel.y);
          expect(bounds.right).toBeLessThanOrEqual(panel.right);
          expect(bounds.bottom).toBeLessThanOrEqual(panel.bottom);
        }
        const copyClips = await page.locator(".qt-copy").evaluate((node) => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1);
        expect(copyClips).toBe(false);
      }
      const start = page.getByRole("button", { name: route === "/" ? "Start" : "Start watering", exact: true });
      await expect(start).toBeDisabled();

      if (route === "/") {
        await expect(page.getByRole("button", { name: "15 minutes" })).toHaveAttribute("aria-pressed", "true");
        const zone = page.getByRole("button", { name: "Zone 1", exact: true });
        await zone.click();
        await expect(start).toBeEnabled();
        await page.request.post("/__test/controller", { data: { mode: "offline" } });
        await page.getByRole("button", { name: /Refresh controller status/i }).click();
        await expect(start).toBeDisabled();
        await zone.click();
      } else {
        await expect(page.locator("#duration")).toHaveValue("15");
        const zone = page.locator("#zone1");
        await zone.check();
        await expect(start).toBeEnabled();
        await page.request.post("/__test/controller", { data: { mode: "offline" } });
        await expect(start).toBeDisabled({ timeout: 5000 });
        await zone.uncheck();
      }
      await expect(start).toBeDisabled();
    });
  }
}

test("dedicated Quick Task keeps Start disabled after an ambiguous response", async ({ page }) => {
  await page.request.post("/__test/controller", { data: { mode: "lost-response", tasks: [] } });
  await page.goto("/quick-task");
  await page.locator("#zone1").check();
  const start = page.getByRole("button", { name: "Start watering", exact: true });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.locator("#taskFeedback")).toContainText(/outcome unknown/i);
  await expect(start).toBeDisabled();
});

test("forms stay compact, non-lawn, labeled and accessible", async ({ page }) => {
  for (const viewport of [{ width: 1440, height: 900 }, ...mobileViewports]) {
    await page.setViewportSize(viewport);
    for (const route of ["/create-schedule", "/edit-schedule?id=schedule-1", "/quick-task"]) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("main .field")).toHaveCount(0);
      const bodyHeight = await page.locator("body").evaluate((node) => node.getBoundingClientRect().height);
      expect(bodyHeight, `${route} at ${viewport.width}`).toBeLessThanOrEqual(viewport.width === 390 ? 1250 : 1000);
      const axe = await new AxeBuilder({ page }).analyze();
      expect(axe.violations).toEqual([]);
    }
  }
});
