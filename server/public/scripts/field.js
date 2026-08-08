/* Living Yard — shared continuous field renderer.
 * Six original SVG sprinkler characters on one twilight lawn.
 * Status-first, glance-and-stop only: the field never starts water.
 * Exposed as window.LivingYard for the plain-script pages. */
(() => {
  const VISIBLE_ZONE_COUNT = 6;

  /* ------------------------------------------------------------- characters
   * One grammar — riser, collar, swivel head, nozzle — six silhouettes.
   * Canvas is 200x150 with the ground line at y=132. Each entry provides its
   * body markup, an organic contour path (never a rectangle), the nozzle
   * point where spray leaves, the spray direction and an anchor-check spot.
   */
  const CHARACTERS = {
    sprout: {
      name: "the sprout",
      numeral: { x: 100, y: 112 },
      nozzle: { x: 114, y: 72 },
      dir: 1,
      anchor: { x: 76, y: 58 },
      body: `
        <g class="char-pose" transform="rotate(-4 100 132)">
          <rect x="95" y="78" width="10" height="54" rx="4" class="c-riser"/>
          <rect x="91" y="88" width="18" height="7" rx="3" class="c-collar"/>
          <rect x="88" y="66" width="23" height="12" rx="5" class="c-head"/>
          <rect x="108" y="69" width="8" height="5" rx="2" class="c-nozzle"/>
        </g>`,
      contour:
        "M72,139 Q66,130 78,126 Q82,110 84,92 Q80,84 88,80 Q84,62 92,60 L112,60 Q122,62 120,72 Q114,78 112,86 Q110,112 116,124 Q130,128 126,139 Q100,146 72,139 Z",
    },
    elder: {
      name: "the elder",
      numeral: { x: 103, y: 96 },
      nozzle: { x: 118, y: 73 },
      dir: 1,
      anchor: { x: 78, y: 58 },
      body: `
        <polygon points="84,132 96,102 110,102 122,132" class="c-skirt"/>
        <rect x="96" y="74" width="12" height="34" rx="4" class="c-riser"/>
        <g transform="rotate(12 102 74)">
          <rect x="89" y="64" width="26" height="12" rx="5" class="c-head"/>
          <rect x="112" y="67" width="8" height="5" rx="2" class="c-nozzle"/>
        </g>`,
      contour:
        "M76,140 Q72,130 82,127 Q88,112 92,100 Q88,92 94,86 Q88,66 96,62 L114,64 Q126,68 122,80 Q116,86 114,96 Q120,112 128,126 Q138,130 132,140 Q102,148 76,140 Z",
    },
    stout: {
      name: "the stout",
      numeral: { x: 100, y: 122 },
      nozzle: { x: 74, y: 94 },
      dir: -1,
      anchor: { x: 128, y: 82 },
      body: `
        <rect x="86" y="100" width="28" height="32" rx="6" class="c-riser"/>
        <rect x="82" y="106" width="36" height="8" rx="3" class="c-collar"/>
        <rect x="80" y="88" width="40" height="14" rx="6" class="c-head"/>
        <rect x="72" y="91" width="9" height="6" rx="2" class="c-nozzle"/>`,
      contour:
        "M68,140 Q62,130 74,126 Q74,112 70,100 Q66,88 78,84 L120,82 Q132,84 128,96 Q122,102 122,112 Q124,124 130,128 Q140,132 134,140 Q100,148 68,140 Z",
    },
    classic: {
      name: "the classic",
      numeral: { x: 100, y: 112 },
      nozzle: { x: 121, y: 70 },
      dir: 1,
      anchor: { x: 76, y: 56 },
      body: `
        <rect x="94" y="76" width="12" height="56" rx="4" class="c-riser"/>
        <rect x="90" y="86" width="20" height="8" rx="3" class="c-collar"/>
        <rect x="87" y="64" width="28" height="13" rx="5" class="c-head"/>
        <rect x="113" y="67" width="9" height="6" rx="2" class="c-nozzle"/>`,
      contour:
        "M70,139 Q64,129 78,125 Q82,108 84,94 Q78,88 86,82 Q82,62 90,60 L114,60 Q126,62 124,74 Q116,80 114,90 Q112,112 118,124 Q132,128 128,139 Q98,147 70,139 Z",
    },
    scout: {
      name: "the scout",
      numeral: { x: 100, y: 112 },
      nozzle: { x: 112, y: 66 },
      dir: 1,
      anchor: { x: 76, y: 56 },
      body: `
        <rect x="95" y="80" width="11" height="52" rx="4" class="c-riser"/>
        <rect x="91" y="90" width="19" height="7" rx="3" class="c-collar"/>
        <g transform="rotate(-16 100 80)">
          <rect x="88" y="70" width="26" height="12" rx="5" class="c-head"/>
          <rect x="111" y="72" width="8" height="5" rx="2" class="c-nozzle"/>
        </g>`,
      contour:
        "M72,139 Q66,130 78,126 Q82,110 86,96 Q80,90 88,84 Q84,66 94,60 L112,56 Q124,58 120,70 Q114,76 112,88 Q110,112 116,124 Q130,128 126,139 Q98,147 72,139 Z",
    },
    column: {
      name: "the column",
      numeral: { x: 100, y: 120 },
      nozzle: { x: 117, y: 52 },
      dir: 1,
      anchor: { x: 76, y: 42 },
      body: `
        <rect x="94" y="58" width="12" height="74" rx="4" class="c-riser"/>
        <rect x="90" y="72" width="20" height="7" rx="3" class="c-collar"/>
        <rect x="90" y="94" width="20" height="7" rx="3" class="c-collar"/>
        <rect x="88" y="46" width="24" height="12" rx="5" class="c-head"/>
        <rect x="110" y="49" width="8" height="5" rx="2" class="c-nozzle"/>`,
      contour:
        "M72,139 Q66,130 78,126 Q82,104 84,78 Q78,70 86,64 Q82,46 90,42 L112,42 Q124,44 122,56 Q116,62 114,72 Q112,108 118,124 Q132,128 128,139 Q98,147 72,139 Z",
    },
  };

  /* Zone-to-character maps come from the approved Paper boards; desktop and
   * mobile assign numerals independently by visual row order. */
  const LAYOUTS = {
    desktop: {
      media: "(min-width: 900px)",
      frame: { w: 1140, h: 524 },
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
    return `
      <svg viewBox="0 0 200 150" aria-hidden="true" focusable="false" class="char">
        <ellipse cx="100" cy="135" rx="27" ry="5" class="c-shadow"/>
        <path class="c-grass" d="M66,132 q-3,-8 -7,-10 M138,132 q4,-9 8,-11" />
        <path class="char-contour contour-halo" d="${c.contour}"/>
        <path class="char-contour contour-keyline" d="${c.contour}"/>
        <path class="char-contour contour-focus" d="${c.contour}"/>
        ${c.body}
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
        <g class="char-anchor" transform="translate(${c.anchor.x} ${c.anchor.y})">
          <circle r="7" class="anchor-disc"/>
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
    if (!s || s.status === "idle") return `${base} — idle`;
    if (s.status === "offline") return `${base} — controller offline, controls unavailable`;
    if (s.status === "starting") return `${base} — starting, waiting for the controller`;
    if (s.status === "stopping") return `${base} — stopping, water draining`;
    if (s.status === "active") {
      const shared = s.task.zones.length > 1
        ? ` Stopping ends watering for ${listZones(s.task.zones)} together.`
        : "";
      const stale = s.stale ? " Controller state is stale; controls unavailable." : "";
      return `${base} — watering, about ${s.remaining} of ${s.task.runTime} minutes left.${stale} Opens the Stop watering task valve.${shared}`;
    }
    if (s.status === "queued") {
      const shared = s.task.zones.length > 1
        ? ` Removing cancels ${listZones(s.task.zones)} together.`
        : "";
      return `${base} — queued to water for ${s.task.runTime} minutes. Opens the Remove queued task control.${shared}`;
    }
    return base;
  }

  function renderField(container, handlers = {}) {
    const state = {
      offline: false,
      stale: false,
      zones: new Map(),
      selected: null,
      layout: null,
    };

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
        btn.setAttribute("aria-expanded", "false");
        btn.setAttribute("aria-label", headLabel(entry.z, CHARACTERS[entry.kind].name, null));
        btn.innerHTML = characterSVG(entry, entry.z);
        btn.addEventListener("click", () => toggleSelect(entry.z));

        const waterline = document.createElement("div");
        waterline.className = "waterline";
        waterline.setAttribute("aria-hidden", "true");
        waterline.innerHTML = `<div class="waterline-fill"></div>`;

        wrap.append(btn, waterline);
        container.appendChild(wrap);
      }
      applyState();
    }

    function wrapFor(z) {
      return container.querySelector(`[data-zone-wrapper="${z}"]`);
    }

    function entryFor(z) {
      return state.layout.zones.find((e) => e.z === z);
    }

    function closePopover({ refocus = false } = {}) {
      const pop = container.querySelector("[data-testid=zone-action-popover]");
      if (!pop) return;
      const z = state.selected;
      pop.remove();
      if (z !== null) {
        const btn = wrapFor(z)?.querySelector(".field-zone");
        btn?.setAttribute("aria-expanded", "false");
        if (refocus) btn?.focus();
      }
    }

    function clearSelection(opts = {}) {
      closePopover(opts);
      if (state.selected !== null) {
        wrapFor(state.selected)?.classList.remove("is-selected");
        state.selected = null;
      }
    }

    function toggleSelect(z) {
      if (state.offline || state.stale) return;
      if (state.selected === z) {
        clearSelection();
        return;
      }
      clearSelection();
      state.selected = z;
      const wrap = wrapFor(z);
      wrap.classList.add("is-selected");
      openPopover(z);
    }

    function openPopover(z) {
      const s = state.zones.get(z);
      if (state.stale || !s || (s.status !== "active" && s.status !== "queued" && s.status !== "stopping")) {
        return; // idle/starting selection shows the contour only — nothing fires
      }
      const wrap = wrapFor(z);
      const entry = entryFor(z);
      const pop = document.createElement("div");
      pop.className = "zone-popover";
      pop.setAttribute("data-testid", "zone-action-popover");
      pop.setAttribute("role", "group");
      pop.setAttribute("aria-label", `Zone ${z} actions`);
      const onLeftEdge = entry.x / state.layout.frame.w < 0.16;
      pop.classList.add(onLeftEdge ? "popover-right" : "popover-left");

      if (s.status === "active" || s.status === "stopping") {
        const stopBtn = document.createElement("button");
        stopBtn.type = "button";
        stopBtn.className = "valve-btn";
        stopBtn.setAttribute(
          "aria-label",
          s.task.zones.length > 1
            ? `Stop watering — ${listZones(s.task.zones)}, one task, stops all of them`
            : `Stop watering — zone ${z}`
        );
        stopBtn.innerHTML = valveSVG();
        if (s.status === "stopping") stopBtn.disabled = true;
        stopBtn.addEventListener("click", () => {
          if (stopBtn.disabled) return;
          stopBtn.disabled = true;
          markStopping(s.task.id);
          handlers.onStop?.(s.task);
        });
        pop.appendChild(stopBtn);
      } else if (s.status === "queued") {
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "remove-btn";
        removeBtn.setAttribute(
          "aria-label",
          s.task.zones.length > 1
            ? `Remove queued task — ${listZones(s.task.zones)}, removed together`
            : `Remove queued task — zone ${z}`
        );
        removeBtn.innerHTML = `${removeCouplerSVG()}<span class="remove-text">Remove</span>`;
        removeBtn.addEventListener("click", () => {
          removeBtn.disabled = true;
          markStopping(s.task.id);
          handlers.onRemove?.(s.task);
        });
        pop.appendChild(removeBtn);
      }

      wrap.appendChild(pop);
      wrap.querySelector(".field-zone").setAttribute("aria-expanded", "true");
    }

    function markStopping(taskId) {
      for (const [z, s] of state.zones) {
        if (s.task && s.task.id === taskId) {
          state.zones.set(z, { ...s, status: "stopping" });
        }
      }
      applyState();
    }

    function applyState() {
      container.classList.toggle("offline", state.offline);
      for (const entry of state.layout.zones) {
        const wrap = wrapFor(entry.z);
        if (!wrap) continue;
        const s = state.offline
          ? { status: "offline" }
          : state.zones.get(entry.z) || { status: "idle" };
        wrap.className = wrap.className
          .replace(/\bis-(idle|active|queued|starting|stopping|offline)\b/g, "")
          .trim();
        wrap.classList.add(`is-${s.status}`);
        const btn = wrap.querySelector(".field-zone");
        btn.setAttribute("aria-label", headLabel(entry.z, CHARACTERS[entry.kind].name, s));
        btn.disabled = state.offline || state.stale;
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
      if (state.selected !== null) {
        const s = state.offline ? null : state.zones.get(state.selected);
        const pop = container.querySelector("[data-testid=zone-action-popover]");
        if (!s || s.status === "idle" || s.status === "starting" || state.offline || state.stale) {
          // Poll confirmed the task is gone (or we went offline) — retire controls.
          if (pop) closePopover();
          if (state.offline || state.stale) clearSelection();
        } else if (pop) {
          const valve = pop.querySelector(".valve-btn");
          if (valve) valve.disabled = s.status === "stopping";
          pop.classList.toggle("is-stopping", s.status === "stopping");
        }
      }
    }

    /* update() receives truthful controller state only:
     * tasks: [{id, zones, runTime, startTime}], startTime 0 => queued.
     * startingZones: local pending-create zones. offline: fetch failed. */
    function update({ tasks = [], offline = false, stale = false, startingZones = [] } = {}) {
      const previous = state.zones;
      state.offline = offline;
      state.stale = stale;
      state.zones = new Map();
      const nowSec = Date.now() / 1000;
      for (const task of tasks) {
        const running = task.startTime && task.startTime !== 0;
        const elapsedMin = running ? Math.max(0, (nowSec - task.startTime) / 60) : 0;
        for (const z of task.zones) {
          if (z < 1 || z > VISIBLE_ZONE_COUNT) continue; // zones 7-8 stay API-only
          const wasStopping = previous.get(z)?.status === "stopping" && previous.get(z)?.task.id === task.id;
          state.zones.set(z, {
            status: wasStopping ? "stopping" : running ? "active" : "queued",
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
        const withinPopover = container
          .querySelector("[data-testid=zone-action-popover]")
          ?.contains(document.activeElement);
        clearSelection({ refocus: Boolean(withinPopover) });
      }
    });

    document.addEventListener("pointerdown", (event) => {
      if (state.selected === null) return;
      if (!event.target.closest("[data-zone-wrapper]")) clearSelection();
    });

    mqDesktop.addEventListener("change", () => {
      build();
    });

    build();
    return { update, clearSelection, get layoutName() { return mqDesktop.matches ? "desktop" : "mobile"; } };
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
