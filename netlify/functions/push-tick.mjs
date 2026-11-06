import { store, runTick } from "../lib/core.mjs";

// Runs every minute: sends the "started", "30분째" and test notifications that are due.
export default async () => {
  await runTick(store());
};

export const config = { schedule: "* * * * *" };
