const ZONE_COUNT = 6;

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

function selectedZones() {
  const zones = [];
  for (let i = 1; i <= ZONE_COUNT; i++) {
    if (document.querySelector(`#zone${i}`).checked) zones.push(i);
  }
  return zones;
}

buildZoneGrid("zoneGrid");

const durationInput = document.getElementById("duration");
const presets = document.querySelectorAll(".preset");

presets.forEach((btn) => {
  btn.addEventListener("click", () => {
    durationInput.value = btn.dataset.min;
    presets.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  });
});

durationInput.addEventListener("input", () => {
  presets.forEach((b) =>
    b.classList.toggle("active", b.dataset.min === durationInput.value)
  );
});

const startBtn = document.getElementById("startBtn");

startBtn.addEventListener("click", async () => {
  const zones = selectedZones();
  if (zones.length === 0) {
    startBtn.textContent = "Select at least one zone";
    setTimeout(() => (startBtn.textContent = "Start Watering"), 1600);
    return;
  }

  const duration = durationInput.valueAsNumber || 15;

  startBtn.disabled = true;
  startBtn.textContent = "Starting…";

  try {
    const response = await fetch("/api/tasks/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zones, runTime: duration }),
    });
    if (!response.ok) throw new Error(`Task request failed (${response.status})`);
    window.location.href = "/";
  } catch {
    startBtn.disabled = false;
    startBtn.textContent = "Something went wrong — retry";
  }
});
