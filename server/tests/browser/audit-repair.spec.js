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

test("editor reports a durable idempotency conflict truthfully and permits corrective action", async ({ page }) => {
  await page.route("**/api/schedules/delete", (route) => route.fulfill({
    status: 409,
    contentType: "application/json",
    body: JSON.stringify({ error: "requestId was already used for another operation" }),
  }));
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/edit-schedule?id=schedule-2");
  const remove = page.getByRole("button", { name: "Delete schedule" });
  await remove.click();
  await expect(page.locator("#formFeedback")).toHaveText("Delete failed · requestId was already used for another operation");
  await expect(remove).toBeEnabled();
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

for (const viewport of [{ width: 1440, height: 900 }, ...mobileViewports]) {
  test(`schedule create retains semantic payload and request key across 503, delay and reload at ${viewport.width}x${viewport.height}`, async ({ page }) => {
  await page.setViewportSize(viewport);
  const requestIds = [];
  await page.route("**/api/schedules/create", async (route) => {
    requestIds.push(route.request().postDataJSON().requestId);
    if (requestIds.length === 1) return route.fulfill({
      status: 503,
      headers: { "Retry-After": "1" },
      contentType: "application/json",
      body: JSON.stringify({ error: "datastore busy", outcome: "not_applied", recovery: "Not applied. Retry this same requestId after the indicated delay." }),
    });
    return route.continue();
  });
  await page.goto("/create-schedule");
  await page.locator("#scheduleName").fill("Busy retained schedule");
  await page.locator("#startTime").fill("08:25");
  await page.locator("#day3").check();
  await page.locator("#zone3").check();
  await page.locator("#duration").fill("12");
  await page.locator("#addTaskBtn").click();
  await page.locator("#saveBtn").click();
  await expect(page.locator("#formFeedback")).toContainText(/datastore busy.*same request.*1 second/i);
  await expect(page.locator("#saveBtn")).toBeDisabled();
  await expect(page.locator("#saveBtn")).toBeEnabled({ timeout: 2500 });
  await page.reload();
  await expect(page.locator("#scheduleName")).toHaveValue("Busy retained schedule");
  await expect(page.locator("#scheduleName")).toBeDisabled();
  await expect(page.locator("#saveBtn")).toHaveText(/retry/i);
  await expect(page.locator("#saveBtn")).toBeEnabled({ timeout: 2500 });
  await page.locator("#saveBtn").click();
  await expect(page).toHaveURL(/\/schedules$/);
  expect(requestIds).toHaveLength(2);
  expect(requestIds[0]).toBe(requestIds[1]);
  });
}

for (const route of ["/", "/quick-task"]) {
  for (const viewport of [{ width: 1440, height: 900 }, ...mobileViewports]) {
  test(`${route} retains one Quick Task key and payload through definitive overload and reload at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const requestIds = [];
    await page.route("**/api/tasks/create", async (intercept) => {
      requestIds.push(intercept.request().postDataJSON().requestId);
      if (requestIds.length === 1) return intercept.fulfill({
        status: 503,
        headers: { "Retry-After": "1" },
        contentType: "application/json",
        body: JSON.stringify({ error: "datastore busy", outcome: "not_applied", recovery: "Not applied. Retry this same requestId after the indicated delay." }),
      });
      return intercept.continue();
    });
    await page.goto(route);
    if (route === "/") await page.getByRole("button", { name: "Zone 2", exact: true }).click();
    else await page.locator("#zone2").check();
    const start = page.getByRole("button", { name: route === "/" ? "Start" : "Start watering", exact: true });
    await start.click();
    const feedback = page.locator(route === "/" ? "#quickMessage" : "#taskFeedback");
    await expect(feedback).toContainText(/datastore busy.*same request.*1 second/i);
    await expect(start).toBeDisabled();
    await expect(start).toBeEnabled({ timeout: 2500 });
    await page.reload();
    const restored = page.getByRole("button", { name: route === "/" ? "Start" : "Start watering", exact: true });
    if (route === "/") await expect(page.getByRole("button", { name: "Zone 2", exact: true })).toHaveAttribute("aria-pressed", "true");
    else await expect(page.locator("#zone2")).toBeChecked();
    await expect(restored).toBeEnabled({ timeout: 2500 });
    await restored.click();
    await expect(page).toHaveURL(/\/$/);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toBe(requestIds[1]);
  });
  }
}

for (const route of ["/", "/quick-task"]) {
  for (const viewport of [{ width: 1440, height: 900 }, ...mobileViewports]) {
    test(`${route} preserves one controller add through causal post-controller saturation and reload at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.request.post("/__test/controller", { data: { mode: "post-controller-overload", tasks: [] } });
      await page.goto(route);
      if (route === "/") await page.getByRole("button", { name: "Zone 3", exact: true }).click();
      else await page.locator("#zone3").check();
      const start = page.getByRole("button", { name: route === "/" ? "Start" : "Start watering", exact: true });
      await start.click();
      const feedback = page.locator(route === "/" ? "#quickMessage" : "#taskFeedback");
      await expect(feedback).toContainText(/outcome unknown/i);
      const beforeReload = await page.request.get("/__test/state");
      expect((await beforeReload.json()).adds).toBe(1);
      await page.reload();
      await expect(feedback).toContainText(/outcome unknown/i);
      await expect(page.getByRole("button", { name: route === "/" ? "Start" : "Start watering", exact: true })).toBeDisabled();
      const afterReload = await page.request.get("/__test/state");
      expect((await afterReload.json()).adds).toBe(1);
    });
  }
}

const quickOutcomeCases = [
  { name: "202", status: 202, body: { operationId: "pending-browser-operation-0001", state: "pending", outcome: "unknown", recovery: "This request will not be sent again." } },
  { name: "409", status: 409, body: { error: "requestId was already used for another operation" } },
  { name: "network reset", status: 0, body: {} },
];
for (const route of ["/", "/quick-task"]) {
  for (const viewport of [{ width: 1440, height: 900 }, ...mobileViewports]) {
    for (const outcome of quickOutcomeCases) {
      test(`${route} classifies ${outcome.name} without stale-state lies at ${viewport.width}x${viewport.height}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const requestIds = [];
        await page.route("**/api/operations/**", (operationRoute) => operationRoute.fulfill({
          status: outcome.name === "202" ? 200 : 404,
          contentType: "application/json",
          body: JSON.stringify(outcome.name === "202" ? outcome.body : { error: "operation not found" }),
        }));
        await page.route("**/api/tasks/create", async (intercept) => {
          requestIds.push(intercept.request().postDataJSON().requestId);
          if (outcome.name === "network reset" && requestIds.length === 1) return intercept.abort("connectionreset");
          if (outcome.name === "network reset") return intercept.continue();
          return intercept.fulfill({ status: outcome.status, contentType: "application/json", body: JSON.stringify(outcome.body) });
        });
        await page.goto(route);
        if (route === "/") await page.getByRole("button", { name: "Zone 1", exact: true }).click();
        else await page.locator("#zone1").check();
        const start = page.getByRole("button", { name: route === "/" ? "Start" : "Start watering", exact: true });
        await start.click();
        const feedback = page.locator(route === "/" ? "#quickMessage" : "#taskFeedback");
        if (outcome.name === "409") {
          await expect(feedback).toContainText(/conflict.*refresh.*edit/i);
          if (route === "/") {
            await expect(page.locator("[data-testid=controller-freshness]")).toHaveText("Controller status current");
            await page.getByRole("button", { name: "Zone 2", exact: true }).click();
          } else {
            await page.locator("#zone2").check();
          }
          await expect(start).toBeEnabled();
        } else if (outcome.name === "202") {
          await expect(feedback).toContainText(/outcome unknown/i);
          await expect(start).toBeDisabled();
          await page.reload();
          await expect(page.getByRole("button", { name: route === "/" ? "Start" : "Start watering", exact: true })).toBeDisabled();
          expect(requestIds).toHaveLength(1);
        } else {
          await expect(feedback).toContainText(/retry only this same request/i, { timeout: 2500 });
          await expect(start).toBeEnabled();
          await page.reload();
          const restored = page.getByRole("button", { name: route === "/" ? "Start" : "Start watering", exact: true });
          await expect(restored).toBeEnabled({ timeout: 2500 });
          await restored.click();
          expect(requestIds).toHaveLength(2);
          expect(requestIds[0]).toBe(requestIds[1]);
        }
      });
    }
  }
}

for (const route of ["/", "/quick-task"]) {
  test(`${route} treats a durable controller rejection after network loss as definitive`, async ({ page }) => {
    let requestId;
    await page.route("**/api/tasks/create", async (route) => {
      requestId = route.request().postDataJSON().requestId;
      await route.abort("connectionreset");
    });
    await page.route("**/api/operations/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ operationId: requestId, state: "rejected", outcome: "rejected", recovery: "Controller rejected the request." }) }));
    await page.goto(route);
    if (route === "/") {
      await page.getByRole("button", { name: "Zone 2", exact: true }).click();
      await page.getByRole("button", { name: "Start", exact: true }).click();
      await expect(page.locator("#quickMessage")).toContainText(/rejected.*edit|edit.*rejected/i);
      await expect(page.locator("[data-testid=controller-freshness]")).toHaveText("Controller status current");
    } else {
      await page.locator("#zone2").check();
      await page.getByRole("button", { name: "Start watering", exact: true }).click();
      await expect(page.locator("#taskFeedback")).toContainText(/rejected.*edit|edit.*rejected/i);
      await expect(page).toHaveURL(/\/quick-task$/);
    }
  });
}

const stopOutcomeCases = [
  { name: "503", status: 503, body: { error: "datastore busy", outcome: "not_applied", recovery: "Retry this same requestId." }, headers: { "Retry-After": "1" } },
  { name: "202", status: 202, body: { operationId: "pending-stop-operation-0001", state: "pending", outcome: "unknown" } },
  { name: "409", status: 409, body: { error: "requestId was already used for another operation" } },
  { name: "network reset", status: 0, body: {} },
];
for (const viewport of [{ width: 1440, height: 900 }, ...mobileViewports]) {
  for (const outcome of stopOutcomeCases) {
    test(`Stop classifies ${outcome.name}, preserves key and online state at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const requestIds = [];
      await page.route("**/api/operations/**", (operationRoute) => operationRoute.fulfill({
        status: outcome.name === "202" ? 200 : 404,
        contentType: "application/json",
        body: JSON.stringify(outcome.name === "202" ? outcome.body : { error: "operation not found" }),
      }));
      await page.route("**/api/tasks/delete", async (intercept) => {
        requestIds.push(intercept.request().postDataJSON().requestId);
        if ((outcome.name === "503" || outcome.name === "network reset") && requestIds.length > 1) return intercept.continue();
        if (outcome.name === "network reset") return intercept.abort("connectionreset");
        return intercept.fulfill({ status: outcome.status, headers: outcome.headers, contentType: "application/json", body: JSON.stringify(outcome.body) });
      });
      await page.goto("/status");
      await page.getByRole("button", { name: /Zone 4.*watering/i }).click();
      await page.getByRole("button", { name: /^Stop watering/i }).click();
      const feedback = page.locator("#fieldMutationFeedback");
      await expect(page.locator("[data-testid=controller-freshness]")).toHaveText("Controller status current");
      if (outcome.name === "503") {
        await expect(feedback).toContainText(/not applied.*same Stop.*1 second/i);
        await page.waitForTimeout(1050);
      } else if (outcome.name === "202") {
        await expect(feedback).toContainText(/outcome unknown/i);
        expect(requestIds).toHaveLength(1);
        return;
      } else if (outcome.name === "409") {
        await expect(feedback).toContainText(/conflict.*refresh/i);
        expect(requestIds).toHaveLength(1);
        return;
      } else {
        await expect(feedback).toContainText(/retry only this same Stop/i, { timeout: 2500 });
      }
      await page.getByRole("button", { name: /^Stop watering/i }).click();
      await expect(feedback).toHaveText("Task stopped");
      expect(requestIds).toHaveLength(2);
      expect(requestIds[0]).toBe(requestIds[1]);
    });
  }
}

test("definitive Stop conflict keeps truthful online task state and gives concise recovery", async ({ page }) => {
  await page.route("**/api/tasks/delete", (route) => route.fulfill({
    status: 409,
    contentType: "application/json",
    body: JSON.stringify({ error: "requestId was already used for another operation" }),
  }));
  await page.goto("/status");
  await page.getByRole("button", { name: /Zone 4.*watering/i }).click();
  await page.getByRole("button", { name: /^Stop watering/i }).click();
  await expect(page.locator("#fieldMutationFeedback")).toContainText(/conflict.*refresh/i);
  await expect(page.locator("[data-testid=controller-freshness]")).toHaveText("Controller status current");
  await expect(page.getByRole("button", { name: /Zone 4.*watering/i })).toBeVisible();
  await page.getByRole("button", { name: /^Stop watering/i }).click();
  await expect(page.locator("#fieldMutationFeedback")).toContainText(/refresh required/i);
});

const removeOutcomeCases = [
  {
    name: "503",
    response: { status: 503, headers: { "Retry-After": "1" }, body: { error: "datastore busy", outcome: "not_applied" } },
    copy: "Datastore busy · Remove was not applied. Retry this same Remove in 1 second.",
  },
  {
    name: "409",
    response: { status: 409, body: { error: "requestId was already used for another operation" } },
    copy: "Remove conflict · task unchanged. Refresh status before a deliberate new Remove.",
  },
  {
    name: "202",
    response: { status: 202, body: { operationId: "pending-remove-operation", state: "pending", outcome: "unknown" } },
    copy: "Remove outcome unknown · check the visible task state. No new Remove will be sent.",
  },
  { name: "network", response: null, copy: "Remove not committed · retry only this same Remove." },
];

for (const viewport of [{ width: 1440, height: 900 }, ...mobileViewports]) {
  for (const outcome of removeOutcomeCases) {
    test(`queued Remove uses Remove-only ${outcome.name} recovery and stable retry at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const requests = [];
      await page.route("**/api/operations/**", (route) => route.fulfill({
        status: outcome.name === "202" ? 200 : 404,
        contentType: "application/json",
        body: JSON.stringify(outcome.name === "202" ? outcome.response.body : { error: "operation not found" }),
      }));
      await page.route("**/api/tasks/delete", async (route) => {
        requests.push(route.request().postDataJSON());
        if (requests.length > 1) return route.continue();
        if (!outcome.response) return route.abort("connectionreset");
        return route.fulfill({
          status: outcome.response.status,
          headers: outcome.response.headers,
          contentType: "application/json",
          body: JSON.stringify(outcome.response.body),
        });
      });
      await page.goto("/status");
      await page.getByRole("button", { name: /Zone 6.*queued/i }).click();
      const remove = page.getByRole("button", { name: /^Remove queued task/i });
      await expect(remove).toHaveAttribute("aria-label", /Remove queued task/);
      await expect(remove).not.toHaveAttribute("aria-label", /Stop/);
      await remove.click();
      const feedback = page.locator("#fieldMutationFeedback");
      await expect(feedback).toHaveText(outcome.copy, { timeout: 3000 });
      await expect(feedback).not.toContainText("Stop");
      await expect(page.locator("[data-testid=controller-freshness]")).toHaveText("Controller status current");
      if (outcome.name === "503" || outcome.name === "network") {
        await expect(remove).toBeEnabled({ timeout: 2500 });
        await remove.click();
        await expect(feedback).toHaveText("Task removed");
        expect(requests).toHaveLength(2);
        expect(requests[1]).toEqual(requests[0]);
      } else {
        expect(requests).toHaveLength(1);
      }
    });
  }
}

for (const viewport of [{ width: 1440, height: 900 }, ...mobileViewports]) {
  test(`queued Remove reload after elapsed 503 delay keeps same-key retry usable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const requests = [];
    await page.route("**/api/tasks/delete", async (route) => {
      requests.push(route.request().postDataJSON());
      if (requests.length > 1) return route.continue();
      return route.fulfill({
        status: 503,
        headers: { "Content-Type": "application/json", "Retry-After": "1" },
        body: JSON.stringify({ error: "datastore busy", outcome: "not_applied" }),
      });
    });
    await page.goto("/status");
    await page.getByRole("button", { name: /Zone 6.*queued/i }).click();
    await page.getByRole("button", { name: /^Remove queued task/i }).click();
    await expect(page.locator("#fieldMutationFeedback")).toHaveText("Datastore busy · Remove was not applied. Retry this same Remove in 1 second.");
    await page.waitForTimeout(1100);
    await page.reload();
    await page.getByRole("button", { name: /Zone 6.*queued/i }).click();
    const retry = page.getByRole("button", { name: /^Remove queued task/i });
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect(page.locator("#fieldMutationFeedback")).toHaveText("Task removed");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
  });
}

test("legacy queued pending mutation infers Remove before reconciliation without emitting Stop copy", async ({ page }) => {
  const requestId = "legacy-queued-remove-pending-0001";
  await page.addInitScript(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), {
    key: "sprinkler.pendingMutation.task-delete.queued.v1",
    value: { requestId, payload: { id: "queued" } },
  });
  let tasksResolved = false;
  const reconciliationOrder = [];
  await page.route("**/api/tasks", async (route) => {
    await route.continue();
    tasksResolved = true;
  });
  await page.route("**/api/operations/**", (route) => {
    reconciliationOrder.push(tasksResolved);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ operationId: requestId, state: "pending", outcome: "unknown" }) });
  });
  await page.goto("/status");
  await expect(page.locator("#fieldMutationFeedback")).toHaveText("Remove outcome unknown · check the visible task state. No new Remove will be sent.");
  await expect(page.locator("#fieldMutationFeedback")).not.toContainText("Stop");
  expect(reconciliationOrder).toEqual([true]);
  await page.getByRole("button", { name: /Zone 6.*queued/i }).click();
  await expect(page.getByRole("button", { name: /^Remove queued task/i })).toBeDisabled();
  const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem("sprinkler.pendingMutation.task-delete.queued.v1")));
  expect(stored).toMatchObject({ requestId, payload: { id: "queued" }, operationKind: "remove", recoveryState: "pending" });
});

for (const viewport of [{ width: 1440, height: 900 }, ...mobileViewports]) {
  for (const operation of [
    { kind: "stop", zoneNumber: 4, zone: /Zone 4.*watering/i, action: /^Stop watering/i, pending: "Stop outcome unknown · reconciling. No new Stop will be sent.", success: "Task stopped" },
    { kind: "remove", zoneNumber: 6, zone: /Zone 6.*queued/i, action: /^Remove queued task/i, pending: "Remove outcome unknown · reconciling. No new Remove will be sent.", success: "Task removed" },
  ]) {
    test(`${operation.kind} reload restores atomic pending truth before successful reconciliation at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const requests = [];
      let operationChecks = 0;
      let releaseReloadCheck;
      const reloadCheck = new Promise((resolve) => { releaseReloadCheck = resolve; });
      await page.route("**/api/tasks/delete", (route) => {
        requests.push(route.request().postDataJSON());
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ operationId: `${operation.kind}-pending`, state: "pending", outcome: "unknown" }) });
      });
      await page.route("**/api/operations/**", async (route) => {
        operationChecks += 1;
        if (operationChecks === 1) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ operationId: `${operation.kind}-pending`, state: "pending", outcome: "unknown" }) });
        await reloadCheck;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ operationId: `${operation.kind}-pending`, state: "completed", outcome: "committed" }) });
      });
      await page.goto("/status");
      await page.getByRole("button", { name: operation.zone }).click();
      await page.getByRole("button", { name: operation.action }).click();
      await expect(page.locator("#fieldMutationFeedback")).toContainText(/outcome unknown/i);
      await page.reload({ waitUntil: "domcontentloaded" });
      const feedback = page.locator("#fieldMutationFeedback");
      await expect(feedback).toHaveText(operation.pending);
      await expect(page.locator("[data-testid=controller-freshness]")).toHaveText("Controller status current");
      await page.locator(`[data-testid=field-zone-${operation.zoneNumber}] .field-zone`).click();
      const action = page.getByRole("button", { name: operation.action });
      await expect(action).toBeDisabled();
      await action.click({ force: true });
      expect(requests).toHaveLength(1);
      const storedBefore = await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.includes("task-delete")));
      expect(storedBefore).toHaveLength(1);
      expect(JSON.parse(storedBefore[0][1])).toMatchObject({ requestId: requests[0].requestId, payload: { id: requests[0].id }, operationKind: operation.kind, recoveryState: "pending" });
      releaseReloadCheck();
      await expect(feedback).toHaveText(operation.success);
      await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.includes("task-delete")).length)).toBe(0);
      expect(requests).toHaveLength(1);
    });
  }
}

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
