import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = express();
app.use(express.json());
app.use(express.static(path.join(root, "public")));
app.set("views", path.join(root, "views"));
app.set("view engine", "ejs");

const schedules = {
  morning: {
    name: "Morning lawn",
    days: [1, 3, 5],
    startTime: "06:30",
    lastRun: 1786141800,
    enabled: true,
    tasks: [{ zones: [1, 2, 3], runTime: 12 }],
  },
};
const tasks = [
  { id: "running", zones: [4], runTime: 20, startTime: 1 },
  { id: "queued", zones: [6], runTime: 10, startTime: 0 },
];
const history = [
  { zones: [1, 2], event: "Started", reason: "Schedule", timestamp: 1786141800 },
];

app.get("/healthz", (_req, res) => res.json({ ok: true, mode: "synthetic" }));
app.get("/", (_req, res) => res.render("index"));
app.get("/quick-task", (_req, res) => res.render("quick-task"));
app.get("/schedules", (_req, res) => res.render("schedules"));
app.get("/create-schedule", (_req, res) => res.render("create-schedule"));
app.get("/edit-schedule", (_req, res) => res.render("edit-schedule"));
app.get("/activity", (_req, res) => res.render("activity"));
app.get("/controller", (_req, res) => res.render("controller"));
app.get("/api/tasks", (_req, res) => res.json({ tasks }));
app.post("/api/tasks/create", (_req, res) => res.status(201).json({ success: true }));
app.delete("/api/tasks/delete", (_req, res) => res.json({ success: true }));
app.get("/api/schedules", (_req, res) => res.json(schedules));
app.put("/api/schedules/update", (req, res) => res.json(req.body));
app.delete("/api/schedules/delete", (_req, res) => res.json({ success: true }));
app.get("/api/history", (_req, res) => res.json(history));
app.listen(4178, "127.0.0.1", () => console.log("synthetic fixture http://127.0.0.1:4178"));
