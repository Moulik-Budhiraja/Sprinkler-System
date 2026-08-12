/* Shared live-paint predicate for the sprinkler → connector → Stop/Remove
 * assembly contract: every busy zone's control must visibly EMERGE from its
 * own rendered sprinkler through a painted mechanical connector that begins
 * at the silhouette's physical base attachment point and terminates tucked
 * into the control's own housing — one continuous assembly, never a control
 * floating on empty lawn below an unrelated status rail.
 *
 * The measurement is the ACTUAL composited page (phase-differential
 * screenshots, as in livePaintGeometry): each probe phase hides exactly one
 * assembly layer and the pixel diff isolates that layer's visibly painted
 * set in the live engine output. Anything that paints OVER the connector
 * (e.g. a status rail lying across the pipe) therefore erodes the painted
 * set and is caught as a discontinuity — the predicate cannot be satisfied
 * by DOM geometry alone.
 *
 * The expected attachment point/axis is re-derived here independently from
 * the character part data (ground-edge midpoint of the physical silhouette,
 * honouring the whole-body pose) so the production formula is checked, not
 * trusted. Spray, shadow, grass, labels and the zone wrapper are never part
 * of the derivation. */

import {
  SILHOUETTE_SELECTOR,
  decodePngNode,
  diffPixels,
  edtNode,
} from "./design-repair-utils.js";

export const ATTACHMENT_CONTRACT = {
  threshold: 24, // per-channel screenshot diff that counts as visibly painted
  minConnectorAreaCss: 40, // px²: a real pipe paints at least ~7px × 6px
  touchTolerancePx: 1.5, // AA: painted sets within this are touching
  bridgeTolerancePx: 1, // gaps ≤ 1 CSS px are AA-forgiven; larger = severed
  axisTolerancePx: 3, // connector centreline vs attachment axis / housing port
  minHousingTargetPx: 44,
};

/* Every way the rendered assembly can break the contract. Negative-control
 * tests drive the known-bad detached and rail-severed layouts through this
 * same list, proving the predicate detects them. */
export function attachmentViolations(g) {
  const c = ATTACHMENT_CONTRACT;
  if (!g.dockVisible) return ["no visible Stop/Remove control is present to attach"];
  const v = [];
  const fmt = (value) => (Number.isFinite(value) ? value.toFixed(2) : String(value));
  if (!(g.connectorAreaCss >= c.minConnectorAreaCss)) {
    v.push(`no painted connector (${fmt(g.connectorAreaCss)}px² < ${c.minConnectorAreaCss}): control reads as a detached object on empty lawn`);
  }
  if (!(g.touchSilhouetteCss <= c.touchTolerancePx)) {
    v.push(`connector never reaches the silhouette (nearest painted gap ${fmt(g.touchSilhouetteCss)}px > ${c.touchTolerancePx}px)`);
  }
  if (!(g.touchHousingCss <= c.touchTolerancePx)) {
    v.push(`connector never reaches the control housing (nearest painted gap ${fmt(g.touchHousingCss)}px > ${c.touchTolerancePx}px)`);
  }
  if (!g.assembled) {
    v.push("assembly discontinuous: silhouette, connector and housing are not one continuous painted component (visible break > 1 CSS px)");
  }
  if (!(Math.abs(g.axisTopDxCss) <= c.axisTolerancePx)) {
    v.push(`connector does not emerge on the silhouette's own attachment axis (dx ${fmt(g.axisTopDxCss)}px)`);
  }
  if (!(Math.abs(g.axisBottomDxCss) <= c.axisTolerancePx)) {
    v.push(`connector does not terminate at its own housing port (dx ${fmt(g.axisBottomDxCss)}px)`);
  }
  if (g.railSevers) {
    v.push("status rail floats between stem and housing across the connection, severing the assembly");
  }
  if (g.control.width < c.minHousingTargetPx - 0.5 || g.control.height < c.minHousingTargetPx - 0.5) {
    v.push(`housing target ${g.control.width.toFixed(1)}x${g.control.height.toFixed(1)} under ${c.minHousingTargetPx}px`);
  }
  return v;
}

/* Let two geometry syncs (rAF-scheduled) and dock resolution settle after a
 * state or viewport change before measuring. */
export async function settleGeometry(page) {
  await page.evaluate(() => new Promise((resolve) => {
    // Canonical top-of-page scroll state: every rect this suite compares is
    // then measured in one shared viewport coordinate frame.
    window.scrollTo(0, 0);
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 40)));
  }));
}

export async function attachmentGeometry(page, zone) {
  const info = await page.evaluate(({ zone, SIL }) => {
    // Interacting with the refresh control may have scrolled the dashboard;
    // measure and screenshot from the canonical top-of-page scroll state.
    window.scrollTo(0, 0);
    const wrap = document.querySelector(`[data-testid=field-zone-${zone}]`);
    if (!wrap) throw new Error(`zone ${zone} wrapper missing`);
    const svg = wrap.querySelector("svg.char");
    const svgRect = svg.getBoundingClientRect();
    const scale = Math.min(svgRect.width / 200, svgRect.height / 150);
    const offsetX = (svgRect.width - 200 * scale) / 2;
    const offsetY = (svgRect.height - 150 * scale) / 2;
    /* Independent attachment derivation: transformed ground-edge midpoint of
     * the physical parts (rect bottom corners / polygon vertices), axis =
     * body-vertical rotated by the pose. */
    const LY = window.LivingYard;
    const layout = matchMedia(LY.LAYOUTS.desktop.media).matches ? LY.LAYOUTS.desktop : LY.LAYOUTS.mobile;
    const entry = layout.zones.find((candidate) => candidate.z === zone);
    const character = LY.CHARACTERS[entry.kind];
    const rotate = ([x, y], { a, cx, cy }) => {
      const rad = (a * Math.PI) / 180;
      const dx = x - cx;
      const dy = y - cy;
      return [cx + dx * Math.cos(rad) - dy * Math.sin(rad), cy + dx * Math.sin(rad) + dy * Math.cos(rad)];
    };
    const points = [];
    for (const part of character.parts) {
      const corners = part.points
        ? part.points.trim().split(/\s+/).map((pair) => pair.split(",").map(Number))
        : [[part.x, part.y + part.h], [part.x + part.w, part.y + part.h]];
      for (let corner of corners) {
        if (part.rot) corner = rotate(corner, part.rot);
        if (character.pose) corner = rotate(corner, character.pose);
        points.push(corner);
      }
    }
    const groundY = Math.max(...points.map(([, y]) => y));
    const baseXs = points.filter(([, y]) => y >= groundY - 1.5).map(([x]) => x);
    const poseRad = (((character.pose && character.pose.a) || 0) * Math.PI) / 180;
    const attachment = {
      x: svgRect.left + offsetX + ((Math.min(...baseXs) + Math.max(...baseXs)) / 2) * scale,
      y: svgRect.top + offsetY + groundY * scale,
      dirX: -Math.sin(poseRad),
      dirY: Math.cos(poseRad),
    };
    const rectOfNode = (node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    let silhouette = null;
    for (const part of wrap.querySelectorAll(SIL)) {
      const r = rectOfNode(part);
      silhouette = silhouette
        ? {
          x: Math.min(silhouette.x, r.x),
          y: Math.min(silhouette.y, r.y),
          right: Math.max(silhouette.right, r.right),
          bottom: Math.max(silhouette.bottom, r.bottom),
        }
        : { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
    }
    const dock = wrap.querySelector(".zone-dock");
    const control = dock && !dock.hidden ? dock.querySelector("button") : null;
    const isValve = Boolean(control && control.querySelector(".valve-wheel"));
    const portNode = control
      ? (control.querySelector(".valve-wheel") || control.querySelector(".coupler") || control)
      : null;
    let port = null;
    if (portNode) {
      const portRect = rectOfNode(portNode);
      const controlRect = rectOfNode(control);
      port = {
        x: portRect.x + portRect.width / 2,
        y: isValve ? portRect.y + portRect.height / 2 : controlRect.y + controlRect.height / 2,
      };
    }
    const waterline = wrap.querySelector(".waterline");
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      wrap: rectOfNode(wrap),
      attachment,
      silhouette,
      controlKind: control ? (isValve ? "stop" : "remove") : null,
      control: control ? rectOfNode(control) : null,
      port,
      waterline: waterline
        ? { ...rectOfNode(waterline), opacity: Number.parseFloat(getComputedStyle(waterline).opacity) }
        : null,
    };
  }, { zone, SIL: SILHOUETTE_SELECTOR });

  if (!info.control) return { dockVisible: false, info };

  const c = ATTACHMENT_CONTRACT;
  const boxes = [info.wrap, info.control];
  if (info.waterline) boxes.push(info.waterline);
  const pad = 8;
  const clip = {
    x: Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad),
    y: Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad),
  };
  clip.width = Math.min(info.viewportWidth, Math.max(...boxes.map((b) => b.right)) + pad) - clip.x;
  clip.height = Math.min(info.viewportHeight, Math.max(...boxes.map((b) => b.bottom)) + pad) - clip.y;

  const scoped = (inner) => inner.split(",")
    .map((selector) => `[data-testid=field-zone-${zone}] ${selector.trim()}`).join(",");
  const phases = [
    "",
    `${scoped(".dock-connector")}{visibility:hidden !important}`,
    `${scoped(".dock-connector,.zone-dock")}{visibility:hidden !important}`,
    `${scoped(`.dock-connector,.zone-dock,${SILHOUETTE_SELECTOR}`)}{visibility:hidden !important}`,
  ];
  const shots = [];
  for (const css of phases) {
    await page.evaluate((probeCss) => {
      let style = document.getElementById("attachment-paint-probe");
      if (!style) {
        style = document.createElement("style");
        style.id = "attachment-paint-probe";
        document.head.append(style);
      }
      style.textContent = probeCss;
    }, css);
    await page.waitForTimeout(40);
    shots.push(decodePngNode(await page.screenshot({ clip, animations: "disabled" })));
  }
  await page.evaluate(() => document.getElementById("attachment-paint-probe")?.remove());

  const [full, noConnector, noDock, bare] = shots;
  const W = full.width;
  const H = full.height;
  const pxScale = W / clip.width;
  const connector = diffPixels(full, noConnector, c.threshold);
  const housing = diffPixels(noConnector, noDock, c.threshold);
  const silhouette = diffPixels(noDock, bare, c.threshold);

  const minOver = (set, dist) => {
    if (!set.count || !dist) return Infinity;
    let min = Infinity;
    for (let i = 0; i < W * H; i += 1) {
      if (set.mask[i] && dist[i] < min) min = dist[i];
    }
    return Math.sqrt(min) / pxScale;
  };
  const silDist = silhouette.count ? edtNode(silhouette.mask, W, H) : null;
  const housingDist = housing.count ? edtNode(housing.mask, W, H) : null;
  const touchSilhouetteCss = minOver(connector, silDist);
  const touchHousingCss = minOver(connector, housingDist);

  /* Connected components over the union of the three painted sets. Two
   * pixels join when within Chebyshev distance (1 + bridge) — at DPR 1 this
   * forgives exactly a ≤1 CSS px AA seam and severs anything wider. */
  const reach = 1 + Math.max(1, Math.round(c.bridgeTolerancePx * pxScale));
  const union = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i += 1) {
    if (connector.mask[i] || housing.mask[i] || silhouette.mask[i]) union[i] = 1;
  }
  const component = new Int32Array(W * H).fill(-1);
  let componentCount = 0;
  const queue = new Int32Array(W * H);
  for (let start = 0; start < W * H; start += 1) {
    if (!union[start] || component[start] !== -1) continue;
    const id = componentCount++;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    component[start] = id;
    while (head < tail) {
      const i = queue[head++];
      const cx = i % W;
      const cy = (i / W) | 0;
      for (let dy = -reach; dy <= reach; dy += 1) {
        const ny = cy + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -reach; dx <= reach; dx += 1) {
          const nx = cx + dx;
          if (nx < 0 || nx >= W) continue;
          const ni = ny * W + nx;
          if (union[ni] && component[ni] === -1) {
            component[ni] = id;
            queue[tail++] = ni;
          }
        }
      }
    }
  }
  /* The assembled component must hold the connector's own majority plus a
   * noise-proof floor of BOTH partner sets (a housing legitimately paints
   * as several pieces — pill ring, coupler, text — so demanding its
   * majority would be wrong; demanding ≥20 substantial pixels means a
   * stray flickering pixel shared between diff sets can never fake the
   * silhouette–housing junction, in either direction). */
  const perComponent = (set) => {
    const counts = new Map();
    for (let i = 0; i < W * H; i += 1) {
      if (set.mask[i]) counts.set(component[i], (counts.get(component[i]) || 0) + 1);
    }
    return counts;
  };
  const silByComponent = perComponent(silhouette);
  const housingByComponent = perComponent(housing);
  const connectorByComponent = perComponent(connector);
  const silNeeded = Math.max(20, silhouette.count * 0.02);
  const housingNeeded = Math.max(20, housing.count * 0.02);
  let assembled = false;
  if (connector.count > 0) {
    for (const [id, connectorPixels] of connectorByComponent) {
      if (connectorPixels < connector.count * 0.5) continue;
      if ((silByComponent.get(id) || 0) < silNeeded) continue;
      if ((housingByComponent.get(id) || 0) < housingNeeded) continue;
      assembled = true;
      break;
    }
  }

  const setStats = (set) => {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        if (!set.mask[y * W + x]) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return { minX, minY, maxX, maxY };
  };
  /* The joint bands: connector pixels PAINTED ADJACENT to each partner set
   * (within 2.5 CSS px through the same distance fields the touch checks
   * use). Where the connector meets the silhouette its centreline must sit
   * on the silhouette's own attachment axis; where it meets the housing it
   * must arrive at the housing's own port. */
  const bandMedian = (dist, maxCss) => {
    if (!dist) return null;
    const limit = (maxCss * pxScale) ** 2;
    const xs = [];
    const ys = [];
    for (let i = 0; i < W * H; i += 1) {
      if (!connector.mask[i] || dist[i] > limit) continue;
      xs.push(i % W);
      ys.push((i / W) | 0);
    }
    if (!xs.length) return null;
    // Median centreline: a stray flickering AA pixel caught by the phase
    // diff cannot drag the joint position the way a mean would.
    const median = (values) => values.sort((a, b) => a - b)[values.length >> 1];
    return { x: clip.x + median(xs) / pxScale, y: clip.y + median(ys) / pxScale };
  };
  const att = info.attachment;
  const axisXAt = (cssY) => att.x + att.dirX * ((cssY - att.y) / att.dirY);
  const topBand = bandMedian(silDist, 2.5);
  const bottomBand = bandMedian(housingDist, 2.5);
  const axisTopDxCss = topBand ? topBand.x - axisXAt(topBand.y) : NaN;
  const axisBottomDxCss = bottomBand && info.port ? bottomBand.x - info.port.x : NaN;

  /* Status-rail severing: a visible rail lying strictly between the stem's
   * ground boundary and the housing top, across the attachment axis, is the
   * user-reported "floating rail" interruption regardless of paint order. */
  const rail = info.waterline;
  const midY = (info.silhouette.bottom + info.control.y) / 2;
  const axisMidX = axisXAt(midY);
  const railSevers = Boolean(rail && rail.opacity > 0.05 &&
    rail.y > info.silhouette.bottom + 1 && rail.bottom < info.control.y - 1 &&
    rail.x < axisMidX && rail.right > axisMidX);

  const connectorStats = setStats(connector);
  const connectorBBoxCss = connector.count
    ? {
      x: clip.x + connectorStats.minX / pxScale,
      y: clip.y + connectorStats.minY / pxScale,
      right: clip.x + connectorStats.maxX / pxScale,
      bottom: clip.y + connectorStats.maxY / pxScale,
    }
    : null;

  return {
    dockVisible: true,
    zone,
    pxScale,
    controlKind: info.controlKind,
    control: info.control,
    silhouetteRect: info.silhouette,
    attachment: info.attachment,
    port: info.port,
    waterline: info.waterline,
    counts: { connector: connector.count, housing: housing.count, silhouette: silhouette.count },
    connectorAreaCss: connector.count / (pxScale * pxScale),
    connectorBBoxCss,
    touchSilhouetteCss,
    touchHousingCss,
    assembled,
    axisTopDxCss,
    axisBottomDxCss,
    railSevers,
  };
}
