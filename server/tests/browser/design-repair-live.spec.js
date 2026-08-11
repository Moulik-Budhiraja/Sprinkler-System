/* Live composited paint regression.
 *
 * These tests measure the ACTUAL page the engine painted — via
 * livePaintGeometry's phase-differential screenshots — so engine- and
 * DPR-specific rendering differences are visible to the assertions. The
 * detached construction-model instrument (outlineGeometry) is deliberately
 * engine-independent and cannot see live compositing; cross-engine paint
 * claims live here, in this spec, which runs in both Chromium and WebKit
 * at devicePixelRatio 1 and 2 over all six silhouette variants.
 *
 * Band rationale (threshold-24 "visibly painted" classification): the
 * construction is a 4 px empty gap, keyline outer edge 6.2 px, halo outer
 * edge 9.2 px, and a painted badge clearance of 2 px (stroke-inclusive).
 * Antialias fringes erode the empty gap by ≤ ~0.5 px and extend outer
 * edges by ≤ ~1.2 px at this threshold, so the bands hold every painted
 * measurement inside the intended 3–5 px gap while still catching the
 * ~1 px engine drift this spec was RED against.
 */
import { expect, test } from "@playwright/test";
import { livePaintGeometry } from "./design-repair-utils.js";

test.afterEach(async ({ request }) => {
  await request.post("/__test/reset");
});

const LIVE_PAINT = {
  gapMin: 3.4,
  gapMax: 4.6,
  keylineOuterMin: 6.0,
  keylineOuterMax: 7.6,
  haloOuterMin: 8.8,
  haloOuterMax: 10.4,
  badgeClearanceMin: 1.6, // 2 px painted construction − ≤0.4 px fringe
};

async function selectAllIdleZones(page) {
  await page.request.post("/__test/controller", { data: { mode: "online", tasks: [] } });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  for (let zone = 1; zone <= 6; zone += 1) {
    await page.getByRole("button", { name: new RegExp(`Zone ${zone}.*idle`, "i") }).click();
  }
  await page.waitForTimeout(80);
}

for (const dpr of [1, 2]) {
  test.describe(`live composited paint at devicePixelRatio ${dpr}`, () => {
    test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: dpr });

    test(`live outline paint keeps every variant inside the intended gap bands at DPR ${dpr}`, async ({ page }) => {
      await selectAllIdleZones(page);
      for (let zone = 1; zone <= 6; zone += 1) {
        const paint = await livePaintGeometry(page, zone);
        expect(paint.counts.silhouette, `zone ${zone} DPR ${dpr}: silhouette painted`).toBeGreaterThan(200);
        expect(paint.counts.keyline, `zone ${zone} DPR ${dpr}: keyline painted`).toBeGreaterThan(100);
        expect(paint.counts.halo, `zone ${zone} DPR ${dpr}: halo painted`).toBeGreaterThan(100);
        expect(paint.keyline.minCss, `zone ${zone} DPR ${dpr}: live painted gap floor (got ${paint.keyline.minCss.toFixed(2)})`)
          .toBeGreaterThanOrEqual(LIVE_PAINT.gapMin);
        expect(paint.keyline.minCss, `zone ${zone} DPR ${dpr}: live painted gap ceiling (got ${paint.keyline.minCss.toFixed(2)})`)
          .toBeLessThanOrEqual(LIVE_PAINT.gapMax);
        expect(paint.keyline.maxCss, `zone ${zone} DPR ${dpr}: live keyline outer edge (got ${paint.keyline.maxCss.toFixed(2)})`)
          .toBeGreaterThanOrEqual(LIVE_PAINT.keylineOuterMin);
        expect(paint.keyline.maxCss, `zone ${zone} DPR ${dpr}: live keyline never drifts outward (got ${paint.keyline.maxCss.toFixed(2)})`)
          .toBeLessThanOrEqual(LIVE_PAINT.keylineOuterMax);
        expect(paint.halo.maxCss, `zone ${zone} DPR ${dpr}: live halo outer edge (got ${paint.halo.maxCss.toFixed(2)})`)
          .toBeGreaterThanOrEqual(LIVE_PAINT.haloOuterMin);
        expect(paint.halo.maxCss, `zone ${zone} DPR ${dpr}: live halo never drifts outward (got ${paint.halo.maxCss.toFixed(2)})`)
          .toBeLessThanOrEqual(LIVE_PAINT.haloOuterMax);
      }
    });

    test(`live painted badge keeps stroke-aware clearance from every silhouette at DPR ${dpr}`, async ({ page }) => {
      await selectAllIdleZones(page);
      for (let zone = 1; zone <= 6; zone += 1) {
        const paint = await livePaintGeometry(page, zone);
        expect(paint.counts.badge, `zone ${zone} DPR ${dpr}: badge painted`).toBeGreaterThan(50);
        expect(paint.badge.minCss, `zone ${zone} DPR ${dpr}: painted badge clearance includes the stroke (got ${paint.badge.minCss.toFixed(2)})`)
          .toBeGreaterThanOrEqual(LIVE_PAINT.badgeClearanceMin);
      }
    });
  });
}

test.describe("live paint instrument negative controls", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a 1.5px live outline shift is detected through the same live bands", async ({ page }) => {
    await selectAllIdleZones(page);
    const clean = await livePaintGeometry(page, 3);
    expect(clean.keyline.minCss, "clean zone passes before the control").toBeGreaterThanOrEqual(LIVE_PAINT.gapMin);
    await page.evaluate(() => {
      const svg = document.querySelector("[data-testid=field-zone-3] svg.char");
      const rect = svg.getBoundingClientRect();
      const scale = Math.min(rect.width / 200, rect.height / 150);
      svg.querySelector("[data-selection-outline]")
        .setAttribute("transform", `translate(${(1.5 / scale).toFixed(3)} 0)`);
    });
    const shifted = await livePaintGeometry(page, 3);
    expect(shifted.keyline.minCss, "a 1.5px live drift lands below the gap floor")
      .toBeLessThan(LIVE_PAINT.gapMin);
  });

  test("a missing keyline is reported instead of passing silently", async ({ page }) => {
    await selectAllIdleZones(page);
    await page.addStyleTag({ content: "[data-testid=field-zone-2] .outline-keyline{display:none !important}" });
    const paint = await livePaintGeometry(page, 2);
    expect(paint.counts.keyline, "missing keyline paints zero pixels").toBe(0);
    expect(Number.isNaN(paint.keyline.minCss), "missing layer measures as NaN, never as a passing number").toBe(true);
  });
});

/* Desktop live composited paint: the declared bands must hold at desktop
 * scales too — the audited gap was zone 2 (the elder, rotated head)
 * eroding to 1.41px painted badge clearance at DPR 1, below the 1.6 floor
 * that was only ever exercised at 390px. */
for (const desktop of [
  { width: 1440, height: 900, dpr: 1 },
  { width: 1440, height: 900, dpr: 2 },
  { width: 1920, height: 1080, dpr: 1 },
  { width: 1920, height: 1080, dpr: 2 },
]) {
  test.describe(`desktop live paint ${desktop.width}x${desktop.height} DPR ${desktop.dpr}`, () => {
    test.use({ viewport: { width: desktop.width, height: desktop.height }, deviceScaleFactor: desktop.dpr });

    test(`live outline and painted badge clearance hold for every variant at ${desktop.width} DPR ${desktop.dpr}`, async ({ page }) => {
      await selectAllIdleZones(page);
      for (let zone = 1; zone <= 6; zone += 1) {
        const paint = await livePaintGeometry(page, zone);
        expect(paint.counts.silhouette, `zone ${zone}: silhouette painted`).toBeGreaterThan(200);
        expect(paint.keyline.minCss, `zone ${zone}: live painted gap floor (got ${paint.keyline.minCss.toFixed(2)})`)
          .toBeGreaterThanOrEqual(LIVE_PAINT.gapMin);
        expect(paint.keyline.minCss, `zone ${zone}: live painted gap ceiling (got ${paint.keyline.minCss.toFixed(2)})`)
          .toBeLessThanOrEqual(LIVE_PAINT.gapMax);
        expect(paint.badge.minCss,
          `zone ${zone}: painted badge clearance meets the declared floor (got ${paint.badge.minCss.toFixed(2)})`)
          .toBeGreaterThanOrEqual(LIVE_PAINT.badgeClearanceMin);
      }
      // Honest negative control at desktop scale: a 1.5px live outline
      // shift must break the same gap floor.
      await page.evaluate(() => {
        const svg = document.querySelector("[data-testid=field-zone-3] svg.char");
        const rect = svg.getBoundingClientRect();
        const scale = Math.min(rect.width / 200, rect.height / 150);
        svg.querySelector("[data-selection-outline]")
          .setAttribute("transform", `translate(${(1.5 / scale).toFixed(3)} 0)`);
      });
      const drifted = await livePaintGeometry(page, 3);
      expect(drifted.keyline.minCss, "a 1.5px live drift is detected at desktop scale")
        .toBeLessThan(LIVE_PAINT.gapMin);
      await page.evaluate(() => {
        document.querySelector("[data-testid=field-zone-3] [data-selection-outline]").removeAttribute("transform");
      });
    });
  });
}
