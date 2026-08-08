const ZONE_COUNT = 6;
const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const scheduleId = new URLSearchParams(location.search).get("id");
const tasks = [];
const feedback = document.getElementById("formFeedback");
let enabled = true;
const deleteRequestId = `schedule-delete-${crypto.randomUUID()}`;

function choice(grid, id, text, className = "") {
  const tile = document.createElement("span");
  tile.className = `choice ${className}`.trim();
  const input = document.createElement("input"); input.type = "checkbox"; input.id = id;
  const label = document.createElement("label"); label.htmlFor = id; label.textContent = text;
  tile.append(input, label); grid.append(tile);
}
for (let zone = 1; zone <= ZONE_COUNT; zone += 1) choice(document.getElementById("zoneGrid"), `zone${zone}`, String(zone));
DAY_LABELS.forEach((label, day) => choice(document.getElementById("dayGrid"), `day${day}`, label, "choice-day"));

function renderTasks() {
  const list = document.getElementById("taskList"); list.replaceChildren();
  if (!tasks.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "No tasks yet"; list.append(empty); return; }
  tasks.forEach((task, index) => {
    const row = document.createElement("div"); row.className = "builder-task";
    const order = document.createElement("span"); order.className = "builder-task-order"; order.textContent = String(index + 1);
    const info = document.createElement("span"); info.className = "builder-task-info"; info.textContent = `Zones ${task.zones.join(", ")} · ${task.runTime} min`;
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "text-action danger-action"; remove.textContent = "Remove"; remove.setAttribute("aria-label", `Remove task ${index + 1}`);
    remove.addEventListener("click", () => { tasks.splice(index, 1); renderTasks(); });
    row.append(order, info, remove); list.append(row);
  });
}
renderTasks();

document.getElementById("addTaskBtn").addEventListener("click", () => {
  const zones = Array.from({ length: ZONE_COUNT }, (_, index) => index + 1).filter((zone) => document.getElementById(`zone${zone}`).checked);
  const duration = document.getElementById("duration").valueAsNumber;
  if (!zones.length || !Number.isInteger(duration) || duration < 1 || duration > 1440) { feedback.textContent = "Select zones and enter 1–1440 minutes"; return; }
  tasks.push({ zones, runTime: duration });
  zones.forEach((zone) => { document.getElementById(`zone${zone}`).checked = false; });
  feedback.textContent = ""; renderTasks();
});

async function load() {
  try {
    const response = await fetch("/api/schedules");
    if (!response.ok) throw new Error("Schedule unavailable");
    const schedule = (await response.json())[scheduleId];
    if (!schedule) throw new Error("Schedule not found");
    enabled = schedule.enabled;
    document.getElementById("scheduleName").value = schedule.name;
    document.getElementById("startTime").value = schedule.startTime;
    schedule.days.forEach((day) => { document.getElementById(`day${day}`).checked = true; });
    tasks.push(...schedule.tasks.map((task) => ({ zones: [...task.zones], runTime: task.runTime })));
    renderTasks();
  } catch (error) { feedback.textContent = error.message; }
}
load();

document.getElementById("saveBtn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const payload = { id: scheduleId, name: document.getElementById("scheduleName").value.trim(), days: Array.from({ length: 7 }, (_, day) => day).filter((day) => document.getElementById(`day${day}`).checked), startTime: document.getElementById("startTime").value, tasks, enabled };
  if (!payload.name || !payload.days.length || !payload.startTime || !tasks.length) { feedback.textContent = "Complete name, time, days and sequence"; return; }
  button.disabled = true; feedback.textContent = "Saving";
  try {
    const response = await fetch("/api/schedules/update", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error((await response.json()).error || "Save failed");
    location.assign("/schedules");
  } catch (error) { button.disabled = false; feedback.textContent = error.message; }
});

document.getElementById("deleteScheduleBtn").addEventListener("click", async (event) => {
  if (!window.confirm("Delete this schedule?")) return;
  const button = event.currentTarget; button.disabled = true;
  try {
    const response = await fetch("/api/schedules/delete", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: scheduleId, requestId: deleteRequestId }) });
    if (!response.ok) {
      const error = new Error((await response.json()).error || "Delete failed");
      error.status = response.status;
      throw error;
    }
    location.assign("/schedules");
  } catch (error) {
    if (error.status) {
      button.disabled = false;
      feedback.textContent = `Delete failed · ${error.message}`;
    } else {
      feedback.textContent = "Delete outcome unknown · refresh Schedules before another action";
    }
  }
});
