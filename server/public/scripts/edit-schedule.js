const ZONE_COUNT = 6;
const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

const urlParams = new URLSearchParams(window.location.search);
const scheduleId = urlParams.get("id");

function buildZoneGrid(containerId) {
  const grid = document.getElementById(containerId);
  for (let i = 1; i <= ZONE_COUNT; i++) {
    const tile = document.createElement("div");
    tile.className = "tile";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `zone${i}`;
    const label = document.createElement("label");
    label.setAttribute("for", `zone${i}`);
    label.textContent = i;
    tile.append(input, label);
    grid.appendChild(tile);
  }
}

function buildDayGrid(containerId) {
  const grid = document.getElementById(containerId);
  DAY_LABELS.forEach((label, i) => {
    const tile = document.createElement("div");
    tile.className = "tile tile--day";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `day${i}`;
    const lbl = document.createElement("label");
    lbl.setAttribute("for", `day${i}`);
    lbl.textContent = label;
    tile.append(input, lbl);
    grid.appendChild(tile);
  });
}

const tasks = {};
let enabledState = true;

function renderTasks() {
  const container = document.getElementById("taskList");
  container.innerHTML = "";

  const entries = Object.entries(tasks);
  if (entries.length === 0) {
    container.appendChild(emptyRow("No tasks yet — add one below."));
    return;
  }

  entries.forEach(([id, task], index) => {
    const row = document.createElement("div");
    row.className = "builder-task";

    const order = document.createElement("div");
    order.className = "builder-task__order";
    order.textContent = index + 1;

    const info = document.createElement("div");
    info.className = "builder-task__info";
    task.zones.forEach((z) => {
      const chip = document.createElement("span");
      chip.className = "chip grass";
      chip.textContent = `Zone ${z}`;
      info.appendChild(chip);
    });
    const dur = document.createElement("span");
    dur.className = "chip";
    dur.textContent = `${task.runTime} min`;
    info.appendChild(dur);

    const remove = document.createElement("button");
    remove.className = "btn btn--danger btn--sm";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      delete tasks[id];
      renderTasks();
    });

    row.append(order, info, remove);
    container.appendChild(row);
  });
}

function emptyRow(text) {
  const div = document.createElement("div");
  div.className = "empty";
  div.textContent = text;
  return div;
}

function setupAddTask() {
  document.getElementById("addTaskBtn").addEventListener("click", () => {
    const zones = [];
    for (let i = 1; i <= ZONE_COUNT; i++) {
      if (document.querySelector(`#zone${i}`).checked) zones.push(i);
    }
    if (zones.length === 0) return;

    const duration = document.querySelector(".task-duration").valueAsNumber || 15;
    tasks[Date.now() + Math.random()] = { zones, runTime: duration };

    for (let i = 1; i <= ZONE_COUNT; i++) {
      document.querySelector(`#zone${i}`).checked = false;
    }
    renderTasks();
  });
}

function flash(btn, message) {
  const original = btn.textContent;
  btn.textContent = message;
  setTimeout(() => (btn.textContent = original), 1600);
}

buildZoneGrid("zoneGrid");
buildDayGrid("dayGrid");
setupAddTask();
renderTasks();

/* load existing schedule */
fetch("/api/schedules")
  .then((res) => {
    if (!res.ok) throw new Error(`Schedule request failed (${res.status})`);
    return res.json();
  })
  .then((schedules) => {
    const schedule = schedules[scheduleId];
    if (!schedule) {
      flash(document.getElementById("saveBtn"), "Schedule not found");
      return;
    }

    enabledState = schedule.enabled;
    document.querySelector(".schedule-name").value = schedule.name || "";
    document.querySelector(".start-time").value = schedule.startTime || "";

    (schedule.days || []).forEach((day) => {
      const input = document.querySelector(`#day${day}`);
      if (input) input.checked = true;
    });

    (schedule.tasks || []).forEach((task) => {
      tasks[Date.now() + Math.random()] = {
        zones: task.zones,
        runTime: task.runTime,
      };
    });

    renderTasks();
  })
  .catch(() => flash(document.getElementById("saveBtn"), "Schedule unavailable"));

document.getElementById("saveBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;

  const name = document.querySelector(".schedule-name").value.trim();
  const days = [];
  for (let i = 0; i <= 6; i++) {
    if (document.querySelector(`#day${i}`).checked) days.push(i);
  }
  const startTime = document.querySelector(".start-time").value;
  const parsedTasks = Object.values(tasks).map((t) => ({
    zones: t.zones,
    runTime: t.runTime,
  }));

  if (!name) {
    flash(btn, "Add a name first");
    return;
  }
  if (parsedTasks.length === 0) {
    flash(btn, "Add at least one task");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const response = await fetch("/api/schedules/update", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: scheduleId,
        name,
        days,
        startTime,
        tasks: parsedTasks,
        enabled: enabledState,
      }),
    });
    if (!response.ok) throw new Error(`Schedule request failed (${response.status})`);
    window.location.href = "/schedules";
  } catch {
    btn.disabled = false;
    btn.textContent = "Something went wrong — retry";
  }
});
