import fs from "fs/promises";
import { savePath } from "./constants.js";

export async function logHistory(zones, event, reason, timestamp = undefined) {
  const data = await fs.readFile(savePath, "utf8");

  const newHistory = {
    timestamp: timestamp | Math.floor(Date.now() / 1000),
    zones,
    event,
    reason,
  };

  const newData = {
    ...JSON.parse(data),
    history: [newHistory, ...JSON.parse(data).history.slice(0, 249)],
  };

  // Write to file

  await fs.writeFile(savePath, JSON.stringify(newData), "utf8");

  return newHistory;
}
