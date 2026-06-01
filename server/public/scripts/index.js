const ZONE_COUNT = 8;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtTime(hhmm) {
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  const ampm = h >= 12 ? "PM" : "AM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${m.toString().padStart(2, "0")} ${ampm}`;
}

function relativeFrom(unixSeconds) {
  if (unixSeconds === null || unixSeconds === undefined) return "Never";
  const min = Math.floor((Date.now() - unixSeconds * 1000) / 60000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/* ---------------------------------------------------------------- tasks + zones */

let lastTasks = [];

function renderZonemap(tasks) {
  const active = new Set();
  const queued = new Set();
  tasks.forEach((t) => {
    const running = t.startTime && t.startTime !== 0;
    t.zones.forEach((z) => (running ? active : queued).add(z));
  });

  const map = document.getElementById("zonemap");
  map.innerHTML = "";

  for (let z = 1; z <= ZONE_COUNT; z++) {
    const isActive = active.has(z);
    const isQueued = !isActive && queued.has(z);
    const zone = el("div", "zone" + (isActive ? " active" : isQueued ? " queued" : ""));
    zone.appendChild(el("div", "zone__water"));
    zone.appendChild(el("div", "zone__num", z));
    zone.appendChild(
      el("div", "zone__state", isActive ? "Watering" : isQueued ? "Queued" : "Idle")
    );
    map.appendChild(zone);
  }

  document.getElementById("zoneCount").textContent = active.size
    ? `${active.size} active`
    : "all idle";

  const zoneDot = document.getElementById("zoneDot");
  const zoneValue = document.getElementById("zoneValue");
  if (active.size) {
    zoneDot.classList.remove("idle");
    zoneValue.textContent = `Zone ${[...active].sort((a, b) => a - b).join(", ")}`;
  } else {
    zoneDot.classList.add("idle");
    zoneValue.textContent = "Nothing running";
  }
}

function renderTasks(tasks) {
  const container = document.getElementById("tasks");
  container.innerHTML = "";
  document.getElementById("taskCount").textContent = `${tasks.length} active`;

  if (tasks.length === 0) {
    container.appendChild(
      el("div", "empty", "No tasks running. The garden is resting.")
    );
    return;
  }

  tasks.forEach((task) => {
    const running = task.startTime && task.startTime !== 0;
    const card = el("div", "task-card" + (running ? "" : " queued"));

    // progress ring
    const ringWrap = el("div", "task-card__ring");
    const ring = el("div", "ring" + (running ? "" : " queued"));
    let pct = 0;
    let elapsed = 0;
    if (running) {
      elapsed = Math.floor((Date.now() / 1000 - task.startTime) / 60);
      pct = Math.max(0, Math.min(100, (elapsed / task.runTime) * 100));
      ring.style.setProperty("--val", pct);
      ring.appendChild(el("span", "ring__label", `${Math.max(0, task.runTime - elapsed)}m`));
    } else {
      ring.appendChild(el("span", "ring__label", "—"));
    }
    ringWrap.appendChild(ring);

    const body = el("div", "task-card__body");
    const zonesRow = el("div", "task-card__zones");
    task.zones.forEach((z) => zonesRow.appendChild(el("span", "chip", `Zone ${z}`)));
    body.appendChild(zonesRow);

    const meta = el("div", "task-card__meta");
    if (running) {
      meta.innerHTML = `<b>${elapsed} min</b> of ${task.runTime} min elapsed`;
    } else {
      meta.innerHTML = `Queued · <b>${task.runTime} min</b> when it runs`;
    }
    body.appendChild(meta);

    const stop = el("button", "btn btn--danger btn--sm");
    stop.innerHTML =
      '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg> Stop';
    stop.addEventListener("click", () => {
      stop.disabled = true;
      fetch("/api/tasks/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: task.id }),
      })
        .then((r) => r.json())
        .then(() => {
          refreshTasks();
          refreshHistory();
        })
        .catch(() => (stop.disabled = false));
    });

    card.append(ringWrap, body, stop);
    container.appendChild(card);
  });
}

function refreshTasks() {
  fetch("/api/tasks")
    .then((r) => r.json())
    .then((data) => {
      lastTasks = data.tasks || [];
      const sysDot = document.getElementById("sysDot");
      const sysValue = document.getElementById("sysValue");
      sysDot.classList.remove("idle");
      sysValue.textContent = "Online";
      renderZonemap(lastTasks);
      renderTasks(lastTasks);
    })
    .catch((err) => {
      console.error(err);
      const sysDot = document.getElementById("sysDot");
      const sysValue = document.getElementById("sysValue");
      sysDot.classList.add("idle");
      sysValue.textContent = "Offline";
      renderZonemap([]);
      const container = document.getElementById("tasks");
      container.innerHTML = "";
      container.appendChild(
        el("div", "empty", "Can't reach the controller right now.")
      );
    });
}

/* ---------------------------------------------------------------- schedules */

function refreshSchedules() {
  fetch("/api/schedules")
    .then((r) => r.json())
    .then((data) => {
      const container = document.getElementById("schedules");
      container.innerHTML = "";
      const ids = Object.keys(data);

      document.getElementById("schedCount").textContent = `${ids.length} total`;
      const enabledCount = ids.filter((id) => data[id].enabled).length;
      document.getElementById("schedValue").textContent = `${enabledCount} active`;

      if (ids.length === 0) {
        container.appendChild(
          el("div", "empty", "No schedules yet. Create one to automate watering.")
        );
        return;
      }

      ids.forEach((id) => {
        const s = data[id];
        const card = el("div", "sched" + (s.enabled ? "" : " disabled"));

        const top = el("div", "sched__top");
        const titleWrap = el("div");
        titleWrap.appendChild(el("div", "sched__name", s.name || "Untitled"));
        titleWrap.appendChild(el("div", "sched__time", fmtTime(s.startTime)));
        top.appendChild(titleWrap);
        top.appendChild(el("div", "sched__lastrun", `Last run · ${relativeFrom(s.lastRun)}`));
        card.appendChild(top);

        const daysRow = el("div", "days-row");
        ["S", "M", "T", "W", "T", "F", "S"].forEach((label, i) => {
          const dot = el("div", "day-dot" + (s.days.includes(i) ? " on" : ""), label);
          daysRow.appendChild(dot);
        });
        card.appendChild(daysRow);

        const tasksWrap = el("div", "sched__tasks");
        s.tasks.forEach((t) => {
          const row = el("div", "sched__task");
          const chips = el("div");
          chips.style.display = "flex";
          chips.style.gap = "5px";
          chips.style.flexWrap = "wrap";
          t.zones.forEach((z) => chips.appendChild(el("span", "chip grass", `Z${z}`)));
          row.appendChild(chips);
          row.appendChild(el("span", "dur", `${t.runTime} min`));
          tasksWrap.appendChild(row);
        });
        card.appendChild(tasksWrap);

        const foot = el("div", "sched__foot");

        const toggle = el("div", "toggle" + (s.enabled ? " on" : ""));
        toggle.appendChild(el("span", "toggle__track"));
        toggle.appendChild(el("span", "toggle__label", s.enabled ? "Enabled" : "Disabled"));
        toggle.addEventListener("click", () => {
          fetch("/api/schedules/update", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...s, id, enabled: !s.enabled }),
          })
            .then((r) => r.json())
            .then(() => refreshSchedules());
        });
        foot.appendChild(toggle);

        const edit = el("button", "btn btn--ghost btn--sm", "Edit");
        edit.addEventListener("click", () => {
          window.location.href = `/edit-schedule?id=${id}`;
        });

        const del = el("button", "btn btn--danger btn--sm", "Delete");
        del.addEventListener("click", () => {
          fetch("/api/schedules/delete", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id }),
          })
            .then((r) => r.json())
            .then(() => refreshSchedules());
        });

        foot.append(edit, del);
        card.appendChild(foot);
        container.appendChild(card);
      });
    })
    .catch((err) => console.error(err));
}

/* ---------------------------------------------------------------- history */

function refreshHistory() {
  fetch("/api/history")
    .then((r) => r.json())
    .then((data) => {
      const container = document.getElementById("history");
      container.innerHTML = "";

      if (!data.length) {
        const empty = el("div", "empty", "No history yet.");
        empty.style.border = "none";
        empty.style.background = "none";
        container.appendChild(empty);
        return;
      }

      data.forEach((event) => {
        const minSince = Math.floor((Date.now() - event.timestamp * 1000) / 60000);
        let type = event.event.toLowerCase();
        let typeLabel = event.event;
        if (minSince < 0) {
          type = "queued";
          typeLabel = "Queued";
        }

        const date = new Date(event.timestamp * 1000);
        let when;
        if (minSince < 0) {
          when = "Upcoming";
        } else if (minSince < 1) {
          when = "Just now";
        } else if (minSince < 60) {
          when = `${minSince}m ago`;
        } else if (minSince < 60 * 24) {
          when = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        } else {
          when =
            date.toLocaleDateString([], { month: "short", day: "numeric" }) +
            " · " +
            date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        }

        const item = el("div", `hevent ${type}`);
        const main = el("div", "hevent__main");
        main.appendChild(el("div", "hevent__type", `${typeLabel} · Zone ${event.zones.join(", ")}`));
        main.appendChild(el("div", "hevent__sub", event.reason));
        item.appendChild(main);
        item.appendChild(el("div", "hevent__time", when));
        container.appendChild(item);
      });
    })
    .catch((err) => console.error(err));
}

/* ---------------------------------------------------------------- boot */

function refreshAll() {
  refreshTasks();
  refreshSchedules();
  refreshHistory();
}

window.addEventListener("load", refreshAll);
setInterval(refreshAll, 10000);
