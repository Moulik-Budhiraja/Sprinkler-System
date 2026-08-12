/* Legibility under zoom stress: every navigation destination and every
 * Today schedule identifier must stay fully readable — not merely
 * contained — with 44px reachable targets, at the narrowest supported
 * widths, at the 200% device-metrics zoom equivalence width, and under
 * 200% text-only zoom. Assertions measure painted truncation
 * (scrollWidth/scrollHeight vs client box), target size, and hit-target
 * reachability, plus the completeness of accessible names. */
import { expect, test } from "@playwright/test";
import { doubleTextSize, noHorizontalOverflow, rectOf } from "./design-repair-utils.js";

test.afterEach(async ({ request }) => {
  await request.post("/__test/reset");
});

async function expectContained(page, label) {
  const geometry = await noHorizontalOverflow(page);
  expect(geometry.documentScrollWidth, `${label}: documentElement horizontal overflow`).toBe(geometry.documentClientWidth);
  expect(geometry.bodyScrollWidth, `${label}: body horizontal overflow`).toBe(geometry.bodyClientWidth);
}

async function expectUnclippedText(locator, label) {
  const clip = await locator.evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
  }));
  expect(clip.scrollWidth, `${label}: text is painted without horizontal truncation`)
    .toBeLessThanOrEqual(clip.clientWidth + 1);
  expect(clip.scrollHeight, `${label}: text is painted without vertical truncation`)
    .toBeLessThanOrEqual(clip.clientHeight + 2);
}

const NAV_DESTINATIONS = ["Today", "Status", "Schedules", "Activity", "Controller"];

/* THE shared accessible-name predicate: reads the link's live aria-label
 * (which wins the accessible-name computation for these links) and the
 * schedule's full identifier from the DOM, and reports every way the name
 * can be incomplete. Both the real per-link assertion and the sensitivity
 * control call this same function against the live link. */
async function accessibleNameViolations(link) {
  return link.evaluate((node) => {
    // The aria-label SUPERSEDES the link's contents in the accessible-name
    // computation, so everything the row shows visually — the identifier,
    // the Enabled/Paused status, and the start time — must survive into
    // the label, or assistive tech loses it entirely.
    const fullName = node.querySelector(".schedule-name")?.textContent.trim() || "";
    const status = node.querySelector(".schedule-state")?.textContent.trim() || "";
    const time = node.querySelector(".schedule-time")?.textContent.trim() || "";
    const ariaLabel = node.getAttribute("aria-label") || "";
    const violations = [];
    if (!fullName) violations.push("schedule name missing from the row");
    if (!ariaLabel) violations.push("aria-label missing");
    else {
      if (fullName && !ariaLabel.includes(fullName)) {
        violations.push(`aria-label "${ariaLabel}" drops the identifier "${fullName}"`);
      }
      if (status && !ariaLabel.includes(status)) {
        violations.push(`aria-label "${ariaLabel}" drops the ${status} status`);
      }
      if (time && !ariaLabel.includes(time)) {
        violations.push(`aria-label "${ariaLabel}" drops the start time "${time}"`);
      }
      if (!/open in all schedules/i.test(ariaLabel)) {
        violations.push("aria-label drops the navigation purpose");
      }
    }
    return violations;
  });
}

const modes = [
  {
    name: "195px 200% zoom equivalence",
    use: { viewport: { width: 195, height: 422 }, deviceScaleFactor: 2 },
    apply: async () => {},
  },
  {
    name: "320px + 200% text zoom",
    use: { viewport: { width: 320, height: 844 } },
    apply: async (page) => { await doubleTextSize(page); await page.waitForTimeout(120); },
  },
  {
    name: "390px + 200% text zoom",
    use: { viewport: { width: 390, height: 844 } },
    apply: async (page) => { await doubleTextSize(page); await page.waitForTimeout(120); },
  },
];

for (const mode of modes) {
  test.describe(mode.name, () => {
    test.use(mode.use);

    test(`every bottom-nav destination stays legible with a 44px reachable target — ${mode.name}`, async ({ page }) => {
      await page.goto("/");
      await page.waitForSelector("[data-testid=field-zone-6]");
      await mode.apply(page);
      const nav = page.locator(".mobile-nav");
      await expect(nav).toBeVisible();
      for (const destination of NAV_DESTINATIONS) {
        const link = nav.getByRole("link", { name: destination, exact: true });
        await expect(link, `${destination} destination exists with its complete accessible name`).toHaveCount(1);
        // Reachability: the link can be brought into view (the nav may
        // scroll internally) and then actually receives the pointer.
        await link.evaluate((node) => node.scrollIntoView({ inline: "center", block: "nearest" }));
        await expectUnclippedText(link, `${destination} nav label (${mode.name})`);
        const box = await rectOf(link);
        expect(box.width, `${destination} nav target width (${mode.name})`).toBeGreaterThanOrEqual(44);
        expect(box.height, `${destination} nav target height (${mode.name})`).toBeGreaterThanOrEqual(44);
        const hit = await page.evaluate(({ x, y, destination }) => {
          const node = document.elementFromPoint(x, y);
          const link = node?.closest("a");
          return Boolean(link && link.textContent.trim() === destination);
        }, { x: box.x + box.width / 2, y: box.y + box.height / 2, destination });
        expect(hit, `${destination} nav target receives the pointer at its centre (${mode.name})`).toBe(true);
      }
      // The nav manages its own space; the document never scrolls sideways.
      await expectContained(page, `nav legibility (${mode.name})`);
      // Discoverability: at these widths the five destinations cannot all
      // share the fold, so the nav must scroll AND advertise the hidden
      // side with a visible, AT-decorative affordance that retires at the
      // scrolled edge — off-fold destinations are never a secret.
      const scrollable = await nav.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
      expect(scrollable, `nav overflows and scrolls internally (${mode.name})`).toBe(true);
      const hintState = (side) => nav.locator(`.nav-scroll-hint-${side}`).evaluate((node) => ({
        opacity: Number.parseFloat(getComputedStyle(node).opacity),
        width: node.getBoundingClientRect().width,
        ariaHidden: node.getAttribute("aria-hidden"),
      }));
      await nav.evaluate((node) => { node.scrollLeft = 0; });
      await page.waitForTimeout(80);
      let right = await hintState("right");
      expect(right.ariaHidden, "affordance is decorative for AT (every link stays exposed)").toBe("true");
      expect(right.opacity, `start edge: more-destinations affordance visible (${mode.name})`).toBeGreaterThanOrEqual(0.9);
      expect(right.width, `affordance has visible size (${mode.name})`).toBeGreaterThanOrEqual(10);
      await nav.evaluate((node) => { node.scrollLeft = node.scrollWidth; });
      await page.waitForTimeout(80);
      right = await hintState("right");
      const left = await hintState("left");
      expect(right.opacity, `end edge: right affordance retires (${mode.name})`).toBeLessThanOrEqual(0.1);
      expect(left.opacity, `end edge: left affordance appears (${mode.name})`).toBeGreaterThanOrEqual(0.9);
      // Keyboard discoverability: focusing the last destination brings it
      // FULLY into the nav's fold (the nav's focusin handler compensates
      // for engines that only scroll a focused element partially into an
      // overflowing container).
      await nav.evaluate((node) => { node.scrollLeft = 0; });
      const controller = nav.getByRole("link", { name: "Controller", exact: true });
      await controller.evaluate((node) => node.focus());
      await expect(controller).toBeFocused();
      const navBox = await rectOf(nav);
      const controllerBox = await rectOf(controller);
      expect(controllerBox.right, `focused off-fold destination fully enters the fold (${mode.name})`)
        .toBeLessThanOrEqual(navBox.right + 1);
      expect(controllerBox.x, `focused destination fully visible (${mode.name})`)
        .toBeGreaterThanOrEqual(navBox.x - 1);
      // Safe area: the nav stays pinned to the viewport bottom throughout.
      const pinned = await nav.evaluate((node) => Math.abs(node.getBoundingClientRect().bottom - window.innerHeight));
      expect(pinned, `nav pinned to the viewport bottom (${mode.name})`).toBeLessThanOrEqual(0.5);
      // Navigation truly works in this state.
      const activity = nav.getByRole("link", { name: "Activity", exact: true });
      await activity.evaluate((node) => node.scrollIntoView({ inline: "center", block: "nearest" }));
      await activity.click();
      await expect(page).toHaveURL(/\/activity$/);
    });

    test(`Today schedule links keep readable full names and 44px targets — ${mode.name}`, async ({ page }) => {
      await page.goto("/");
      await page.waitForSelector("#schedules [data-schedule-row]");
      await mode.apply(page);
      const links = page.locator("#schedules a[data-schedule-link]");
      const count = await links.count();
      expect(count, "Today schedule deep links present").toBeGreaterThanOrEqual(2);
      const names = page.locator("#schedules .schedule-name");
      expect(await names.count()).toBe(count);
      for (let i = 0; i < count; i += 1) {
        const name = names.nth(i);
        const text = (await name.textContent()).trim();
        expect(text.length, `schedule ${i} has a real name`).toBeGreaterThan(2);
        // The primary identifier is painted completely — wrapped if needed,
        // never reduced to an ellipsis stub.
        await expectUnclippedText(name, `schedule name "${text}" (${mode.name})`);
        const link = links.nth(i);
        const box = await rectOf(link);
        expect(box.height, `schedule link "${text}" keeps a 44px target (${mode.name})`).toBeGreaterThanOrEqual(44);
        // The link's REAL accessible name: these links carry an aria-label,
        // which wins the accessible-name computation, so that attribute —
        // not descendant text, which would be a tautology — must preserve
        // the complete schedule identifier. Asserted through the shared
        // predicate that the sensitivity control below also exercises.
        expect(await accessibleNameViolations(link),
          `schedule link accessible name preserves "${text}" (${mode.name})`).toEqual([]);
        // Keyboard reachable in this zoom mode.
        await link.focus();
        await expect(link, `schedule link "${text}" is keyboard-focusable (${mode.name})`).toBeFocused();
      }
      // Sensitivity control: mutate the LIVE link's aria-label to a broken
      // truncated value, run the SAME shared predicate the real check uses,
      // prove it fails, then restore and prove it passes again.
      const firstLink = links.first();
      const originalLabel = await firstLink.getAttribute("aria-label");
      await firstLink.evaluate((node) => {
        const full = node.querySelector(".schedule-name").textContent.trim();
        node.setAttribute("aria-label", `${full.slice(0, 1)}… — open in all schedules`);
      });
      expect(await accessibleNameViolations(firstLink),
        "the shared predicate detects a truncated live accessible name").not.toEqual([]);
      await firstLink.evaluate((node, label) => node.setAttribute("aria-label", label), originalLabel);
      expect(await accessibleNameViolations(firstLink),
        "restoring the live accessible name satisfies the same predicate again").toEqual([]);
      await expectContained(page, `schedule names (${mode.name})`);
      // Keyboard activation lands on the exact schedule.
      await links.first().focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/schedules#/);
    });
  });
}

/* Mobile header under 200% text-only zoom: the product heading may wrap,
 * but its lines must never collide (readable line-height that scales with
 * the font), the header must grow with its content instead of letting the
 * opaque lawn or page content paint over "Controller online" and the
 * divider, and the geometry below must follow the real measured header. */
for (const width of [320, 390, 430]) {
  test(`mobile header stays readable and unobscured under 200% text zoom at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    for (const route of ["/", "/activity", "/schedules"]) {
      await page.goto(route);
      await page.waitForSelector(".mobile-header");
      await doubleTextSize(page);
      await page.waitForTimeout(120);
      const heading = page.locator(".mobile-product-heading, .mobile-header .product-name").first();
      const metrics = await heading.evaluate((node) => ({
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        fontSize: Number.parseFloat(getComputedStyle(node).fontSize),
        lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight),
      }));
      expect(metrics.scrollHeight, `${route} at ${width}px: heading not vertically clipped`)
        .toBeLessThanOrEqual(metrics.clientHeight + 2);
      expect(metrics.scrollWidth, `${route} at ${width}px: heading not horizontally clipped`)
        .toBeLessThanOrEqual(metrics.clientWidth + 1);
      // Wrapped lines never collide: line-height keeps pace with the font.
      expect(metrics.lineHeight, `${route} at ${width}px: readable line-height under text zoom`)
        .toBeGreaterThanOrEqual(metrics.fontSize * 1.1);
      // The header contains its whole stack: status and divider stay inside
      // the header box, below the heading, and no following content paints
      // over them.
      const headerRect = await rectOf(page.locator(".mobile-header"));
      const headingRect = await rectOf(heading);
      const statusRect = await rectOf(page.locator(".controller-status"));
      const dividerRect = await rectOf(page.locator(".header-divider"));
      expect(statusRect.y, `${route} at ${width}px: status sits below the heading`)
        .toBeGreaterThanOrEqual(headingRect.bottom - 0.5);
      expect(statusRect.bottom, `${route} at ${width}px: status inside the header`)
        .toBeLessThanOrEqual(headerRect.bottom + 0.5);
      expect(dividerRect.bottom, `${route} at ${width}px: divider inside the header`)
        .toBeLessThanOrEqual(headerRect.bottom + 0.5);
      const mainRect = await rectOf(page.locator("main"));
      expect(mainRect.y, `${route} at ${width}px: content never paints over the header`)
        .toBeGreaterThanOrEqual(dividerRect.bottom - 0.5);
      // Content-driven, no dead space: the header ends at its divider.
      expect(headerRect.bottom - dividerRect.bottom, `${route} at ${width}px: no dead header space`)
        .toBeLessThanOrEqual(8);
      // Containment and the fixed nav's safe-area pinning are unaffected.
      await expectContained(page, `${route} header at ${width}px text zoom`);
      const nav = await rectOf(page.locator(".mobile-nav"));
      expect(Math.abs(nav.bottom - 844), `${route} at ${width}px: nav stays pinned`).toBeLessThanOrEqual(0.5);
    }
  });
}

/* Section heading / action pairs (Today's "Schedules · All schedules",
 * "History · All activity") must never overprint under 200% text zoom at
 * any width: the pair may wrap, but painted boxes stay separated, with no
 * dead vertical space at normal zoom. */
async function sectionHeadViolations(page) {
  return page.evaluate(() => {
    // Ink-level measurement: a shrunken centred action paints its glyphs
    // OUTSIDE its own element box, so element rects cannot see the
    // overprint — Range rects over the text contents can.
    const inkRect = (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect();
    };
    const violations = [];
    for (const head of document.querySelectorAll(".section-head")) {
      const heading = head.querySelector("h2");
      const action = head.querySelector("a, .text-action");
      if (!heading || !action) continue;
      const a = inkRect(heading);
      const b = inkRect(action);
      const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (overlapX > 0.5 && overlapY > 0.5) {
        violations.push(`"${heading.textContent.trim()}" ink overlaps "${action.textContent.trim()}" by ${overlapX.toFixed(1)}x${overlapY.toFixed(1)}`);
      }
    }
    return violations;
  });
}

for (const width of [320, 900, 940, 980]) {
  test(`section headings and actions never overprint under 200% text zoom at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await page.waitForSelector(".section-head");
    // Normal zoom baseline: separated, and no dead space in the head band.
    expect(await sectionHeadViolations(page), `${width}px normal zoom`).toEqual([]);
    const normalHeight = await page.locator(".section-head").first()
      .evaluate((node) => node.getBoundingClientRect().height);
    expect(normalHeight, `${width}px: no dead space at normal zoom`).toBeLessThanOrEqual(60);
    await doubleTextSize(page);
    await page.waitForTimeout(120);
    expect(await sectionHeadViolations(page), `${width}px + 200% text zoom`).toEqual([]);
    await expectContained(page, `section heads at ${width}px text zoom`);
    // Sensitivity control: force the pre-repair non-wrapping flex row and
    // prove the very same predicate detects the overprint again.
    await page.addStyleTag({ content: ".section-head{flex-wrap:nowrap !important;gap:0 !important}" });
    await page.waitForTimeout(60);
    const forced = await sectionHeadViolations(page);
    if (width < 1024) {
      expect(forced.length, `${width}px: the predicate detects the forced non-wrapping overprint`)
        .toBeGreaterThan(0);
    }
  });
}

test("schedule link accessible names distinguish Enabled from Paused truthfully", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Today lists the first three schedules; pause one through the real API
  // so both states are visible in the summary.
  const schedules = await (await page.request.get("/api/schedules")).json();
  const [targetId, target] = Object.entries(schedules)
    .find(([, schedule]) => schedule.name === "Herb garden");
  const updated = await page.request.put("/api/schedules/update", {
    data: {
      id: targetId,
      name: target.name,
      days: target.days,
      startTime: target.startTime,
      tasks: target.tasks,
      enabled: false,
      revision: target.revision,
    },
  });
  expect(updated.ok()).toBe(true);
  await page.goto("/");
  await page.waitForSelector("#schedules [data-schedule-row]");
  const links = page.locator("#schedules a[data-schedule-link]");
  const count = await links.count();
  expect(count).toBeGreaterThanOrEqual(2);
  const statuses = new Set();
  for (let i = 0; i < count; i += 1) {
    const link = links.nth(i);
    expect(await accessibleNameViolations(link),
      `schedule link ${i} accessible name carries identifier, status, time and purpose`).toEqual([]);
    statuses.add((await link.locator(".schedule-state").textContent()).trim());
  }
  // The fixture exposes both states, so Enabled and Paused schedules are
  // proven to differ by status in their computed accessible names.
  expect([...statuses].sort(), "both Enabled and Paused schedules are represented").toEqual(["Enabled", "Paused"]);
  // Negative control: strip only the status from a live label and prove the
  // same shared predicate flags exactly that drop, then restore.
  const first = links.first();
  const original = await first.getAttribute("aria-label");
  await first.evaluate((node) => {
    const status = node.querySelector(".schedule-state").textContent.trim();
    node.setAttribute("aria-label", node.getAttribute("aria-label").split(status).join(""));
  });
  const flagged = await accessibleNameViolations(first);
  expect(flagged.some((violation) => /status/.test(violation)),
    "the shared predicate flags a status-free accessible name").toBe(true);
  await first.evaluate((node, label) => node.setAttribute("aria-label", label), original);
  expect(await accessibleNameViolations(first), "restored label passes again").toEqual([]);
});

/* /schedules data rows under 200% text-only zoom: the audited 900–1100px
 * window starved the name track to 0–8px, producing one-letter-per-line
 * columns (~520px rows) whose glyphs overprinted the Enabled/Paused
 * status. The contract below holds at mobile, both breakpoint boundaries,
 * the failing window, and full desktop, at normal and doubled text. */
for (const width of [390, 899, 900, 1024, 1100, 1200, 1440]) {
  test(`/schedules rows stay readable and separated under 200% text zoom at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/schedules");
    await page.waitForSelector("[data-schedule-row]");
    const auditRows = async (label, rowLimit) => {
      const rows = page.locator("[data-schedule-row]");
      const count = await rows.count();
      expect(count).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < count; i += 1) {
        const row = rows.nth(i);
        await expectUnclippedText(row.locator(".schedule-name"), `${label} row ${i} name`);
        const geometry = await row.evaluate((node) => {
          const nameEl = node.querySelector(".schedule-name");
          const stateEl = node.querySelector(".schedule-state");
          const style = getComputedStyle(nameEl);
          const ink = (el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return range.getBoundingClientRect();
          };
          const nameInk = ink(nameEl);
          const stateInk = stateEl ? ink(stateEl) : null;
          const overlap = stateInk
            ? Math.min(
              Math.min(nameInk.right, stateInk.right) - Math.max(nameInk.left, stateInk.left),
              Math.min(nameInk.bottom, stateInk.bottom) - Math.max(nameInk.top, stateInk.top)
            )
            : 0;
          return {
            nameWidth: nameEl.getBoundingClientRect().width,
            fontSize: Number.parseFloat(style.fontSize),
            lineHeight: Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.45,
            nameInkHeight: nameInk.height,
            inkOverlap: overlap,
            rowHeight: node.getBoundingClientRect().height,
          };
        });
        // A short name that fits on a single line needs no width floor; a
        // wrapping name must have a track of at least ~5 characters so it
        // can never degenerate into a letter column.
        const singleLine = geometry.nameInkHeight <= geometry.lineHeight * 1.2;
        expect(singleLine || geometry.nameWidth >= geometry.fontSize * 5,
          `${label} row ${i}: name track fits ~5 characters when wrapping (width ${geometry.nameWidth.toFixed(1)})`)
          .toBe(true);
        expect(geometry.nameInkHeight, `${label} row ${i}: name is never a one-letter column`)
          .toBeLessThanOrEqual(geometry.lineHeight * 3.2);
        expect(geometry.inkOverlap, `${label} row ${i}: name ink stays separated from Enabled/Paused`)
          .toBeLessThanOrEqual(0.5);
        expect(geometry.rowHeight, `${label} row ${i}: row stays compact`).toBeLessThanOrEqual(rowLimit);
      }
      await expectContained(page, label);
    };
    await auditRows(`/schedules ${width}px normal`, 220);
    await doubleTextSize(page);
    await page.waitForTimeout(150);
    await auditRows(`/schedules ${width}px + 200% text zoom`, 360);
    // Actions stay 44px targets and keyboard reachable under zoom.
    const firstRow = page.locator("[data-schedule-row]").first();
    const edit = firstRow.getByRole("link", { name: /^Edit / });
    const remove = firstRow.getByRole("button", { name: /^Delete / });
    for (const [label, target] of [["Edit", edit], ["Delete", remove]]) {
      const box = await rectOf(target);
      expect(box.height, `${label} keeps a 44px target at ${width}px text zoom`).toBeGreaterThanOrEqual(44);
    }
    await edit.focus();
    await expect(edit, `Edit is keyboard reachable at ${width}px text zoom`).toBeFocused();
  });
}

/* History rows: the phrase and its metadata must keep positive INK
 * separation (Range-based glyph bands, not element boxes) and line boxes
 * that scale with the font, at normal and 200% text zoom, on Today and
 * Activity, without ballooning leading. */
async function historyInkViolations(page) {
  return page.evaluate(() => {
    const violations = [];
    const ink = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect();
    };
    const rows = [...document.querySelectorAll("[data-history-row]")];
    if (!rows.length) return ["no history rows"];
    rows.forEach((row, i) => {
      const primary = row.querySelector(".history-primary");
      const meta = row.querySelector(".history-meta");
      if (!primary || !meta) {
        violations.push(`row ${i} structure missing`);
        return;
      }
      const a = ink(primary);
      const b = ink(meta);
      const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (overlapX > 0.5 && overlapY > 0.5) {
        violations.push(`row ${i} primary/meta ink overlap ${overlapX.toFixed(1)}x${overlapY.toFixed(1)}`);
      }
      for (const [name, el] of [["primary", primary], ["meta", meta]]) {
        const style = getComputedStyle(el);
        const fontSize = Number.parseFloat(style.fontSize);
        const lineHeight = Number.parseFloat(style.lineHeight);
        if (lineHeight && lineHeight < fontSize * 1.15) {
          violations.push(`row ${i} ${name} line box ${lineHeight.toFixed(1)}px crowds its ${fontSize.toFixed(1)}px font`);
        }
      }
      // Stacked rows keep modest leading — readable, not ballooned.
      if (overlapX > 0.5 && b.top >= a.bottom && b.top - a.bottom > 18) {
        violations.push(`row ${i} dead leading ${(b.top - a.bottom).toFixed(1)}px`);
      }
    });
    return violations;
  });
}

for (const width of [320, 390, 430, 900, 1440]) {
  test(`history text keeps ink separation at normal and 200% text zoom at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    // Descender-heavy data: "stopped" phrases carry p descenders that reach
    // deepest into the following metadata band.
    for (let i = 0; i < 6; i += 1) {
      const response = await page.request.post("/api/history/create", {
        data: { zones: i % 2 ? [1, 4] : [(i % 6) + 1], event: "Stopped", reason: ["Schedule", "Remote", "Manual"][i % 3] },
      });
      expect(response.ok()).toBe(true);
    }
    for (const route of ["/", "/activity"]) {
      await page.goto(route);
      await page.waitForSelector("[data-history-row]");
      expect(await historyInkViolations(page), `${route} at ${width}px normal zoom`).toEqual([]);
      await doubleTextSize(page);
      await page.waitForTimeout(120);
      expect(await historyInkViolations(page), `${route} at ${width}px + 200% text zoom`).toEqual([]);
      await expectContained(page, `history ink ${route} at ${width}px text zoom`);
      // Sensitivity control: restoring the pre-repair fixed line boxes must
      // be detected by the very same predicate.
      await page.addStyleTag({ content: ".history-primary{line-height:20px !important}.history-meta{line-height:18px !important}" });
      await page.waitForTimeout(60);
      expect((await historyInkViolations(page)).length,
        `${route} at ${width}px: fixed 20px/18px line boxes are detected under text zoom`).toBeGreaterThan(0);
    }
  });
}

/* Activity at the 160px layout viewport — the real 200% page-zoom
 * equivalence of a 320x568 phone. The audited failure: nowrap history
 * metadata forced documentElement scrollWidth past clientWidth, the page
 * gained a real sideways scroll, and meta escaped its row. The predicate
 * measures document overflow, ACTUAL achievable window.scrollX, and
 * per-row meta containment; the sensitivity control re-injects the exact
 * pre-repair nowrap and must flip the very same predicate. */
async function historyMetaEscapeViolations(page) {
  return page.evaluate(() => {
    const violations = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth) {
      violations.push(`document overflow ${doc.scrollWidth}x${doc.clientWidth}`);
    }
    if (document.body.scrollWidth > document.body.clientWidth) {
      violations.push(`body overflow ${document.body.scrollWidth}x${document.body.clientWidth}`);
    }
    const priorX = window.scrollX;
    window.scrollTo(50, window.scrollY);
    if (window.scrollX > 0) violations.push(`real sideways scroll to x=${window.scrollX}`);
    window.scrollTo(priorX, window.scrollY);
    const rows = [...document.querySelectorAll("[data-history-row]")];
    if (!rows.length) violations.push("no history rows");
    rows.forEach((row, i) => {
      const meta = row.querySelector(".history-meta");
      if (!meta) {
        violations.push(`row ${i} has no metadata`);
        return;
      }
      const rowBox = row.getBoundingClientRect();
      const metaBox = meta.getBoundingClientRect();
      if (metaBox.right > rowBox.right + 0.5) {
        violations.push(`row ${i} meta escapes its row by ${(metaBox.right - rowBox.right).toFixed(2)}px`);
      }
      if (metaBox.right > doc.clientWidth + 0.5) {
        violations.push(`row ${i} meta escapes the viewport by ${(metaBox.right - doc.clientWidth).toFixed(2)}px`);
      }
      if (row.scrollWidth > row.clientWidth + 1) {
        violations.push(`row ${i} clips ${row.scrollWidth}x${row.clientWidth}`);
      }
    });
    return violations;
  });
}

test.describe("history metadata at the 160px page-zoom equivalence", () => {
  test.use({ viewport: { width: 160, height: 284 } });

  test("activity metadata stays contained and coherent at 160x284", async ({ page }) => {
    for (let i = 0; i < 6; i += 1) {
      const response = await page.request.post("/api/history/create", {
        data: { zones: i % 2 ? [1, 4] : [(i % 6) + 1], event: "Stopped", reason: ["Schedule", "Remote", "Manual"][i % 3] },
      });
      expect(response.ok()).toBe(true);
    }
    await page.goto("/activity");
    await page.waitForSelector("[data-history-row]");
    expect(await historyMetaEscapeViolations(page), "metadata contained at 160x284").toEqual([]);
    // Coherence: the wrapped metadata still reads as one attached source
    // phrase with readable line boxes, not as clipped or colliding text.
    const rows = page.locator("[data-history-row]");
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(6);
    await expect(rows.first().locator(".history-meta"))
      .toHaveText(/^(Remote|Schedule|Manual|Completed|Home Assistant|Controller) · .+$/);
    expect(await historyInkViolations(page), "ink separation at 160x284").toEqual([]);
    // Sensitivity control: the exact pre-repair rule must be caught by the
    // very same predicate this test passes with.
    await page.addStyleTag({ content: ".history-meta{white-space:nowrap !important}" });
    await page.waitForTimeout(60);
    expect((await historyMetaEscapeViolations(page)).length,
      "re-injected nowrap metadata is detected as escape/overflow").toBeGreaterThan(0);
  });
});
