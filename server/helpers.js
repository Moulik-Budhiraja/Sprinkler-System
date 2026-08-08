import fs from "fs/promises";

export async function logHistory(dataPath, zones, event, reason, timestamp = undefined) {
  const data = JSON.parse(await fs.readFile(dataPath, "utf8"));

  const newHistory = {
    timestamp: timestamp ?? Math.floor(Date.now() / 1000),
    zones,
    event,
    reason,
  };

  const newData = {
    ...data,
    history: [newHistory, ...data.history.slice(0, 249)],
  };

  await fs.writeFile(dataPath, JSON.stringify(newData), "utf8");

  return newHistory;
}
