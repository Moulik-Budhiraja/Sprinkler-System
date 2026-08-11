/* The Zone-N Stop/Remove control must visibly emerge from its own sprinkler:
 * a painted mechanical connector starts at the rendered silhouette's base
 * attachment point and terminates tucked into the control's housing — one
 * continuous assembly. The status rail may never float between them. These
 * specs drive the live composited paint through the shared predicate in
 * stop-attachment-utils.js for every silhouette variant, layout, busy mix
 * and 200% text zoom, in both engines, and prove via negative controls that
 * the same predicate rejects the detached and rail-severed layouts. */

import { expect, test } from "@playwright/test";

import {
  doubleTextSize,
  intersects,
  makeBusyZones,
  rectOf,
  silhouetteRect,
} from "./design-repair-utils.js";
import {
  attachmentGeometry,
  attachmentViolations,
  settleGeometry,
} from "./stop-attachment-utils.js";

const layouts = [
  { name: "mobile", viewport: { width: 390, height: 844 } },
  { name: "desktop", viewport: { width: 1440, height: 900 } },
];

const nowSec = () => Math.floor(Date.now() / 1000);
const allRunning = () => [1, 2, 3, 4, 5, 6].map((z) => (
  { id: `run-${z}`, zones: [z], runTime: 20, startTime: nowSec() - 240 }
));
const allQueued = () => [1, 2, 3, 4, 5, 6].map((z) => (
  { id: `queued-${z}`, zones: [z], runTime: 10, startTime: 0 }
));

async function setTasks(page, tasks) {
  await page.request.post("/__test/controller", { data: { mode: "online", tasks } });
  await page.getByRole("button", { name: "Refresh controller status" }).click();
}

async function openField(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
}

async function expectAssembled(page, zone, label) {
  const geometry = await attachmentGeometry(page, zone);
  expect(attachmentViolations(geometry), `${label}: zone ${zone} assembly contract`).toEqual([]);
  return geometry;
}

const rectDistance = (a, b) => Math.hypot(
  Math.max(b.x - a.right, a.x - b.right, 0),
  Math.max(b.y - a.bottom, a.y - b.bottom, 0)
);

test.afterEach(async ({ request }) => {
  await request.post("/__test/reset");
});

/* The reported screenshot state: only zone 4 watering. Its Stop valve must
 * be one continuous assembly with the zone-4 sprinkler at every phone
 * width, with the status rail integrated instead of floating across. */
for (const width of [320, 390, 430]) {
  test(`zone 4 running alone is one continuous sprinkler-to-valve assembly at ${width}x844`, async ({ page }) => {
    await openField(page, { width, height: 844 });
    await setTasks(page, [{ id: "running-4", zones: [4], runTime: 20, startTime: nowSec() - 240 }]);
    await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(1);
    await settleGeometry(page);
    const geometry = await expectAssembled(page, 4, `zone 4 alone at ${width}`);
    expect(geometry.controlKind, "a running zone offers exactly Stop").toBe("stop");
    // The watering progress rail exists, but as part of the assembly — never
    // a floating bar severing stem from housing.
    expect(geometry.waterline.opacity, "running zone still shows its progress rail").toBeGreaterThan(0.9);
    expect(geometry.railSevers, "rail must not sever the assembly").toBe(false);
  });
}

/* Every silhouette variant in both approved arrangements, running (Stop
 * valve) and queued (Remove coupler): each zone's control emerges from its
 * own exact silhouette. */
for (const layout of layouts) {
  test(`all six running zones keep continuous Stop assemblies for every variant at ${layout.name}`, async ({ page }) => {
    test.slow();
    await openField(page, layout.viewport);
    await setTasks(page, allRunning());
    await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(6);
    await settleGeometry(page);
    const silhouettes = [];
    for (let zone = 1; zone <= 6; zone += 1) {
      silhouettes.push({ zone, rect: await silhouetteRect(page, zone) });
    }
    for (let zone = 1; zone <= 6; zone += 1) {
      const geometry = await expectAssembled(page, zone, `all-running ${layout.name}`);
      expect(geometry.controlKind, `zone ${zone} running control is Stop`).toBe("stop");
      // Ownership: the housing is nearer its own silhouette than any
      // neighbour's, and the painted connector never crosses a neighbour.
      const ranked = [...silhouettes]
        .sort((a, b) => rectDistance(geometry.control, a.rect) - rectDistance(geometry.control, b.rect));
      expect(ranked[0].zone, `zone ${zone} housing is closest to its own silhouette (${layout.name})`).toBe(zone);
      for (const { zone: other, rect } of silhouettes) {
        if (other === zone) continue;
        expect(intersects(geometry.connectorBBoxCss, rect),
          `zone ${zone} connector crosses zone ${other} silhouette (${layout.name})`).toBe(false);
      }
    }
  });

  test(`all six queued zones keep continuous Remove assemblies for every variant at ${layout.name}`, async ({ page }) => {
    test.slow();
    await openField(page, layout.viewport);
    await setTasks(page, allQueued());
    await expect(page.locator("[data-testid=zone-remove]")).toHaveCount(6);
    await settleGeometry(page);
    for (let zone = 1; zone <= 6; zone += 1) {
      const geometry = await expectAssembled(page, zone, `all-queued ${layout.name}`);
      expect(geometry.controlKind, `zone ${zone} queued control is Remove`).toBe("remove");
    }
  });

  test(`mixed shared/solo/queued busy zones keep per-zone assemblies at ${layout.name}`, async ({ page }) => {
    test.slow();
    await openField(page, layout.viewport);
    await makeBusyZones(page);
    await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(3);
    await expect(page.locator("[data-testid=zone-remove]")).toHaveCount(1);
    await settleGeometry(page);
    for (const zone of [1, 2, 4, 6]) {
      const geometry = await expectAssembled(page, zone, `mixed busy ${layout.name}`);
      expect(geometry.controlKind, `zone ${zone} control semantics`)
        .toBe(zone === 6 ? "remove" : "stop");
    }
  });

  test(`busy assemblies hold under 200% text zoom at ${layout.name}`, async ({ page }) => {
    test.slow();
    await openField(page, layout.viewport);
    await makeBusyZones(page);
    await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(3);
    await doubleTextSize(page);
    await settleGeometry(page);
    for (const zone of [1, 2, 4, 6]) {
      await expectAssembled(page, zone, `200% text zoom ${layout.name}`);
    }
  });
}

/* Truthful withdrawal: when controller state goes stale the control AND its
 * connector leave together — never an orphaned pipe promising a control. */
test("stale state withdraws the whole assembly, not just the control", async ({ page }) => {
  await openField(page, { width: 390, height: 844 });
  await setTasks(page, [{ id: "running-4", zones: [4], runTime: 20, startTime: nowSec() - 240 }]);
  await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(1);
  await page.request.post("/__test/controller", { data: { mode: "read-timeout" } });
  await page.getByRole("button", { name: "Refresh controller status" }).click();
  await expect(page.locator("[data-testid=controller-freshness]")).toHaveText(/stale/i);
  await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(0);
  await settleGeometry(page);
  const geometry = await attachmentGeometry(page, 4);
  expect(geometry.dockVisible, "no control means no assembly to measure").toBe(false);
  const orphanedConnector = await page.locator("[data-testid=field-zone-4] .dock-connector")
    .evaluateAll((nodes) => nodes.filter((node) => {
      const style = getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden";
    }).length);
  expect(orphanedConnector, "stale state leaves no orphaned connector").toBe(0);
});

/* -------------------------------------------------------- negative controls
 * The exact user-reported layout — stem, floating status rail, detached
 * octagonal Stop on empty lawn — and a rail painted across the connection
 * must both fail the very same shared predicate the positive tests use. */
test.describe("shared predicate negative controls (390x844, zone 4 running)", () => {
  test.beforeEach(async ({ page }) => {
    await openField(page, { width: 390, height: 844 });
    await setTasks(page, [{ id: "running-4", zones: [4], runTime: 20, startTime: nowSec() - 240 }]);
    await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(1);
    await settleGeometry(page);
  });

  test("the detached design (no connector, rail floating mid-gap) fails the predicate", async ({ page }) => {
    await page.evaluate(() => {
      const wrap = document.querySelector("[data-testid=field-zone-4]");
      const svg = wrap.querySelector("svg.char");
      const rect = svg.getBoundingClientRect();
      const scale = Math.min(rect.width / 200, rect.height / 150);
      const offsetX = (rect.width - 200 * scale) / 2;
      const offsetY = (rect.height - 150 * scale) / 2;
      // The pre-repair construction: no connector, rail centred beneath the
      // silhouette in the empty gap between stem and control.
      const style = document.createElement("style");
      style.id = "negative-detached";
      style.textContent = `
        [data-testid=field-zone-4] .dock-connector { display: none !important; }
        [data-testid=field-zone-4] .waterline {
          left: ${(offsetX + 100 * scale).toFixed(1)}px !important;
          top: ${(offsetY + 150 * scale + 4).toFixed(1)}px !important;
        }`;
      document.head.append(style);
    });
    await settleGeometry(page);
    const geometry = await attachmentGeometry(page, 4);
    const violations = attachmentViolations(geometry);
    expect(violations.length, "detached layout must fail the shared predicate").toBeGreaterThan(0);
    expect(violations.join("; ")).toMatch(/detached object|discontinuous/);
    expect(violations.join("; "), "the floating rail is itself detected").toMatch(/status rail/);
    await page.evaluate(() => document.getElementById("negative-detached")?.remove());
  });

  test("a status rail repositioned across the connection fails the predicate", async ({ page }) => {
    await page.evaluate(() => {
      const wrap = document.querySelector("[data-testid=field-zone-4]");
      const wrapRect = wrap.getBoundingClientRect();
      const svg = wrap.querySelector("svg.char");
      const rect = svg.getBoundingClientRect();
      const scale = Math.min(rect.width / 200, rect.height / 150);
      const offsetX = (rect.width - 200 * scale) / 2;
      const offsetY = (rect.height - 150 * scale) / 2;
      const control = wrap.querySelector(".zone-dock button");
      const controlTop = control
        ? control.getBoundingClientRect().top - wrapRect.top
        : offsetY + 150 * scale + 20;
      const silhouetteBottom = offsetY + 132 * scale;
      const midY = (silhouetteBottom + controlTop) / 2;
      const style = document.createElement("style");
      style.id = "negative-severed";
      style.textContent = `
        [data-testid=field-zone-4] .waterline {
          left: ${(offsetX + 100 * scale).toFixed(1)}px !important;
          top: ${midY.toFixed(1)}px !important;
          z-index: 7 !important;
          opacity: 1 !important;
        }`;
      document.head.append(style);
    });
    await settleGeometry(page);
    const geometry = await attachmentGeometry(page, 4);
    const violations = attachmentViolations(geometry);
    expect(violations.length, "rail-severed layout must fail the shared predicate").toBeGreaterThan(0);
    expect(violations.join("; ")).toMatch(/status rail|discontinuous/);
    await page.evaluate(() => document.getElementById("negative-severed")?.remove());
  });
});
