# AI Empire · Krea 2 NSFW serverless worker
# Used when RunPod builds this repo itself (Serverless → "GitHub repo" / RunPod Hub, on each GitHub release).
# The real image is built and checked by GitHub Actions (.github/workflows/build.yml): the krea2-nsfw base +
# models baked in + serverless/handler.py, and the workflow is validated against the installed nodes first.
# This file just uses that finished image, so RunPod runs exactly what was checked.
FROM ghcr.io/justlinuxnoob/krea2-nsfw-serverless:latest
