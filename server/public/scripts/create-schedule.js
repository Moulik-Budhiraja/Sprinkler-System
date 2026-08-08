const ZONE_COUNT = 6;
const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const tasks = [];
const feedback = document.getElementById("formFeedback");

function choice(grid, id, text, className = "") {
  const tile = document.createElement("span");
  tile.className = `choice ${className}`.trim();
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = id;
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = text;
  tile.append(input, label);
  grid.append(tile);
}

for (let zone = 1; zone <= ZONE_COUNT; zone += 1) choice(document.getElementById("zoneGrid"), `zone${zone}`, String(zone));
DAY_LABELS.forEach((label, day) => choice(document.getElementById("dayGrid"), `day${day}`, label, "choice-day"));

function renderTasks() {
  const list = document.getElementById("taskList");
  list.replaceChildren();
  if (!tasks.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No tasks yet";
    list.append(empty);
    return;
  }
  tasks.forEach((task, index) => {
    const row = document.createElement("div");
    row.className = "builder-task";
    const order = document.createElement("span");
    order.className = "builder-task-order";
    order.textContent = String(index + 1);
    const info = document.createElement("span");
    info.className = "builder-task-info";
    info.textContent = `Zones ${task.zones.join(", ")} · ${task.runTime} min`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-action danger-action";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove task ${index + 1}`);
    remove.addEventListener("click", () => { tasks.splice(index, 1); renderTasks(); });
    row.append(order, info, remove);
    list.append(row);
  });
}
renderTasks();

document.getElementById("addTaskBtn").addEventListener("click", () => {
  const zones = Array.from({ length: ZONE_COUNT }, (_, index) => index + 1).filter((zone) => document.getElementById(`zone${zone}`).checked);
  const duration = document.getElementById("duration").valueAsNumber;
  if (!zones.length || !Number.isInteger(duration) || duration < 1 || duration > 1440) {
    feedback.textContent = "Select zones and enter 1–1440 minutes";
    return;
  }
  tasks.push({ zones, runTime: duration });
  zones.forEach((zone) => { document.getElementById(`zone${zone}`).checked = false; });
  feedback.textContent = "";
  renderTasks();
});

document.getElementById("saveBtn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const payload = {
    name: document.getElementById("scheduleName").value.trim(),
    days: Array.from({ length: 7 }, (_, day) => day).filter((day) => document.getElementById(`day${day}`).checked),
    startTime: document.getElementById("startTime").value,
    tasks,
  };
  if (!payload.name || !payload.days.length || !payload.startTime || !tasks.length) {
    feedback.textContent = "Complete name, time, days and sequence";
    return;
  }
  button.disabled = true;
  feedback.textContent = "Saving";
  try {
    const response = await fetch("/api/schedules/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error((await response.json()).error || "Save failed");
    window.location.assign("/schedules");
  } catch (error) {
    button.disabled = false;
    feedback.textContent = error.message;
  }
});
