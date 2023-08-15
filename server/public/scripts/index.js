function refreshTasks() {
  fetch("/api/tasks")
    .then((response) => response.json())
    .then((data) => {
      console.log(data);
      const tasksContainer = document.querySelector(".current-tasks");
      tasksContainer.innerHTML = ""; // Clear existing tasks

      if (data.tasks.length === 0) {
        const noTasks = document.createElement("p");
        noTasks.className = "text-muted";
        noTasks.textContent = "No tasks running";
        noTasks.style.marginLeft = "1rem";
        tasksContainer.appendChild(noTasks);
      }

      data.tasks.forEach((task) => {
        const taskDiv = document.createElement("div");
        taskDiv.className = "task list-group-item";

        const zones = document.createElement("h6");
        zones.className = "zones";
        zones.textContent = `Zone(s): ${task.zones.join(", ")}`;

        const duration = document.createElement("p");
        duration.className = "duration text-muted";
        duration.textContent = `${task.runTime} min`;

        const timestamp = document.createElement("p");
        timestamp.className = "timestamp text-muted";

        // Parse startTime from unix seconds to human readable
        const date = new Date(task.startTime * 1000);
        const minSinceStart = Math.floor(
          (Date.now() - task.startTime * 1000) / 1000 / 60
        );

        timestamp.textContent = `Started ${minSinceStart} min ago`;

        if (task.startTime === 0) {
          timestamp.textContent = "Queued";
        }

        const button = document.createElement("button");
        button.className = "stop-task btn btn-danger btn-sm";
        button.type = "submit";
        button.value = "Stop";
        button.textContent = "Stop";

        button.addEventListener("click", (e) => {
          e.preventDefault();

          fetch(`/api/tasks/delete`, {
            method: "DELETE",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ id: task.id }),
          })
            .then((response) => response.json())
            .then((data) => {
              console.log(data);
              refreshTasks();
              refreshHistory();
            });
        });

        taskDiv.append(zones, duration, timestamp, button);
        tasksContainer.appendChild(taskDiv);
      });
    })
    .catch((err) => console.error(err));
}

function refreshSchedules() {
  fetch("/api/schedules")
    .then((response) => response.json())
    .then((data) => {
      console.log(data);
      const schedulesContainer = document.querySelector(
        ".schedules-container .list-group"
      );
      schedulesContainer.innerHTML = ""; // Clear existing schedules

      if (Object.values(data).length === 0) {
        const noSchedules = document.createElement("p");
        noSchedules.className = "text-muted";
        noSchedules.textContent = "No Schedules";
        noSchedules.style.marginLeft = "1rem";
        schedulesContainer.appendChild(noSchedules);
      }

      for (const scheduleId in data) {
        const schedule = data[scheduleId];

        const scheduleDiv = document.createElement("div");
        scheduleDiv.className = "schedule list-group-item";

        const header = document.createElement("div");
        header.className = "header";

        const headerText = document.createElement("div");
        headerText.className = "header-text";

        const scheduleName = document.createElement("h5");
        scheduleName.textContent = schedule.name;

        const scheduleDays = document.createElement("p");
        scheduleDays.className = "days text-muted";

        // Parse days from ints to human readable
        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const newDays = schedule.days.map((day) => days[day]);

        scheduleDays.textContent = newDays.join(", ");

        const startTime = document.createElement("p");
        startTime.className = "start-time text-muted";

        // Parse startTime from HH:MM 24h string to human readable am/pm
        const time = schedule.startTime.split(":");
        let hours = parseInt(time[0]);
        const minutes = parseInt(time[1]);

        let ampm = "AM";
        if (hours > 12) {
          hours -= 12;
          ampm = "PM";
        }

        const hoursStr = hours.toString();
        const minutesStr = minutes.toString().padStart(2, "0");

        startTime.textContent = `${hoursStr}:${minutesStr} ${ampm}`;

        headerText.append(scheduleName, scheduleDays, startTime);
        header.appendChild(headerText);

        const tasksContainer = document.createElement("div");
        tasksContainer.className = "tasks";

        const tasksHeader = document.createElement("p");
        tasksHeader.textContent = "Tasks:";
        tasksContainer.appendChild(tasksHeader);

        schedule.tasks.forEach((task) => {
          const taskP = document.createElement("p");
          taskP.className = "task text-muted";
          taskP.textContent = `Zone(s): ${task.zones.join(", ")} | ${
            task.runTime
          } min`;
          tasksContainer.appendChild(taskP);
        });

        const lastRun = document.createElement("div");
        lastRun.className = "last-run text-muted";

        // Parse lastRun from unix seconds to human readable
        // If lastRun is 0, then the schedule has never run
        // If lastRun is less than 60 min then display in minutes
        // If lastRun is less than 24 hours then display in hours
        // If lastRun is more than 24 hours then display in days

        const lastRunDate = new Date(schedule.lastRun * 1000);
        const lastRunMin = Math.floor(
          (Date.now() - schedule.lastRun * 1000) / 1000 / 60
        );
        const lastRunHours = Math.floor(lastRunMin / 60);

        if (schedule.lastRun === null) {
          lastRun.textContent = "Never";
        } else if (lastRunMin < 1) {
          lastRun.textContent = "Just now";
        } else if (lastRunMin < 60) {
          lastRun.textContent = `${lastRunMin} min`;
        } else if (lastRunHours < 24) {
          lastRun.textContent = `${lastRunHours} hours`;
        } else {
          lastRun.textContent = `${Math.floor(lastRunHours / 24)} days`;
        }

        const actionButtons = document.createElement("div");
        actionButtons.className = "action-buttons";

        const enabledButton = document.createElement("button");
        enabledButton.className = "enabled-button btn btn-sm";
        enabledButton.type = "submit";

        if (schedule.enabled) {
          enabledButton.value = "Enabled";
          enabledButton.textContent = "Enabled";
          enabledButton.classList.add("btn-success");
        } else {
          enabledButton.value = "Disabled";
          enabledButton.textContent = "Disabled";
          enabledButton.classList.add("btn-secondary");
        }

        enabledButton.addEventListener("click", (e) => {
          e.preventDefault();

          fetch(`/api/schedules/update`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              ...schedule,
              id: scheduleId,
              enabled: !schedule.enabled,
            }),
          })
            .then((response) => response.json())
            .then((data) => {
              console.log(data);
              refreshSchedules();
            });
        });

        const editButton = document.createElement("button");
        editButton.className = "edit-button btn btn-secondary btn-sm";
        editButton.type = "submit";
        editButton.value = "Edit";
        editButton.textContent = "Edit";

        editButton.addEventListener("click", (e) => {
          e.preventDefault();

          //Redirect to edit page
          window.location.href = `/edit-schedule?id=${scheduleId}`;
        });

        const deleteButton = document.createElement("button");
        deleteButton.className = "edit-button btn btn-danger btn-sm";
        deleteButton.type = "submit";
        deleteButton.value = "Delete";
        deleteButton.textContent = "Delete";

        deleteButton.addEventListener("click", (e) => {
          e.preventDefault();

          fetch(`/api/schedules/delete`, {
            method: "DELETE",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ id: scheduleId }),
          })
            .then((response) => response.json())
            .then((data) => {
              console.log(data);
              refreshSchedules();
            });
        });

        actionButtons.append(editButton, deleteButton);
        scheduleDiv.append(
          header,
          lastRun,
          tasksContainer,
          enabledButton,
          actionButtons
        );
        schedulesContainer.appendChild(scheduleDiv);
      }
    });
}

function refreshHistory() {
  fetch("/api/history")
    .then((response) => response.json())
    .then((data) => {
      console.log(data);
      const historyContainer = document.querySelector(".history");
      historyContainer.innerHTML = ""; // Clear existing history

      if (data.length === 0) {
        const noHistory = document.createElement("p");
        noHistory.className = "text-muted";
        noHistory.textContent = "No history";
        noHistory.style.marginLeft = "1rem";
        historyContainer.appendChild(noHistory);
      }

      data.forEach((event) => {
        const historyEventDiv = document.createElement("div");
        historyEventDiv.className = "history-event list-group-item";

        const eventType = document.createElement("h6");
        eventType.className = `event ${event.event.toLowerCase()}`;
        eventType.textContent = event.event;

        const reason = document.createElement("p");
        reason.className = "reason text-muted";
        reason.textContent = event.reason;

        const timestamp = document.createElement("p");
        timestamp.className = "timestamp text-muted";

        // Parse startTime from unix seconds to human readable
        const date = new Date(event.timestamp * 1000);
        const minSinceEvent = Math.floor(
          (Date.now() - event.timestamp * 1000) / 1000 / 60
        );

        // If event is less than 60 min then display in minutes
        // If event is less than 24 hours then display in hours
        // If event is more than 24 hours then display in days
        if (minSinceEvent < 0) {
          eventType.classList.add("queued");
          eventType.textContent = "Queued";
        }

        if (minSinceEvent < 1) {
          timestamp.textContent = "Just now";
        } else if (minSinceEvent < 60) {
          timestamp.textContent = `${minSinceEvent} min ago`;
        } else if (minSinceEvent < 60 * 24) {
          timestamp.textContent = date
            .toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })
            .replace(/\./g, "")
            .toUpperCase();
        } else {
          // Show like: Mar 3 HH:MM AM/PM
          timestamp.textContent =
            date
              .toLocaleDateString([], {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })
              .replace(/\./g, "")
              .split(",")[0] +
            "," +
            date
              .toLocaleDateString([], {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })
              .replace(/\./g, "")
              .split(",")[1]
              .toUpperCase();
        }

        const zones = document.createElement("p");
        zones.className = "zones";
        zones.textContent = `Zone(s): ${event.zones.join(", ")}`;

        historyEventDiv.append(eventType, reason, timestamp, zones);
        historyContainer.appendChild(historyEventDiv);
      });
    })
    .catch((err) => console.error(err));
}

window.onload = () => {
  refreshTasks();
  refreshSchedules();
  refreshHistory();
};

setInterval(() => {
  refreshTasks();
  refreshSchedules();
  refreshHistory();
}, 10000); // Refresh tasks and history every 15 seconds
