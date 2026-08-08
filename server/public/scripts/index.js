const VISIBLE_ZONE_COUNT = 6;
const selectedZones = new Set();
let selectedDuration = 10;
let currentTasks = [];
let startingZones = [];
let field;

const $ = (selector) => document.querySelector(selector);
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

async function request(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function formatTime(value) {
  if (!/^\d{2}:\d{2}$/.test(value || "")) return "Time unavailable";
  const [hour, minute] = value.split(":").map(Number);
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
    .format(new Date(2000, 0, 1, hour, minute));
}

function relativeTime(timestamp) {
  if (!Number.isFinite(timestamp)) return "Not yet run";
  const minutes = Math.floor((Date.now() - timestamp * 1000) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(timestamp * 1000));
}

function setControllerStatus(online) {
  const status = $("#mobileControllerStatus");
  const wrap = status?.closest(".controller-status");
  if (status) status.textContent = online ? "Controller online" : "Controller offline";
  wrap?.classList.toggle("offline", !online);
}

async function stopTask(task) {
  try {
    await request("/api/tasks/delete", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: task.id }),
    });
    await Promise.all([refreshTasks(), refreshHistory()]);
  } catch {
    field.update({ tasks: currentTasks, offline: false });
  }
}

async function refreshTasks() {
  try {
    const data = await request("/api/tasks");
    currentTasks = Array.isArray(data.tasks) ? data.tasks : [];
    startingZones = [];
    setControllerStatus(true);
    field.update({ tasks: currentTasks, startingZones });
  } catch {
    currentTasks = [];
    setControllerStatus(false);
    field.update({ tasks: [], offline: true });
  }
}

function setupQuickTask() {
  const zones = $("#quickZones");
  const durations = $("#quickDurations");
  if (!zones || !durations || !$("#quickTaskForm")) return;
  for (let zone = 1; zone <= VISIBLE_ZONE_COUNT; zone += 1) {
    const button = node("button", "qt-zone", String(zone));
    button.type = "button";
    button.setAttribute("aria-label", `Zone ${zone}`);
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      selectedZones.has(zone) ? selectedZones.delete(zone) : selectedZones.add(zone);
      button.setAttribute("aria-pressed", String(selectedZones.has(zone)));
    });
    zones.append(button);
  }
  for (const minutes of [5, 10, 15, 20]) {
    const button = node("button", "qt-duration", `${minutes}m`);
    button.type = "button";
    button.setAttribute("aria-label", `${minutes} minutes`);
    button.setAttribute("aria-pressed", String(minutes === selectedDuration));
    button.addEventListener("click", () => {
      selectedDuration = minutes;
      durations.querySelectorAll("button").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    });
    durations.append(button);
  }
  $("#quickTaskForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = $("#quickMessage");
    if (!selectedZones.size) { message.textContent = "Select at least one zone"; return; }
    const submit = event.currentTarget.querySelector("[type=submit]");
    submit.disabled = true;
    message.textContent = "Starting";
    startingZones = [...selectedZones];
    field.update({ tasks: currentTasks, startingZones });
    try {
      await request("/api/tasks/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zones: [...selectedZones], runTime: selectedDuration }),
      });
      selectedZones.clear();
      zones.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", "false"));
      message.textContent = "Task added";
      await refreshTasks();
    } catch {
      startingZones = [];
      field.update({ tasks: currentTasks });
      message.textContent = "Could not start task. Try again";
    } finally { submit.disabled = false; }
  });
}

function renderSchedules(data) {
  const container = $("#schedules");
  container.replaceChildren();
  const entries = Object.entries(data).slice(0, 3);
  if (!entries.length) return container.append(node("p", "empty", "No schedules"));
  for (const [id, schedule] of entries) {
    const link = node("a", "schedule-row");
    link.href = `/edit-schedule?id=${encodeURIComponent(id)}`;
    link.setAttribute("aria-label", `Edit ${schedule.name || "untitled schedule"}`);
    const details = node("span", "schedule-main");
    details.append(node("strong", "", schedule.name || "Untitled schedule"), node("small", "", schedule.enabled ? "Enabled" : "Paused"));
    const time = node("time", "mono", formatTime(schedule.startTime));
    link.append(details, time);
    container.append(link);
  }
}

async function refreshSchedules() {
  if (!$("#schedules")) return;
  try { renderSchedules(await request("/api/schedules")); }
  catch { $("#schedules").replaceChildren(node("p", "empty", "Schedules unavailable")); }
}

function renderHistory(events) {
  const container = $("#history");
  container.replaceChildren();
  if (!events.length) return container.append(node("p", "empty", "No history"));
  for (const event of events.slice(0, 4)) {
    const row = node("div", "history-row");
    const details = node("span", "history-main");
    const zones = (event.zones || []).join(", ");
    details.append(node("strong", "", `${event.event || "Event"} · ${event.zones?.length === 1 ? "Zone" : "Zones"} ${zones}`), node("small", "", event.reason || "Controller"));
    row.append(details, node("time", "mono", relativeTime(event.timestamp)));
    container.append(row);
  }
}

async function refreshHistory() {
  if (!$("#history")) return;
  try { renderHistory(await request("/api/history?limit=4")); }
  catch { $("#history").replaceChildren(node("p", "empty", "History unavailable")); }
}

document.addEventListener("DOMContentLoaded", () => {
  const fieldElement = $("#sprinklerField");
  if (fieldElement && window.LivingYard) {
    field = window.LivingYard.renderField(fieldElement, { onStop: stopTask, onRemove: stopTask });
  }
  setupQuickTask();
  if (field) refreshTasks();
  refreshSchedules();
  refreshHistory();
});
