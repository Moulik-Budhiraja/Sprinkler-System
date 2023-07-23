import express from "express";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { existsSync } from "fs";
import { v4 as uuid4 } from "uuid";
import { logHistory } from "./helpers.js";
import { savePath } from "./constants.js";
import dotenv from "dotenv";
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 5000;

const microcontrollerHost = `http://${process.env.MICROCONTROLLER_HOST}`;

if (existsSync(savePath)) {
  console.log("Data file exists");
} else {
  console.log("Data file does not exist, creating...");

  const data = {
    schedules: {},
    history: [],
  };

  fs.writeFile(savePath, JSON.stringify(data), "utf8");
}

app.use(express.static(path.join(__dirname, "/public")));
app.use(bodyParser.json());

app.set("view engine", "ejs");

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send("Something broke!");
});

app.get("/", (req, res) => {
  res.render("index");
});

app.get("/quick-task", (req, res) => {
  res.render("quick-task");
});

app.get("/create-schedule", (req, res) => {
  res.render("create-schedule");
});

app.get("/edit-schedule", (req, res) => {
  res.render("edit-schedule");
});

app.get("/api/schedules", async (req, res) => {
  const data = await fs.readFile(savePath, "utf8");
  res.json(JSON.parse(data).schedules);
});

app.post("/api/schedules/create", async (req, res) => {
  const data = await fs.readFile(savePath, "utf8");

  const newSchedule = {
    name: req.body.name,
    days: req.body.days,
    startTime: req.body.startTime,
    lastRun: null,
    enabled: true,
    tasks: req.body.tasks,
  };

  const newData = {
    ...JSON.parse(data),
    schedules: {
      ...JSON.parse(data).schedules,
      [uuid4()]: newSchedule,
    },
  };

  // Write to file

  await fs.writeFile(savePath, JSON.stringify(newData), "utf8");

  res.json(newSchedule);
});

app.put("/api/schedules/update", async (req, res) => {
  const data = await fs.readFile(savePath, "utf8");

  const newData = {
    ...JSON.parse(data),
    schedules: {
      ...JSON.parse(data).schedules,
      [req.body.id]: {
        ...JSON.parse(data).schedules[req.body.id],
        name: req.body.name,
        days: req.body.days,
        startTime: req.body.startTime,
        tasks: req.body.tasks,
        enabled: req.body.enabled,
      },
    },
  };

  // Write to file

  await fs.writeFile(savePath, JSON.stringify(newData), "utf8");

  res.json(newData.schedules[req.body.id]);
});

app.delete("/api/schedules/delete", async (req, res) => {
  const data = await fs.readFile(savePath, "utf8");

  const newData = JSON.parse(data);
  delete newData.schedules[req.body.id];

  // Write to file
  await fs.writeFile(savePath, JSON.stringify(newData), "utf8");

  res.json({ success: true });
});

app.get("/api/history", async (req, res) => {
  const data = await fs.readFile(savePath, "utf8");

  const limit = req.query.limit || 50;
  const history = JSON.parse(data).history.slice(0, limit);

  res.json(history);
});

app.post("/api/history/create", async (req, res) => {
  const newHistory = await logHistory(
    req.body.zones,
    req.body.event,
    req.body.reason
  );

  res.json(newHistory);
});

app.get("/api/tasks", async (req, res) => {
  const response = await fetch(microcontrollerHost + "/tasks");
  const data = await response.json();

  res.json(data);
});

app.post("/api/tasks/create", async (req, res) => {
  console.log(req.body);

  const response = await fetch(microcontrollerHost + "/tasks/add", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tasks: [
        {
          zones: req.body.zones,
          runTime: req.body.runTime,
        },
      ],
    }),
  });

  const data = await response.json();

  await logHistory(req.body.zones, "Started", "Remote");

  res.json(data);
});

app.delete("/api/tasks/delete", async (req, res) => {
  const response1 = await fetch(microcontrollerHost + `/tasks`);
  const data1 = await response.json();

  const task = data1.tasks.find((t) => t.id === req.body.id);

  const response2 = await fetch(
    microcontrollerHost + `/tasks/delete?id=${req.body.id}`,
    {
      method: "DELETE",
    }
  );

  const data2 = await response2.json();

  await logHistory(task.zones, "Stopped", "Remote");

  res.json(data);
});

let activeZones = [];

setInterval(async () => {
  const response = await fetch(microcontrollerHost + "/tasks");
  const data = await response.json();

  const zoneSet = new Set();

  for (const task of data.tasks) {
    for (const zone of task.zones) {
      zoneSet.add(zone);
    }
  }

  activeZones = [...zoneSet];
}, 10000);

app.get("/api/zones", async (req, res) => {
  res.json(activeZones);
});

app.post("/api/zones", async (req, res) => {
  // Body will include 1 zone and on/off
  // If off, get all tasks on the microcontroller and remove the zone from each task, if there is a task with only 1 zone, delete it
  // If a task is already running, readd the task with only the time remaining
  // If on, add a task with the zone and 15 minutes

  const response = await fetch(microcontrollerHost + "/tasks");
  const data = await response.json();

  const zone = req.body.zone;
  const on = req.body.on;

  console.log(req.body);

  const tasks = data.tasks;

  const newTasks = [];

  if (on) {
    const response = await fetch(microcontrollerHost + "/tasks/add", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tasks: [
          {
            zones: [zone],
            runTime: 15,
          },
        ],
      }),
    });

    console.log(await logHistory([zone], "Started", "Home Assistant"));
  } else {
    // Delete all tasks
    for (const task of tasks.reverse()) {
      const response = await fetch(
        microcontrollerHost + `/tasks/delete?id=${task.id}`,
        {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    // Remove zone from all tasks
    for (const task of tasks.reverse()) {
      const zones = task.zones.filter((z) => z !== zone);

      if (zones.length > 0) {
        let newRunTime;
        // Calculate new run time
        if (task.startTime != 0) {
          newRunTime = Math.ceil(
            task.runTime - (Date.now() / 1000 - task.startTime) / 60
          );
        } else {
          newRunTime = task.runTime;
        }

        const response = await fetch(microcontrollerHost + "/tasks/add", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            tasks: [
              {
                zones,
                runTime: newRunTime,
              },
            ],
          }),
        });
      }
    }

    console.log(await logHistory([zone], "Stopped", "Home Assistant"));
  }
});

setInterval(async () => {
  // Check if any schedules need to run

  const data = JSON.parse(await fs.readFile(savePath, "utf8"));

  const schedules = data.schedules;

  for (const [id, schedule] of Object.entries(schedules)) {
    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();
    const minute = now.getMinutes();

    if (
      schedule.enabled &&
      schedule.days.includes(day) &&
      schedule.startTime ===
        `${hour.toString().padStart(2, "0")}:${minute
          .toString()
          .padStart(2, "0")}` &&
      schedule.lastRun + 60 < Math.floor(Date.now() / 1000)
    ) {
      console.log("Running schedule", schedule.name);

      // Run schedule

      const response = await fetch(microcontrollerHost + "/tasks/add", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tasks: schedule.tasks,
        }),
      });

      const newData = {
        ...data,
        schedules: {
          ...data.schedules,
          [id]: {
            ...data.schedules[id],
            lastRun: Math.floor(Date.now() / 1000),
          },
        },
      };

      // Write to file

      await fs.writeFile(savePath, JSON.stringify(newData), "utf8");

      let timestamp = Math.floor(Date.now() / 1000);

      for (const task of schedule.tasks) {
        console.log(
          await logHistory(task.zones, "Started", "Schedule", timestamp)
        );
        timestamp += task.runTime * 60;
      }
    }
  }
}, 5000);

app.listen(port, () => {
  console.log(`Sprinkler Webserver listening on port ${port}`);
});
