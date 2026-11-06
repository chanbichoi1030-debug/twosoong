// Shared server code: storage, Web Push sending, and 투숭이 messages.
import webpush from "web-push";
import { getStore } from "@netlify/blobs";

export const START_DELAY_MS = 60 * 1000;   // first nudge 1 minute after start (phone is usually locked by then)
export const INTERVAL_MIN = 30;            // then every 30 minutes
export const MAX_RUN_MS = 12 * 60 * 60 * 1000;

let storeFactory = () => getStore({ name: "twosoong", consistency: "strong" });
export const store = () => storeFactory();
export function setStoreFactory(fn) { storeFactory = fn; }           // tests only

let sender = (sub, body, opts) => webpush.sendNotification(sub, body, opts);
export function setSender(fn) { sender = fn; }                        // tests only

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const validId = id => typeof id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(id);

export async function readJson(req) {
  try { return await req.json(); } catch { return null; }
}

/** VAPID keys are created on first use and kept in Blobs, so no setup is needed. */
export async function vapid(st) {
  let keys = await st.get("config/vapid", { type: "json" });
  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    await st.setJSON("config/vapid", keys);
  }
  return keys;
}

function subject() {
  const u = process.env.URL || "";
  return u.startsWith("https://") ? u : "mailto:twosoong@users.noreply.github.com";
}

export async function sendPush(st, deviceId, payload) {
  const sub = await st.get(`subs/${deviceId}`, { type: "json" });
  if (!sub) return "no-sub";
  const keys = await vapid(st);
  try {
    await sender(sub, JSON.stringify(payload), {
      vapidDetails: { subject: subject(), publicKey: keys.publicKey, privateKey: keys.privateKey },
      TTL: 900,
      urgency: "high",
    });
    return "sent";
  } catch (e) {
    if (e && (e.statusCode === 404 || e.statusCode === 410)) {
      await st.delete(`subs/${deviceId}`);
      return "gone";
    }
    console.error("push failed", e && e.statusCode, e && e.body);
    return "error";
  }
}

// ---------- words ----------

export function actOf(title) {
  const l = String(title || "").toLowerCase();
  if (l.includes("공부") || l.includes("study")) return "study";
  if (l.includes("운동") || l.includes("exercise") || l.includes("workout")) return "gym";
  return "";
}

export function fmtDur(sec) {
  if (sec < 60) return sec > 0 ? "1분 미만" : "0분";
  const m = Math.floor(sec / 60), h = Math.floor(m / 60);
  return h ? `${h}시간${m % 60 ? ` ${m % 60}분` : ""}` : `${m}분`;
}

const tag = "twosoong-timer";

export function startMsg(j) {
  if (j.act === "study") return { title: "📚 공부와 사투 중!", body: `투숭이가 '${j.title}' 지켜보는 중이에요. 화이팅!`, tag };
  if (j.act === "gym") return { title: "🏃 투숭이 핫 걸 되는중!", body: `'${j.title}' 시작! 땀 흘리는 중이에요.`, tag };
  return { title: `🎀 ${j.title} 하는 중`, body: "투숭이가 같이 집중하고 있어요. 쉿!", tag };
}

export function resumeMsg(j) {
  if (j.act === "study") return { title: "📚 다시 공부와 사투 시작!", body: `'${j.title}' 이어서 가 보자!`, tag };
  if (j.act === "gym") return { title: "🏃 다시 핫 걸 되는중!", body: `'${j.title}' 이어서 달린다!`, tag };
  return { title: `🎀 ${j.title} 다시 시작`, body: "투숭이도 다시 집중 모드예요.", tag };
}

export function milestoneMsg(j, min) {
  const d = fmtDur(min * 60);
  if (j.act === "study") return { title: `📚 ${j.title} ${d}째!`, body: "공부와 사투 중! 조금만 더 힘내자.", tag };
  if (j.act === "gym") return { title: `🏃 ${j.title} ${d}째!`, body: "투숭이 핫 걸 되는중! 거의 다 왔어.", tag };
  return { title: `⏱ ${j.title} ${d}째`, body: "투숭이가 박수 치는 중이에요. 잘하고 있어요!", tag };
}

export function stopMsg(title, act, sec) {
  const head = `✅ ${title} ${fmtDur(sec)} 기록 완료!`;
  if (act === "study") return { title: head, body: "공부와의 사투에서 살아남았다! 투숭이가 바나나 하나 줄게요 🍌", tag };
  if (act === "gym") return { title: head, body: "오늘도 핫 걸에 한 걸음 더! 🔥", tag };
  return { title: head, body: "투숭이가 칭찬해요. 수고했어요!", tag };
}

export const testMsg = () => ({ title: "🐵 투숭이 알림 테스트", body: "이 알림이 보이면 준비 완료! 타이머를 켜면 투숭이가 알려 줄게요.", tag: "twosoong-test", url: "./#timer" });

// ---------- scheduler step ----------

/** Sends whatever is due for one running timer. Returns the updated job, or null when it was removed. */
export async function tickJob(st, j, now) {
  const key = `jobs/${j.deviceId}`;
  if (j.paused) return j;
  const elapsed = j.acc + (now - j.segStart);
  if (elapsed > MAX_RUN_MS) { await st.delete(key); return null; }
  const out = { ...j };
  let changed = false;
  if (out.noticeAt && now >= out.noticeAt) {
    await sendPush(st, out.deviceId, out.notice === "resume" ? resumeMsg(out) : startMsg(out));
    out.noticeAt = null;
    changed = true;
  }
  const min = Math.floor(elapsed / 60000);
  if (min >= out.nextMin) {
    const reached = Math.floor(min / INTERVAL_MIN) * INTERVAL_MIN;
    await sendPush(st, out.deviceId, milestoneMsg(out, reached));
    out.nextMin = reached + INTERVAL_MIN;
    changed = true;
  }
  if (changed) {
    // The timer may have been stopped while we were sending: only save if it is still the same run.
    const cur = await st.get(key, { type: "json" });
    if (!cur || cur.run !== out.run || cur.paused !== out.paused || cur.segStart !== out.segStart) return cur;
    await st.setJSON(key, out);
  }
  return out;
}

export async function runTick(st, now = Date.now()) {
  const jobs = await st.list({ prefix: "jobs/" });
  for (const { key } of jobs.blobs) {
    const j = await st.get(key, { type: "json" });
    if (j) await tickJob(st, j, now);
  }
  const tests = await st.list({ prefix: "tests/" });
  for (const { key } of tests.blobs) {
    const t = await st.get(key, { type: "json" });
    if (t && t.at <= now) {
      await st.delete(key);
      await sendPush(st, t.deviceId, testMsg());
    }
  }
}
