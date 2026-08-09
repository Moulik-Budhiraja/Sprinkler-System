import { expect, test } from "@playwright/test";

const viewports = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 390, height: 1067 },
];

for (const route of ["/", "/status"]) {
  for (const viewport of viewports) {
    test(`${route} preserves live tasks and truthfully recovers from read capacity overload at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.request.post("/__test/reset");
      await page.goto(route);
      await page.waitForSelector("[data-testid=field-zone-6]");
      await expect(page.getByRole("button", { name: /Zone 4.*watering/i })).toBeVisible();
      await expect(page.locator("[data-testid=controller-freshness]")).toHaveText("Controller status current");

      await page.request.post("/__test/controller", { data: { mode: "read-overload" } });
      await page.evaluate(() => {
        window.__readOverloadMutation = fetch("/api/tasks/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: "browser-read-overload-0001", zones: [1], runTime: 5 }),
        });
      });
      await expect.poll(async () => (await (await page.request.get("/__test/state")).json()).adds).toBe(1);
      await page.getByRole("button", { name: "Refresh controller status" }).evaluate((button) => button.click());

      const freshness = page.locator("[data-testid=controller-freshness]");
      await expect(freshness).toHaveText("Controller busy · try again shortly");
      await expect(freshness).toHaveAttribute("data-state", "busy");
      await expect(page.getByText(/Controller offline|stale last-known/i)).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Zone 4.*watering/i })).toBeVisible();

      await page.request.post("/__test/controller", { data: { mode: "online", release: true } });
      await expect.poll(async () => (await (await page.request.get("/__test/state")).json()).controllerWork.admitted).toBe(0);
      await page.getByRole("button", { name: "Refresh controller status" }).evaluate((button) => button.click());
      await expect(freshness).toHaveText("Controller status current");
      await expect(freshness).toHaveAttribute("data-state", "live");
      await expect(page.getByRole("button", { name: /Zone 4.*watering/i })).toBeVisible();
    });
  }
}

for (const failureMode of ["read-timeout", "read-reject", "read-abort"]) {
  for (const route of ["/", "/status"]) {
    test(`${route} marks last-known controller state stale after ${failureMode} and recovers`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.request.post("/__test/reset");
      await page.goto(route);
      await page.waitForSelector("[data-testid=field-zone-6]");
      const freshness = page.locator("[data-testid=controller-freshness]");
      await expect(freshness).toHaveText("Controller status current");
      await expect(page.getByRole("button", { name: /Zone 4.*watering/i })).toBeVisible();

      await page.request.post("/__test/controller", { data: { mode: failureMode } });
      await page.getByRole("button", { name: "Refresh controller status" }).evaluate((button) => button.click());
      await expect(freshness).toHaveText("Controller offline · showing stale last-known state");
      await expect(freshness).toHaveAttribute("data-state", "stale");
      await expect(page.getByRole("button", { name: /Zone 4.*watering/i })).toBeVisible();
      await expect(page.getByText(/outcome unknown|same request|retry this request/i)).toHaveCount(0);

      await page.request.post("/__test/controller", { data: { mode: "online" } });
      await page.getByRole("button", { name: "Refresh controller status" }).evaluate((button) => button.click());
      await expect(freshness).toHaveText("Controller status current");
      await expect(freshness).toHaveAttribute("data-state", "live");
    });
  }
}
