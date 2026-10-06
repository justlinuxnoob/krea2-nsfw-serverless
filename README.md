# AI Empire · Krea 2 NSFW Telegram generator

Text your private Telegram bot a prompt and get a photo of **your** AI character back.

It runs the **AI Empire Krea 2 NSFW V1.5 (clean prompt paste)** workflow with every setting unchanged:

| | |
|---|---|
| Model | Krea 2 Turbo fp8 · Qwen3-VL 4B fp8 · Wan 2.1 VAE |
| LoRAs | skindetails **0.5** · RawGirlV2 **0.75** · **your character LoRA 1.0** · Refusal Reduction **1.0** |
| Sampling | 8 steps · CFG 1 · euler_ancestral · beta57 · shift 6 · 9:16 at 2 MP (1088×1920) |
| Post | Camera Look → Renoise (ISO 1600) → CRT Post-Process → clean JPEG (no metadata) |

Your character LoRA is downloaded from your link (Dropbox works) and put into LoRA slot 3 automatically.
Your prompt goes in exactly as you type it. Every photo gets a new random seed.

- **Bot:** a Cloudflare Worker on the free plan. It never sleeps.
- **Generator:** a RunPod Serverless endpoint. It costs **$0 while idle**. You pay only while the GPU makes a photo.
- **Private:** the bot answers only the Telegram IDs you allow.

Use it for an original AI character only. Never a real person's face.

---

## 1 · Put your LoRA online

- **Dropbox:** upload → Share → Copy link. `dl=0` is changed to `dl=1` for you.
- **Google Drive:** upload → Share → General access: **Anyone with the link** → Copy link.
- **Hugging Face:** a public model repo, copy the file's link.

## 2 · Make the bot in Telegram

**@BotFather** → `/newbot` → pick a name and username → copy the **token**.

## 3 · Start the generator on RunPod

RunPod → **Serverless** → **New Endpoint** → **Import from Docker Registry**:

```
ghcr.io/justlinuxnoob/krea2-nsfw-serverless:latest
```

Settings:

- **GPU:** 24 GB (4090 / 3090 / L4…). Out-of-memory errors? Use 48 GB.
- **Max workers:** 1
- **Idle timeout:** 5 s
- **FlashBoot:** on
- **Container disk:** 20 GB
- **Environment variables:** none

Copy the **Endpoint ID**, then make an API key: RunPod → **Settings** → **API Keys**.

## 4 · Start the bot on Cloudflare (free)

1. dash.cloudflare.com → **Workers & Pages** → **Create** → *Hello World* → name it → **Deploy**.
2. **Edit code** → delete everything → paste [`cloudflare/worker.js`](cloudflare/worker.js) → **Deploy**.
3. **Settings → Variables and Secrets**:

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the token from BotFather |
| `RUNPOD_API_KEY` | your RunPod API key |
| `RUNPOD_ENDPOINT_ID` | your endpoint ID |
| `LORA_URL` | your LoRA link from step 1 |
| `OWNER_ID` | leave empty for now |

4. Deploy, then open `https://<your-worker>.workers.dev/setup` → **"Bot connected!"**
5. Message your bot. It replies with **your Telegram ID**.
6. Put that number in `OWNER_ID` → **Deploy**. Done. (More people: IDs separated by commas.)

## Speed

- First photo after a break: **1 to 3 minutes** (the GPU wakes up, loads the models and downloads your LoRA).
- After that it's much faster while the worker is warm.

## Troubleshooting

- **Bot doesn't answer:** open `/setup` again and follow what it says.
- **"This is a private bot.":** your Telegram ID isn't in `OWNER_ID`.
- **"RunPod rejected the API key" / "can't find that endpoint":** re-copy `RUNPOD_API_KEY` / `RUNPOD_ENDPOINT_ID`.
- **"the LoRA link didn't give me a .safetensors file":** the link opens a web page, not the file. Check sharing.
- **Out of memory:** switch the endpoint to a 48 GB GPU.
- **Changed your LoRA:** update `LORA_URL` and deploy. The next photo downloads it (slow once).

---

### How it's built

`ghcr.io/justlinuxnoob/krea2-nsfw-serverless` = the `krea2-nsfw` pod image (same ComfyUI and nodes)
+ the models baked in + `serverless/handler.py`. GitHub Actions builds it on every push to `main`:
it first starts ComfyUI from the base image on CPU and submits the workflow (so a wrong node or
setting fails the build), then stacks the models and handler on top of the base.

- `serverless/workflow_api.json`: the workflow (API format). Slot `lora_3` is filled with your LoRA per job.
- `serverless/handler.py`: downloads your LoRA, runs the workflow, sends the photo to Telegram.
- `serverless/start.sh`: starts ComfyUI (same flags as the pod) and the handler.
- `cloudflare/worker.js`: the Telegram bot.
