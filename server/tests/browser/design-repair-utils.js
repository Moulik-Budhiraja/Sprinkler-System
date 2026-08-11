/* Shared measurement helpers for the design-repair specs.
 *
 * The outline measurement rasterizes the real rendered SVG (silhouette layer
 * and selection-outline layer separately) and computes an exact euclidean
 * distance transform, so the asserted gap is the visually rendered gap in CSS
 * pixels — not a bounding-box approximation. It understands both the legacy
 * hand-drawn contour paths and the rebuilt silhouette-derived outline, so the
 * same test provides honest RED evidence against the legacy geometry.
 */

import zlib from "node:zlib";

export const SILHOUETTE_SELECTOR = ".c-riser,.c-collar,.c-head,.c-nozzle,.c-skirt";

/* Outline construction constants shared by the instruments: the rendered
 * empty gap, the keyline outer edge and the halo outer edge, in CSS px. */
export const OUTLINE_PX = { gap: 4, keylineOuter: 6.2, haloOuter: 9.2 };

/* Outline contract in rendered CSS pixels (construction model). The
 * construction is a 4 px empty gap plus a 2.2 px keyline, uniform on every
 * side at every scale, so the bounds hold the measurement to that intent —
 * gap inside the designed 3–5 px band, keyline outer edge 6.2 ± raster
 * tolerance, margins uniform and centred. */
export const OUTLINE_CONTRACT = {
  gapMin: 3, // CSS px: rendered empty gap stays inside the designed 3–5 band
  gapMax: 5, // CSS px (construction target 4; ±1 covers the ×2 raster grid)
  ringOuterMin: 5.5, // CSS px: keyline outer edge = gap 4 + ring 2.2 ± tolerance
  ringOuterMax: 7.5, // CSS px
  marginMin: 5.5, // CSS px: per-side extension beyond the silhouette = 6.2 ± tolerance
  marginMax: 7, // CSS px (measured 5.97–6.45 across engines/zones/scales)
  // A uniform ring around an asymmetric non-convex silhouette honestly
  // shifts its centroid (up to ~2.5 CSS px from corner-curvature area);
  // margins and side balance are the fine uniformity detectors, so the
  // centroid stays a coarse sanity bound.
  centroidTolerancePx: 3, // CSS px
  sideBalancePx: 1.2, // CSS px symmetry (measured ≤ 0.38; a 1.5px drift reads 3)
};

/* Every way a measured outline can break the contract; negative-control
 * tests drive known-bad geometry through this same predicate, so the
 * bounds themselves are proven able to detect drift and mismatched
 * dilation. */
export function outlineViolations(geometry) {
  const violations = [];
  if (geometry.gapMinCss < OUTLINE_CONTRACT.gapMin) violations.push(`gap ${geometry.gapMinCss.toFixed(2)} below ${OUTLINE_CONTRACT.gapMin}`);
  if (geometry.gapMinCss > OUTLINE_CONTRACT.gapMax) violations.push(`gap ${geometry.gapMinCss.toFixed(2)} above ${OUTLINE_CONTRACT.gapMax}`);
  if (geometry.gapMaxCss < OUTLINE_CONTRACT.ringOuterMin) violations.push(`ring outer ${geometry.gapMaxCss.toFixed(2)} below ${OUTLINE_CONTRACT.ringOuterMin}`);
  if (geometry.gapMaxCss > OUTLINE_CONTRACT.ringOuterMax) violations.push(`ring outer ${geometry.gapMaxCss.toFixed(2)} above ${OUTLINE_CONTRACT.ringOuterMax}`);
  if (Math.abs(geometry.centroidDxCss) > OUTLINE_CONTRACT.centroidTolerancePx) violations.push(`centroid dx ${geometry.centroidDxCss.toFixed(2)}`);
  if (Math.abs(geometry.centroidDyCss) > OUTLINE_CONTRACT.centroidTolerancePx) violations.push(`centroid dy ${geometry.centroidDyCss.toFixed(2)}`);
  for (const [side, value] of Object.entries(geometry.marginsCss)) {
    if (value < OUTLINE_CONTRACT.marginMin) violations.push(`${side} margin ${value.toFixed(2)} below ${OUTLINE_CONTRACT.marginMin}`);
    if (value > OUTLINE_CONTRACT.marginMax) violations.push(`${side} margin ${value.toFixed(2)} above ${OUTLINE_CONTRACT.marginMax}`);
  }
  const { left, right, top, bottom } = geometry.marginsCss;
  if (Math.abs(left - right) > OUTLINE_CONTRACT.sideBalancePx) violations.push(`horizontal imbalance ${(left - right).toFixed(2)}`);
  if (Math.abs(top - bottom) > OUTLINE_CONTRACT.sideBalancePx) violations.push(`vertical imbalance ${(top - bottom).toFixed(2)}`);
  return violations;
}

/* Rendered check-badge contract, in CSS pixels. The disc centre sits a
 * constant distance from the nearest point of the physical silhouette — the
 * same scale-invariant construction the selection outline uses — and the
 * disc renders at one constant size. distTolerancePx covers the ×2
 * supersampled rasterisation and antialias threshold (≤ ~0.6 CSS px at the
 * largest zone scale) with headroom; the pre-repair user-unit formula missed
 * the contract by 2–5 CSS px, several times this band. */
export const BADGE_CONTRACT = {
  distPx: 10.15, // radius 7 + stroke overhang 0.75 + painted clearance 2.4
  distTolerancePx: 1.1,
  spreadMaxPx: 1.5,
  radiusPx: 7,
  radiusTolerancePx: 0.6,
  strokePx: 1.5, // the disc's painted stroke; half of it overhangs the geometric radius
  paintedClearancePx: 2.4, // intended painted clearance (2px intent + 0.4px DPR1 raster margin)
};

export async function outlineGeometry(page, zone) {
  return page.evaluate(async ({ zone, SIL }) => {
    const wrap = document.querySelector(`[data-testid=field-zone-${zone}]`);
    if (!wrap) throw new Error(`zone ${zone} wrapper missing`);
    const svg = wrap.querySelector("svg.char");
    const rect = svg.getBoundingClientRect();
    // preserveAspectRatio=xMidYMid meet content scale: CSS px per user unit.
    const scale = Math.min(rect.width / 200, rect.height / 150);
    const newOutline = svg.querySelector("[data-selection-outline]");
    const mode = newOutline ? "silhouette-derived" : "legacy-contour";
    const outlineSelector = newOutline
      ? "[data-selection-outline] .outline-keyline"
      : ".char-contour.contour-keyline";
    const legacyStroke = newOutline
      ? 0
      : Number.parseFloat(getComputedStyle(svg.querySelector(".char-contour.contour-keyline")).strokeWidth) || 2;

    const S = 2; // canvas pixels per SVG user unit (supersample)
    // The clone rasterizes the extended -40..240 × -40..190 region (the
    // mask's own bounds): at very small rendered scales the outline's
    // user-unit dilation extends past the 0..200×0..150 viewBox, and a
    // viewBox-sized canvas would clip it and understate the margins.
    const EXT = 40;
    const W = (200 + 2 * EXT) * S;
    const H = (150 + 2 * EXT) * S;

    const buildClone = (selector, paint) => {
      const clone = svg.cloneNode(true);
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("viewBox", `${-EXT} ${-EXT} ${200 + 2 * EXT} ${150 + 2 * EXT}`);
      clone.setAttribute("width", String(W));
      clone.setAttribute("height", String(H));
      clone.removeAttribute("class");
      const targets = [...clone.querySelectorAll(selector)];
      if (!targets.length) return null;
      const keep = new Set();
      const keepSubtree = (el) => {
        keep.add(el);
        el.querySelectorAll("*").forEach((child) => keep.add(child));
      };
      const keepAncestors = (el) => {
        let node = el.parentElement;
        while (node && node !== clone) {
          keep.add(node);
          node = node.parentElement;
        }
      };
      targets.forEach((t) => { keepSubtree(t); keepAncestors(t); });
      clone.querySelectorAll("defs,mask").forEach((el) => { keepSubtree(el); keepAncestors(el); });
      [...clone.querySelectorAll("*")].forEach((el) => {
        if (!keep.has(el) && clone.contains(el)) el.remove();
      });
      // The live outline strokes are screen-space (vector-effect
      // non-scaling-stroke with CSS-px widths). This clone rasterizes the
      // CONSTRUCTION MODEL at S canvas px per user unit, so convert those
      // widths to the user-unit equivalent of this zone's live scale. The
      // clone is deliberately engine-independent — live per-engine paint
      // truth is measured by livePaintGeometry below, never by this clone.
      clone.querySelectorAll("[vector-effect]").forEach((el) => el.removeAttribute("vector-effect"));
      clone.querySelectorAll(".outline-mask,.outline-keyline,.outline-halo").forEach((el) => {
        const width = Number.parseFloat(el.getAttribute("stroke-width"));
        if (Number.isFinite(width)) el.setAttribute("stroke-width", String(width / scale));
      });
      paint(targets);
      return clone;
    };

    const rasterize = async (clone) => {
      const xml = new XMLSerializer().serializeToString(clone);
      // data: URL keeps the raster inside the page's img-src CSP allowance.
      const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("svg raster failed"));
        img.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, W, H);
      return ctx.getImageData(0, 0, W, H).data;
    };

    const coverage = (data) => {
      const mask = new Uint8Array(W * H);
      let count = 0;
      let sx = 0;
      let sy = 0;
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          const alpha = data[(y * W + x) * 4 + 3];
          if (alpha > 127) {
            mask[y * W + x] = 1;
            count += 1;
            sx += x;
            sy += y;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      return { mask, count, cx: sx / Math.max(1, count), cy: sy / Math.max(1, count), minX, minY, maxX, maxY };
    };

    // Exact euclidean distance transform (Felzenszwalb), squared distances.
    const edt = (mask) => {
      const INF = 1e12;
      const n = Math.max(W, H);
      const f = new Float64Array(n);
      const zBound = new Float64Array(n + 1);
      const v = new Int32Array(n);
      const out = new Float64Array(n);
      const d = new Float64Array(W * H);
      for (let i = 0; i < W * H; i += 1) d[i] = mask[i] ? 0 : INF;
      const dt1 = (len) => {
        let k = 0;
        v[0] = 0;
        zBound[0] = -INF;
        zBound[1] = INF;
        for (let q = 1; q < len; q += 1) {
          let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
          while (s <= zBound[k]) {
            k -= 1;
            s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
          }
          k += 1;
          v[k] = q;
          zBound[k] = s;
          zBound[k + 1] = INF;
        }
        k = 0;
        for (let q = 0; q < len; q += 1) {
          while (zBound[k + 1] < q) k += 1;
          out[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
        }
      };
      for (let x = 0; x < W; x += 1) {
        for (let y = 0; y < H; y += 1) f[y] = d[y * W + x];
        dt1(H);
        for (let y = 0; y < H; y += 1) d[y * W + x] = out[y];
      }
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) f[x] = d[y * W + x];
        dt1(W);
        for (let x = 0; x < W; x += 1) d[y * W + x] = out[x];
      }
      return d;
    };

    const silhouetteClone = buildClone(SIL, (targets) => targets.forEach((t) => {
      t.setAttribute("fill", "#000");
      t.setAttribute("stroke", "none");
    }));
    if (!silhouetteClone) throw new Error("silhouette shapes missing");
    const outlineClone = buildClone(outlineSelector, (targets) => targets.forEach((t) => {
      if (mode === "legacy-contour") {
        t.setAttribute("fill", "none");
        t.setAttribute("stroke", "#000");
        t.setAttribute("stroke-width", String(legacyStroke));
      } else {
        t.setAttribute("fill", "#000");
        t.setAttribute("stroke", "#000");
      }
    }));
    if (!outlineClone) {
      return { mode, missingOutline: true, scale };
    }
    // Only the outline geometry may survive in the outline raster: the
    // silhouette body art must not repaint there (masks/defs stay).
    const sil = coverage(await rasterize(silhouetteClone));
    const out = coverage(await rasterize(outlineClone));
    if (!sil.count) throw new Error("silhouette raster empty");
    if (!out.count) return { mode, missingOutline: true, scale };
    const dist = edt(sil.mask);
    const toCss = (canvasUnits) => (canvasUnits / S) * scale;
    let minD = Infinity;
    let maxD = -Infinity;
    for (let i = 0; i < W * H; i += 1) {
      if (!out.mask[i]) continue;
      const d = Math.sqrt(dist[i]);
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
    }
    /* Badge centre → silhouette distance, sampled bilinearly from the same
     * euclidean distance field the outline gap is measured with, so both
     * assertions share one definition of "the rendered silhouette". */
    const offsetX = (rect.width - 200 * scale) / 2;
    const offsetY = (rect.height - 150 * scale) / 2;
    const sampleDistCss = (cssX, cssY) => {
      const cx = ((cssX - rect.left - offsetX) / scale + EXT) * S;
      const cy = ((cssY - rect.top - offsetY) / scale + EXT) * S;
      const x0 = Math.max(0, Math.min(W - 2, Math.floor(cx)));
      const y0 = Math.max(0, Math.min(H - 2, Math.floor(cy)));
      const fx = Math.max(0, Math.min(1, cx - x0));
      const fy = Math.max(0, Math.min(1, cy - y0));
      const at = (x, y) => Math.sqrt(dist[y * W + x]);
      const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
      const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
      return toCss(top * (1 - fy) + bottom * fy);
    };
    let badge = null;
    const disc = svg.querySelector(".anchor-disc");
    if (disc) {
      const discRect = disc.getBoundingClientRect();
      badge = {
        distCss: sampleDistCss(discRect.left + discRect.width / 2, discRect.top + discRect.height / 2),
        radiusCss: (discRect.width + discRect.height) / 4,
      };
    }
    /* Negative-control probe: the pre-repair anchor formula placed the badge
     * centre at (bbox.minX − 5, bbox.minY − 5) in SVG user units — a corner
     * that is not a silhouette point and an offset that scales with the zone.
     * Measuring that construction through the same distance field proves the
     * rendered-distance assertions catch it. */
    let legacyBadge = null;
    const characters = window.LivingYard?.CHARACTERS;
    const layouts = window.LivingYard?.LAYOUTS;
    if (characters && layouts) {
      const layout = matchMedia(layouts.desktop.media).matches ? layouts.desktop : layouts.mobile;
      const entry = layout.zones.find((candidate) => candidate.z === zone);
      const character = entry ? characters[entry.kind] : null;
      if (character) {
        const rotate = ([x, y], { a, cx, cy }) => {
          const rad = (a * Math.PI) / 180;
          const dx = x - cx;
          const dy = y - cy;
          return [cx + dx * Math.cos(rad) - dy * Math.sin(rad), cy + dx * Math.sin(rad) + dy * Math.cos(rad)];
        };
        let minX = Infinity;
        let minY = Infinity;
        for (const part of character.parts) {
          const corners = part.points
            ? part.points.trim().split(/\s+/).map((pair) => pair.split(",").map(Number))
            : [
              [part.x, part.y],
              [part.x + part.w, part.y],
              [part.x, part.y + part.h],
              [part.x + part.w, part.y + part.h],
            ];
          for (let corner of corners) {
            if (part.rot) corner = rotate(corner, part.rot);
            if (character.pose) corner = rotate(corner, character.pose);
            minX = Math.min(minX, corner[0]);
            minY = Math.min(minY, corner[1]);
          }
        }
        legacyBadge = {
          distCss: sampleDistCss(
            rect.left + offsetX + (minX - 5) * scale,
            rect.top + offsetY + (minY - 5) * scale
          ),
        };
      }
    }
    return {
      mode,
      scale,
      badge,
      legacyBadge,
      gapMinCss: toCss(minD),
      gapMaxCss: toCss(maxD),
      centroidDxCss: toCss(out.cx - sil.cx),
      centroidDyCss: toCss(out.cy - sil.cy),
      marginsCss: {
        left: toCss(sil.minX - out.minX),
        right: toCss(out.maxX - sil.maxX),
        top: toCss(sil.minY - out.minY),
        bottom: toCss(out.maxY - sil.maxY),
      },
    };
  }, { zone, SIL: SILHOUETTE_SELECTOR });
}

/* Rendered CSS rect of the physical silhouette (union of the body shapes),
 * honouring every SVG transform, excluding spray, shadow and labels. */
export async function silhouetteRect(page, zone) {
  return page.evaluate(({ zone, SIL }) => {
    const wrap = document.querySelector(`[data-testid=field-zone-${zone}]`);
    const parts = [...wrap.querySelectorAll(SIL)];
    if (!parts.length) throw new Error(`zone ${zone} silhouette missing`);
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const part of parts) {
      const r = part.getBoundingClientRect();
      minX = Math.min(minX, r.left);
      minY = Math.min(minY, r.top);
      maxX = Math.max(maxX, r.right);
      maxY = Math.max(maxY, r.bottom);
    }
    return { x: minX, y: minY, right: maxX, bottom: maxY, width: maxX - minX, height: maxY - minY };
  }, { zone, SIL: SILHOUETTE_SELECTOR });
}

export async function rectOf(locator) {
  return locator.evaluate((node) => {
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  });
}

export function intersects(a, b, slack = 0.5) {
  return Math.min(a.right, b.right) - Math.max(a.x, b.x) > slack &&
    Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > slack;
}

export async function noHorizontalOverflow(page) {
  return page.evaluate(() => ({
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
}

/* Emulated 200% text-only zoom: snapshot every computed font size first,
 * then apply — setting parents while walking would compound through
 * em/inherit cascades instead of scaling each element to exactly twice its
 * rendered size. */
export async function doubleTextSize(page) {
  await page.evaluate(() => {
    const sizes = [...document.querySelectorAll("body *")]
      .map((element) => [element, Number.parseFloat(getComputedStyle(element).fontSize)]);
    for (const [element, size] of sizes) {
      if (size) element.style.fontSize = `${size * 2}px`;
    }
  });
}

export async function makeBusyZones(page) {
  const now = Math.floor(Date.now() / 1000);
  await page.request.post("/__test/controller", { data: { mode: "online", tasks: [
    { id: "shared-14", zones: [1, 4], runTime: 20, startTime: now - 240 },
    { id: "solo-2", zones: [2], runTime: 15, startTime: now - 60 },
    { id: "queued-6", zones: [6], runTime: 10, startTime: 0 },
  ] } });
  await page.getByRole("button", { name: "Refresh controller status" }).click();
}

/* ---------------------------------------------------------------- live paint
 * livePaintGeometry measures the ACTUAL composited page — not a detached
 * re-rasterization — by taking phase-differential screenshots: each probe
 * phase hides exactly one paint layer (badge, halo, keyline, silhouette)
 * with an injected stylesheet, and the pixel diff between consecutive
 * phases isolates that layer's painted pixel set in the live engine
 * output. Compositing is deterministic within a page, so a small diff
 * threshold classifies "visibly painted" pixels without noise. Distances
 * come from an exact euclidean distance transform over the painted
 * silhouette set, converted to CSS px via the screenshot's own pixel
 * scale, so engine- and DPR-specific paint differences are visible to the
 * assertion — unlike the construction-model instrument above. */

function decodePngNode(buffer) {
  let offset = 8;
  let width;
  let height;
  let colorType;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += length + 12;
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const encoded = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * channels);
  const previous = Buffer.alloc(stride);
  const row = Buffer.alloc(stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = encoded[cursor++];
    for (let x = 0; x < stride; x += 1) {
      const raw = encoded[cursor++];
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x];
      const upperLeft = x >= channels ? previous[x - channels] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up :
        filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft);
      row[x] = (raw + predictor) & 0xff;
    }
    row.copy(out, y * stride);
    row.copy(previous);
  }
  return { width, height, channels, data: out };
}

function diffPixels(a, b, threshold) {
  const mask = new Uint8Array(a.width * a.height);
  let count = 0;
  for (let i = 0; i < a.width * a.height; i += 1) {
    const offset = i * a.channels;
    for (let c = 0; c < 3; c += 1) {
      if (Math.abs(a.data[offset + c] - b.data[offset + c]) >= threshold) {
        mask[i] = 1;
        count += 1;
        break;
      }
    }
  }
  return { mask, count };
}

function edtNode(mask, W, H) {
  const INF = 1e12;
  const n = Math.max(W, H);
  const f = new Float64Array(n);
  const zBound = new Float64Array(n + 1);
  const v = new Int32Array(n);
  const out = new Float64Array(n);
  const d = new Float64Array(W * H);
  for (let i = 0; i < W * H; i += 1) d[i] = mask[i] ? 0 : INF;
  const dt1 = (len) => {
    let k = 0;
    v[0] = 0;
    zBound[0] = -INF;
    zBound[1] = INF;
    for (let q = 1; q < len; q += 1) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= zBound[k]) {
        k -= 1;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k += 1;
      v[k] = q;
      zBound[k] = s;
      zBound[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q += 1) {
      while (zBound[k + 1] < q) k += 1;
      out[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  };
  for (let x = 0; x < W; x += 1) {
    for (let y = 0; y < H; y += 1) f[y] = d[y * W + x];
    dt1(H);
    for (let y = 0; y < H; y += 1) d[y * W + x] = out[y];
  }
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) f[x] = d[y * W + x];
    dt1(W);
    for (let x = 0; x < W; x += 1) d[y * W + x] = out[x];
  }
  return d;
}

export async function livePaintGeometry(page, zone, { threshold = 24 } = {}) {
  const info = await page.locator(`[data-testid=field-zone-${zone}] svg.char`).evaluate((node) => {
    const r = node.getBoundingClientRect();
    return {
      x: r.x, y: r.y, width: r.width, height: r.height,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
    };
  });
  const pad = 6;
  const clip = {
    x: Math.max(0, info.x - pad),
    y: Math.max(0, info.y - pad),
  };
  clip.width = Math.min(info.viewportWidth, info.x + info.width + pad) - clip.x;
  clip.height = Math.min(info.viewportHeight, info.y + info.height + pad) - clip.y;
  const scoped = (inner) => inner.split(",")
    .map((selector) => `[data-testid=field-zone-${zone}] ${selector.trim()}`).join(",");
  const phases = [
    "",
    `${scoped(".char-anchor")}{visibility:hidden !important}`,
    `${scoped(".char-anchor,.outline-halo")}{visibility:hidden !important}`,
    `${scoped(".char-anchor,.outline-halo,.outline-keyline")}{visibility:hidden !important}`,
    `${scoped(`.char-anchor,[data-selection-outline],${SILHOUETTE_SELECTOR}`)}{visibility:hidden !important}`,
  ];
  const shots = [];
  for (const css of phases) {
    await page.evaluate((probeCss) => {
      let style = document.getElementById("live-paint-probe");
      if (!style) {
        style = document.createElement("style");
        style.id = "live-paint-probe";
        document.head.append(style);
      }
      style.textContent = probeCss;
    }, css);
    await page.waitForTimeout(40);
    shots.push(decodePngNode(await page.screenshot({ clip, animations: "disabled" })));
  }
  await page.evaluate(() => document.getElementById("live-paint-probe")?.remove());
  const [full, noBadge, noHalo, noKeyline, bare] = shots;
  const W = full.width;
  const H = full.height;
  const pxScale = W / clip.width; // device px per CSS px in this screenshot
  const badge = diffPixels(full, noBadge, threshold);
  const halo = diffPixels(noBadge, noHalo, threshold);
  const keyline = diffPixels(noHalo, noKeyline, threshold);
  const silhouette = diffPixels(noKeyline, bare, threshold);
  const measure = (set, dist) => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < W * H; i += 1) {
      if (!set.mask[i]) continue;
      const value = Math.sqrt(dist[i]);
      if (value < min) min = value;
      if (value > max) max = value;
    }
    return { minCss: min / pxScale, maxCss: max / pxScale };
  };
  const dist = silhouette.count ? edtNode(silhouette.mask, W, H) : null;
  const toBands = (set) => (set.count && dist ? measure(set, dist) : { minCss: NaN, maxCss: NaN });
  return {
    pxScale,
    counts: { badge: badge.count, halo: halo.count, keyline: keyline.count, silhouette: silhouette.count },
    keyline: toBands(keyline),
    halo: toBands(halo),
    badge: toBands(badge),
  };
}
