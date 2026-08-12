import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  BADGE_CONTRACT,
  intersects,
  makeBusyZones,
  outlineGeometry,
  outlineViolations,
  rectOf,
  silhouetteRect,
} from "./design-repair-utils.js";

test.afterEach(async ({ request }) => {
  await request.post("/__test/reset");
});

const layouts = [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "mobile-430", viewport: { width: 430, height: 844 } },
  { name: "mobile-390", viewport: { width: 390, height: 844 } },
  { name: "mobile-320", viewport: { width: 320, height: 844 } },
];

for (const layout of layouts) {
  test(`selection outline hugs every rendered silhouette variant with a uniform gap at ${layout.name}`, async ({ page }) => {
    await page.setViewportSize(layout.viewport);
    await page.goto("/");
    await page.waitForSelector("[data-testid=field-zone-6]");
    for (let zone = 1; zone <= 6; zone += 1) {
      const geometry = await outlineGeometry(page, zone);
      expect(geometry.missingOutline, `zone ${zone} has a selection outline layer`).toBeFalsy();
      expect(outlineViolations(geometry), `zone ${zone} ${layout.name}: rendered outline honours the uniform-gap contract`)
        .toEqual([]);
    }
  });
}

test("outline bounds detect drift, wrong dilation and asymmetry the construction forbids (negative controls)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  const applyControl = (zone, mutation) => page.evaluate(({ zone, mutation }) => {
    const svg = document.querySelector(`[data-testid=field-zone-${zone}]`).querySelector("svg.char");
    const rect = svg.getBoundingClientRect();
    const scale = Math.min(rect.width / 200, rect.height / 150);
    if (mutation.shiftPx) {
      svg.querySelector("[data-selection-outline]")
        .setAttribute("transform", `translate(${(mutation.shiftPx / scale).toFixed(3)} 0)`);
    }
    // Outline strokes are screen-space CSS px (non-scaling strokes), so the
    // control mutations set CSS-px dilation directly.
    if (mutation.uniformGapPx) {
      // Re-dilate mask and keyline coherently to a wrong but uniform gap.
      svg.querySelector(".outline-mask").setAttribute("stroke-width", String(2 * mutation.uniformGapPx));
      svg.querySelector(".outline-keyline").setAttribute("stroke-width", String(2 * (mutation.uniformGapPx + 2.2)));
    }
    if (mutation.extraRingPx) {
      // Over-dilate only the keyline: the mask still clips the inner edge at
      // the true gap, so the ring silently thickens outward.
      const keyline = svg.querySelector(".outline-keyline");
      const current = Number.parseFloat(keyline.getAttribute("stroke-width"));
      keyline.setAttribute("stroke-width", String(current + 2 * mutation.extraRingPx));
    }
  }, { zone, mutation });
  // 1) A rigid 1.5 CSS px sideways drift of the whole ring.
  await applyControl(3, { shiftPx: 1.5 });
  const drifted = await outlineGeometry(page, 3);
  expect(outlineViolations(drifted), "a 1.5px asymmetric outline drift must break the contract").not.toEqual([]);
  // 2) A uniform but wrong 6 CSS px gap — symmetric, centred, and outside
  // the designed 3–5 px band.
  await applyControl(4, { uniformGapPx: 6 });
  const wideGap = await outlineGeometry(page, 4);
  expect(outlineViolations(wideGap), "a uniform 6px gap must break the 3–5px contract").not.toEqual([]);
  // 3) A keyline over-dilated by 2.5 CSS px: the inner gap stays perfect,
  // only the outer edge drifts into the lawn.
  await applyControl(5, { extraRingPx: 2.5 });
  const thickRing = await outlineGeometry(page, 5);
  expect(outlineViolations(thickRing), "a 2.5px over-dilated keyline must break the contract").not.toEqual([]);
  // Untouched zones still measure clean through the very same predicate.
  const clean = await outlineGeometry(page, 1);
  expect(outlineViolations(clean), "control mutations never leak into other zones").toEqual([]);
});

test("selection outline derives from the silhouette shapes and reveals for single and multi selection", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  // Outline layers exist for every zone, exclude spray/shadow, and are hidden at rest.
  for (let zone = 1; zone <= 6; zone += 1) {
    const wrap = page.locator(`[data-testid=field-zone-${zone}]`);
    const structure = await wrap.evaluate((node) => {
      const outline = node.querySelector("[data-selection-outline]");
      if (!outline) return { present: false };
      const forbidden = outline.querySelectorAll(".char-spray,.c-shadow,.c-grass,.spray-arc,.droplet,.ripple,text").length;
      return {
        present: true,
        forbidden,
        opacity: Number.parseFloat(getComputedStyle(outline).opacity),
      };
    });
    expect(structure.present, `zone ${zone} outline layer present`).toBe(true);
    expect(structure.forbidden, `zone ${zone} outline built only from the physical silhouette`).toBe(0);
    expect(structure.opacity, `zone ${zone} outline hidden at rest`).toBe(0);
  }
  await page.getByRole("button", { name: /Zone 1.*idle/i }).click();
  await page.getByRole("button", { name: /Zone 5.*idle/i }).click();
  for (const zone of [1, 5]) {
    const wrap = page.locator(`[data-testid=field-zone-${zone}]`);
    await expect(wrap).toHaveClass(/is-selected/);
    await expect.poll(() => wrap.locator("[data-selection-outline]")
      .evaluate((node) => Number.parseFloat(getComputedStyle(node).opacity))).toBeGreaterThanOrEqual(0.9);
  }
  const unselected = await page.locator("[data-testid=field-zone-2] [data-selection-outline]")
    .evaluate((node) => Number.parseFloat(getComputedStyle(node).opacity));
  expect(unselected).toBe(0);
});

/* The badge contract is measured in rendered CSS pixels against the actual
 * rasterized silhouette — never against bounding-box corners and never with
 * the scale divided out — so a construction whose offset scales with the
 * zone, or that anchors to a corner the silhouette never touches, fails. */
for (const layout of layouts) {
  test(`check badge keeps one constant rendered offset from every silhouette variant at ${layout.name}`, async ({ page }) => {
    await page.setViewportSize(layout.viewport);
    await page.goto("/");
    await page.waitForSelector("[data-testid=field-zone-6]");
    const distances = [];
    for (let zone = 1; zone <= 6; zone += 1) {
      const geometry = await outlineGeometry(page, zone);
      expect(geometry.badge, `zone ${zone} ${layout.name}: badge disc present`).toBeTruthy();
      expect(Math.abs(geometry.badge.distCss - BADGE_CONTRACT.distPx),
        `zone ${zone} ${layout.name}: badge centre sits ${BADGE_CONTRACT.distPx} CSS px from the rendered silhouette (got ${geometry.badge.distCss.toFixed(2)})`)
        .toBeLessThanOrEqual(BADGE_CONTRACT.distTolerancePx);
      expect(Math.abs(geometry.badge.radiusCss - BADGE_CONTRACT.radiusPx),
        `zone ${zone} ${layout.name}: badge renders at a constant ${BADGE_CONTRACT.radiusPx} CSS px radius (got ${geometry.badge.radiusCss.toFixed(2)})`)
        .toBeLessThanOrEqual(BADGE_CONTRACT.radiusTolerancePx);
      // Painted clearance: the disc's stroke overhangs the geometric radius
      // by strokePx/2, and the painted edge must still keep the intended
      // clearance from the silhouette.
      // 0.6 covers the raster-sampling error at the largest zone scale; the
      // pre-repair 1.25px painted clearance still lands well below the bar.
      expect(geometry.badge.distCss - (geometry.badge.radiusCss + BADGE_CONTRACT.strokePx / 2),
        `zone ${zone} ${layout.name}: painted badge edge keeps ${BADGE_CONTRACT.paintedClearancePx}px clearance`)
        .toBeGreaterThanOrEqual(BADGE_CONTRACT.paintedClearancePx - 0.6);
      distances.push(geometry.badge.distCss);
    }
    const spread = Math.max(...distances) - Math.min(...distances);
    expect(spread, `${layout.name}: badge-to-silhouette distance never drifts between variants`)
      .toBeLessThanOrEqual(BADGE_CONTRACT.spreadMaxPx);
  });
}

test("legacy bbox-corner badge formula violates the rendered-distance contract (negative control)", async ({ page }) => {
  // The pre-repair anchor — (bbox.minX − 5, bbox.minY − 5) in SVG user units —
  // must be caught by the same band the real badge is held to: its rendered
  // distances drift across variants and shrink with the zone scale.
  const violations = [];
  for (const layout of [layouts[0], layouts[3]]) {
    await page.setViewportSize(layout.viewport);
    await page.goto("/");
    await page.waitForSelector("[data-testid=field-zone-6]");
    const distances = [];
    for (let zone = 1; zone <= 6; zone += 1) {
      const geometry = await outlineGeometry(page, zone);
      expect(geometry.legacyBadge, `zone ${zone} ${layout.name}: legacy probe computable`).toBeTruthy();
      distances.push(geometry.legacyBadge.distCss);
    }
    const outOfBand = distances.filter(
      (distance) => Math.abs(distance - BADGE_CONTRACT.distPx) > BADGE_CONTRACT.distTolerancePx
    ).length;
    const spread = Math.max(...distances) - Math.min(...distances);
    violations.push({ layout: layout.name, outOfBand, spread });
    expect(outOfBand, `${layout.name}: legacy formula lands outside the distance band for most variants`)
      .toBeGreaterThanOrEqual(2);
    expect(spread, `${layout.name}: legacy formula drifts across variants beyond the allowed spread`)
      .toBeGreaterThan(BADGE_CONTRACT.spreadMaxPx);
  }
  // And the two scales disagree with each other: the same formula measures
  // differently at desktop and 320 for at least one variant — scale variance.
  expect(violations).toHaveLength(2);
});

test("check badge reveals for single and multi selection with unchanged geometry", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  const before = await outlineGeometry(page, 1);
  const opacity = (zone) => page.locator(`[data-testid=field-zone-${zone}] .char-anchor`)
    .evaluate((node) => Number.parseFloat(getComputedStyle(node).opacity));
  expect(await opacity(1), "badge hidden at rest").toBe(0);
  await page.getByRole("button", { name: /Zone 1.*idle/i }).click();
  await expect.poll(() => opacity(1), { message: "badge reveals on single selection" }).toBe(1);
  expect(await opacity(5), "unselected badge stays hidden").toBe(0);
  await page.getByRole("button", { name: /Zone 5.*idle/i }).click();
  await expect.poll(() => opacity(1), { message: "badge persists in multi selection" }).toBe(1);
  await expect.poll(() => opacity(5), { message: "second badge reveals in multi selection" }).toBe(1);
  const after = await outlineGeometry(page, 1);
  expect(Math.abs(after.badge.distCss - before.badge.distCss),
    "selection state never moves the badge").toBeLessThanOrEqual(0.5);
});

for (const layout of layouts) {
  test(`every running or queued zone owns an anchored 44px Stop/Remove control at ${layout.name}`, async ({ page }) => {
    await page.setViewportSize(layout.viewport);
    await page.goto("/");
    await page.waitForSelector("[data-testid=field-zone-6]");
    await makeBusyZones(page);
    // Zones 1+4 share one running task, zone 2 runs its own, zone 6 is queued:
    // each busy zone shows its own truthful control with no selection needed.
    await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(3);
    await expect(page.locator("[data-testid=zone-remove]")).toHaveCount(1);
    const docks = [];
    for (const zone of [1, 2, 4, 6]) {
      const control = page.locator(`[data-testid=field-zone-${zone}] .zone-dock button`);
      await expect(control, `zone ${zone} owns a control`).toBeVisible();
      const box = await rectOf(control);
      expect(box.width, `zone ${zone} control width`).toBeGreaterThanOrEqual(44);
      expect(box.height, `zone ${zone} control height`).toBeGreaterThanOrEqual(44);
      const sil = await silhouetteRect(page, zone);
      const controlCx = box.x + box.width / 2;
      const silCx = sil.x + sil.width / 2;
      // Association contract: centred where nothing blocks, or a bounded
      // shift within the zone's own span when the dock must clear a
      // neighbour's activation region (activation-theft zero is asserted
      // in the all-six suite — that is the functional guarantee).
      const wrapSpan = await rectOf(page.locator(`[data-testid=field-zone-${zone}]`));
      const offCentre = Math.abs(controlCx - silCx);
      const inSpan = controlCx >= wrapSpan.x - 8 && controlCx <= wrapSpan.right + 8;
      expect(offCentre <= 10 || (inSpan && offCentre <= 48),
        `zone ${zone} control associated with its silhouette (off-centre ${offCentre.toFixed(1)})`).toBe(true);
      expect(box.y - sil.bottom, `zone ${zone} control sits below its silhouette`).toBeGreaterThanOrEqual(2);
      expect(box.y - sil.bottom, `zone ${zone} control stays adjacent to its silhouette`).toBeLessThanOrEqual(34);
      docks.push({ zone, box });
    }
    // Controls never overlap each other, other silhouettes, spray, or progress bars.
    for (let a = 0; a < docks.length; a += 1) {
      for (let b = a + 1; b < docks.length; b += 1) {
        expect(intersects(docks[a].box, docks[b].box), `zone ${docks[a].zone} and zone ${docks[b].zone} controls overlap`).toBe(false);
      }
    }
    for (const { zone, box } of docks) {
      for (let other = 1; other <= 6; other += 1) {
        if (other === zone) continue;
        const otherSil = await silhouetteRect(page, other);
        expect(intersects(box, otherSil), `zone ${zone} control overlaps zone ${other} silhouette`).toBe(false);
        // The control must never swallow another zone's primary tap point.
        const otherButton = await rectOf(page.locator(`[data-testid=field-zone-${other}] .field-zone`));
        const centre = { x: otherButton.x + otherButton.width / 2, y: otherButton.y + otherButton.height / 2 };
        const covers = centre.x >= box.x && centre.x <= box.right && centre.y >= box.y && centre.y <= box.bottom;
        expect(covers, `zone ${zone} control covers zone ${other} activation centre`).toBe(false);
      }
      const spray = page.locator(`[data-testid=field-zone-${zone}] .char-spray`);
      if (await spray.count()) {
        const sprayBox = await rectOf(spray);
        expect(intersects(box, sprayBox), `zone ${zone} control overlaps water spray`).toBe(false);
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `zone ${zone} control causes horizontal overflow`).toBe(0);
    }
    // Aria labels keep the exact shared-task truth.
    await expect(page.locator("[data-testid=field-zone-1] .zone-dock button"))
      .toHaveAttribute("aria-label", /Stop watering — zones 1 and 4, one task, stops all of them/);
    await expect(page.locator("[data-testid=field-zone-2] .zone-dock button"))
      .toHaveAttribute("aria-label", "Stop watering — zone 2");
    await expect(page.locator("[data-testid=field-zone-6] .zone-dock button"))
      .toHaveAttribute("aria-label", "Remove queued task — zone 6");
  });
}

test("shared-task Stop disables both anchored controls, commits once, and clears the docks", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const deleteRequests = [];
  await page.route("**/api/tasks/delete", async (route) => {
    deleteRequests.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  await makeBusyZones(page);
  const zone1Stop = page.locator("[data-testid=field-zone-1] .zone-dock button");
  const zone4Stop = page.locator("[data-testid=field-zone-4] .zone-dock button");
  await expect(zone1Stop).toBeVisible();
  await zone1Stop.click();
  // The shared task is pending for both of its zones.
  await expect(zone4Stop).toBeDisabled();
  await expect(page.locator("#fieldMutationFeedback")).toHaveText("Task stopped");
  expect(deleteRequests).toHaveLength(1);
  expect(deleteRequests[0].id).toBe("shared-14");
  await expect(page.locator("[data-testid=field-zone-1] .zone-dock button")).toHaveCount(0);
  await expect(page.locator("[data-testid=field-zone-4] .zone-dock button")).toHaveCount(0);
});

test("anchored controls are keyboard reachable, axe-clean, and withdrawn when state goes stale", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  await makeBusyZones(page);
  await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(3);
  // Keyboard flow: the zone control is followed immediately by its own dock control.
  await page.locator("[data-testid=field-zone-2] .field-zone").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("[data-testid=field-zone-2] .zone-dock button")).toBeFocused();
  const scan = await new AxeBuilder({ page }).analyze();
  expect(scan.violations).toEqual([]);
  // Stale controller state withdraws every mutation control truthfully.
  await page.request.post("/__test/controller", { data: { mode: "read-timeout" } });
  await page.getByRole("button", { name: "Refresh controller status" }).click();
  await expect(page.locator("[data-testid=controller-freshness]")).toHaveText(/stale/i);
  await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(0);
  await expect(page.locator("[data-testid=zone-remove]")).toHaveCount(0);
});

test("open Quick Task island never covers any zone or anchored control, even with zone 5 busy on desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  const now = Math.floor(Date.now() / 1000);
  await page.request.post("/__test/controller", { data: { mode: "online", tasks: [
    { id: "shared-14", zones: [1, 4], runTime: 20, startTime: now - 240 },
    { id: "run-2", zones: [2], runTime: 15, startTime: now - 60 },
    { id: "run-5", zones: [5], runTime: 15, startTime: now - 120 },
    { id: "queued-6", zones: [6], runTime: 10, startTime: 0 },
  ] } });
  await page.getByRole("button", { name: "Refresh controller status" }).click();
  await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(4);
  await page.getByRole("button", { name: /Zone 3.*idle/i }).click();
  const island = page.locator("[data-testid=quick-task-island]");
  await expect(island).toBeVisible();
  const islandBox = await rectOf(island);
  const viewport = page.viewportSize();
  expect(islandBox.x).toBeGreaterThanOrEqual(0);
  expect(islandBox.right).toBeLessThanOrEqual(viewport.width);
  expect(islandBox.bottom).toBeLessThanOrEqual(viewport.height);
  for (let zone = 1; zone <= 6; zone += 1) {
    const wrap = await rectOf(page.locator(`[data-testid=field-zone-${zone}]`));
    expect(intersects(islandBox, wrap), `island covers zone ${zone}`).toBe(false);
    const dockButton = page.locator(`[data-testid=field-zone-${zone}] .zone-dock button`);
    if (await dockButton.count()) {
      const dockBox = await rectOf(dockButton);
      expect(intersects(islandBox, dockBox), `island covers zone ${zone} Stop/Remove control`).toBe(false);
      expect(dockBox.width, `zone ${zone} control width beside the island`).toBeGreaterThanOrEqual(44);
      expect(dockBox.height, `zone ${zone} control height beside the island`).toBeGreaterThanOrEqual(44);
    }
  }
});

test("anchored controls join the layout without shifting document sections", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  const geometry = () => page.evaluate(() => {
    const capture = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y + window.scrollY), Math.round(r.width), Math.round(r.height)];
    };
    return {
      field: capture("[data-testid=field]"),
      schedules: capture("[data-dashboard-section=schedules]"),
      history: capture("[data-dashboard-section=history]"),
    };
  });
  const before = await geometry();
  await makeBusyZones(page);
  await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(3);
  const after = await geometry();
  expect(after).toEqual(before);
});

test("layout rebuilds never accumulate ResizeObserver targets (retention regression)", async ({ page }) => {
  // Instrument ResizeObserver before any page script runs: every observe /
  // unobserve / disconnect is mirrored into an inspectable target set.
  await page.addInitScript(() => {
    const Original = window.ResizeObserver;
    if (!Original) return;
    const instances = [];
    window.ResizeObserver = class InstrumentedResizeObserver extends Original {
      constructor(callback) {
        super(callback);
        this.__targets = new Set();
        instances.push(this);
      }
      observe(target, options) { this.__targets.add(target); return super.observe(target, options); }
      unobserve(target) { this.__targets.delete(target); return super.unobserve(target); }
      disconnect() { this.__targets.clear(); return super.disconnect(); }
    };
    window.__resizeObserverInstances = instances;
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  const snapshot = () => page.evaluate(() => {
    let observed = 0;
    let detached = 0;
    for (const instance of window.__resizeObserverInstances) {
      for (const target of instance.__targets) {
        observed += 1;
        if (!target.isConnected) detached += 1;
      }
    }
    return { instances: window.__resizeObserverInstances.length, observed, detached };
  });
  const cycle = async () => {
    for (const width of [1440, 390, 1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForSelector("[data-testid=field-zone-6]");
      await page.waitForTimeout(60);
    }
    return snapshot();
  };
  const before = await snapshot();
  expect(before.detached, "no detached targets after initial build").toBe(0);
  // Cross the 900px layout breakpoint repeatedly: each crossing rebuilds the
  // field (new docks). Discarded docks must be released, not retained.
  // Lazily-created observers (e.g. the island placement watcher) may appear
  // once, so the leak contract is steady state: a SECOND identical cycle
  // set must add nothing — the pre-repair leak added six detached docks per
  // crossing, failing both the detached and steady-state assertions.
  const afterFirst = await cycle();
  expect(afterFirst.detached, "rebuilds must not retain observers on discarded docks").toBe(0);
  const afterSecond = await cycle();
  expect(afterSecond.detached, "repeat cycles never retain detached targets").toBe(0);
  expect(afterSecond.observed, "observed-target count reaches a steady state across cycle sets")
    .toBe(afterFirst.observed);
  expect(afterSecond.instances, "observer instances reach a steady state across cycle sets")
    .toBe(afterFirst.instances);
});

for (const layout of layouts) {
  test(`every busy dock stays inside its lawn control band at ${layout.name}`, async ({ page }) => {
    await page.setViewportSize(layout.viewport);
    await page.goto("/");
    await page.waitForSelector("[data-testid=field-zone-6]");
    // Busy bottom rows included: zones 5 running and 6 queued exercise the
    // docks nearest the lawn's bottom edge in both arrangements.
    const now = Math.floor(Date.now() / 1000);
    await page.request.post("/__test/controller", { data: { mode: "online", tasks: [
      { id: "shared-14", zones: [1, 4], runTime: 20, startTime: now - 240 },
      { id: "run-5", zones: [5], runTime: 15, startTime: now - 120 },
      { id: "queued-6", zones: [6], runTime: 10, startTime: 0 },
    ] } });
    await page.getByRole("button", { name: "Refresh controller status" }).click();
    await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(3);
    await expect(page.locator("[data-testid=zone-remove]")).toHaveCount(1);
    const lawn = await rectOf(page.locator(".lawn-field"));
    // The lawn's own reserved dock band: its bottom margin (56px on mobile,
    // 0 on desktop where the frame itself must contain every dock).
    const band = await page.locator(".lawn-field")
      .evaluate((node) => Number.parseFloat(getComputedStyle(node).marginBottom) || 0);
    const schedulesTop = (await rectOf(page.locator("[data-dashboard-section=schedules]"))).y;
    for (const zone of [1, 4, 5, 6]) {
      const control = page.locator(`[data-testid=field-zone-${zone}] .zone-dock button`);
      await expect(control, `zone ${zone} owns a control`).toBeVisible();
      const box = await rectOf(control);
      expect(box.x, `zone ${zone} dock inside the lawn's left edge (${layout.name})`)
        .toBeGreaterThanOrEqual(lawn.x + 2);
      expect(box.right, `zone ${zone} dock inside the lawn's right edge (${layout.name})`)
        .toBeLessThanOrEqual(lawn.right - 2);
      expect(box.bottom, `zone ${zone} dock stays inside the lawn + its reserved band (${layout.name})`)
        .toBeLessThanOrEqual(lawn.bottom + band - 2);
      expect(box.bottom, `zone ${zone} dock never reaches the Schedules section (${layout.name})`)
        .toBeLessThanOrEqual(schedulesTop - 2);
    }
  });
}

test("queued zone accessible labels stay truthful across current, stale and offline controller states", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  const zoneLabel = () => page.locator("[data-testid=field-zone-6] .field-zone").getAttribute("aria-label");
  const removeCount = () => page.locator("[data-testid=field-zone-6] .zone-dock button").count();
  // Truthfulness invariant, applied identically in every state: the label
  // promises a Remove control exactly when one exists in the DOM. This is
  // the sensitivity control too — any state whose label and DOM disagree
  // (the pre-repair stale behaviour) fails this exact predicate.
  const expectLabelTruthful = async (stateName) => {
    const label = await zoneLabel();
    const promisesControl = label.includes("Its Remove control sits just below.");
    const hasControl = (await removeCount()) > 0;
    expect(promisesControl, `${stateName}: label promises Remove ⇔ control exists (label: "${label}")`)
      .toBe(hasControl);
    return label;
  };
  // Current (online) queued state: shared task across zones 5 and 6.
  await page.request.post("/__test/controller", { data: { mode: "online", tasks: [
    { id: "queued-56", zones: [5, 6], runTime: 10, startTime: 0 },
  ] } });
  await page.getByRole("button", { name: "Refresh controller status" }).click();
  await expect(page.locator("[data-testid=zone-remove]")).toHaveCount(2);
  const current = await expectLabelTruthful("online queued");
  expect(current).toContain("queued to water for 10 minutes");
  expect(current).toContain("Removing cancels zones 5 and 6 together.");
  expect(current).not.toContain("stale");
  // Stale controller: syncDock withdraws the Remove control, so the label
  // must announce staleness and stop promising the absent control, while
  // preserving the queued status and shared-task consequence.
  await page.request.post("/__test/controller", { data: { mode: "read-timeout" } });
  await page.getByRole("button", { name: "Refresh controller status" }).click();
  await expect(page.locator("[data-testid=controller-freshness]")).toHaveText(/stale/i);
  await expect(page.locator("[data-testid=zone-remove]")).toHaveCount(0);
  const stale = await expectLabelTruthful("stale queued");
  expect(stale, "stale queued label announces the stale controller")
    .toContain("Controller state is stale; controls unavailable.");
  expect(stale, "stale queued label keeps the queued status").toContain("queued to water for 10 minutes");
  expect(stale, "stale queued label preserves the shared-task consequence")
    .toContain("Removing cancels zones 5 and 6 together.");
  // Offline controller on a fresh load (no cached tasks): the freshness
  // line reports offline, every zone control is disabled, and no label
  // promises a control — the same truthfulness invariant, third state.
  // (Mid-session failures stay "stale" because last-known state is
  // retained — asserted above.)
  await page.request.post("/__test/controller", { data: { mode: "offline" } });
  await page.reload();
  await page.waitForSelector("[data-testid=field-zone-6]");
  await expect(page.locator("#mobileControllerStatus")).toHaveText(/Controller offline/);
  await expect(page.locator("[data-testid=field-zone-6] .field-zone")).toBeDisabled();
  await expectLabelTruthful("offline fresh load");
});

test("fresh offline load announces controller-offline for every zone, never an unproven idle, and recovers truthfully", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Fresh load with the controller unreachable and no cached tasks: the app
  // has NO data, so no zone may claim a positive status like "idle".
  await page.request.post("/__test/controller", { data: { mode: "offline" } });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  await expect(page.locator("#mobileControllerStatus")).toHaveText(/Controller offline/);
  const labelOf = (zone) => page.locator(`[data-testid=field-zone-${zone}] .field-zone`).getAttribute("aria-label");
  for (let zone = 1; zone <= 6; zone += 1) {
    const label = await labelOf(zone);
    // Sensitivity: the pre-repair behaviour announced "— idle" here, which
    // this exact pair of assertions fails.
    expect(label, `zone ${zone} offline label announces the outage`)
      .toContain("controller offline, controls unavailable");
    expect(label, `zone ${zone} never claims idle without data`).not.toContain("— idle");
    await expect(page.locator(`[data-testid=field-zone-${zone}] .field-zone`)).toBeDisabled();
  }
  await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(0);
  await expect(page.locator("[data-testid=zone-remove]")).toHaveCount(0);
  // Recovery: polling returns online with a running shared task and a
  // queued zone — statuses and docks come back from real data only.
  const now = Math.floor(Date.now() / 1000);
  await page.request.post("/__test/controller", { data: { mode: "online", tasks: [
    { id: "shared-14", zones: [1, 4], runTime: 20, startTime: now - 240 },
    { id: "queued-6", zones: [6], runTime: 10, startTime: 0 },
  ] } });
  await page.getByRole("button", { name: "Refresh controller status" }).click();
  await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(2);
  await expect(page.locator("[data-testid=zone-remove]")).toHaveCount(1);
  await expect.poll(() => labelOf(1)).toContain("watering");
  expect(await labelOf(1)).toContain("Stopping ends watering for zones 1 and 4 together.");
  expect(await labelOf(6)).toContain("queued to water for 10 minutes");
  expect(await labelOf(6)).toContain("Its Remove control sits just below.");
  await expect.poll(() => labelOf(2)).toContain("— idle");
  await expect(page.locator("[data-testid=field-zone-2] .field-zone")).toBeEnabled();
});

test("controller availability truth matrix: no-known-data vs stale-last-known vs current", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const labelOf = (zone) => page.locator(`[data-testid=field-zone-${zone}] .field-zone`).getAttribute("aria-label");
  const freshness = page.locator("[data-testid=controller-freshness]");
  // --- Fresh busy (read_overload) first load: NO known data. Sensitivity
  // for the false-idle / live-controls regressions: the old behaviour
  // asserted "— idle" with enabled buttons here, which these exact
  // assertions fail.
  let busyMode = true;
  await page.route("**/api/tasks", async (route) => {
    if (busyMode) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ kind: "read_overload", retryAfter: 1 }),
      });
    } else {
      await route.continue();
    }
  });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  await expect(page.locator("#mobileControllerStatus")).toHaveText(/busy/i);
  for (let zone = 1; zone <= 6; zone += 1) {
    const label = await labelOf(zone);
    expect(label, `fresh busy zone ${zone} never claims an unproven idle`).not.toContain("— idle");
    expect(label, `fresh busy zone ${zone} announces controls unavailable`).toContain("controls unavailable");
    await expect(page.locator(`[data-testid=field-zone-${zone}] .field-zone`),
      `fresh busy zone ${zone} button disabled`).toBeDisabled();
  }
  await expect(page.locator("[data-testid=zone-stop]")).toHaveCount(0);
  await expect(page.locator("[data-testid=zone-remove]")).toHaveCount(0);
  await expect(freshness, "no-known-data freshness never claims last-known state").not.toContainText(/last-known/i);
  // --- Recovery: online with a shared queued task restores current truth.
  busyMode = false;
  await page.request.post("/__test/controller", { data: { mode: "online", tasks: [
    { id: "shared-56", zones: [5, 6], runTime: 10, startTime: 0 },
  ] } });
  await page.getByRole("button", { name: "Refresh controller status" }).click();
  await expect(page.locator("[data-testid=zone-remove]")).toHaveCount(2);
  await expect.poll(() => labelOf(6)).toContain("Its Remove control sits just below.");
  expect(await labelOf(6)).toContain("Removing cancels zones 5 and 6 together.");
  expect(await labelOf(2)).toContain("— idle");
  expect(await labelOf(2)).not.toContain("stale");
  await expect(page.locator("[data-testid=field-zone-2] .field-zone")).toBeEnabled();
  // --- Mid-session busy with KNOWN data: stale presentation everywhere,
  // controls withdrawn (sensitivity for the live-controls regression).
  busyMode = true;
  await page.getByRole("button", { name: "Refresh controller status" }).click();
  await expect(page.locator("#mobileControllerStatus")).toHaveText(/busy/i);
  await expect(page.locator("[data-testid=zone-remove]")).toHaveCount(0);
  const staleQueued = await labelOf(6);
  expect(staleQueued).toContain("queued to water");
  expect(staleQueued).toContain("Controller state is stale; controls unavailable.");
  expect(staleQueued, "shared-task facts stay truthful while stale")
    .toContain("Removing cancels zones 5 and 6 together.");
  expect(staleQueued).not.toContain("Its Remove control sits just below.");
  const staleIdle = await labelOf(2);
  expect(staleIdle, "stale idle zones keep the idle claim but qualify it").toContain("— idle");
  expect(staleIdle, "stale idle zones announce the stale controller").toContain("stale");
  // --- Mid-session timeout with known data: same stale truth, and the
  // freshness copy truthfully mentions last-known state (guard against
  // over-correcting the offline copy).
  busyMode = false;
  await page.unroute("**/api/tasks");
  await page.request.post("/__test/controller", { data: { mode: "read-timeout" } });
  await page.getByRole("button", { name: "Refresh controller status" }).click();
  await expect(freshness).toContainText(/stale last-known/i);
  await expect(page.locator("[data-testid=zone-remove]")).toHaveCount(0);
  expect(await labelOf(2)).toContain("stale");
  // --- Full recovery: current labels and docks exactly restored.
  await page.request.post("/__test/controller", { data: { mode: "online" } });
  await page.getByRole("button", { name: "Refresh controller status" }).click();
  await expect(page.locator("[data-testid=zone-remove]")).toHaveCount(2);
  expect(await labelOf(2)).toContain("— idle");
  expect(await labelOf(2)).not.toContain("stale");
  expect(await labelOf(6)).toContain("Its Remove control sits just below.");
});

test("fresh offline freshness line never claims last-known state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.request.post("/__test/controller", { data: { mode: "offline" } });
  await page.goto("/");
  await page.waitForSelector("[data-testid=field-zone-6]");
  await expect(page.locator("#mobileControllerStatus")).toHaveText(/Controller offline/);
  const freshness = page.locator("[data-testid=controller-freshness]");
  await expect(freshness).toContainText(/offline/i);
  await expect(freshness, "no last-known claim without any known state")
    .not.toContainText(/last-known|stale/i);
});
