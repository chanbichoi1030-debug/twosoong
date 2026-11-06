import { store, json, readJson, validId } from "../lib/core.mjs";

// POST /api/push-subscribe {deviceId, subscription} saves this phone's push address.
// POST /api/push-subscribe {deviceId, off: true} forgets it.
export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const b = await readJson(req);
  if (!b || !validId(b.deviceId)) return json({ error: "bad device id" }, 400);
  const st = store();
  if (b.off) {
    await st.delete(`subs/${b.deviceId}`);
    await st.delete(`jobs/${b.deviceId}`);
    return json({ ok: true, off: true });
  }
  const s = b.subscription;
  if (!s || typeof s.endpoint !== "string" || !s.endpoint.startsWith("https://") || !s.keys || !s.keys.p256dh || !s.keys.auth) {
    return json({ error: "bad subscription" }, 400);
  }
  await st.setJSON(`subs/${b.deviceId}`, { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } });
  return json({ ok: true });
};

export const config = { path: "/api/push-subscribe" };
