document.querySelector(".save-btn").addEventListener("click", async () => {
  const zones = [];

  for (let i = 1; i <= 8; i++) {
    const zone = document.querySelector(`#zone${i}`).checked;

    if (zone) {
      zones.push(i);
    }
  }

  let duration = document.querySelector(".task-duration").valueAsNumber;

  if (!duration) {
    duration = 15;
  }

  console.log({
    zones,
    runTime: duration,
  });

  const response = await fetch("/api/tasks/create", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      zones,
      runTime: duration,
    }),
  });

  const data = await response.json();

  console.log(data);
  window.location.href = "/";
});
