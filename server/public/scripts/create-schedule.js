const tasks = {};

/* <div class="tasks list-group">
<div class="task list-group-item">
  <p>Zone(s): 1, 2, 5 | 4 min</p>
  <button class="btn btn-sm btn-danger">Remove</button>
</div>
</div> */

const renderTasks = () => {
  const tasksContainer = document.querySelector(".tasks");
  tasksContainer.innerHTML = "";

  if (Object.keys(tasks).length === 0) {
    const noTasks = document.createElement("p");
    noTasks.textContent = "No tasks added yet.";
    noTasks.classList.add("text-muted");
    noTasks.style.marginLeft = "1rem";
    tasksContainer.appendChild(noTasks);
  }

  for (const [id, task] of Object.entries(tasks)) {
    const taskElement = document.createElement("div");
    taskElement.classList.add("task", "list-group-item");

    const zones = task.zones.join(", ");
    const zoneP = document.createElement("p");
    zoneP.textContent = `Zone(s): ${zones} | ${task.runTime} min`;

    const removeBtn = document.createElement("button");
    removeBtn.classList.add("btn", "btn-sm", "btn-danger");
    removeBtn.textContent = "Remove";

    removeBtn.addEventListener("click", () => {
      delete tasks[id];
      renderTasks();
    });

    taskElement.appendChild(zoneP);

    taskElement.appendChild(removeBtn);

    tasksContainer.appendChild(taskElement);

    console.log(id, task);
  }
};

document.querySelector(".add-task-btn").addEventListener("click", () => {
  let duration = document.querySelector(".task-duration").valueAsNumber;

  if (!duration) {
    duration = 15;
  }

  const zones = [];

  for (let i = 1; i <= 8; i++) {
    const zone = document.querySelector(`#zone${i}`).checked;

    if (zone) {
      zones.push(i);
    }
  }

  const task = {
    zones: zones,
    runTime: duration,
  };

  tasks[Math.random()] = task;

  console.log(tasks);

  renderTasks();
});

document.querySelector(".save-btn").addEventListener("click", async () => {
  const name = document.querySelector(".schedule-name").value;
  const days = [];

  for (let i = 0; i <= 6; i++) {
    const day = document.querySelector(`#day${i}`).checked;

    if (day) {
      days.push(i);
    }
  }

  const startTime = document.querySelector(".start-time").value;

  const parsedTasks = [];

  for (const [id, task] of Object.entries(tasks)) {
    parsedTasks.push({
      zones: task.zones,
      runTime: task.runTime,
    });
  }

  const response = await fetch("/api/schedules/create", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      days,
      startTime,
      tasks: parsedTasks,
    }),
  });

  const data = await response.json();

  console.log(data);

  window.location.href = "/";
});

renderTasks();
