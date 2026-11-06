import { store, json, readJson, validId, sendPush, testMsg } from "../lib/core.mjs";

// POST /api/push-test {deviceId, delay}  delay 0 = now, otherwise seconds (max 300) via the scheduler.
export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const b = await readJson(req);
  if (!b || !validId(b.deviceId)) return json({ error: "bad device id" }, 400);
  const st = store();
  const delay = Math.min(300, Math.max(0, Number(b.delay) || 0));
  if (!delay) return json({ ok: true, result: await sendPush(st, b.deviceId, testMsg()) });
  await st.setJSON(`tests/${b.deviceId}`, { deviceId: b.deviceId, at: Date.now() + delay * 1000 });
  return json({ ok: true, scheduled: true });
};

export const config = { path: "/api/push-test" };
