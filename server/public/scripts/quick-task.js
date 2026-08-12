const contract = window.QuickTaskContract;
const ZONE_COUNT = contract.visibleZoneCount;
const grid = document.getElementById("zoneGrid");
const feedback = document.getElementById("taskFeedback");
const duration = document.getElementById("duration");
const startButton = document.getElementById("startBtn");
let controllerAvailable = false;
let ambiguous = false;
let availabilityInFlight = false;
const mutationStore = window.MutationRecovery.storage("manual-start");
let pendingMutation = mutationStore.load();
let conflictLocked = false;

function selectedZones() {
  return Array.from({ length: ZONE_COUNT }, (_, index) => index + 1)
    .filter((zone) => document.getElementById(`zone${zone}`).checked);
}

function validDuration() {
  return Number.isInteger(duration.valueAsNumber) && duration.valueAsNumber >= 1 && duration.valueAsNumber <= 1440;
}

function updateStartState() {
  startButton.disabled = !selectedZones().length || !validDuration() || !controllerAvailable || ambiguous || conflictLocked;
}

function lockSemanticInputs(locked) {
  grid.querySelectorAll("input").forEach((input) => { input.disabled = locked; });
  duration.disabled = locked;
  presets.querySelectorAll("button").forEach((button) => { button.disabled = locked; });
}

function restorePayload(payload) {
  for (let zone = 1; zone <= ZONE_COUNT; zone += 1) document.getElementById(`zone${zone}`).checked = payload.zones.includes(zone);
  duration.value = String(payload.runTime);
  presets.querySelectorAll(".preset").forEach((button) => button.classList.toggle("active", button.dataset.min === duration.value));
}

function permitSameKeyRetry(seconds = 0) {
  ambiguous = false;
  lockSemanticInputs(true);
  startButton.disabled = true;
  const enable = () => { feedback.textContent = "Datastore busy · not applied. Retry only this same request."; updateStartState(); };
  if (seconds > 0) setTimeout(enable, seconds * 1000); else enable();
}

async function reconcilePending() {
  ambiguous = true;
  lockSemanticInputs(true);
  updateStartState();
  feedback.textContent = "Outcome unknown · checking the durable operation. No new request will be sent.";
  const result = await window.MutationRecovery.reconcile(pendingMutation.requestId);
  if (result.kind === "committed") {
    mutationStore.clear();
    pendingMutation = null;
    location.assign("/");
  } else if (result.kind === "rejected") {
    mutationStore.clear();
    pendingMutation = null;
    ambiguous = false;
    conflictLocked = true;
    lockSemanticInputs(false);
    feedback.textContent = "Start rejected · task unchanged. Edit before a deliberate new Start.";
    updateStartState();
  } else if (result.kind === "not_found" || result.kind === "not_applied") {
    permitSameKeyRetry();
  } else {
    feedback.textContent = "Outcome unknown · check Status. This request will not be sent again.";
  }
}

for (let zone = 1; zone <= ZONE_COUNT; zone += 1) {
  const choice = document.createElement("span");
  choice.className = "choice";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = `zone${zone}`;
  input.addEventListener("change", updateStartState);
  const label = document.createElement("label");
  label.htmlFor = input.id;
  label.textContent = String(zone);
  choice.append(input, label);
  grid.append(choice);
}

const presets = document.getElementById("presets");
for (const minutes of contract.durations) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "preset";
  button.dataset.min = String(minutes);
  button.textContent = `${minutes} min`;
  button.classList.toggle("active", minutes === contract.defaultDuration);
  button.addEventListener("click", () => {
    duration.value = String(minutes);
    presets.querySelectorAll(".preset").forEach((entry) => entry.classList.toggle("active", entry === button));
    updateStartState();
  });
  presets.append(button);
}
duration.value = String(contract.defaultDuration);
duration.addEventListener("input", () => {
  presets.querySelectorAll(".preset").forEach((button) => button.classList.toggle("active", button.dataset.min === duration.value));
  updateStartState();
});

async function refreshAvailability() {
  if (availabilityInFlight) return;
  availabilityInFlight = true;
  try {
    const response = await fetch("/api/tasks", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    await response.json();
    controllerAvailable = true;
  } catch {
    controllerAvailable = false;
  } finally {
    availabilityInFlight = false;
    updateStartState();
  }
}

startButton.addEventListener("click", async () => {
  const zones = pendingMutation?.payload.zones ?? selectedZones();
  const runTime = pendingMutation?.payload.runTime ?? duration.valueAsNumber;
  if (!zones.length || !validDuration() || startButton.disabled) {
    feedback.textContent = contract.precondition;
    updateStartState();
    return;
  }
  startButton.disabled = true;
  feedback.textContent = "Starting";
  if (!pendingMutation) {
    pendingMutation = mutationStore.save({ requestId: `manual-${crypto.randomUUID()}`, payload: { zones, runTime } });
    lockSemanticInputs(true);
  }
  const result = await window.MutationRecovery.send("/api/tasks/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: pendingMutation.requestId, ...pendingMutation.payload }),
    });
  if (result.kind === "committed") {
    mutationStore.clear();
    pendingMutation = null;
    location.assign("/");
  } else if (result.kind === "not_applied") {
    pendingMutation.retryAt = Date.now() + result.retryAfter * 1000;
    mutationStore.save(pendingMutation);
    feedback.textContent = `Datastore busy · not applied. Retry this same request in ${result.retryAfter} second${result.retryAfter === 1 ? "" : "s"}.`;
    permitSameKeyRetry(result.retryAfter);
  } else if (result.kind === "conflict") {
    mutationStore.clear();
    pendingMutation = null;
    ambiguous = false;
    conflictLocked = true;
    lockSemanticInputs(false);
    feedback.textContent = `Request conflict · ${result.data.error}. Refresh status or edit the task before starting again.`;
    updateStartState();
  } else if (result.kind === "outcome_unknown" || result.kind === "network_ambiguous") {
    ambiguous = true;
    feedback.textContent = "Outcome unknown · reconciling the durable operation. No new request will be sent.";
    updateStartState();
    await reconcilePending();
  } else {
    mutationStore.clear();
    pendingMutation = null;
    ambiguous = false;
    lockSemanticInputs(false);
    feedback.textContent = `Start failed · ${result.data.error || "request rejected"}`;
    updateStartState();
  }
});

grid.addEventListener("change", () => { if (conflictLocked) { conflictLocked = false; updateStartState(); } });
duration.addEventListener("input", () => { if (conflictLocked) { conflictLocked = false; updateStartState(); } });
if (pendingMutation) {
  restorePayload(pendingMutation.payload);
  lockSemanticInputs(true);
  if (Number.isFinite(pendingMutation.retryAt)) permitSameKeyRetry(Math.max(0, (pendingMutation.retryAt - Date.now()) / 1000));
  else void reconcilePending();
}
refreshAvailability();
setInterval(refreshAvailability, 2000);
