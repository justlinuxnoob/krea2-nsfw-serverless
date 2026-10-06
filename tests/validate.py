"""CI check: submit the real workflow (with a test character LoRA) to ComfyUI running on CPU inside the
base image. ComfyUI validates every node, input name, option and number range before it runs anything,
so if this passes, the workflow matches the installed nodes exactly. (The dummy models then fail to load:
that part is expected and ignored.)"""
import json
import sys
import urllib.request

sys.path.insert(0, "/aiempire")
import handler  # noqa: E402

BASE = "http://127.0.0.1:8188"


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        return json.loads(r.read())


info = get("/object_info")
wf, _ = handler.build_workflow("validation test prompt", "char_test.safetensors", 1)
missing = sorted({n["class_type"] for n in wf.values()} - set(info))
print("node classes in workflow:", sorted({n["class_type"] for n in wf.values()}))
if missing:
    print("MISSING NODE CLASSES:", missing)
    sys.exit(1)

req = urllib.request.Request(BASE + "/prompt", data=json.dumps({"prompt": wf}).encode(),
                             headers={"Content-Type": "application/json"})
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        res = json.loads(r.read())
except urllib.error.HTTPError as e:
    print("PROMPT REJECTED:", e.read().decode()[:3000])
    sys.exit(1)
if res.get("node_errors"):
    print("NODE ERRORS:", json.dumps(res["node_errors"])[:3000])
    sys.exit(1)
print("WORKFLOW ACCEPTED by ComfyUI, prompt_id", res.get("prompt_id"))
