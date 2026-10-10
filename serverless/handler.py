"""AI Empire · Krea 2 NSFW Telegram generator: RunPod serverless handler.

Runs workflow_api.json, which is the "AI Empire Krea2 NSFW V1.5 (clean prompt paste)" workflow
converted 1:1. Every setting is unchanged. Per job only these things change:
  - the positive prompt (node 6) = what you typed, pasted as-is
  - LoRA slot 3 (node 28, lora_3) = your character LoRA, downloaded from your link, strength 1.0
  - new random seeds (KSampler + Renoise), so every message gives a new photo

Job input (sent by the Cloudflare bot):
  prompt          the full prompt, pasted as-is
  lora_url        direct link to your character LoRA .safetensors (Dropbox, Google Drive or Hugging Face)
  telegram_token  your bot token  } when given, the photo is sent straight to this chat
  chat_id         your chat id    }
  seed            optional: fixed seed instead of a random one
Without telegram_token the image comes back as base64 (handy for RunPod's "Requests" test tab).
"""
import base64
import copy
import hashlib
import io
import json
import os
import random
import re
import time
import uuid

import requests

COMFY = "http://127.0.0.1:8188"
COMFY_DIR = "/ComfyUI"
LORA_DIR = os.path.join(COMFY_DIR, "models", "loras")
OUTPUT_DIR = os.path.join(COMFY_DIR, "output")
HERE = os.path.dirname(os.path.abspath(__file__))
WORKFLOW_FILE = os.path.join(HERE, "workflow_api.json")

PROMPT_NODE = "6"
LORA_NODE = "28"
CHARACTER_SLOT = "lora_3"
SEED_NODES = ("98", "110")      # KSampler, Aiorbust Renoise
OUTPUT_NODE = "112"             # Save Image (no metadata), JPEG 100


def log(*a):
    print("[ai-empire]", *a, flush=True)


# ------------------------------------------------------------------ workflow
def build_workflow(prompt, lora_name=None, seed=None):
    """The saved workflow with only prompt, character LoRA and seeds filled in."""
    with open(WORKFLOW_FILE) as f:
        wf = json.load(f)
    wf = copy.deepcopy(wf)
    wf[PROMPT_NODE]["inputs"]["text"] = prompt
    slot = wf[LORA_NODE]["inputs"][CHARACTER_SLOT]
    if lora_name:
        slot["lora"] = lora_name
        slot["on"] = True
    else:  # no character LoRA given: leave the slot switched off
        slot["on"] = False
    base = int(seed) if seed is not None else random.randint(1, 2**48)
    for i, node in enumerate(SEED_NODES):
        wf[node]["inputs"]["seed"] = base + i
    return wf, base


# ------------------------------------------------------------------ ComfyUI
def wait_for_comfy(timeout=900):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if requests.get(COMFY + "/system_stats", timeout=5).ok:
                if time.time() - t0 > 1:
                    log(f"ComfyUI ready after {time.time() - t0:.0f}s")
                return
        except requests.RequestException:
            pass
        if int(time.time() - t0) % 15 == 0:
            log(f"waiting for ComfyUI... {time.time() - t0:.0f}s")
        time.sleep(1)
    tail = ""
    try:
        with open("/tmp/comfyui.log") as f:
            tail = f.read()[-600:]
    except OSError:
        pass
    raise RuntimeError(f"ComfyUI did not start. Last log lines: {tail}")


def run(wf, timeout=900):
    r = requests.post(COMFY + "/prompt", json={"prompt": wf, "client_id": str(uuid.uuid4())}, timeout=60)
    if not r.ok:
        raise RuntimeError(f"ComfyUI refused the job: {r.text[:800]}")
    pid = r.json()["prompt_id"]
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = requests.get(f"{COMFY}/history/{pid}", timeout=30).json().get(pid)
        if h:
            status = h.get("status", {})
            if status.get("status_str") == "error":
                msgs = [m for m in status.get("messages", []) if m[0] == "execution_error"]
                detail = msgs[-1][1] if msgs else {}
                raise RuntimeError("generation failed: "
                                   f"{detail.get('node_type', '')} {detail.get('exception_message', 'unknown error')[:300]}")
            imgs = (h.get("outputs", {}).get(OUTPUT_NODE) or {}).get("images", [])
            if imgs:
                img = imgs[0]
                v = requests.get(f"{COMFY}/view", params={"filename": img["filename"], "subfolder": img.get("subfolder", ""),
                                                         "type": img.get("type", "output")}, timeout=60)
                v.raise_for_status()
                try:  # keep the worker disk clean
                    os.remove(os.path.join(OUTPUT_DIR, img.get("subfolder", ""), img["filename"]))
                except OSError:
                    pass
                return v.content
            if status.get("completed"):
                raise RuntimeError("the workflow finished without an image")
        time.sleep(0.5)
    raise RuntimeError("generation timed out")


# ------------------------------------------------------------------ LoRA download (cached per worker)
def drive_id(url):
    """File id from any Google Drive share link."""
    m = re.search(r"/file/d/([A-Za-z0-9_-]{10,})", url) or re.search(r"[?&]id=([A-Za-z0-9_-]{10,})", url)
    return m.group(1) if m else None


def direct_link(url):
    if "drive.google.com" in url or "drive.usercontent.google.com" in url:
        fid = drive_id(url)
        if fid:  # confirm=t skips Google's "can't scan this big file for viruses" page
            return f"https://drive.usercontent.google.com/download?id={fid}&export=download&confirm=t"
    if "dropbox.com" in url:
        url = url.replace("dl=0", "dl=1")
        if "dl=1" not in url:
            url += ("&" if "?" in url else "?") + "dl=1"
    if "huggingface.co" in url and "/blob/" in url:
        url = url.replace("/blob/", "/resolve/")
    return url


def fetch_lora(url):
    os.makedirs(LORA_DIR, exist_ok=True)
    name = "char_" + hashlib.sha1(url.encode()).hexdigest()[:12] + ".safetensors"
    path = os.path.join(LORA_DIR, name)
    if os.path.exists(path) and os.path.getsize(path) > 1_000_000:
        return name
    tmp = path + ".part"
    log("downloading LoRA")
    with requests.get(direct_link(url), stream=True, timeout=60, allow_redirects=True) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(8 << 20):
                f.write(chunk)
    ok = False
    if os.path.exists(tmp) and os.path.getsize(tmp) > 1_000_000:
        with open(tmp, "rb") as f:
            head = f.read(9)
        ok = len(head) == 9 and head[8:9] == b"{"  # safetensors: 8-byte length + JSON header
    if not ok:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise RuntimeError("the LoRA link didn't give me a .safetensors file. Use a direct download link "
                           "(Dropbox, Google Drive shared with 'Anyone with the link', or Hugging Face).")
    os.replace(tmp, path)
    log("LoRA ready", round(os.path.getsize(path) / 1e6), "MB")
    return name


# ------------------------------------------------------------------ Telegram
def tg(token, method, data=None, files=None):
    try:
        r = requests.post(f"https://api.telegram.org/bot{token}/{method}", data=data, files=files, timeout=120)
        return r.ok and r.json().get("ok", False)
    except requests.RequestException:
        return False


# ------------------------------------------------------------------ photo details
JOBS_DONE = 0  # per worker: the first job after a worker boots is a cold start


def image_size(data):
    try:
        from PIL import Image
        return Image.open(io.BytesIO(data)).size
    except Exception:
        return None


def caption_for(prompt, gen_s, setup_s, cold, seed, size, lora_on):
    speed = f"✅ Done in {gen_s:.1f}s"
    speed += f" · ❄️ cold start (+{setup_s:.0f}s wake-up)" if cold else " · ⚡ warm"
    info = f"🎲 Seed {seed}"
    if size:
        info += f" · 📐 {size[0]}×{size[1]}"
    info += " · 🧬 LoRA " + ("on" if lora_on else "off")
    head = f"{speed}\n{info}\n\n"
    return head + prompt[: 1000 - len(head)]  # margin: Telegram counts emoji as 2


# ------------------------------------------------------------------ handler
def handler(job):
    global JOBS_DONE
    t_job = time.time()
    cold = JOBS_DONE == 0
    inp = job.get("input") or {}
    token, chat = (inp.get("telegram_token") or "").strip(), inp.get("chat_id")
    notify = bool(token and chat)
    try:
        prompt = (inp.get("prompt") or "").strip()
        if not prompt:
            raise RuntimeError("empty prompt")
        if notify:
            tg(token, "sendChatAction", {"chat_id": chat, "action": "upload_photo"})
        lora_url = (inp.get("lora_url") or "").strip()
        lora = fetch_lora(lora_url) if lora_url else None
        wf, seed = build_workflow(prompt, lora, inp.get("seed"))
        log("job received, character LoRA:", lora or "none")
        wait_for_comfy()
        t0 = time.time()
        jpg = run(wf)
        gen_s, setup_s = time.time() - t0, t0 - t_job
        JOBS_DONE += 1
        log(f"image ready in {gen_s:.1f}s (seed {seed}, setup {setup_s:.0f}s, cold={cold})")
        result = {"ok": True, "seed": seed, "gen_seconds": round(gen_s, 1),
                  "setup_seconds": round(setup_s, 1), "cold": cold, "lora": bool(lora)}
        if notify:
            caption = caption_for(prompt, gen_s, setup_s, cold, seed, image_size(jpg), bool(lora))
            files = {"photo": ("photo.jpg", jpg, "image/jpeg")}
            if not tg(token, "sendPhoto", {"chat_id": chat, "caption": caption}, files):
                tg(token, "sendDocument", {"chat_id": chat, "caption": caption}, {"document": ("photo.jpg", jpg, "image/jpeg")})
            return {**result, "notified": True}
        return {**result, "image": base64.b64encode(jpg).decode()}
    except Exception as e:
        log("error:", e)
        sent = notify and tg(token, "sendMessage", {"chat_id": chat, "text": f"⚠️ Something went wrong: {e}"})
        # no "error" key on purpose: the bot already told the chat, so the job ends normally with ok=false
        # (a real crash or timeout still reaches the bot through RunPod's webhook and gets reported there)
        return {"ok": False, "message": str(e), "notified": bool(sent)}


if __name__ == "__main__":
    import runpod  # only needed on RunPod; build_workflow() is importable without it

    log("worker starting")
    runpod.serverless.start({"handler": handler})
