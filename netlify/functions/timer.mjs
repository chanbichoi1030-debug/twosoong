import { store, json, readJson, validId, actOf, sendPush, stopMsg, START_DELAY_MS, INTERVAL_MIN } from "../lib/core.mjs";

// POST /api/timer {deviceId, action: start|pause|resume|stop|cancel, title?, sec?}
export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const b = await readJson(req);
  if (!b || !validId(b.deviceId)) return json({ error: "bad device id" }, 400);
  const st = store();
  const key = `jobs/${b.deviceId}`;
  const now = Date.now();
  const title = String(b.title || "").trim().slice(0, 40);

  switch (b.action) {
    case "start": {
      if (!title) return json({ error: "title required" }, 400);
      await st.setJSON(key, {
        deviceId: b.deviceId, title, act: actOf(title), run: now.toString(36),
        segStart: now, acc: 0, paused: false,
        noticeAt: now + START_DELAY_MS, notice: "start", nextMin: INTERVAL_MIN,
      });
      break;
    }
    case "pause": {
      const j = await st.get(key, { type: "json" });
      if (j && !j.paused) {
        j.acc += now - j.segStart; j.paused = true; j.noticeAt = null;
        await st.setJSON(key, j);
      }
      break;
    }
    case "resume": {
      const j = await st.get(key, { type: "json" });
      if (j && j.paused) {
        j.segStart = now; j.paused = false; j.noticeAt = now + START_DELAY_MS; j.notice = "resume";
        await st.setJSON(key, j);
      }
      break;
    }
    case "stop": {
      await st.delete(key);
      const sec = Math.max(0, Math.round(Number(b.sec) || 0));
      if (title && sec >= 5) await sendPush(st, b.deviceId, stopMsg(title, actOf(title), sec));
      break;
    }
    case "cancel":
      await st.delete(key);
      break;
    default:
      return json({ error: "unknown action" }, 400);
  }
  return json({ ok: true });
};

export const config = { path: "/api/timer" };
