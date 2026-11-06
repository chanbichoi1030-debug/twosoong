// POST /api/opic-grade  {deviceId, question, qtype, transcript, seconds, target}
// Streams Server-Sent Events: "progress" while Claude writes, then one "result" (JSON) or "error".
import Anthropic from "@anthropic-ai/sdk";
import { store, json, readJson, validId } from "../lib/core.mjs";

const DAILY_LIMIT_TOTAL = Number(process.env.OPIC_DAILY_LIMIT || 80);   // protects the API bill if the link leaks
const LEVELS = ["NL", "NM", "NH", "IL", "IM1", "IM2", "IM3", "IH", "AL"];

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["level", "score", "monkey_comment", "summary_ko", "strengths", "improvements", "corrected_answer", "useful_expressions"],
  properties: {
    level: { type: "string", enum: LEVELS, description: "Estimated OPIc level for this single answer" },
    score: { type: "integer", description: "0-100 overall score for this answer" },
    monkey_comment: { type: "string", description: "One or two short, warm, playful Korean sentences in the voice of 투숭이 the monkey coach" },
    summary_ko: { type: "string", description: "2-3 Korean sentences: overall evaluation" },
    strengths: { type: "array", items: { type: "string" }, description: "1-3 strengths, in Korean" },
    improvements: {
      type: "array",
      description: "2-5 concrete fixes taken from the learner's own sentences",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "original", "better", "why_ko"],
        properties: {
          category: { type: "string", enum: ["문법", "어휘", "표현", "구성", "내용", "유창성"] },
          original: { type: "string", description: "The learner's phrase exactly as transcribed" },
          better: { type: "string", description: "Improved English version" },
          why_ko: { type: "string", description: "Short Korean explanation" },
        },
      },
    },
    corrected_answer: { type: "string", description: "A natural English model answer that keeps the learner's ideas, written at the target level, about 120-200 words" },
    useful_expressions: {
      type: "array",
      description: "3-5 expressions worth memorising for this question",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["en", "ko"],
        properties: { en: { type: "string" }, ko: { type: "string" } },
      },
    },
  },
};

const SYSTEM = `You are an experienced OPIc (Oral Proficiency Interview - computer) English rater and a friendly coach for a Korean learner.
The learner's spoken answer was converted to text by speech recognition, so:
- You cannot judge pronunciation or intonation; do not comment on them.
- Ignore missing punctuation, capitalization, and obvious speech-recognition mistakes (homophones, split words). Only flag errors the learner most likely really made.
Rate the answer the way OPIc does: task completion for the question type (description, routine, past experience, comparison, role-play), length and fluency (very short answers, long pauses or heavy filler cap the level), sentence complexity and connectors, vocabulary range, and grammar accuracy (especially tense in past-experience questions).
Be honest about the level, but encouraging. Explanations go in Korean; English examples stay in English.
In "original", quote the learner's own words from the transcript. Keep the corrected answer close to the learner's own story so it is easy to learn from.
"monkey_comment" is spoken by 투숭이, a cute pixel monkey who loves bananas; keep it short and warm.`;

function sse(controller, event, data) {
  controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

async function underDailyLimit(st) {
  const key = `usage/opic-${new Date().toISOString().slice(0, 10)}`;
  const n = (await st.get(key, { type: "json" })) || 0;
  if (n >= DAILY_LIMIT_TOTAL) return false;
  await st.setJSON(key, n + 1);
  return true;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: "no_key", message: "Netlify 환경 변수에 ANTHROPIC_API_KEY가 없어요." }, 500);
  const b = await readJson(req);
  if (!b || !validId(b.deviceId)) return json({ error: "bad device id" }, 400);
  const question = String(b.question || "").slice(0, 600);
  const transcript = String(b.transcript || "").trim().slice(0, 5000);
  const qtype = String(b.qtype || "").slice(0, 40);
  const target = LEVELS.includes(b.target) ? b.target : "IH";
  const seconds = Math.max(0, Math.min(600, Math.round(Number(b.seconds) || 0)));
  if (!question || transcript.split(/\s+/).length < 3) return json({ error: "too_short", message: "답변이 너무 짧아요. 몇 문장 더 말해 주세요." }, 400);

  const st = store();
  if (!(await underDailyLimit(st))) return json({ error: "limit", message: "오늘 채점 횟수를 다 썼어요. 내일 다시 해 주세요." }, 429);

  const userText = `Question type: ${qtype || "unknown"}
Question: ${question}
Learner's target level: ${target}
Answer length: ${seconds ? `${seconds} seconds` : "unknown"}, ${transcript.split(/\s+/).length} words

Learner's answer (speech-to-text):
"""
${transcript}
"""`;

  const client = new Anthropic();
  const body = new ReadableStream({
    async start(controller) {
      const ping = setInterval(() => controller.enqueue(new TextEncoder().encode(": ping\n\n")), 5000);
      try {
        sse(controller, "progress", { chars: 0 });
        const stream = client.beta.messages.stream({
          model: "claude-opus-5-5",
          max_tokens: 16000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
          system: SYSTEM,
          messages: [{ role: "user", content: userText }],
        });
        let chars = 0;
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            chars += event.delta.text.length;
            sse(controller, "progress", { chars });
          }
        }
        const msg = await stream.finalMessage();
        if (msg.stop_reason === "refusal") {
          sse(controller, "error", { message: "이 답변은 채점할 수 없었어요. 다른 질문으로 해 볼까요?" });
        } else {
          const text = msg.content.filter(c => c.type === "text").map(c => c.text).join("");
          sse(controller, "result", JSON.parse(text));
        }
      } catch (e) {
        let message = "채점 중에 문제가 생겼어요. 잠시 후 다시 해 주세요.";
        if (e instanceof Anthropic.AuthenticationError) message = "API 키가 올바르지 않아요. Netlify 환경 변수를 확인해 주세요.";
        else if (e instanceof Anthropic.RateLimitError) message = "요청이 많아요. 1분 뒤에 다시 해 주세요.";
        else if (e instanceof Anthropic.APIError && e.status === 400 && /credit/i.test(String(e.message))) message = "API 크레딧이 부족해요. Claude Console에서 충전해 주세요.";
        else if (e instanceof SyntaxError) message = "채점 결과를 읽지 못했어요. 다시 한 번 해 주세요.";
        console.error("opic-grade failed", e && e.status, e && e.message);
        sse(controller, "error", { message });
      } finally {
        clearInterval(ping);
        controller.close();
      }
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } });
};

export const config = { path: "/api/opic-grade" };
