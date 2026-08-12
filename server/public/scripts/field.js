/* Living Yard — shared continuous field renderer.
 * Six original SVG sprinkler characters on one twilight lawn.
 * Status-first, glance-and-stop only: the field never starts water.
 * Exposed as window.LivingYard for the plain-script pages. */
(() => {
  const VISIBLE_ZONE_COUNT = 6;

  /* Selection outline in rendered CSS pixels: the ring hugs the exact
   * silhouette at OUTLINE_GAP_PX and is OUTLINE_RING_PX thick; the halo
   * glows just beyond it. Stroke widths are recomputed per rendered scale. */
  const OUTLINE_GAP_PX = 4;
  const OUTLINE_RING_PX = 2.2;
  const OUTLINE_HALO_PX = 3;

  /* Check badge in rendered CSS pixels: the disc centre sits BADGE_DIST_PX
   * from the nearest point of the physical silhouette along the up-left
   * diagonal, and the disc renders at a constant BADGE_RADIUS_PX. Both are
   * CSS-pixel quantities applied per rendered scale, so the badge keeps one
   * visually constant relation to the silhouette at every zone size,
   * viewport and zoom. The distance is derived from the PAINTED extent:
   * the disc's stroke overhangs the geometric radius by half its width, and
   * the painted stroke edge keeps an intentional 2 CSS px clearance from
   * the silhouette — pinning the disc onto the outline's halo corner. */
  const BADGE_RADIUS_PX = 7;
  const BADGE_STROKE_PX = 1.5; // .anchor-disc stroke width (app.css)
  // 2.4: the intent is >=2px painted; desktop DPR1 rasterisation erodes
  // the painted stroke edge by up to ~0.6px (audited 1.41 at intent 2.0),
  // so the constructed clearance carries that margin — live floor 1.6
  // then holds at every scale/DPR/engine with ~0.2px to spare.
  const BADGE_PAINT_CLEARANCE_PX = 2.4;
  const BADGE_DIST_PX = BADGE_RADIUS_PX + BADGE_STROKE_PX / 2 + BADGE_PAINT_CLEARANCE_PX;
  const BADGE_DIR = { x: -Math.SQRT1_2, y: -Math.SQRT1_2 };

  /* ------------------------------------------------------------- characters
   * One grammar — riser, collar, swivel head, nozzle — six silhouettes.
   * Canvas is 200x150 with the ground line at y=132. Every physical part is
   * structured data so the body art, the selection outline and the anchored
   * controls all derive from the same geometry in the same coordinate
   * system. Spray, shadow and labels are never part of the silhouette. */
  const rotation = (a, cx, cy) => ({ a, cx, cy });

  const CHARACTERS = {
    sprout: {
      name: "the sprout",
      numeral: { x: 100, y: 112 },
      nozzle: { x: 114, y: 72 },
      dir: 1,
      pose: rotation(-4, 100, 132),
      parts: [
        { kind: "riser", x: 95, y: 78, w: 10, h: 54, rx: 4 },
        { kind: "collar", x: 91, y: 88, w: 18, h: 7, rx: 3 },
        { kind: "head", x: 88, y: 66, w: 23, h: 12, rx: 5 },
        { kind: "nozzle", x: 108, y: 69, w: 8, h: 5, rx: 2 },
      ],
    },
    elder: {
      name: "the elder",
      numeral: { x: 103, y: 96 },
      nozzle: { x: 118, y: 73 },
      dir: 1,
      parts: [
        { kind: "skirt", points: "84,132 96,102 110,102 122,132" },
        { kind: "riser", x: 96, y: 74, w: 12, h: 34, rx: 4 },
        { kind: "head", x: 89, y: 64, w: 26, h: 12, rx: 5, rot: rotation(12, 102, 74) },
        { kind: "nozzle", x: 112, y: 67, w: 8, h: 5, rx: 2, rot: rotation(12, 102, 74) },
      ],
    },
    stout: {
      name: "the stout",
      numeral: { x: 100, y: 122 },
      nozzle: { x: 74, y: 94 },
      dir: -1,
      parts: [
        { kind: "riser", x: 86, y: 100, w: 28, h: 32, rx: 6 },
        { kind: "collar", x: 82, y: 106, w: 36, h: 8, rx: 3 },
        { kind: "head", x: 80, y: 88, w: 40, h: 14, rx: 6 },
        { kind: "nozzle", x: 72, y: 91, w: 9, h: 6, rx: 2 },
      ],
    },
    classic: {
      name: "the classic",
      numeral: { x: 100, y: 112 },
      nozzle: { x: 121, y: 70 },
      dir: 1,
      parts: [
        { kind: "riser", x: 94, y: 76, w: 12, h: 56, rx: 4 },
        { kind: "collar", x: 90, y: 86, w: 20, h: 8, rx: 3 },
        { kind: "head", x: 87, y: 64, w: 28, h: 13, rx: 5 },
        { kind: "nozzle", x: 113, y: 67, w: 9, h: 6, rx: 2 },
      ],
    },
    scout: {
      name: "the scout",
      numeral: { x: 100, y: 112 },
      nozzle: { x: 112, y: 66 },
      dir: 1,
      parts: [
        { kind: "riser", x: 95, y: 80, w: 11, h: 52, rx: 4 },
        { kind: "collar", x: 91, y: 90, w: 19, h: 7, rx: 3 },
        { kind: "head", x: 88, y: 70, w: 26, h: 12, rx: 5, rot: rotation(-16, 100, 80) },
        { kind: "nozzle", x: 111, y: 72, w: 8, h: 5, rx: 2, rot: rotation(-16, 100, 80) },
      ],
    },
    column: {
      name: "the column",
      numeral: { x: 100, y: 120 },
      nozzle: { x: 117, y: 52 },
      dir: 1,
      parts: [
        { kind: "riser", x: 94, y: 58, w: 12, h: 74, rx: 4 },
        { kind: "collar", x: 90, y: 72, w: 20, h: 7, rx: 3 },
        { kind: "collar", x: 90, y: 94, w: 20, h: 7, rx: 3 },
        { kind: "head", x: 88, y: 46, w: 24, h: 12, rx: 5 },
        { kind: "nozzle", x: 110, y: 49, w: 8, h: 5, rx: 2 },
      ],
    },
  };

  const PART_CLASS = {
    riser: "c-riser",
    collar: "c-collar",
    head: "c-head",
    nozzle: "c-nozzle",
    skirt: "c-skirt",
  };

  function sameRotation(a, b) {
    return a && b && a.a === b.a && a.cx === b.cx && a.cy === b.cy;
  }

  function shapeMarkup(part, withClasses, extra = "") {
    const cls = withClasses ? ` class="${PART_CLASS[part.kind]}"` : "";
    if (part.points) return `<polygon points="${part.points}"${cls}${extra}/>`;
    return `<rect x="${part.x}" y="${part.y}" width="${part.w}" height="${part.h}" rx="${part.rx}"${cls}${extra}/>`;
  }

  function partsMarkup(character, withClasses, extra = "") {
    const out = [];
    let index = 0;
    while (index < character.parts.length) {
      const part = character.parts[index];
      if (!part.rot) {
        out.push(shapeMarkup(part, withClasses, extra));
        index += 1;
        continue;
      }
      const group = [];
      const shared = part.rot;
      while (index < character.parts.length && sameRotation(character.parts[index].rot, shared)) {
        group.push(shapeMarkup(character.parts[index], withClasses, extra));
        index += 1;
      }
      out.push(`<g transform="rotate(${shared.a} ${shared.cx} ${shared.cy})">${group.join("")}</g>`);
    }
    const inner = out.join("\n        ");
    if (!character.pose) return inner;
    const pose = character.pose;
    const cls = withClasses ? ` class="char-pose"` : "";
    return `<g${cls} transform="rotate(${pose.a} ${pose.cx} ${pose.cy})">${inner}</g>`;
  }

  /* Exact silhouette bounding box in SVG user units, honouring both the
   * per-part and whole-pose rotations. Rounded corners stay inside the
   * rectangle corners, so corner math is exact for the box. */
  function rotatePoint([x, y], { a, cx, cy }) {
    const rad = (a * Math.PI) / 180;
    const dx = x - cx;
    const dy = y - cy;
    return [
      cx + dx * Math.cos(rad) - dy * Math.sin(rad),
      cy + dx * Math.sin(rad) + dy * Math.cos(rad),
    ];
  }

  function silhouetteBBox(character) {
    if (character._bbox) return character._bbox;
    const points = [];
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
        if (part.rot) corner = rotatePoint(corner, part.rot);
        if (character.pose) corner = rotatePoint(corner, character.pose);
        points.push(corner);
      }
    }
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    character._bbox = {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    };
    return character._bbox;
  }

  /* Exact silhouette support point in a unit direction: the boundary point
   * of the rendered silhouette farthest along (dirX, dirY), honouring both
   * rotations and the rounded rect corners (a rounded corner's support is
   * its corner-circle centre pushed radius further along the direction).
   * Unlike a bounding-box corner this is always a real silhouette point, so
   * offsetting from it by a CSS-pixel distance is scale-invariant: every
   * silhouette point lies on the far side of the supporting line, which
   * makes the offset point's nearest-silhouette distance exactly the offset.
   * Spray, shadow, grass and numerals are never part of the silhouette. */
  function silhouetteSupportPoint(character, dirX, dirY) {
    const key = `_support_${dirX.toFixed(4)}_${dirY.toFixed(4)}`;
    if (character[key]) return character[key];
    let best = null;
    let bestDot = -Infinity;
    for (const part of character.parts) {
      const candidates = [];
      if (part.points) {
        for (const pair of part.points.trim().split(/\s+/)) {
          const [x, y] = pair.split(",").map(Number);
          candidates.push({ x, y, r: 0 });
        }
      } else {
        const r = Math.min(part.rx || 0, part.w / 2, part.h / 2);
        for (const cx of [part.x + r, part.x + part.w - r]) {
          for (const cy of [part.y + r, part.y + part.h - r]) {
            candidates.push({ x: cx, y: cy, r });
          }
        }
      }
      for (const candidate of candidates) {
        let point = [candidate.x, candidate.y];
        if (part.rot) point = rotatePoint(point, part.rot);
        if (character.pose) point = rotatePoint(point, character.pose);
        const dot = point[0] * dirX + point[1] * dirY + candidate.r;
        if (dot > bestDot) {
          bestDot = dot;
          best = { x: point[0] + dirX * candidate.r, y: point[1] + dirY * candidate.r };
        }
      }
    }
    character[key] = best;
    return best;
  }

  /* Exact silhouette base attachment: the midpoint of the physical
   * silhouette's ground-touching bottom edge plus the stem axis direction
   * (unit vector pointing into the ground), honouring the whole-body pose.
   * This is where each zone's Stop/Remove connector physically emerges —
   * always a real silhouette boundary point, never the bounding box, wrap,
   * spray, shadow or label. */
  function silhouetteAttachment(character) {
    if (character._attachment) return character._attachment;
    const points = [];
    for (const part of character.parts) {
      const corners = part.points
        ? part.points.trim().split(/\s+/).map((pair) => pair.split(",").map(Number))
        : [[part.x, part.y + part.h], [part.x + part.w, part.y + part.h]];
      for (let corner of corners) {
        if (part.rot) corner = rotatePoint(corner, part.rot);
        if (character.pose) corner = rotatePoint(corner, character.pose);
        points.push(corner);
      }
    }
    const groundY = Math.max(...points.map(([, y]) => y));
    const baseXs = points.filter(([, y]) => y >= groundY - 1.5).map(([x]) => x);
    const poseRad = (((character.pose && character.pose.a) || 0) * Math.PI) / 180;
    character._attachment = {
      x: (Math.min(...baseXs) + Math.max(...baseXs)) / 2,
      y: groundY,
      dirX: -Math.sin(poseRad),
      dirY: Math.cos(poseRad),
    };
    return character._attachment;
  }

  /* Zone-to-character maps come from the approved Paper boards; desktop and
   * mobile assign numerals independently by visual row order. */
  const LAYOUTS = {
    desktop: {
      media: "(min-width: 900px)",
      // 560 = the 524-unit yard plus a 36-unit band inside the frame's
      // bottom edge, so every anchored Stop/Remove dock (bottom row lands
      // at ≈528) stays fully inside the lawn on desktop.
      frame: { w: 1140, h: 560 },
      zones: [
        { z: 1, kind: "sprout", x: 60, y: 10, w: 150, h: 112 },
        { z: 2, kind: "elder", x: 920, y: 0, w: 150, h: 112 },
        { z: 3, kind: "stout", x: 560, y: 90, w: 195, h: 146 },
        { z: 4, kind: "classic", x: 170, y: 170, w: 215, h: 161 },
        { z: 5, kind: "scout", x: 830, y: 200, w: 205, h: 154 },
        { z: 6, kind: "column", x: 430, y: 300, w: 235, h: 176 },
      ],
    },
    mobile: {
      media: "(max-width: 899px)",
      frame: { w: 390, h: 400 },
      zones: [
        { z: 1, kind: "sprout", x: 30, y: 36, w: 120, h: 90 },
        { z: 2, kind: "elder", x: 240, y: 6, w: 110, h: 82 },
        { z: 3, kind: "stout", x: 200, y: 88, w: 150, h: 112 },
        { z: 4, kind: "classic", x: 20, y: 160, w: 160, h: 120 },
        { z: 5, kind: "column", x: 90, y: 266, w: 175, h: 131 },
        { z: 6, kind: "scout", x: 215, y: 236, w: 150, h: 112 },
      ],
    },
  };

  /* Fixed tuft positions keep the lawn deterministic. */
  const TUFTS = [
    [7, 30], [18, 62], [30, 18], [44, 44], [55, 12], [63, 68], [74, 30],
    [86, 55], [93, 20], [12, 86], [38, 78], [58, 90], [80, 82], [95, 74],
    [25, 40], [70, 8],
  ];

  function characterSVG(entry, zone) {
    const c = CHARACTERS[entry.kind];
    const n = c.nozzle;
    const d = c.dir;
    const landX = n.x + 54 * d;
    const maskId = `sel-mask-${zone}`;
    /* The selection outline is the silhouette itself, dilated by a uniform
     * rendered distance: the paint layers stroke the exact silhouette copy
     * outward, and the mask cuts everything closer than the gap, leaving a
     * ring that hugs only the physical sprinkler — never spray or shadow.
     * The copies carry vector-effect="non-scaling-stroke", so the stroke
     * widths below are CSS-pixel values the engine applies in screen space:
     * the dilation is exact at every zone scale and DPR, rasterized at
     * native screen resolution in both engines, with no per-resize stroke
     * arithmetic. */
    const outlineCopy = partsMarkup(c, false, ' vector-effect="non-scaling-stroke"');
    /* The mask cutter is painted twice: compounding the antialiased edge
     * alpha steepens the cut, so WebKit's softer mask rasterisation on
     * rotated part groups no longer bleeds keyline paint into the gap —
     * both engines hold the 4 px cut to within half a pixel. */
    const maskCutter = `<g class="outline-mask" fill="#000" stroke="#000" stroke-width="${(2 * OUTLINE_GAP_PX).toFixed(1)}" stroke-linejoin="round" stroke-linecap="round">${outlineCopy}</g>`;
    return `
      <svg viewBox="0 0 200 150" aria-hidden="true" focusable="false" class="char">
        <defs>
          <mask id="${maskId}" maskUnits="userSpaceOnUse" x="-40" y="-40" width="280" height="230">
            <rect x="-40" y="-40" width="280" height="230" fill="#fff"/>
            ${maskCutter}${maskCutter}
          </mask>
        </defs>
        <rect class="hit-proxy" x="0" y="0" width="0" height="0"/>
        <ellipse cx="100" cy="135" rx="27" ry="5" class="c-shadow"/>
        <path class="c-grass" d="M66,132 q-3,-8 -7,-10 M138,132 q4,-9 8,-11" />
        <g class="selection-outline" data-selection-outline mask="url(#${maskId})">
          <g class="outline-halo" stroke-width="${(2 * (OUTLINE_GAP_PX + OUTLINE_RING_PX + OUTLINE_HALO_PX)).toFixed(1)}" stroke-linejoin="round" stroke-linecap="round">${outlineCopy}</g>
          <g class="outline-keyline" stroke-width="${(2 * (OUTLINE_GAP_PX + OUTLINE_RING_PX)).toFixed(1)}" stroke-linejoin="round" stroke-linecap="round">${outlineCopy}</g>
        </g>
        ${partsMarkup(c, true)}
        <text x="${c.numeral.x}" y="${c.numeral.y}" class="sprinkler-number">${zone}</text>
        <g class="char-spray">
          <path class="spray-arc a1" d="M${n.x},${n.y} q ${28 * d},-34 ${52 * d},-8"/>
          <path class="spray-arc a2" d="M${n.x},${n.y} q ${19 * d},-25 ${38 * d},-3"/>
          <circle class="droplet d1" cx="${n.x + 40 * d}" cy="${n.y - 27}" r="2"/>
          <circle class="droplet d2" cx="${n.x + 50 * d}" cy="${n.y - 13}" r="1.6"/>
          <circle class="droplet d3" cx="${n.x + 28 * d}" cy="${n.y - 29}" r="1.4"/>
          <ellipse class="ripple" cx="${landX}" cy="136" rx="13" ry="3.4"/>
        </g>
        <circle class="char-queued-dot" cx="${n.x}" cy="${n.y}" r="2.8"/>
        <circle class="char-starting-dot" cx="${n.x}" cy="${n.y}" r="2.4"/>
        <g class="char-anchor">
          <circle r="${BADGE_RADIUS_PX}" class="anchor-disc"/>
          <path d="M-3,0 L-1,2.6 L3.4,-2.4" class="anchor-check"/>
        </g>
      </svg>`;
  }

  /* Thematic irrigation shutoff: hose coupling into an octagonal cross-spoke
   * valve wheel with a coral stop mark. Never a rectangle or pill. */
  function valveSVG() {
    const oct = (r) => {
      const pts = [];
      for (let i = 0; i < 8; i++) {
        const a = (Math.PI / 4) * i + Math.PI / 8;
        pts.push(`${(24 + r * Math.cos(a)).toFixed(2)},${(28 + r * Math.sin(a)).toFixed(2)}`);
      }
      return pts.join(" ");
    };
    return `
      <svg viewBox="0 0 56 56" aria-hidden="true" focusable="false" class="valve">
        <polygon points="${oct(23)}" class="valve-focus-trace"/>
        <path d="M42,28 q 7,1 12,4" class="valve-hose"/>
        <rect x="42" y="24" width="7" height="9" rx="2" class="valve-coupler"/>
        <g class="valve-wheel">
          <polygon points="${oct(20)}" class="valve-rim"/>
          <polygon points="${oct(16)}" class="valve-rim-inner"/>
          <path d="M24,10 L31,12" class="valve-crown"/>
          <rect x="9" y="25.6" width="30" height="4.8" rx="2.4" class="valve-spoke"/>
          <rect x="21.6" y="13" width="4.8" height="30" rx="2.4" class="valve-spoke"/>
          <circle cx="24" cy="28" r="8.5" class="valve-hub"/>
          <rect x="20.5" y="24.5" width="7" height="7" rx="1" class="valve-stop"/>
        </g>
        <g class="valve-drips">
          <circle cx="44" cy="38" r="1.6"/>
          <circle cx="47" cy="43" r="1.3"/>
        </g>
      </svg>`;
  }

  /* Queued heads keep a truthful Remove: a hose-disconnect coupler tab. */
  function removeCouplerSVG() {
    return `
      <svg viewBox="0 0 34 16" aria-hidden="true" focusable="false" class="coupler">
        <rect x="1" y="4" width="12" height="8" rx="3" class="coupler-half"/>
        <rect x="21" y="4" width="12" height="8" rx="3" class="coupler-half"/>
        <path d="M15,5 L17.5,8 L15,11 M19,5 L16.5,8 L19,11" class="coupler-chevrons"/>
      </svg>`;
  }

  function listZones(zones) {
    const sorted = [...zones].sort((a, b) => a - b);
    if (sorted.length === 1) return `zone ${sorted[0]}`;
    return `zones ${sorted.slice(0, -1).join(", ")} and ${sorted[sorted.length - 1]}`;
  }

  function headLabel(z, kindName, s) {
    const base = `Zone ${z}, ${kindName} sprinkler`;
    if (!s || s.status === "idle") {
      // A stale controller qualifies even the idle claim: it is last-known
      // truth, presented with the same standard as busy neighbours.
      const stale = s?.stale ? ". Controller state is stale; controls unavailable." : "";
      return `${base} — idle${stale}`;
    }
    if (s.status === "offline") return `${base} — controller offline, controls unavailable`;
    if (s.status === "starting") return `${base} — starting, waiting for the controller`;
    if (s.status === "stopping") return `${base} — stopping, water draining`;
    if (s.status === "active") {
      const shared = s.task.zones.length > 1
        ? ` Stopping ends watering for ${listZones(s.task.zones)} together.`
        : "";
      const stale = s.stale ? " Controller state is stale; controls unavailable." : "";
      const control = s.stale ? "" : " Its Stop valve sits just below.";
      return `${base} — watering, about ${s.remaining} of ${s.task.runTime} minutes left.${stale}${control}${shared}`;
    }
    if (s.status === "queued") {
      const shared = s.task.zones.length > 1
        ? ` Removing cancels ${listZones(s.task.zones)} together.`
        : "";
      // Mirror the active branch: a stale controller withdraws the Remove
      // control from the dock, so the label must say so instead of
      // promising a control that is not in the DOM.
      const stale = s.stale ? " Controller state is stale; controls unavailable." : "";
      const control = s.stale ? "" : " Its Remove control sits just below.";
      return `${base} — queued to water for ${s.task.runTime} minutes.${stale}${control}${shared}`;
    }
    return base;
  }

  function renderField(container, handlers = {}) {
    const state = {
      offline: false,
      stale: false,
      zones: new Map(),
      pendingTasks: new Map(),
      selected: null,
      idleSelected: new Set(),
      idleLocked: false,
      layout: null,
    };
    const contextualSelection = typeof handlers.onIdleSelectionChange === "function";

    const mqDesktop = window.matchMedia(LAYOUTS.desktop.media);

    function activeLayout() {
      return mqDesktop.matches ? LAYOUTS.desktop : LAYOUTS.mobile;
    }

    function pct(v, total) {
      return `${((v / total) * 100).toFixed(3)}%`;
    }

    function build() {
      const layout = activeLayout();
      state.layout = layout;
      state.selected = null;
      container.innerHTML = "";
      container.classList.add("field-lawn");
      // Release every target from the previous layout before rebuilding:
      // the observer holds strong references, so discarded docks would
      // otherwise be retained across every breakpoint crossing. The
      // container and the new docks are re-observed below.
      resizeObserver?.disconnect();
      resizeObserver?.observe(container);

      const tufts = document.createElement("div");
      tufts.className = "field-tufts";
      tufts.setAttribute("aria-hidden", "true");
      tufts.innerHTML = TUFTS.map(
        ([x, y], i) => `
          <svg viewBox="0 0 20 14" class="tuft t${i % 4}" style="left:${x}%;top:${y}%">
            <path d="M4,13 q 0,-7 -3,-9 M10,13 q 0,-9 1,-11 M16,13 q 1,-7 3,-8"/>
          </svg>`
      ).join("");
      container.appendChild(tufts);

      for (const entry of layout.zones) {
        const wrap = document.createElement("div");
        wrap.className = "field-zone-wrap is-idle";
        wrap.dataset.zoneWrapper = String(entry.z);
        wrap.setAttribute("data-testid", `field-zone-${entry.z}`);
        wrap.style.left = pct(entry.x, layout.frame.w);
        wrap.style.top = pct(entry.y, layout.frame.h);
        wrap.style.width = pct(entry.w, layout.frame.w);
        wrap.style.height = pct(entry.h, layout.frame.h);

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "field-zone";
        btn.setAttribute("data-testid", "field-zone");
        btn.dataset.zone = String(entry.z);
        btn.setAttribute("aria-label", headLabel(entry.z, CHARACTERS[entry.kind].name, null));
        btn.innerHTML = characterSVG(entry, entry.z);
        btn.addEventListener("click", () => toggleSelect(entry.z));

        const waterline = document.createElement("div");
        waterline.className = "waterline";
        waterline.setAttribute("aria-hidden", "true");
        waterline.innerHTML = `<div class="waterline-fill"></div>`;

        /* Every running/queued zone owns this dock: its Stop/Remove control,
         * one continuous mechanical assembly with its own sprinkler through
         * the connector stem below. */
        const dock = document.createElement("div");
        dock.className = "zone-dock";
        dock.dataset.zoneDock = String(entry.z);
        dock.hidden = true;

        /* The connector: a painted supply stem that begins at the rendered
         * silhouette's base attachment point and terminates tucked into the
         * dock's housing (path set by syncGeometry). Presentation only. */
        const connector = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        connector.setAttribute("class", "dock-connector");
        connector.setAttribute("aria-hidden", "true");
        connector.setAttribute("focusable", "false");
        connector.innerHTML = '<path class="pipe-collar"/><path class="pipe"/><path class="pipe-core"/>';
        connector.style.display = "none";

        wrap.append(btn, waterline, connector, dock);
        container.appendChild(wrap);
        // The keep-inside-the-lawn clamp must re-run whenever the dock's own
        // content size changes (e.g. text scaling widens the Remove pill),
        // not only when the container resizes.
        resizeObserver?.observe(dock);
      }
      applyState();
      syncGeometry();
    }

    /* The housing port: the exact point on a dock's control where its
     * connector stem enters — the valve wheel's centre for Stop, the
     * disconnect coupler's centreline for Remove — in wrap-relative CSS px.
     * Deriving it from the control's own rendered parts keeps the assembly
     * truthful for both control kinds and the compact Remove form. */
    function dockPort(dock, wrapRect) {
      const control = dock.querySelector("button");
      if (!control) return null;
      const wheel = control.querySelector(".valve-wheel");
      const anchor = wheel || control.querySelector(".coupler") || control;
      const anchorRect = anchor.getBoundingClientRect();
      const controlRect = control.getBoundingClientRect();
      if (!controlRect.width || !controlRect.height) return null;
      // The entry point sits INSIDE the housing, below its opaque top face
      // (the valve's octagon rim, the Remove pill's filled body), so the
      // stem's tail is always overpainted by the housing — a visible tuck
      // with no seam at any scale or engine.
      return {
        x: anchorRect.left + anchorRect.width / 2 - wrapRect.left,
        y: controlRect.top + (wheel ? 18 : 10) - wrapRect.top,
      };
    }

    /* Position and scale everything that must track the rendered silhouette:
     * outline stroke widths (so the gap is uniform in CSS pixels at every
     * zone size), the waterline, each zone's anchored control dock, and the
     * connector stem that joins silhouette and dock into one assembly.
     * preserveAspectRatio letterboxing is accounted for explicitly. */
    function syncGeometry() {
      if (!state.layout) return;
      // First pass: rendered geometry for every zone including each
      // silhouette's viewport rect — dock placement must respect every
      // neighbour's silhouette, not only the lawn edges.
      const zoneMetrics = [];
      for (const entry of state.layout.zones) {
        const wrap = wrapFor(entry.z);
        if (!wrap) continue;
        const rect = wrap.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const scale = Math.min(rect.width / 200, rect.height / 150);
        const offsetX = (rect.width - 200 * scale) / 2;
        const offsetY = (rect.height - 150 * scale) / 2;
        const bbox = silhouetteBBox(CHARACTERS[entry.kind]);
        const silhouette = {
          left: rect.left + offsetX + bbox.minX * scale,
          right: rect.left + offsetX + bbox.maxX * scale,
          top: rect.top + offsetY + bbox.minY * scale,
          bottom: rect.top + offsetY + bbox.maxY * scale,
        };
        // The zone's INTENDED activation region: the silhouette inflated to
        // a generous >=44px tap target, unioned with a 44px box at the
        // wrap centre (the conventional tap point) so centre taps always
        // land inside the region for every variant.
        const padX = Math.max(10, (44 - (silhouette.right - silhouette.left)) / 2);
        const padY = Math.max(6, (44 - (silhouette.bottom - silhouette.top)) / 2);
        const centreX = rect.left + rect.width / 2;
        const centreY = rect.top + rect.height / 2;
        zoneMetrics.push({
          entry,
          wrap,
          rect,
          scale,
          offsetX,
          offsetY,
          bbox,
          silhouette,
          activation: {
            left: Math.min(silhouette.left - padX, centreX - 22),
            right: Math.max(silhouette.right + padX, centreX + 22),
            top: Math.min(silhouette.top - padY, centreY - 22),
            bottom: Math.max(silhouette.bottom + padY, centreY + 22),
          },
        });
      }
      const DOCK_CLEARANCE = 2; // CSS px between a dock and any neighbour ACTIVATION region
      const fieldRect = container.getBoundingClientRect();
      const bandPx = Number.parseFloat(getComputedStyle(container).marginBottom) || 0;
      const dockJobs = [];
      for (const metric of zoneMetrics) {
        const { entry, wrap, rect: wrapRect, scale, offsetX, offsetY, bbox } = metric;
        // Outline stroke widths are screen-space constants (non-scaling
        // strokes set in the markup); only the badge and dock need scale.
        const svg = wrap.querySelector("svg.char");
        /* Badge: anchor to the real silhouette boundary, offset a constant
         * CSS-pixel distance up-left, and undo the zone scale so the disc
         * renders at one constant size everywhere. */
        const support = silhouetteSupportPoint(CHARACTERS[entry.kind], BADGE_DIR.x, BADGE_DIR.y);
        const anchorX = support.x + (BADGE_DIST_PX / scale) * BADGE_DIR.x;
        const anchorY = support.y + (BADGE_DIST_PX / scale) * BADGE_DIR.y;
        const proxy = svg.querySelector(".hit-proxy");
        if (proxy) {
          const activation = metric.activation;
          proxy.setAttribute("x", ((activation.left - wrapRect.left - offsetX) / scale).toFixed(2));
          proxy.setAttribute("y", ((activation.top - wrapRect.top - offsetY) / scale).toFixed(2));
          proxy.setAttribute("width", ((activation.right - activation.left) / scale).toFixed(2));
          proxy.setAttribute("height", ((activation.bottom - activation.top) / scale).toFixed(2));
        }
        svg.querySelector(".char-anchor").setAttribute(
          "transform",
          `translate(${anchorX.toFixed(3)} ${anchorY.toFixed(3)}) scale(${(1 / scale).toFixed(4)})`
        );
        const contentBottom = offsetY + 150 * scale;
        const waterline = wrap.querySelector(".waterline");
        waterline.style.left = `${(offsetX + 100 * scale).toFixed(1)}px`;
        waterline.style.top = `${(contentBottom + 4).toFixed(1)}px`;
        const dock = wrap.querySelector(".zone-dock");
        dock.style.left = `${(offsetX + ((bbox.minX + bbox.maxX) / 2) * scale).toFixed(1)}px`;
        dock.style.top = `${(contentBottom + 8).toFixed(1)}px`;
        /* The zone's own attachment axis in wrap-relative CSS px: where the
         * connector emerges from the silhouette base, continuing the stem
         * direction. The dock's ideal position puts its housing PORT on
         * that axis, so the whole control visibly hangs off its sprinkler
         * rather than floating near a generic row coordinate. */
        const attachment = silhouetteAttachment(CHARACTERS[entry.kind]);
        metric.attach = {
          x: offsetX + attachment.x * scale,
          y: offsetY + attachment.y * scale,
          dirX: attachment.dirX,
          dirY: attachment.dirY,
        };
        if (dock.childElementCount) {
          const port = dockPort(dock, wrapRect);
          if (port) {
            const axisX = metric.attach.x +
              metric.attach.dirX * ((port.y - metric.attach.y) / metric.attach.dirY);
            const centre = Number.parseFloat(dock.style.left);
            dock.style.left = `${(axisX - (port.x - centre)).toFixed(1)}px`;
          }
          dockJobs.push({ entry, dock });
        }
      }
      /* Multi-pass dock resolution: every dock must clear the lawn edges,
       * every OTHER zone's activation region, and every OTHER dock —
       * preferring a modest horizontal shift or a lower row directly under
       * its own zone over a large sideways jump; a full Remove pill that
       * fits nowhere compacts to its 44px icon form. Docks constrain each
       * other, so a few passes let the placements settle; each run starts
       * from the ideal positions, keeping the result deterministic. */
      const solveDock = (job) => {
        const { entry, dock } = job;
        const bestPosition = (idealLeft, width, top, bottom) => {
          const minLeft = fieldRect.left + 4;
          const maxLeft = fieldRect.right - 4 - width;
          if (maxLeft < minLeft) return null;
          const blockers = [];
          for (const other of zoneMetrics) {
            if (other.entry.z === entry.z) continue;
            if (other.activation.bottom > top + 0.5 && other.activation.top < bottom - 0.5) {
              blockers.push({
                from: other.activation.left - DOCK_CLEARANCE - width,
                to: other.activation.right + DOCK_CLEARANCE,
              });
            }
          }
          for (const other of dockJobs) {
            if (other === job) continue;
            const rect = other.dock.getBoundingClientRect();
            if (rect.bottom + DOCK_CLEARANCE > top + 0.5 && rect.top - DOCK_CLEARANCE < bottom - 0.5) {
              blockers.push({ from: rect.left - DOCK_CLEARANCE - width, to: rect.right + DOCK_CLEARANCE });
            }
          }
          const fits = (left) => left >= minLeft && left <= maxLeft &&
            blockers.every((blocker) => left <= blocker.from || left >= blocker.to);
          const candidates = [Math.min(Math.max(idealLeft, minLeft), maxLeft)];
          for (const blocker of blockers) candidates.push(blocker.from, blocker.to);
          let best = null;
          for (const candidate of candidates) {
            if (!fits(candidate)) continue;
            if (best === null || Math.abs(candidate - idealLeft) < Math.abs(best - idealLeft)) best = candidate;
          }
          return best;
        };
        // Compact hysteresis: while compact, first check — without touching
        // any class, so the ResizeObserver never oscillates — whether the
        // stored full width would fit again, and only then expand.
        if (dock.dataset.dockCompact) {
          const fullWidth = Number.parseFloat(dock.dataset.dockCompact);
          const probe = dock.getBoundingClientRect();
          if (bestPosition(probe.left, fullWidth, probe.top, probe.bottom) !== null) {
            dock.classList.remove("dock-compact");
            delete dock.dataset.dockCompact;
          }
        }
        const applyBest = (maxShift) => {
          const dockRect = dock.getBoundingClientRect();
          const width = dockRect.width;
          const height = dockRect.height;
          const baseTop = dockRect.top;
          const maxTop = fieldRect.bottom + bandPx - 2 - height;
          const tops = [baseTop];
          for (const other of zoneMetrics) {
            if (other.entry.z === entry.z) continue;
            const candidate = other.activation.bottom + DOCK_CLEARANCE;
            if (candidate > baseTop && candidate <= maxTop) tops.push(candidate);
          }
          for (const other of dockJobs) {
            if (other === job) continue;
            const candidate = other.dock.getBoundingClientRect().bottom + DOCK_CLEARANCE;
            if (candidate > baseTop && candidate <= maxTop) tops.push(candidate);
          }
          tops.sort((a, b) => a - b);
          for (const top of tops) {
            const best = bestPosition(dockRect.left, width, top, top + height);
            if (best === null || Math.abs(best - dockRect.left) > maxShift) continue;
            if (Math.abs(best - dockRect.left) > 0.1) {
              dock.style.left = `${(Number.parseFloat(dock.style.left) + (best - dockRect.left)).toFixed(1)}px`;
            }
            if (Math.abs(top - baseTop) > 0.1) {
              dock.style.top = `${(Number.parseFloat(dock.style.top) + (top - baseTop)).toFixed(1)}px`;
            }
            return true;
          }
          return false;
        };
        // Association first: a modest shift beats compaction, compaction
        // beats a far sideways jump, and the jump beats leaving the lawn.
        if (!applyBest(40)) {
          if (!dock.classList.contains("dock-compact") && dock.querySelector(".remove-text")) {
            // No nearby clear span fits the full Remove pill: collapse it to
            // its 44px coupler-icon form — the aria-label keeps the name.
            dock.dataset.dockCompact = dock.getBoundingClientRect().width.toFixed(1);
            dock.classList.add("dock-compact");
          }
          if (!applyBest(40) && !applyBest(Number.POSITIVE_INFINITY)) {
            // Last resort: at least never leave the lawn.
            const dockRect = dock.getBoundingClientRect();
            let shift = 0;
            if (dockRect.right > fieldRect.right - 4) shift = fieldRect.right - 4 - dockRect.right;
            else if (dockRect.left < fieldRect.left + 4) shift = fieldRect.left + 4 - dockRect.left;
            if (shift) dock.style.left = `${(Number.parseFloat(dock.style.left) + shift).toFixed(1)}px`;
          }
        }
      };
      for (let pass = 0; pass < 3; pass += 1) {
        let anyMoved = false;
        for (const job of dockJobs) {
          const before = job.dock.getBoundingClientRect();
          solveDock(job);
          const after = job.dock.getBoundingClientRect();
          if (Math.abs(after.left - before.left) > 0.5 || Math.abs(after.top - before.top) > 0.5) anyMoved = true;
        }
        if (!anyMoved) break;
      }
      /* Assembly pass, after every dock has settled: paint each busy zone's
       * connector as one continuous stem from the silhouette's base
       * attachment point into its own housing port. When the solver had to
       * shift a dock aside, the cubic bend still visibly originates at the
       * sprinkler and terminates at the same control. The status rail seats
       * beneath its own housing — part of the assembly, never a bar floating
       * across the connection — and returns to its resting spot under the
       * head whenever the zone has no control (idle/stale/offline). */
      for (const metric of zoneMetrics) {
        const { wrap, rect: wrapRect } = metric;
        const connector = wrap.querySelector(".dock-connector");
        if (!connector || !metric.attach) continue;
        const dock = wrap.querySelector(".zone-dock");
        const control = !dock.hidden && dock.childElementCount ? dock.querySelector("button") : null;
        const port = control ? dockPort(dock, wrapRect) : null;
        if (!port) {
          connector.style.display = "none";
          continue;
        }
        const a = metric.attach;
        // Start 3px inside the silhouette base so pipe and body always
        // overlap; end at the housing port so the housing overpaints the
        // stem's tail — visible continuity at both joints at every scale.
        const startX = a.x - a.dirX * 3;
        const startY = a.y - a.dirY * 3;
        // When the dock had to shift off the attachment axis, route the stem
        // as irrigation plumbing: straight down the axis, a rounded elbow, a
        // horizontal run just above the housing, and a straight vertical
        // entry leg into the port — so the stem still visibly leaves the
        // sprinkler on its own axis AND arrives at its own port vertically.
        const axisAtEntry = a.x + a.dirX * ((port.y - a.y) / a.dirY);
        const shift = port.x - axisAtEntry;
        let path;
        if (Math.abs(shift) <= 1.5) {
          path = `M${startX.toFixed(2)} ${startY.toFixed(2)} L${port.x.toFixed(2)} ${port.y.toFixed(2)}`;
        } else {
          const sign = shift > 0 ? 1 : -1;
          const radius = Math.min(7, Math.abs(shift) / 2);
          // The elbow stays well above the housing's painted top face: the
          // final approach into the port is a straight vertical leg, so the
          // stem visibly arrives AT the port rather than grazing a corner.
          const jointY = Math.min(
            Math.max(a.y + 6 + radius, port.y - 22),
            port.y - radius - 2
          );
          const axisX = a.x + a.dirX * ((jointY - a.y) / a.dirY);
          path = `M${startX.toFixed(2)} ${startY.toFixed(2)} ` +
            `L${axisX.toFixed(2)} ${(jointY - radius).toFixed(2)} ` +
            `Q${axisX.toFixed(2)} ${jointY.toFixed(2)} ${(axisX + sign * radius).toFixed(2)} ${jointY.toFixed(2)} ` +
            `L${(port.x - sign * radius).toFixed(2)} ${jointY.toFixed(2)} ` +
            `Q${port.x.toFixed(2)} ${jointY.toFixed(2)} ${port.x.toFixed(2)} ${(jointY + radius).toFixed(2)} ` +
            `L${port.x.toFixed(2)} ${port.y.toFixed(2)}`;
        }
        const collar = `M${(a.x - a.dirX * 2.2).toFixed(2)} ${(a.y - a.dirY * 2.2).toFixed(2)} ` +
          `L${(a.x + a.dirX * 2.2).toFixed(2)} ${(a.y + a.dirY * 2.2).toFixed(2)}`;
        const minX = Math.min(startX, port.x) - 10;
        const maxX = Math.max(startX, port.x) + 10;
        const minY = Math.min(startY, port.y) - 10;
        const maxY = Math.max(startY, port.y) + 10;
        connector.style.display = "";
        connector.style.left = `${minX.toFixed(1)}px`;
        connector.style.top = `${minY.toFixed(1)}px`;
        connector.style.width = `${(maxX - minX).toFixed(1)}px`;
        connector.style.height = `${(maxY - minY).toFixed(1)}px`;
        connector.setAttribute(
          "viewBox",
          `${minX.toFixed(1)} ${minY.toFixed(1)} ${(maxX - minX).toFixed(1)} ${(maxY - minY).toFixed(1)}`
        );
        connector.querySelector(".pipe").setAttribute("d", path);
        connector.querySelector(".pipe-core").setAttribute("d", path);
        connector.querySelector(".pipe-collar").setAttribute("d", collar);
        const controlRect = control.getBoundingClientRect();
        const waterline = wrap.querySelector(".waterline");
        waterline.style.left = `${port.x.toFixed(1)}px`;
        waterline.style.top = `${(controlRect.bottom - wrapRect.top - 6).toFixed(1)}px`;
      }
    }

    let geometryFrame = 0;
    function scheduleGeometry() {
      cancelAnimationFrame(geometryFrame);
      geometryFrame = requestAnimationFrame(syncGeometry);
    }

    function wrapFor(z) {
      return container.querySelector(`[data-zone-wrapper="${z}"]`);
    }

    function clearSelection({ refocus = false } = {}) {
      if (state.selected === null) return;
      const wrap = wrapFor(state.selected);
      wrap?.classList.remove("is-selected");
      if (refocus) wrap?.querySelector(".field-zone")?.focus();
      state.selected = null;
    }

    /* Zones the controller reports as carrying a task (active/queued) or that
     * hold a local pending create are never eligible for a new Quick Task. */
    function idleEligible(z) {
      const s = state.zones.get(z);
      return !s || s.status === "idle";
    }

    function idleSelectionList() {
      return [...state.idleSelected].sort((a, b) => a - b);
    }

    function toggleSelect(z) {
      if (state.offline || state.stale) return;
      if (contextualSelection && idleEligible(z)) {
        // Idle zones feed the contextual Quick Task selection; ownership of
        // status truth and the anchored Stop/Remove docks stays below.
        if (state.idleLocked) return;
        if (state.idleSelected.has(z)) state.idleSelected.delete(z);
        else state.idleSelected.add(z);
        applyState();
        handlers.onIdleSelectionChange(idleSelectionList(), "toggle");
        return;
      }
      if (state.selected === z) {
        clearSelection();
        return;
      }
      clearSelection();
      state.selected = z;
      wrapFor(z).classList.add("is-selected");
    }

    function setIdleSelection(zones, reason = "restore") {
      state.idleSelected = new Set(
        zones.filter((z) => Number.isInteger(z) && z >= 1 && z <= VISIBLE_ZONE_COUNT)
      );
      applyState();
      handlers.onIdleSelectionChange?.(idleSelectionList(), reason);
    }

    function clearIdleSelection({ refocus = false } = {}) {
      if (!state.idleSelected.size) return;
      const first = idleSelectionList()[0];
      state.idleSelected.clear();
      applyState();
      if (refocus) wrapFor(first)?.querySelector(".field-zone")?.focus();
      handlers.onIdleSelectionChange?.([], "clear");
    }

    function setIdleLocked(locked) {
      state.idleLocked = Boolean(locked);
    }

    function makeStopButton(z, s) {
      const stopBtn = document.createElement("button");
      stopBtn.type = "button";
      stopBtn.className = "valve-btn";
      stopBtn.setAttribute("data-testid", "zone-stop");
      stopBtn.setAttribute(
        "aria-label",
        s.task.zones.length > 1
          ? `Stop watering — ${listZones(s.task.zones)}, one task, stops all of them`
          : `Stop watering — zone ${z}`
      );
      stopBtn.innerHTML = valveSVG();
      stopBtn.addEventListener("click", () => {
        const current = state.zones.get(z);
        if (stopBtn.disabled || !current?.task) return;
        stopBtn.disabled = true;
        markStopping(current.task.id, "stop");
        handlers.onStop?.(current.task);
      });
      return stopBtn;
    }

    function makeRemoveButton(z, s) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "remove-btn";
      removeBtn.setAttribute("data-testid", "zone-remove");
      removeBtn.setAttribute(
        "aria-label",
        s.task.zones.length > 1
          ? `Remove queued task — ${listZones(s.task.zones)}, removed together`
          : `Remove queued task — zone ${z}`
      );
      removeBtn.innerHTML = `${removeCouplerSVG()}<span class="remove-text">Remove</span>`;
      removeBtn.addEventListener("click", () => {
        const current = state.zones.get(z);
        if (removeBtn.disabled || !current?.task) return;
        removeBtn.disabled = true;
        markStopping(current.task.id, "remove");
        handlers.onRemove?.(current.task);
      });
      return removeBtn;
    }

    /* Keep each zone's dock truthful without rebuilding it on every poll:
     * content is replaced only when the underlying task association changes,
     * so an operator's focus survives the 2s refresh cycle. */
    function syncDock(wrap, entry, s) {
      const dock = wrap.querySelector(".zone-dock");
      const usable = !state.offline && !state.stale;
      const status = usable && (s.status === "active" || s.status === "queued") ? s.status : "none";
      const signature = status === "none"
        ? "none"
        : `${status}|${s.task.id}|${[...s.task.zones].sort((a, b) => a - b).join(",")}`;
      if (dock.dataset.signature !== signature) {
        const hadFocus = dock.contains(document.activeElement);
        dock.dataset.signature = signature;
        dock.replaceChildren();
        if (status === "active") dock.appendChild(makeStopButton(entry.z, s));
        else if (status === "queued") dock.appendChild(makeRemoveButton(entry.z, s));
        if (hadFocus) wrap.querySelector(".field-zone")?.focus();
        scheduleGeometry();
      }
      const control = dock.querySelector("button");
      const pending = Boolean(s.task && state.pendingTasks.has(String(s.task.id)));
      if (control) control.disabled = pending;
      dock.classList.toggle("is-stopping", pending);
      dock.hidden = !dock.childElementCount;
    }

    function markStopping(taskId, operationKind = "stop") {
      state.pendingTasks.set(String(taskId), operationKind === "remove" ? "remove" : "stop");
      applyState();
    }

    function clearPendingTask(taskId) {
      state.pendingTasks.delete(String(taskId));
      applyState();
    }

    function restorePendingTask(taskId, operationKind) {
      state.pendingTasks.set(String(taskId), operationKind === "remove" ? "remove" : "stop");
      applyState();
    }

    function applyState() {
      container.classList.toggle("offline", state.offline);
      // A zone that now carries a controller task can never stay in a new
      // Quick Task selection; zones "starting" from our own pending create
      // remain selected so recovery copy stays anchored to the island.
      let idlePruned = false;
      for (const z of [...state.idleSelected]) {
        const s = state.zones.get(z);
        if (s && s.status !== "idle" && s.status !== "starting") {
          state.idleSelected.delete(z);
          idlePruned = true;
        }
      }
      for (const entry of state.layout.zones) {
        const wrap = wrapFor(entry.z);
        if (!wrap) continue;
        const s = state.offline
          ? { status: "offline" }
          : state.zones.get(entry.z) || { status: "idle", stale: state.stale };
        wrap.className = wrap.className
          .replace(/\bis-(idle|active|queued|starting|stopping|offline)\b/g, "")
          .trim();
        const pendingKind = s.task ? state.pendingTasks.get(String(s.task.id)) : null;
        wrap.classList.add(`is-${pendingKind ? "stopping" : s.status}`);
        wrap.classList.toggle(
          "is-selected",
          state.idleSelected.has(entry.z) || state.selected === entry.z
        );
        const btn = wrap.querySelector(".field-zone");
        const labelState = pendingKind === "stop" ? { ...s, status: "stopping" } : s;
        btn.setAttribute("aria-label", headLabel(entry.z, CHARACTERS[entry.kind].name, labelState));
        btn.disabled = state.offline || state.stale;
        if (contextualSelection && !state.offline && !state.stale
          && (idleEligible(entry.z) || state.idleSelected.has(entry.z))) {
          btn.setAttribute("aria-pressed", String(state.idleSelected.has(entry.z)));
        } else {
          btn.removeAttribute("aria-pressed");
        }
        syncDock(wrap, entry, s);
        const waterline = wrap.querySelector(".waterline");
        if (s.status === "active" || s.status === "stopping") {
          waterline.removeAttribute("aria-hidden");
          waterline.setAttribute("role", "progressbar");
          waterline.setAttribute("aria-label", `Zone ${entry.z} watering progress`);
          waterline.setAttribute("aria-valuemin", "0");
          waterline.setAttribute("aria-valuemax", "100");
          waterline.setAttribute("aria-valuenow", String(s.pctDone));
          waterline.querySelector(".waterline-fill").style.width = `${s.pctDone}%`;
        } else {
          waterline.setAttribute("aria-hidden", "true");
          waterline.removeAttribute("role");
          waterline.removeAttribute("aria-label");
          waterline.removeAttribute("aria-valuemin");
          waterline.removeAttribute("aria-valuemax");
          waterline.removeAttribute("aria-valuenow");
          waterline.querySelector(".waterline-fill").style.width = "0%";
        }
      }
      if (state.selected !== null && (state.offline || state.stale)) {
        // The controller vanished under a status selection — retire it.
        clearSelection();
      }
      if (idlePruned) handlers.onIdleSelectionChange?.(idleSelectionList(), "reconcile");
    }

    /* update() receives truthful controller state only:
     * tasks: [{id, zones, runTime, startTime}], startTime 0 => queued.
     * startingZones: local pending-create zones. offline: fetch failed. */
    function update({ tasks = [], offline = false, stale = false, startingZones = [] } = {}) {
      state.offline = offline;
      state.stale = stale;
      state.zones = new Map();
      const nowSec = Date.now() / 1000;
      for (const task of tasks) {
        const running = task.startTime && task.startTime !== 0;
        const elapsedMin = running ? Math.max(0, (nowSec - task.startTime) / 60) : 0;
        for (const z of task.zones) {
          if (z < 1 || z > VISIBLE_ZONE_COUNT) continue; // zones 7-8 stay API-only
          state.zones.set(z, {
            status: running ? "active" : "queued",
            task,
            stale,
            remaining: Math.max(0, Math.ceil(task.runTime - elapsedMin)),
            pctDone: running
              ? Math.max(0, Math.min(100, Math.round((elapsedMin / task.runTime) * 100)))
              : 0,
          });
        }
      }
      for (const z of startingZones) {
        if (!state.zones.has(z) && z >= 1 && z <= VISIBLE_ZONE_COUNT) {
          state.zones.set(z, { status: "starting" });
        }
      }
      applyState();
    }

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.selected !== null) {
        const wrap = wrapFor(state.selected);
        clearSelection({ refocus: Boolean(wrap?.contains(document.activeElement)) });
        // This Escape belongs to the status selection; the contextual island
        // keeps its selection until a further, unconsumed Escape.
        event.preventDefault();
      }
    });

    document.addEventListener("pointerdown", (event) => {
      if (state.selected === null) return;
      if (!event.target.closest("[data-zone-wrapper]")) clearSelection();
    });

    mqDesktop.addEventListener("change", () => {
      build();
    });

    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(scheduleGeometry)
      : null;
    // build() owns the observer's target list: it disconnects and then
    // re-observes the container and the freshly built docks on every run.
    window.addEventListener("resize", scheduleGeometry);

    build();
    return {
      update,
      clearSelection,
      clearPendingTask,
      restorePendingTask,
      setIdleSelection,
      clearIdleSelection,
      setIdleLocked,
      get idleSelection() { return idleSelectionList(); },
      get layoutName() { return mqDesktop.matches ? "desktop" : "mobile"; },
    };
  }

  window.LivingYard = {
    VISIBLE_ZONE_COUNT,
    CHARACTERS,
    LAYOUTS,
    renderField,
    valveSVG,
    removeCouplerSVG,
    listZones,
  };
})();
