// AI Empire · Krea 2 NSFW Telegram bot (Cloudflare Worker, free plan)
// Paste this whole file into a new Cloudflare Worker, add the variables below, deploy, then open
// https://<your-worker>.workers.dev/setup once.
//
// Variables (Worker → Settings → Variables and Secrets):
//   TELEGRAM_BOT_TOKEN   from @BotFather
//   RUNPOD_API_KEY       runpod.io → Settings → API Keys
//   RUNPOD_ENDPOINT_ID   your serverless endpoint's ID
//   LORA_URL             direct download link to your character LoRA .safetensors (Dropbox works)
//   OWNER_ID             your Telegram ID (the bot tells you it on your first message)
// Optional:
//   GPU_PRICE_PER_SECOND your GPU's serverless price in $/s (from RunPod's pricing) → /stats shows the cost
// Optional binding (Worker → Settings → Bindings → KV namespace, variable name STATS):
//   STATS                keeps the /stats history (photos made, times, failures)
// Everything else (LoRA strengths, size, sampler, post-processing) is fixed in the workflow.

const HELP = [
  "👋 Paste your full prompt and I'll send the photo back.",
  "",
  "Start with your trigger word, then the scene: photo type, pose, outfit, place, light, framing.",
  "Your prompt goes in exactly as you type it. Nothing is added.",
  "",
  "/stats shows how many photos you've made, how long they take and what the GPU is doing.",
  "",
  "The first photo after a break takes a few minutes (the GPU wakes up), then it's much faster.",
].join("\n");

const COMMANDS = [
  { command: "stats", description: "Photos made, speed, cost and GPU status" },
  { command: "help", description: "How to write a prompt" },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/setup") {
      const missing = ["TELEGRAM_BOT_TOKEN", "RUNPOD_API_KEY", "RUNPOD_ENDPOINT_ID", "LORA_URL"]
        .filter((k) => !env[k]);
      if (missing.length) return text(`❌ Missing variables: ${missing.join(", ")}\nAdd them in Settings → Variables and Secrets, deploy, then open /setup again.`);
      const res = await telegram(env, "setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: await secret(env),
        allowed_updates: ["message"],
        drop_pending_updates: true,
      });
      if (!res.ok) return text(`❌ Telegram said: ${res.description || JSON.stringify(res)}\n(check TELEGRAM_BOT_TOKEN)`);
      await telegram(env, "setMyCommands", { commands: COMMANDS });
      return text([
        "✅ Bot connected! Open your bot in Telegram and send it any message.",
        env.STATS ? "📊 /stats history: on" : "📊 /stats history: off (optional: add a KV binding named STATS, then deploy)",
      ].join("\n"));
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await secret(env))) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      ctx.waitUntil(onMessage(update.message, env, url.origin));
      return new Response("ok");
    }

    // RunPod calls this when a job finishes (the "webhook" sent with each job)
    if (url.pathname === "/runpod" && request.method === "POST") {
      if (url.searchParams.get("k") !== (await secret(env))) return new Response("forbidden", { status: 403 });
      const job = await request.json().catch(() => ({}));
      ctx.waitUntil(onJobDone(job, url.searchParams.get("chat"), env));
      return new Response("ok");
    }

    return text("AI Empire NSFW bot is running. Open /setup once to connect it to Telegram.");
  },
};

async function onMessage(msg, env, origin) {
  if (!msg || !msg.chat) return;
  const chat = msg.chat.id;
  const from = String(msg.from?.id ?? "");
  const owners = String(env.OWNER_ID || "").split(",").map((s) => s.trim()).filter(Boolean);

  if (!owners.length) {
    return send(env, chat, `🔒 Almost done! Your Telegram ID is ${from}\n\nPut it in Cloudflare as OWNER_ID (Settings → Variables and Secrets), deploy, and message me again. This makes the bot answer only you, so nobody else can spend your RunPod credits.`);
  }
  if (!owners.includes(from)) return send(env, chat, "🔒 This is a private bot.");

  const prompt = (msg.text || "").trim();
  const cmd = prompt.split(/[\s@]/)[0].toLowerCase();
  if (cmd === "/stats") return send(env, chat, await statsText(env));
  if (!prompt || prompt.startsWith("/")) return send(env, chat, HELP);

  const webhook = `${origin}/runpod?k=${await secret(env)}&chat=${encodeURIComponent(chat)}`;
  const r = await fetch(`https://api.runpod.ai/v2/${env.RUNPOD_ENDPOINT_ID}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RUNPOD_API_KEY}` },
    body: JSON.stringify({
      input: {
        prompt,
        lora_url: env.LORA_URL,
        telegram_token: env.TELEGRAM_BOT_TOKEN,
        chat_id: chat,
      },
      webhook,
    }),
  });
  if (!r.ok) {
    const why = r.status === 401 ? "RunPod rejected the API key (check RUNPOD_API_KEY)"
      : r.status === 404 ? "RunPod can't find that endpoint (check RUNPOD_ENDPOINT_ID)"
      : `RunPod error ${r.status}`;
    return send(env, chat, `⚠️ ${why}`);
  }
  return send(env, chat, "🎨 On it…");
}

// ------------------------------------------------------------------ job finished (RunPod webhook)
async function onJobDone(job, chat, env) {
  const out = job.output && typeof job.output === "object" ? job.output : {};
  const ok = job.status === "COMPLETED" && out.ok === true;
  await recordStats(env, job, out, ok);
  // The worker already told the chat (photo, or the error it caught). Only speak up when it couldn't:
  // the worker crashed, ran out of time, or the job was cancelled.
  if (!ok && !out.notified && chat) {
    const why = job.error || out.message || "no details";
    await send(env, chat, `⚠️ The GPU worker failed (${job.status || "unknown"}): ${String(why).slice(0, 500)}\nCheck the endpoint's Logs on RunPod.`);
  }
}

async function recordStats(env, job, out, ok) {
  if (!env.STATS) return;
  const s = await loadStats(env);
  const day = new Date().toISOString().slice(0, 10);
  if (ok) {
    s.photos += 1;
    s.days[day] = (s.days[day] || 0) + 1;
    s.gen_s += Number(out.gen_seconds) || 0;
    if (out.cold) s.cold += 1;
    s.last_at = Date.now();
  } else {
    s.failed += 1;
  }
  s.gpu_s += (Number(job.executionTime) || 0) / 1000;
  for (const d of Object.keys(s.days).sort().slice(0, -31)) delete s.days[d]; // keep ~a month
  await env.STATS.put("stats", JSON.stringify(s));
}

async function loadStats(env) {
  const base = { photos: 0, failed: 0, cold: 0, gen_s: 0, gpu_s: 0, last_at: 0, days: {} };
  try {
    return { ...base, ...(JSON.parse((await env.STATS.get("stats")) || "{}")) };
  } catch {
    return base;
  }
}

// ------------------------------------------------------------------ /stats
async function statsText(env) {
  const lines = ["📊 Bot stats", ""];
  if (env.STATS) {
    const s = await loadStats(env);
    const today = s.days[new Date().toISOString().slice(0, 10)] || 0;
    const week = Object.entries(s.days)
      .filter(([d]) => Date.now() - Date.parse(d) < 7 * 864e5)
      .reduce((a, [, n]) => a + n, 0);
    lines.push(`📸 Photos: ${s.photos} total · ${today} today · ${week} this week`);
    if (s.photos) lines.push(`⏱ Average generation: ${(s.gen_s / s.photos).toFixed(1)}s`);
    lines.push(`❄️ Cold starts: ${s.cold}`);
    lines.push(`❌ Failed: ${s.failed}`);
    const price = Number(env.GPU_PRICE_PER_SECOND);
    const gpu = `${(s.gpu_s / 60).toFixed(1)} min`;
    if (price > 0) {
      const cost = s.gpu_s * price;
      const per = s.photos ? ` · ~$${(cost / s.photos).toFixed(3)} per photo` : "";
      lines.push(`💸 GPU time: ${gpu} · ~$${cost.toFixed(2)}${per}`);
    } else {
      lines.push(`💸 GPU time: ${gpu} (set GPU_PRICE_PER_SECOND to see the cost)`);
    }
    if (s.last_at) lines.push(`🕒 Last photo: ${ago(s.last_at)}`);
  } else {
    lines.push("History is off. Add a KV binding named STATS in Cloudflare to count photos, times and cost.");
  }

  try {
    const r = await fetch(`https://api.runpod.ai/v2/${env.RUNPOD_ENDPOINT_ID}/health`, {
      headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}` },
    });
    if (r.ok) {
      const h = await r.json();
      const w = h.workers || {};
      const j = h.jobs || {};
      const busy = (w.running || 0) > 0 || (j.inProgress || 0) > 0;
      lines.push("");
      lines.push(`🖥 GPU right now: ${busy ? "working" : (w.idle || 0) > 0 ? "awake, idle" : "asleep ($0)"}`);
      lines.push(`   workers: ${w.running || 0} running · ${w.idle || 0} idle · jobs: ${j.inProgress || 0} in progress · ${j.inQueue || 0} queued`);
    }
  } catch {
    // RunPod status is a bonus; the history above still shows
  }
  return lines.join("\n");
}

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

// ------------------------------------------------------------------ helpers
async function telegram(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

function send(env, chat_id, text) {
  return telegram(env, "sendMessage", { chat_id, text });
}

async function secret(env) {
  // Telegram and RunPod send this back on every call, so random people can't trigger anything
  const data = new TextEncoder().encode("ai-empire:" + env.TELEGRAM_BOT_TOKEN);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

function text(body) {
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
