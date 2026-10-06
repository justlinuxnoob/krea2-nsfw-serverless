#!/usr/bin/env bash
# AI Empire · Krea 2 NSFW serverless worker — boot script.
# Starts ComfyUI with the same flags as the krea2-nsfw pod, then the RunPod handler.
# Models are already inside the image, nothing is downloaded here (only your character LoRA, per job).

TCMALLOC="$(ldconfig -p | grep -Po "libtcmalloc.so.\d" | head -n 1)"
export LD_PRELOAD="${TCMALLOC}"
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

cd /ComfyUI
python3 main.py --listen 127.0.0.1 --port 8188 --disable-smart-memory --disable-cuda-malloc \
    > /tmp/comfyui.log 2>&1 &

# the handler waits for ComfyUI itself; runpod SDK lives in /opt/rp so it never touches ComfyUI's packages
cd /aiempire
exec env PYTHONPATH=/opt/rp python3 -u handler.py
