import { JsonRepository } from "../repository.js";

const [dataPath, prefix, countRaw] = process.argv.slice(2);
const count = Number(countRaw);
const repository = await new JsonRepository(dataPath).init();
await Promise.all(Array.from({ length: count }, (_, index) => repository.mutate((data) => {
  data.schedules[`${prefix}-${index}`] = {
    name: `${prefix}-${index}`,
    days: [1],
    startTime: "06:30",
    lastRun: null,
    enabled: true,
    tasks: [{ zones: [1], runTime: 5 }],
  };
})));
