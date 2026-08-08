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

let pendingSubmission = null;
const PENDING_STORAGE_KEY = "sprinkler.pendingScheduleCreate.v1";
const saveButton = document.getElementById("saveBtn");

function clearPendingSubmission() {
  pendingSubmission = null;
  sessionStorage.removeItem(PENDING_STORAGE_KEY);
}

function rememberPendingSubmission(submission) {
  pendingSubmission = submission;
  sessionStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(submission));
}

function setFormLocked(locked) {
  for (const control of document.querySelectorAll(".editor-form input, .editor-form button:not(#saveBtn)")) control.disabled = locked;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reconcileScheduleCreate(submission) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(`/api/operations/${encodeURIComponent(submission.requestId)}`, { cache: "no-store" });
      if (response.ok) {
        const operation = await response.json();
        if (operation.type === "schedule-create" && operation.state === "completed" && operation.scheduleId) {
          clearPendingSubmission();
          feedback.textContent = "Saved";
          window.location.assign("/schedules");
          return;
        }
      } else if (response.status !== 404) {
        await response.json().catch(() => ({}));
      }
    } catch {}
    if (attempt < 3) await delay(250);
  }
  feedback.textContent = "Outcome unknown · no committed result confirmed. Retry save uses the same request.";
  saveButton.textContent = "Retry save";
  saveButton.disabled = false;
}

async function submitSchedule(submission) {
  saveButton.disabled = true;
  saveButton.textContent = "Save schedule";
  feedback.textContent = "Saving";
  try {
    const response = await fetch("/api/schedules/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submission),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = new Error(body.error || "Save failed");
      error.definitive = true;
      throw error;
    }
    clearPendingSubmission();
    feedback.textContent = "Saved";
    window.location.assign("/schedules");
  } catch (error) {
    if (error.definitive) {
      clearPendingSubmission();
      setFormLocked(false);
      saveButton.disabled = false;
      feedback.textContent = error.message;
      return;
    }
    setFormLocked(true);
    feedback.textContent = "Outcome unknown · checking the durable save result before another action.";
    await reconcileScheduleCreate(submission);
  }
}

saveButton.addEventListener("click", async () => {
  if (pendingSubmission) {
    await submitSchedule(pendingSubmission);
    return;
  }
  const semanticPayload = {
    name: document.getElementById("scheduleName").value.trim(),
    days: Array.from({ length: 7 }, (_, day) => day).filter((day) => document.getElementById(`day${day}`).checked),
    startTime: document.getElementById("startTime").value,
    tasks: structuredClone(tasks),
  };
  if (!semanticPayload.name || !semanticPayload.days.length || !semanticPayload.startTime || !semanticPayload.tasks.length) {
    feedback.textContent = "Complete name, time, days and sequence";
    return;
  }
  rememberPendingSubmission({ requestId: crypto.randomUUID(), ...semanticPayload });
  await submitSchedule(pendingSubmission);
});

function restorePendingSubmission() {
  let restored;
  try {
    restored = JSON.parse(sessionStorage.getItem(PENDING_STORAGE_KEY));
  } catch {
    sessionStorage.removeItem(PENDING_STORAGE_KEY);
    return;
  }
  if (!restored || typeof restored.requestId !== "string" || typeof restored.name !== "string" ||
      !Array.isArray(restored.days) || typeof restored.startTime !== "string" || !Array.isArray(restored.tasks)) {
    sessionStorage.removeItem(PENDING_STORAGE_KEY);
    return;
  }
  pendingSubmission = restored;
  document.getElementById("scheduleName").value = restored.name;
  document.getElementById("startTime").value = restored.startTime;
  for (let day = 0; day < 7; day += 1) document.getElementById(`day${day}`).checked = restored.days.includes(day);
  tasks.splice(0, tasks.length, ...structuredClone(restored.tasks));
  renderTasks();
  setFormLocked(true);
  feedback.textContent = "Outcome unknown · checking the durable save result before another action.";
  void reconcileScheduleCreate(restored);
}

restorePendingSubmission();
