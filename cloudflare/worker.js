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
// Everything else (LoRA strengths, size, sampler, post-processing) is fixed in the workflow.

const HELP = [
  "👋 Paste your full prompt and I'll send the photo back.",
  "",
  "Start with your trigger word, then the scene: photo type, pose, outfit, place, light, framing.",
  "Your prompt goes in exactly as you type it. Nothing is added.",
  "",
  "The first photo after a break takes 1–3 minutes (the GPU wakes up), then it's much faster.",
].join("\n");

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
      return text(res.ok
        ? "✅ Bot connected! Open your bot in Telegram and send it any message."
        : `❌ Telegram said: ${res.description || JSON.stringify(res)}\n(check TELEGRAM_BOT_TOKEN)`);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await secret(env))) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      ctx.waitUntil(onMessage(update.message, env));
      return new Response("ok");
    }

    return text("AI Empire NSFW bot is running. Open /setup once to connect it to Telegram.");
  },
};

async function onMessage(msg, env) {
  if (!msg || !msg.chat) return;
  const chat = msg.chat.id;
  const from = String(msg.from?.id ?? "");
  const owners = String(env.OWNER_ID || "").split(",").map((s) => s.trim()).filter(Boolean);

  if (!owners.length) {
    return send(env, chat, `🔒 Almost done! Your Telegram ID is ${from}\n\nPut it in Cloudflare as OWNER_ID (Settings → Variables and Secrets), deploy, and message me again. This makes the bot answer only you, so nobody else can spend your RunPod credits.`);
  }
  if (!owners.includes(from)) return send(env, chat, "🔒 This is a private bot.");

  const prompt = (msg.text || "").trim();
  if (!prompt || prompt === "/start" || prompt === "/help") return send(env, chat, HELP);
  if (prompt.startsWith("/")) return send(env, chat, HELP);

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
  // Telegram sends this back on every webhook call, so random people can't trigger generations
  const data = new TextEncoder().encode("ai-empire:" + env.TELEGRAM_BOT_TOKEN);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

function text(body) {
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
