import express from "express";
import bodyParser from "body-parser";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import fs from "fs/promises";
import { v4 as uuid4 } from "uuid";
import { logHistory } from "./helpers.js";
import { savePath } from "./constants.js";
import dotenv from "dotenv";
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class ControllerError extends Error {}

// Deterministic synthetic controller for demo/test mode. It holds tasks in
// memory only and is structurally incapable of reaching hardware: it never
// opens a socket, it just mimics the microcontroller's /tasks API surface.
export function createSyntheticController(now = () => Math.floor(Date.now() / 1000)) {
  let nextId = 1;
  const state = {
    tasks: [
      { id: "demo-running", zones: [4], runTime: 20, startTime: now() - 240 },
      { id: "demo-queued", zones: [6], runTime: 10, startTime: 0 },
    ],
  };

  return async (url, init = {}) => {
    const parsed = new URL(url, "http://synthetic.invalid");
    if (parsed.pathname === "/tasks" && !init.method) {
      return Response.json({ tasks: state.tasks });
    }
    if (parsed.pathname === "/tasks/add") {
      const body = JSON.parse(init.body);
      for (const task of body.tasks) {
        state.tasks.push({
          id: `demo-${nextId++}`,
          zones: task.zones,
          runTime: task.runTime,
          startTime: state.tasks.some((t) => t.startTime !== 0) ? 0 : now(),
        });
      }
      return Response.json({ success: true });
    }
    if (parsed.pathname === "/tasks/delete") {
      const id = parsed.searchParams.get("id");
      state.tasks = state.tasks.filter((t) => t.id !== id);
      return Response.json({ success: true });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };
}

async function ensureDataFile(dataPath) {
  try {
    await fs.access(dataPath);
  } catch {
    await fs.mkdir(path.dirname(dataPath), { recursive: true });
    await fs.writeFile(dataPath, JSON.stringify({ schedules: {}, history: [] }), "utf8");
  }
}

export async function createApp(options = {}) {
  const demo = options.demo ?? process.env.SPRINKLER_DEMO === "1";
  const dataPath =
    options.dataPath ?? (demo ? path.join(os.tmpdir(), "sprinkler-demo-data.json") : savePath);
  const controllerHost = options.controllerHost ?? `http://${process.env.MICROCONTROLLER_HOST}`;
  const controllerFetch = demo
    ? createSyntheticController()
    : options.controllerFetch ?? ((url, init) => fetch(url, init));

  if (demo) {
    // Demo data must never collide with the live data file.
    await fs.writeFile(dataPath, JSON.stringify({ schedules: {}, history: [] }), "utf8");
  }
  await ensureDataFile(dataPath);

  async function controllerRequest(pathname, init = undefined) {
    let response;
    try {
      response = await controllerFetch(controllerHost + pathname, init);
    } catch (err) {
      throw new ControllerError(`controller unreachable: ${err.message}`);
    }
    if (!response.ok) {
      throw new ControllerError(`controller responded ${response.status}`);
    }
    return response.json();
  }

  const app = express();
  app.use(express.static(path.join(__dirname, "/public")));
  app.use(bodyParser.json());
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views"));

  const wrap = (handler) => (req, res, next) => handler(req, res, next).catch(next);

  const readData = async () => JSON.parse(await fs.readFile(dataPath, "utf8"));
  const writeData = (data) => fs.writeFile(dataPath, JSON.stringify(data), "utf8");

  app.get("/", (req, res) => res.render("index"));
  app.get("/quick-task", (req, res) => res.render("quick-task"));
  app.get("/schedules", (req, res) => res.render("schedules"));
  app.get("/create-schedule", (req, res) => res.render("create-schedule"));
  app.get("/edit-schedule", (req, res) => res.render("edit-schedule"));
  app.get("/activity", (req, res) => res.render("activity"));
  app.get("/controller", (req, res) => res.render("controller"));

  app.get(
    "/api/schedules",
    wrap(async (req, res) => {
      res.json((await readData()).schedules);
    })
  );

  app.post(
    "/api/schedules/create",
    wrap(async (req, res) => {
      const data = await readData();
      const newSchedule = {
        name: req.body.name,
        days: req.body.days,
        startTime: req.body.startTime,
        lastRun: null,
        enabled: true,
        tasks: req.body.tasks,
      };
      await writeData({
        ...data,
        schedules: { ...data.schedules, [uuid4()]: newSchedule },
      });
      res.json(newSchedule);
    })
  );

  app.put(
    "/api/schedules/update",
    wrap(async (req, res) => {
      const data = await readData();
      if (!data.schedules[req.body.id]) {
        return res.status(404).json({ error: "schedule not found" });
      }
      const updated = {
        ...data.schedules[req.body.id],
        name: req.body.name,
        days: req.body.days,
        startTime: req.body.startTime,
        tasks: req.body.tasks,
        enabled: req.body.enabled,
      };
      await writeData({
        ...data,
        schedules: { ...data.schedules, [req.body.id]: updated },
      });
      res.json(updated);
    })
  );

  app.delete(
    "/api/schedules/delete",
    wrap(async (req, res) => {
      const data = await readData();
      delete data.schedules[req.body.id];
      await writeData(data);
      res.json({ success: true });
    })
  );

  app.get(
    "/api/history",
    wrap(async (req, res) => {
      const limit = req.query.limit || 50;
      res.json((await readData()).history.slice(0, limit));
    })
  );

  app.post(
    "/api/history/create",
    wrap(async (req, res) => {
      res.json(await logHistory(dataPath, req.body.zones, req.body.event, req.body.reason));
    })
  );

  app.get(
    "/api/tasks",
    wrap(async (req, res) => {
      res.json(await controllerRequest("/tasks"));
    })
  );

  app.post(
    "/api/tasks/create",
    wrap(async (req, res) => {
      const data = await controllerRequest("/tasks/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tasks: [{ zones: req.body.zones, runTime: req.body.runTime }],
        }),
      });
      await logHistory(dataPath, req.body.zones, "Started", "Remote");
      res.json(data);
    })
  );

  app.delete(
    "/api/tasks/delete",
    wrap(async (req, res) => {
      const current = await controllerRequest("/tasks");
      const task = current.tasks.find((t) => t.id === req.body.id);
      if (!task) {
        return res.status(404).json({ error: "task not found" });
      }
      const data = await controllerRequest(`/tasks/delete?id=${req.body.id}`, {
        method: "DELETE",
      });
      await logHistory(dataPath, task.zones, "Stopped", "Remote");
      res.json(data);
    })
  );

  let activeZones = [];

  async function refreshActiveZones() {
    const data = await controllerRequest("/tasks");
    const zoneSet = new Set();
    for (const task of data.tasks) {
      for (const zone of task.zones) {
        zoneSet.add(zone);
      }
    }
    activeZones = [...zoneSet];
  }

  app.get("/api/zones", (req, res) => res.json(activeZones));

  app.post(
    "/api/zones",
    wrap(async (req, res) => {
      // Body includes one zone and on/off.
      // If on, add a 15 minute task for the zone.
      // If off, rebuild every task without the zone, keeping remaining time.
      const { zone, on } = req.body;
      const data = await controllerRequest("/tasks");
      const tasks = data.tasks;

      if (on) {
        await controllerRequest("/tasks/add", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tasks: [{ zones: [zone], runTime: 15 }] }),
        });
        await logHistory(dataPath, [zone], "Started", "Home Assistant");
      } else {
        for (const task of [...tasks].reverse()) {
          await controllerRequest(`/tasks/delete?id=${task.id}`, { method: "DELETE" });
        }
        for (const task of [...tasks].reverse()) {
          const zones = task.zones.filter((z) => z !== zone);
          if (zones.length > 0) {
            const newRunTime =
              task.startTime !== 0
                ? Math.ceil(task.runTime - (Date.now() / 1000 - task.startTime) / 60)
                : task.runTime;
            await controllerRequest("/tasks/add", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tasks: [{ zones, runTime: newRunTime }] }),
            });
          }
        }
        await logHistory(dataPath, [zone], "Stopped", "Home Assistant");
      }

      res.json({ success: true });
    })
  );

  async function runScheduleTick(now = new Date()) {
    const data = await readData();
    for (const [id, schedule] of Object.entries(data.schedules)) {
      const day = now.getDay();
      const clock = `${now.getHours().toString().padStart(2, "0")}:${now
        .getMinutes()
        .toString()
        .padStart(2, "0")}`;

      if (
        schedule.enabled &&
        schedule.days.includes(day) &&
        schedule.startTime === clock &&
        (schedule.lastRun ?? 0) + 60 < Math.floor(now.getTime() / 1000)
      ) {
        await controllerRequest("/tasks/add", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tasks: schedule.tasks }),
        });

        const latest = await readData();
        await writeData({
          ...latest,
          schedules: {
            ...latest.schedules,
            [id]: { ...latest.schedules[id], lastRun: Math.floor(now.getTime() / 1000) },
          },
        });

        let timestamp = Math.floor(now.getTime() / 1000);
        for (const task of schedule.tasks) {
          await logHistory(dataPath, task.zones, "Started", "Schedule", timestamp);
          timestamp += task.runTime * 60;
        }
      }
    }
  }

  const timers = [];
  function startBackgroundJobs() {
    timers.push(setInterval(() => refreshActiveZones().catch(() => {}), 10000));
    timers.push(setInterval(() => runScheduleTick().catch((err) => console.error(err)), 5000));
  }
  function stopBackgroundJobs() {
    timers.splice(0).forEach(clearInterval);
  }

  app.use((err, req, res, next) => {
    if (err instanceof ControllerError) {
      return res.status(502).json({ error: err.message });
    }
    console.error(err.stack);
    res.status(500).json({ error: "internal error" });
  });

  return { app, dataPath, demo, refreshActiveZones, runScheduleTick, startBackgroundJobs, stopBackgroundJobs };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const port = process.env.PORT || 5000;
  const { app, demo, startBackgroundJobs } = await createApp();
  if (!demo) {
    startBackgroundJobs();
  }
  app.listen(port, () => {
    console.log(`Sprinkler Webserver listening on port ${port}${demo ? " (demo mode)" : ""}`);
  });
}
