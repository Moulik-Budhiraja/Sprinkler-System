/* 200% zoom coverage, in three distinct and honestly-labelled forms:
 *
 * 1. ACTUAL page scale (Chromium only): Emulation.setPageScaleFactor — the
 *    engine's real pinch/page-scale API. The layout viewport keeps its CSS
 *    size while the visual viewport halves; assertions cover
 *    window.visualViewport scale/geometry, panning reachability and real
 *    tap input under scale. Playwright exposes no page-scale automation
 *    API for WebKit, so this suite is Chromium-only by necessity — the
 *    WebKit runs below are device-metrics equivalence, not actual scale.
 *
 * 2. Device-metrics 200% zoom equivalence (both engines): halved CSS
 *    layout viewport + deviceScaleFactor 2 — the layout geometry that
 *    desktop-browser zoom produces (browser zoom shrinks the CSS layout
 *    viewport and raises the device pixel ratio). Real contexts, real
 *    media-query behaviour, cross-engine.
 *
 * 3. Text zoom: font-size-only scaling (browser "text size" accessibility
 *    setting) emulated by doubling every element's computed font size while
 *    leaving all other lengths alone — the layout contract that setting
 *    imposes on a px-based stylesheet.
 */
import { expect, test } from "@playwright/test";
import {
  BADGE_CONTRACT,
  doubleTextSize,
  intersects,
  outlineViolations,
  makeBusyZones,
  noHorizontalOverflow,
  outlineGeometry,
  rectOf,
  silhouetteRect,
} from "./design-repair-utils.js";

test.afterEach(async ({ request }) => {
  await request.post("/__test/reset");
});

const PRIMARY_PATTERN = /^Zones? [\d, and]+ (started|stopped|outcome unknown)$/i;
const META_PATTERN = /^(Remote|Schedule|Manual|Completed|Home Assistant|Controller) · .+$/;

async function expectContained(page, label) {
  const geometry = await noHorizontalOverflow(page);
  expect(geometry.documentScrollWidth, `${label}: documentElement horizontal overflow`).toBe(geometry.documentClientWidth);
  expect(geometry.bodyScrollWidth, `${label}: body horizontal overflow`).toBe(geometry.bodyClientWidth);
}

async function expectDeviceMetricsZoom(page) {
  expect(await page.evaluate(() => window.devicePixelRatio), "device-metrics 200% zoom doubles the device pixel ratio").toBe(2);
}

async function expectReadableHistory(page, label) {
  const rows = page.locator("[data-history-row]");
  const count = await rows.count();
  expect(count, `${label}: history rows present`).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    const primary = row.locator(".history-primary");
    const meta = row.locator(".history-meta");
    await expect(primary, `${label} row ${i}: coherent primary phrase`).toHaveText(PRIMARY_PATTERN);
    await expect(meta, `${label} row ${i}: source metadata present`).toHaveText(META_PATTERN);
    const primaryBox = await rectOf(primary);
    const metaBox = await rectOf(meta);
    const rowBox = await rectOf(row);
    expect(metaBox.y - primaryBox.y, `${label} row ${i}: metadata never orphans from its phrase`)
      .toBeLessThanOrEqual(primaryBox.height + 12);
    expect(metaBox.bottom, `${label} row ${i}: metadata stays inside its row`).toBeLessThanOrEqual(rowBox.bottom + 0.5);
    const clipped = await row.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
    expect(clipped, `${label} row ${i}: row clips horizontally`).toBe(false);
  }
}

async function expectNavClearance(page, label) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(50);
  const nav = await page.locator(".mobile-nav").evaluate((node) => {
    const r = node.getBoundingClientRect();
    return { y: r.y, bottom: r.bottom, position: getComputedStyle(node).position };
  });
  expect(nav.position, `${label}: navigation stays fixed`).toBe("fixed");
  const viewport = page.viewportSize();
  expect(Math.abs(nav.bottom - viewport.height), `${label}: navigation pins to the viewport bottom (safe area)`)
    .toBeLessThanOrEqual(0.5);
  const lastRow = await rectOf(page.locator("[data-history-row]").last());
  expect(lastRow.bottom, `${label}: oldest history row clears the navigation`).toBeLessThanOrEqual(nav.y + 0.5);
  const refresh = await rectOf(page.getByRole("button", { name: "Refresh controller status" }));
  expect(refresh.bottom, `${label}: refresh control clears the navigation`).toBeLessThanOrEqual(nav.y + 0.5);
  return nav;
}

test.describe("device-metrics 200% zoom equivalence of a 390×844 phone (layout viewport 195×422, both engines)", () => {
  test.use({ viewport: { width: 195, height: 422 }, deviceScaleFactor: 2 });

  test("Today stays readable and contained with working navigation", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("[data-history-row]");
    await expectDeviceMetricsZoom(page);
    await expectContained(page, "Today at 200% zoom");
    // Sensitivity control: the containment probe must detect forced overflow.
    const detected = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.cssText = "width:4000px;height:2px";
      document.body.appendChild(probe);
      const overflowing = document.documentElement.scrollWidth > document.documentElement.clientWidth;
      probe.remove();
      return overflowing;
    });
    expect(detected, "containment probe detects a forced 4000px overflow").toBe(true);
    await expectContained(page, "Today after overflow control removed");
    await expectReadableHistory(page, "Today at 200% zoom");
    await expectNavClearance(page, "Today at 200% zoom");
    // Navigation still works: the fixed bottom nav routes to Activity.
    await page.locator(".mobile-nav").getByRole("link", { name: "Activity" }).click();
    await expect(page).toHaveURL(/\/activity$/);
    await page.waitForSelector("[data-history-row]");
  });

  test("selected and running field states keep badge, outline and Stop association at 200% zoom", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("[data-testid=field-zone-6]");
    await expectDeviceMetricsZoom(page);
    await page.getByRole("button", { name: /Zone 1.*idle/i }).click();
    await expect.poll(() => page.locator("[data-testid=field-zone-1] [data-selection-outline]")
      .evaluate((node) => Number.parseFloat(getComputedStyle(node).opacity)),
      { message: "selection outline reveals at zoom" }).toBeGreaterThanOrEqual(0.9);
    // The badge holds its exact rendered contract at this scale for every variant.
    for (let zone = 1; zone <= 6; zone += 1) {
      const geometry = await outlineGeometry(page, zone);
      expect(Math.abs(geometry.badge.distCss - BADGE_CONTRACT.distPx),
        `zone ${zone} at 200% zoom: badge centre distance (got ${geometry.badge.distCss.toFixed(2)})`)
        .toBeLessThanOrEqual(BADGE_CONTRACT.distTolerancePx);
      expect(Math.abs(geometry.badge.radiusCss - BADGE_CONTRACT.radiusPx),
        `zone ${zone} at 200% zoom: badge radius (got ${geometry.badge.radiusCss.toFixed(2)})`)
        .toBeLessThanOrEqual(BADGE_CONTRACT.radiusTolerancePx);
      expect(outlineViolations(geometry), `zone ${zone} at 200% zoom: full outline contract holds`)
        .toEqual([]);
    }
    // Negative control at this zoom level: a 1.5px drift must be caught by
    // the very same predicate, then the control is removed.
    await page.evaluate(() => {
      const svg = document.querySelector("[data-testid=field-zone-2] svg.char");
      const rect = svg.getBoundingClientRect();
      const scale = Math.min(rect.width / 200, rect.height / 150);
      svg.querySelector("[data-selection-outline]")
        .setAttribute("transform", `translate(${(1.5 / scale).toFixed(3)} 0)`);
    });
    const driftedAtZoom = await outlineGeometry(page, 2);
    expect(outlineViolations(driftedAtZoom), "a 1.5px drift is detected at 200% zoom").not.toEqual([]);
    await page.evaluate(() => {
      document.querySelector("[data-testid=field-zone-2] [data-selection-outline]").removeAttribute("transform");
    });
    await page.getByRole("button", { name: /Close Quick Task/i }).click();
    await makeBusyZones(page);
    await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(3);
    await expect(page.locator("[data-testid=zone-remove]")).toHaveCount(1);
    const silhouettes = [];
    for (let zone = 1; zone <= 6; zone += 1) {
      silhouettes.push({ zone, rect: await silhouetteRect(page, zone) });
    }
    const rectDistance = (a, b) => Math.hypot(
      Math.max(b.x - a.right, a.x - b.right, 0),
      Math.max(b.y - a.bottom, a.y - b.bottom, 0)
    );
    const boxes = [];
    for (const zone of [1, 2, 4, 6]) {
      const control = page.locator(`[data-testid=field-zone-${zone}] .zone-dock button`);
      await expect(control, `zone ${zone} control visible at zoom`).toBeVisible();
      const box = await rectOf(control);
      expect(box.width, `zone ${zone} control width at zoom`).toBeGreaterThanOrEqual(44);
      expect(box.height, `zone ${zone} control height at zoom`).toBeGreaterThanOrEqual(44);
      const sil = await silhouetteRect(page, zone);
      const controlCx = box.x + box.width / 2;
      // Centred under its silhouette, except for the documented clamp that
      // shifts a wide control back inside the lawn instead of overflowing;
      // the clamp allowance is exactly the shift the field edge forces.
      const field = await rectOf(page.locator("[data-testid=field]"));
      const silCx = sil.x + sil.width / 2;
      const clampAllowance = Math.max(0, silCx + box.width / 2 - (field.right - 4)) +
        Math.max(0, (field.x + 4) - (silCx - box.width / 2));
      const wrapSpanZ = await rectOf(page.locator(`[data-testid=field-zone-${zone}]`));
      const offCentreZ = Math.abs(controlCx - silCx);
      const inSpanZ = controlCx >= wrapSpanZ.x - 8 && controlCx <= wrapSpanZ.right + 8;
      expect(offCentreZ <= 10 + clampAllowance || (inSpanZ && offCentreZ <= 48),
        `zone ${zone} control associated with its silhouette at zoom (off-centre ${offCentreZ.toFixed(1)})`).toBe(true);
      expect(box.x, `zone ${zone} control stays inside the lawn at zoom`).toBeGreaterThanOrEqual(field.x + 3);
      expect(box.right, `zone ${zone} control stays inside the lawn at zoom`).toBeLessThanOrEqual(field.right - 3);
      expect(box.y - sil.bottom, `zone ${zone} control sits below its silhouette at zoom`).toBeGreaterThanOrEqual(2);
      // Association stays unambiguous: the control is nearest to its own
      // zone's silhouette and never overlaps any other zone's silhouette.
      const ranked = [...silhouettes].sort((a, b) => rectDistance(box, a.rect) - rectDistance(box, b.rect));
      expect(ranked[0].zone, `zone ${zone} control associates with its own silhouette at zoom`).toBe(zone);
      for (const { zone: other, rect: otherSil } of silhouettes) {
        if (other === zone) continue;
        const overlaps = Math.min(box.right, otherSil.right) - Math.max(box.x, otherSil.x) > 0.5 &&
          Math.min(box.bottom, otherSil.bottom) - Math.max(box.y, otherSil.y) > 0.5;
        expect(overlaps, `zone ${zone} control overlaps zone ${other} silhouette at zoom`).toBe(false);
      }
      boxes.push({ zone, box });
    }
    for (let a = 0; a < boxes.length; a += 1) {
      for (let b = a + 1; b < boxes.length; b += 1) {
        const overlap = Math.min(boxes[a].box.right, boxes[b].box.right) - Math.max(boxes[a].box.x, boxes[b].box.x) > 0.5 &&
          Math.min(boxes[a].box.bottom, boxes[b].box.bottom) - Math.max(boxes[a].box.y, boxes[b].box.y) > 0.5;
        expect(overlap, `zone ${boxes[a].zone} and zone ${boxes[b].zone} controls overlap at zoom`).toBe(false);
      }
    }
    await expectContained(page, "running docks at 200% zoom");
  });

  test("Activity keeps the row grammar readable and contained at 200% zoom", async ({ page }) => {
    for (let i = 0; i < 12; i += 1) {
      const response = await page.request.post("/api/history/create", {
        data: {
          zones: i % 3 === 0 ? [1, 4] : [(i % 6) + 1],
          event: i % 2 ? "Stopped" : "Started",
          reason: ["Remote", "Schedule", "Manual"][i % 3],
        },
      });
      expect(response.ok()).toBe(true);
    }
    await page.goto("/activity");
    await page.waitForSelector("[data-history-row]");
    await expectDeviceMetricsZoom(page);
    await expect(page.locator("[data-history-date]").first()).toBeVisible();
    await expectContained(page, "Activity at 200% zoom");
    await expectReadableHistory(page, "Activity at 200% zoom");
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(50);
    const nav = await rectOf(page.locator(".mobile-nav"));
    const lastRow = await rectOf(page.locator("[data-history-row]").last());
    expect(lastRow.bottom, "Activity at 200% zoom: oldest row clears the navigation").toBeLessThanOrEqual(nav.y + 0.5);
  });

  test("Schedules stays contained with 44px focusable rows and working navigation at 200% zoom", async ({ page }) => {
    await page.goto("/schedules");
    await page.waitForSelector("[data-schedule-row]");
    await expectDeviceMetricsZoom(page);
    await expectContained(page, "Schedules at 200% zoom");
    const rows = page.locator("[data-schedule-row]");
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < count; i += 1) {
      const box = await rectOf(rows.nth(i));
      expect(box.height, `schedule row ${i} keeps a 44px target at zoom`).toBeGreaterThanOrEqual(44);
    }
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expectContained(page, "Schedules scrolled at 200% zoom");
    await page.locator(".mobile-nav").getByRole("link", { name: "Today" }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.waitForSelector("[data-testid=field-zone-6]");
  });
});

test.describe("device-metrics 200% zoom equivalence of a 1440×900 desktop window (layout viewport 720×450, both engines)", () => {
  test.use({ viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });

  test("Today responds to the zoomed width, stays contained, and keeps every association", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("[data-testid=field-zone-6]");
    await expectDeviceMetricsZoom(page);
    await expectContained(page, "desktop Today at 200% zoom");
    await expectReadableHistory(page, "desktop Today at 200% zoom");
    // 720 CSS px correctly takes the one-column arrangement: zoom is a
    // responsive event, not a scaled desktop painting.
    for (let zone = 1; zone <= 6; zone += 1) {
      const geometry = await outlineGeometry(page, zone);
      expect(Math.abs(geometry.badge.distCss - BADGE_CONTRACT.distPx),
        `zone ${zone} desktop 200% zoom: badge centre distance (got ${geometry.badge.distCss.toFixed(2)})`)
        .toBeLessThanOrEqual(BADGE_CONTRACT.distTolerancePx);
      expect(outlineViolations(geometry), `zone ${zone} desktop 200% zoom: full outline contract holds`)
        .toEqual([]);
    }
    await makeBusyZones(page);
    await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(3);
    for (const zone of [1, 2, 4]) {
      const box = await rectOf(page.locator(`[data-testid=field-zone-${zone}] .zone-dock button`));
      const sil = await silhouetteRect(page, zone);
      const wrapSpanD = await rectOf(page.locator(`[data-testid=field-zone-${zone}]`));
      const cxD = box.x + box.width / 2;
      const offD = Math.abs(cxD - (sil.x + sil.width / 2));
      expect(offD <= 10 || (cxD >= wrapSpanD.x - 8 && cxD <= wrapSpanD.right + 8 && offD <= 48),
        `zone ${zone} Stop associated with its silhouette at desktop zoom (off-centre ${offD.toFixed(1)})`).toBe(true);
    }
    await expectNavClearance(page, "desktop Today at 200% zoom");
    await page.locator(".mobile-nav").getByRole("link", { name: "Schedules" }).click();
    await expect(page).toHaveURL(/\/schedules$/);
  });
});

/* Neighbour activation integrity: with EVERY zone busy (one shared task,
 * queued or running — the densest reachable dock population), no zone's
 * Stop/Remove control may capture any activation point of another zone,
 * at normal AND 200% text zoom. The activation region is the zone's
 * intended tap area (its hit-proxy when shaped, else its button box). */
async function activationTheft(page) {
  return page.evaluate(() => {
    const theft = [];
    for (let zone = 1; zone <= 6; zone += 1) {
      const wrap = document.querySelector(`[data-testid=field-zone-${zone}]`);
      const proxy = wrap.querySelector(".hit-proxy");
      const region = (proxy || wrap.querySelector(".field-zone")).getBoundingClientRect();
      let stolen = 0;
      let centreStolen = false;
      for (let ix = 0; ix < 11; ix += 1) {
        for (let iy = 0; iy < 11; iy += 1) {
          const x = region.left + ((ix + 0.5) / 11) * region.width;
          const y = region.top + ((iy + 0.5) / 11) * region.height;
          const node = document.elementFromPoint(x, y);
          const dock = node?.closest(".zone-dock");
          if (dock && dock.dataset.zoneDock !== String(zone)) {
            stolen += 1;
            if (ix === 5 && iy === 5) centreStolen = true;
          }
        }
      }
      if (stolen > 0) theft.push(`zone ${zone}: ${stolen}/121 activation points stolen by a foreign dock${centreStolen ? " (centre included)" : ""}`);
    }
    return theft;
  });
}

for (const width of [320, 390, 430]) {
  for (const zoom of ["normal", "text-zoom"]) {
    test(`all-six busy docks never capture neighbour activation at ${width}px (${zoom})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      for (const kind of ["queued", "running"]) {
        // Fresh page per fixture: the state exists FIRST, then the text is
        // zoomed — matching a real user zooming a live busy field (the
        // pills must be zoomed too, or the collision cannot occur).
        await page.goto("/");
        await page.waitForSelector("[data-testid=field-zone-6]");
        const now = Math.floor(Date.now() / 1000);
        await page.request.post("/__test/controller", { data: { mode: "online", tasks: [
          kind === "queued"
            ? { id: "all-queued", zones: [1, 2, 3, 4, 5, 6], runTime: 10, startTime: 0 }
            : { id: "all-running", zones: [1, 2, 3, 4, 5, 6], runTime: 20, startTime: now - 240 },
        ] } });
        await page.getByRole("button", { name: "Refresh controller status" }).click();
        const controlSelector = kind === "queued" ? "[data-testid=zone-remove]" : "[data-testid=zone-stop]";
        await expect(page.locator(controlSelector)).toHaveCount(6);
        if (zoom === "text-zoom") {
          await doubleTextSize(page);
          await page.waitForTimeout(250);
        }
        const lawn = await rectOf(page.locator(".lawn-field"));
        const band = await page.locator(".lawn-field")
          .evaluate((node) => Number.parseFloat(getComputedStyle(node).marginBottom) || 0);
        await page.waitForTimeout(100);
        // No dock steals any activation point of any other zone.
        expect(await activationTheft(page), `${kind} ${zoom} at ${width}px: no activation theft`).toEqual([]);
        // Every dock: 44px target, inside the lawn band, clear of every
        // other dock, exact semantics.
        const boxes = [];
        for (let zone = 1; zone <= 6; zone += 1) {
          const control = page.locator(`[data-testid=field-zone-${zone}] .zone-dock button`);
          const box = await rectOf(control);
          expect(box.width, `zone ${zone} ${kind} control width`).toBeGreaterThanOrEqual(44);
          expect(box.height, `zone ${zone} ${kind} control height`).toBeGreaterThanOrEqual(44);
          expect(box.x, `zone ${zone} ${kind} inside lawn left`).toBeGreaterThanOrEqual(lawn.x + 2);
          expect(box.right, `zone ${zone} ${kind} inside lawn right`).toBeLessThanOrEqual(lawn.right - 2);
          expect(box.bottom, `zone ${zone} ${kind} inside lawn band`).toBeLessThanOrEqual(lawn.bottom + band - 2);
          const expected = kind === "queued"
            ? /Remove queued task — zones 1, 2, 3, 4, 5 and 6, removed together/
            : /Stop watering — zones 1, 2, 3, 4, 5 and 6, one task, stops all of them/;
          await expect(control, `zone ${zone} ${kind} semantics`).toHaveAttribute("aria-label", expected);
          // Association: the dock centre stays within its own zone's
          // horizontal span (docks may legitimately shift to avoid
          // neighbours but never abandon their zone).
          const wrapBox = await rectOf(page.locator(`[data-testid=field-zone-${zone}]`));
          const cx = box.x + box.width / 2;
          expect(cx, `zone ${zone} ${kind} dock stays with its zone`).toBeGreaterThanOrEqual(wrapBox.x - 8);
          expect(cx, `zone ${zone} ${kind} dock stays with its zone (right)`).toBeLessThanOrEqual(wrapBox.right + 8);
          boxes.push({ zone, box });
        }
        for (let a = 0; a < boxes.length; a += 1) {
          for (let b = a + 1; b < boxes.length; b += 1) {
            expect(intersects(boxes[a].box, boxes[b].box),
              `${kind} ${zoom} ${width}px: zone ${boxes[a].zone} and ${boxes[b].zone} docks overlap`).toBe(false);
          }
        }
        // Real clicks land on the intended zone — WebKit intercepted these
        // pre-repair. Clicking selects exactly that zone; Escape clears.
        for (const zone of [2, 3, 5]) {
          await page.locator(`[data-testid=field-zone-${zone}] .field-zone`).click({ timeout: 3000 });
          await expect(page.locator(`[data-testid=field-zone-${zone}]`)).toHaveClass(/is-selected/);
          const selected = await page.locator(".field-zone-wrap.is-selected").count();
          expect(selected, `${kind}: clicking zone ${zone} selects exactly one zone`).toBe(1);
          await page.keyboard.press("Escape");
        }
      }
      // Sensitivity control: translate zone 2's dock over zone 3's
      // activation centre — the SAME theft predicate must detect it.
      const zone3Region = await page.evaluate(() => {
        const wrap = document.querySelector("[data-testid=field-zone-3]");
        const proxy = wrap.querySelector(".hit-proxy") || wrap.querySelector(".field-zone");
        const r = proxy.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      const dock2 = page.locator('[data-zone-dock="2"]');
      const dock2Box = await rectOf(page.locator('[data-testid=field-zone-2] .zone-dock button'));
      await dock2.evaluate((node, delta) => {
        node.style.transform = `translate(${delta.dx}px, ${delta.dy}px)`;
      }, { dx: zone3Region.x - (dock2Box.x + dock2Box.width / 2), dy: zone3Region.y - (dock2Box.y + dock2Box.height / 2) });
      expect((await activationTheft(page)).length,
        "the theft predicate detects a dock shifted onto a neighbour").toBeGreaterThan(0);
      await dock2.evaluate((node) => { node.style.transform = ""; });
    });
  }
}

test.describe("200% text zoom (font scaling only) on narrow phones", () => {
  for (const width of [320, 390]) {
    test(`busy dock controls stay clear of every neighbouring zone under text zoom at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/");
      await page.waitForSelector("[data-testid=field-zone-6]");
      await makeBusyZones(page);
      await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(3);
      await expect(page.locator("[data-testid=zone-remove]")).toHaveCount(1);
      await doubleTextSize(page);
      await page.waitForTimeout(200);
      const silhouettes = {};
      const activationCentres = {};
      for (let zone = 1; zone <= 6; zone += 1) {
        silhouettes[zone] = await silhouetteRect(page, zone);
        const button = await rectOf(page.locator(`[data-testid=field-zone-${zone}] .field-zone`));
        activationCentres[zone] = { x: button.x + button.width / 2, y: button.y + button.height / 2 };
      }
      const lawn = await rectOf(page.locator(".lawn-field"));
      const band = await page.locator(".lawn-field")
        .evaluate((node) => Number.parseFloat(getComputedStyle(node).marginBottom) || 0);
      const rectDistance = (a, b) => Math.hypot(
        Math.max(b.x - a.right, a.x - b.right, 0),
        Math.max(b.y - a.bottom, a.y - b.bottom, 0)
      );
      for (const zone of [1, 2, 4, 6]) {
        const control = page.locator(`[data-testid=field-zone-${zone}] .zone-dock button`);
        await expect(control, `zone ${zone} owns a control under text zoom`).toBeVisible();
        const box = await rectOf(control);
        expect(box.width, `zone ${zone} control width at ${width}px text zoom`).toBeGreaterThanOrEqual(44);
        expect(box.height, `zone ${zone} control height at ${width}px text zoom`).toBeGreaterThanOrEqual(44);
        expect(box.x, `zone ${zone} control inside the lawn (left) at ${width}px text zoom`)
          .toBeGreaterThanOrEqual(lawn.x + 2);
        expect(box.right, `zone ${zone} control inside the lawn (right) at ${width}px text zoom`)
          .toBeLessThanOrEqual(lawn.right - 2);
        expect(box.bottom, `zone ${zone} control inside the lawn band at ${width}px text zoom`)
          .toBeLessThanOrEqual(lawn.bottom + band - 2);
        for (let other = 1; other <= 6; other += 1) {
          if (other === zone) continue;
          expect(intersects(box, silhouettes[other]),
            `zone ${zone} control overlaps zone ${other} silhouette at ${width}px text zoom`).toBe(false);
          // Not merely non-overlapping: a real clearance gap from every
          // other zone's silhouette keeps ownership unambiguous.
          expect(rectDistance(box, silhouettes[other]),
            `zone ${zone} control keeps clearance from zone ${other} silhouette at ${width}px text zoom`)
            .toBeGreaterThanOrEqual(3.5);
          const centre = activationCentres[other];
          const covers = centre.x >= box.x && centre.x <= box.right && centre.y >= box.y && centre.y <= box.bottom;
          expect(covers, `zone ${zone} control covers zone ${other} activation centre at ${width}px text zoom`).toBe(false);
        }
        // Association stays structural: centred where nothing blocks, or a
        // bounded shift within the zone's own span when clearing a
        // neighbour's activation region.
        const own = silhouettes[zone];
        const wrapSpanN = await rectOf(page.locator(`[data-testid=field-zone-${zone}]`));
        const cxN = box.x + box.width / 2;
        const offN = Math.abs(cxN - (own.x + own.width / 2));
        expect(offN <= 12 || (cxN >= wrapSpanN.x - 8 && cxN <= wrapSpanN.right + 8 && offN <= 48),
          `zone ${zone} control associated at ${width}px text zoom (off-centre ${offN.toFixed(1)})`).toBe(true);
      }
      // Sensitivity control: derive a forced overlap from MEASURED rendered
      // geometry — translate zone 6's dock so its control centre coincides
      // with zone 5's silhouette centre (guaranteed intersection regardless
      // of the solver's placement, row drops, or compaction — no magic
      // offsets) — prove the very same intersection predicate flips true,
      // then restore the exact style and re-verify the clean state.
      const dock6 = page.locator('[data-zone-dock="6"]');
      const dock6Button = page.locator("[data-testid=field-zone-6] .zone-dock button");
      const cleanRect = await rectOf(dock6Button);
      const sil5 = silhouettes[5];
      expect(intersects(cleanRect, sil5), "pre-control state is clean").toBe(false);
      await dock6.evaluate((node, delta) => {
        node.style.transform = `translate(${delta.dx}px, ${delta.dy}px)`;
      }, {
        dx: (sil5.x + sil5.width / 2) - (cleanRect.x + cleanRect.width / 2),
        dy: (sil5.y + sil5.height / 2) - (cleanRect.y + cleanRect.height / 2),
      });
      const shifted = await rectOf(dock6Button);
      expect(intersects(shifted, silhouettes[5]),
        "a dock shifted onto a neighbour silhouette is detected by the same predicate").toBe(true);
      await dock6.evaluate((node) => { node.style.transform = ""; });
      const restored = await rectOf(dock6Button);
      expect(intersects(restored, silhouettes[5]), "restoring the dock clears the collision").toBe(false);
      expect(Math.abs(restored.x - cleanRect.x) + Math.abs(restored.y - cleanRect.y),
        "restore returns the exact pre-control position").toBeLessThanOrEqual(0.5);
    });

    test(`Today with busy zones survives doubled text without overflow, orphans or badge drift at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/");
      await page.waitForSelector("[data-history-row]");
      // Busy zones include queued zone 6, whose Remove pill is the widest
      // anchored control: its width grows under text zoom, so the dock must
      // reclamp on the control's own content-size change.
      await makeBusyZones(page);
      await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(3);
      await expect(page.locator("[data-testid=zone-remove]")).toHaveCount(1);
      const before = await outlineGeometry(page, 3);
      await doubleTextSize(page);
      await page.waitForTimeout(150);
      await expectContained(page, `Today at 200% text zoom, ${width}px`);
      const remove = await rectOf(page.locator("[data-testid=zone-remove]"));
      expect(remove.right, `zone 6 Remove pill stays inside the ${width}px viewport under text zoom`)
        .toBeLessThanOrEqual(width - 2);
      expect(remove.x, "zone 6 Remove pill stays inside the left edge under text zoom").toBeGreaterThanOrEqual(2);
      await expectReadableHistory(page, `Today at 200% text zoom, ${width}px`);
      await expectNavClearance(page, `Today at 200% text zoom, ${width}px`);
      // Text scale never moves the badge/outline geometry.
      const after = await outlineGeometry(page, 3);
      expect(Math.abs(after.badge.distCss - before.badge.distCss),
        "text zoom never moves the badge").toBeLessThanOrEqual(0.75);
      expect(outlineViolations(after), `zone 3 at ${width}px text zoom: full outline contract holds`)
        .toEqual([]);
    });
  }

  test("Activity survives doubled text with readable rows", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/activity");
    await page.waitForSelector("[data-history-row]");
    await doubleTextSize(page);
    await page.waitForTimeout(100);
    await expectContained(page, "Activity at 200% text zoom");
    await expectReadableHistory(page, "Activity at 200% text zoom");
  });
});

test.describe("actual 200% page scale via Emulation.setPageScaleFactor (Chromium CDP)", () => {
  /* This is the engine's real pinch/page-scale zoom: the CSS layout
   * viewport keeps its size, the visual viewport halves, and input runs in
   * visual-viewport space. Playwright exposes no page-scale automation API
   * for WebKit, so actual-scale assertions are Chromium-only; WebKit's
   * coverage of these routes lives in the device-metrics equivalence suite
   * above and is not claimed to be actual scale. */
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test.skip(({ browserName }) => browserName !== "chromium",
    "WebKit has no page-scale automation API; see device-metrics equivalence suite");

  const visualMetrics = (page) => page.evaluate(() => ({
    scale: window.visualViewport.scale,
    width: window.visualViewport.width,
    height: window.visualViewport.height,
    offsetTop: window.visualViewport.offsetTop,
    offsetLeft: window.visualViewport.offsetLeft,
    pageTop: window.visualViewport.pageTop,
    layoutWidth: document.documentElement.clientWidth,
    documentHeight: document.documentElement.scrollHeight,
  }));

  async function engageActualScale(page, factor) {
    // Baseline first: actual scale must start at 100% — proof the scaled
    // assertions measure what the CDP call engages, not ambient emulation.
    const before = await visualMetrics(page);
    expect(before.scale, "page starts at actual 100% scale").toBe(1);
    expect(before.width, "visual viewport equals layout viewport at 100%").toBe(before.layoutWidth);
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: factor });
    await expect.poll(async () => (await visualMetrics(page)).scale,
      { message: `actual page scale reaches ${factor}` }).toBe(factor);
    const after = await visualMetrics(page);
    expect(after.width, "visual viewport halves under actual 200% scale")
      .toBeCloseTo(before.layoutWidth / factor, 0);
    expect(after.height, "visual viewport height halves under actual 200% scale")
      .toBeCloseTo(844 / factor, 0);
    expect(after.layoutWidth, "layout viewport keeps its CSS size — actual scale, not device-metrics emulation")
      .toBe(before.layoutWidth);
    return session;
  }

  async function tapUnderScale(page, session, locator) {
    // Playwright's high-level click dispatches input in visual-viewport
    // space without compensating for page scale (proven RED: click() times
    // out at scale 2), so the zoomed-in user's tap is synthesized where the
    // target actually appears inside the visual viewport.
    const target = await locator.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const v = window.visualViewport;
      return {
        x: r.x + r.width / 2 - v.offsetLeft,
        y: r.y + r.height / 2 - v.offsetTop,
        inside: r.x + r.width / 2 >= v.offsetLeft && r.x + r.width / 2 <= v.offsetLeft + v.width &&
          r.y + r.height / 2 >= v.offsetTop && r.y + r.height / 2 <= v.offsetTop + v.height,
      };
    });
    expect(target.inside, "tap target sits inside the visual viewport").toBe(true);
    await session.send("Input.synthesizeTapGesture", { x: Math.round(target.x), y: Math.round(target.y) });
  }

  async function panToDocumentBottom(page, session) {
    // Real zoomed-in panning: synthesized scroll gestures move the visual
    // viewport within the layout viewport, exactly as a pinch-zoomed user
    // pans. Gesture coordinates live in visual-viewport space.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const metrics = await visualMetrics(page);
      if (metrics.pageTop + metrics.height >= metrics.documentHeight - 1) return metrics;
      await session.send("Input.synthesizeScrollGesture", {
        x: Math.floor(metrics.width / 2),
        y: Math.floor(metrics.height / 2),
        xDistance: 0,
        yDistance: -3000,
        speed: 8000,
      });
      await page.waitForTimeout(150);
    }
    return visualMetrics(page);
  }

  test("Today at actual 200% scale: geometry, selected/running association, containment, safe-area and tap navigation", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("[data-testid=field-zone-6]");
    await page.waitForSelector("[data-history-row]");
    // A zoomed-in user's field: busy zones plus one selected idle zone
    // (selection stays live — the island remains open under scale).
    await makeBusyZones(page);
    await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(3);
    await page.getByRole("button", { name: /Zone 3.*idle/i }).click();
    await expect(page.locator("[data-testid=quick-task-island]")).toBeVisible();
    const session = await engageActualScale(page, 2);
    // Actual scale magnifies without reflow: the layout stays contained and
    // every CSS-pixel association contract keeps holding while zoomed.
    await expectContained(page, "Today at actual 200% scale");
    for (let zone = 1; zone <= 6; zone += 1) {
      const geometry = await outlineGeometry(page, zone);
      expect(Math.abs(geometry.badge.distCss - BADGE_CONTRACT.distPx),
        `zone ${zone} at actual 200% scale: badge centre distance (got ${geometry.badge.distCss.toFixed(2)})`)
        .toBeLessThanOrEqual(BADGE_CONTRACT.distTolerancePx);
      expect(outlineViolations(geometry), `zone ${zone} at actual 200% scale: full outline contract holds`)
        .toEqual([]);
    }
    await expect.poll(() => page.locator("[data-testid=field-zone-3] [data-selection-outline]")
      .evaluate((node) => Number.parseFloat(getComputedStyle(node).opacity)),
      { message: "selection outline stays revealed under actual scale" }).toBeGreaterThanOrEqual(0.9);
    for (const zone of [1, 2, 4]) {
      const box = await rectOf(page.locator(`[data-testid=field-zone-${zone}] .zone-dock button`));
      const sil = await silhouetteRect(page, zone);
      const wrapSpanA = await rectOf(page.locator(`[data-testid=field-zone-${zone}]`));
      const cxA = box.x + box.width / 2;
      const offA = Math.abs(cxA - (sil.x + sil.width / 2));
      expect(offA <= 10 || (cxA >= wrapSpanA.x - 8 && cxA <= wrapSpanA.right + 8 && offA <= 48),
        `zone ${zone} Stop associated with its silhouette at actual scale (off-centre ${offA.toFixed(1)})`).toBe(true);
      expect(box.y - sil.bottom, `zone ${zone} Stop below its silhouette at actual scale`).toBeGreaterThanOrEqual(2);
    }
    // Keyboard input is unaffected by page scale: Escape retires the
    // selection and its island before the panning/tap phase.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-testid=quick-task-island]")).toBeHidden();
    await expectReadableHistory(page, "Today at actual 200% scale");
    // Safe area under real zoom: the fixed nav pins to the layout viewport
    // bottom, and panning brings it fully inside the visual viewport.
    const nav = await page.locator(".mobile-nav").evaluate((node) => {
      const r = node.getBoundingClientRect();
      return { y: r.y, bottom: r.bottom, position: getComputedStyle(node).position };
    });
    expect(nav.position, "nav stays fixed under actual scale").toBe("fixed");
    expect(Math.abs(nav.bottom - 844), "nav pins to the layout viewport bottom").toBeLessThanOrEqual(0.5);
    const panned = await panToDocumentBottom(page, session);
    expect(panned.pageTop + panned.height, "panning reaches the document bottom under actual scale")
      .toBeGreaterThanOrEqual(panned.documentHeight - 1);
    const navReachable = await page.evaluate(() => {
      const r = document.querySelector(".mobile-nav").getBoundingClientRect();
      const v = window.visualViewport;
      return r.y >= v.offsetTop - 0.5 && r.bottom <= v.offsetTop + v.height + 0.5;
    });
    expect(navReachable, "panning brings the fixed nav fully inside the visual viewport").toBe(true);
    // Navigation still works for the zoomed-in user: a real tap gesture on
    // the nav link now visible inside the panned visual viewport.
    await tapUnderScale(page, session, page.locator(".mobile-nav").getByRole("link", { name: "Status" }));
    await expect(page).toHaveURL(/\/status$/);
  });

  test("Activity at actual 200% scale: readable rows, containment, reachable end of feed", async ({ page }) => {
    for (let i = 0; i < 12; i += 1) {
      const response = await page.request.post("/api/history/create", {
        data: {
          zones: i % 3 === 0 ? [1, 4] : [(i % 6) + 1],
          event: i % 2 ? "Stopped" : "Started",
          reason: ["Remote", "Schedule", "Manual"][i % 3],
        },
      });
      expect(response.ok()).toBe(true);
    }
    await page.goto("/activity");
    await page.waitForSelector("[data-history-row]");
    const session = await engageActualScale(page, 2);
    await expectContained(page, "Activity at actual 200% scale");
    await expectReadableHistory(page, "Activity at actual 200% scale");
    const panned = await panToDocumentBottom(page, session);
    expect(panned.pageTop + panned.height, "the oldest event is reachable by panning under actual scale")
      .toBeGreaterThanOrEqual(panned.documentHeight - 1);
    const lastRow = await rectOf(page.locator("[data-history-row]").last());
    const nav = await rectOf(page.locator(".mobile-nav"));
    expect(lastRow.bottom, "oldest row clears the fixed nav under actual scale").toBeLessThanOrEqual(nav.y + 0.5);
  });

  test("Schedules at actual 200% scale: 44px rows, containment, tap navigation back to Today", async ({ page }) => {
    await page.goto("/schedules");
    await page.waitForSelector("[data-schedule-row]");
    const session = await engageActualScale(page, 2);
    await expectContained(page, "Schedules at actual 200% scale");
    const rows = page.locator("[data-schedule-row]");
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < count; i += 1) {
      const box = await rectOf(rows.nth(i));
      expect(box.height, `schedule row ${i} keeps a 44px target at actual scale`).toBeGreaterThanOrEqual(44);
    }
    await panToDocumentBottom(page, session);
    await tapUnderScale(page, session, page.locator(".mobile-nav").getByRole("link", { name: "Today" }));
    await expect(page).toHaveURL(/\/$/);
    await page.waitForSelector("[data-testid=field-zone-6]");
  });
});
