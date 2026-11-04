"""Smart Cart inference service (FastAPI + Ultralytics).

Only does inference: Node.js owns the database and all business logic.
Bound to 127.0.0.1 by default, so only the Node.js server on the same machine can call it.

    GET  /health                 model name, model.names, device
    POST /infer?cart_id=&seq=&track=   raw image/jpeg body (or multipart field "image")
    POST /model                  {"path": "...", "name": "..."} load other weights (under WEIGHTS_ROOT)
    DELETE /tracks/{cart_id}     forget the ByteTrack state of a cart (new session)

Weights are opened read-only; nothing is written next to them.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent


def load_env_file(path: Path) -> None:
    """Read KEY=VALUE lines from the repo .env (shared with Node.js); real env vars win."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.split(" #", 1)[0].strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), value)


load_env_file(ROOT / ".env")

# Ultralytics must be configured before it is imported:
#  - YOLO_AUTOINSTALL=false: a checkpoint that names a missing module (YOLOv6/v7/v13 weights) would otherwise make
#    Ultralytics pip-install a package of that name from PyPI at runtime (seen with "yolov6" -> yolov6==0.0.1 from
#    PyPI, not the repo the weights were trained with). Loading such weights now simply fails with MODEL_LOAD_FAILED.
#  - YOLO_OFFLINE=true: no online checks, asset downloads or usage telemetry (the service runs on a shop LAN).
#  - YOLO_CONFIG_DIR: keep Ultralytics' settings.json inside the repo (gitignored), not in %APPDATA%.
os.environ.setdefault("YOLO_AUTOINSTALL", "false")
os.environ.setdefault("YOLO_OFFLINE", "true")
os.environ.setdefault("YOLO_CONFIG_DIR", str(Path(__file__).resolve().parent / ".ultralytics"))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402
import ultralytics  # noqa: E402
from fastapi import FastAPI, HTTPException, Query, Request  # noqa: E402
from fastapi.concurrency import run_in_threadpool  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from pydantic import BaseModel  # noqa: E402
from ultralytics import YOLO  # noqa: E402
from ultralytics.trackers.byte_tracker import BYTETracker  # noqa: E402
from ultralytics.utils import SETTINGS, YAML  # noqa: E402
from ultralytics.utils.checks import check_yaml  # noqa: E402

SETTINGS.update({"sync": False})  # belt and braces: telemetry off in the repo-local settings file

log = logging.getLogger("inference")

WEIGHT_SUFFIXES = {".pt", ".engine", ".onnx"}
MAX_IMAGE_BYTES = 4 * 1024 * 1024
WARMUP_RUNS = 10


def _settings() -> SimpleNamespace:
    url = urlparse(os.environ.get("INFERENCE_URL", "http://127.0.0.1:8001"))
    return SimpleNamespace(
        model_path=os.environ.get("MODEL_PATH", str(ROOT / "models" / "v11" / "best.pt")),
        model_name=os.environ.get("MODEL_NAME") or None,
        weights_root=Path(os.environ.get("WEIGHTS_ROOT", str(ROOT / "models"))).resolve(),
        device=os.environ.get("INFER_DEVICE", "auto"),
        imgsz=int(os.environ.get("INFER_IMGSZ", "640")),
        conf=float(os.environ.get("INFER_CONF", "0.25")),
        track_idle_ms=int(os.environ.get("TRACK_IDLE_MS", "60000")),
        host=os.environ.get("INFERENCE_HOST", "127.0.0.1"),
        port=url.port or 8001,
    )


S = _settings()


def pick_device(pref: str) -> str:
    if pref != "auto":
        return pref
    return "cuda:0" if torch.cuda.is_available() else "cpu"


def model_name_from_path(path: Path) -> str:
    """Same name as model_versions.name.

    models/v11/best.pt next to yolo11s-s1-20261104-test-metrics.json -> yolo11s-20261104 (model_name + run_date of
    the metrics file; the seed is not part of the name), .../<run>/weights/best.pt -> <run>, otherwise the file stem.
    """
    for metrics in sorted(path.parent.glob("*-test-metrics.json")):
        try:
            m = json.loads(metrics.read_text(encoding="utf-8"))
            return f"{m['model_name']}-{m['run_date']}"
        except (OSError, ValueError, KeyError):
            continue
    return path.parent.parent.name if path.parent.name == "weights" else path.stem


class LoadedModel:
    """One set of weights, warmed up and ready."""

    def __init__(self, path: Path, name: str, device: str, imgsz: int):
        t0 = time.perf_counter()
        self.model = YOLO(str(path), task="detect")
        self.path, self.name, self.device, self.imgsz = path, name, device, imgsz
        self.half = device.startswith("cuda") and path.suffix == ".pt"
        names = self.model.names
        self.names = [names[i] for i in sorted(names)] if isinstance(names, dict) else list(names)
        self.load_ms = round((time.perf_counter() - t0) * 1000, 1)
        self.warmup_ms = self._warmup()
        self.loaded_at_ms = int(time.time() * 1000)

    def predict(self, img: np.ndarray, conf: float):
        """Detect on one BGR frame of any aspect ratio.

        Ultralytics letterboxes the frame (LetterBox: one scale factor for both axes so the long side fits imgsz,
        the rest padded with grey; rect/auto padding to the stride for .pt weights) — never a plain resize to
        imgsz x imgsz and never a crop. Boxes are then mapped back through the padding and scale, so
        result.boxes.xyxyn is normalised to THIS image (orig_shape), not to the padded network input.
        """
        # quantize=16 is FP16 on CUDA (replaces the deprecated half=True); None keeps FP32 / the artifact's own precision
        return self.model.predict(img, conf=conf, imgsz=self.imgsz, device=self.device,
                                  quantize=16 if self.half else None, verbose=False)[0]

    def _warmup(self) -> float:
        """Run WARMUP_RUNS dummy frames per input shape so the first real frame is not slow.

        Letterboxing keeps the aspect ratio, so landscape (4:3), portrait (3:4) and square frames reach the
        network as different tensor shapes and each one triggers its own cuDNN autotune on first use.
        Returns the median latency of the landscape shape (the usual phone frame, 640x480).
        """
        rng = np.random.default_rng(0)
        s = self.imgsz
        medians = []
        for h, w in ((s * 3 // 4, s), (s, s * 3 // 4), (s, s)):
            dummy = rng.integers(0, 255, (h, w, 3), dtype=np.uint8)
            times = []
            for _ in range(WARMUP_RUNS):
                t = time.perf_counter()
                self.predict(dummy, 0.25)
                times.append((time.perf_counter() - t) * 1000)
            medians.append(float(np.median(times[-5:])))
        return round(medians[0], 2)


class CartTracker:
    """ByteTrack state of one cart (tracker mode (c) for RQ4). Track IDs are local to the cart."""

    def __init__(self, cfg: SimpleNamespace):
        # bytetrack.yaml defaults (track_buffer=30 frames); IDs are per tracker, so carts never share IDs
        self.tracker = BYTETracker(cfg)
        self.last_used_ms = time.time() * 1000

    def update(self, boxes) -> dict[int, int]:
        """Returns {detection index: track_id}. Detections ByteTrack did not confirm get no ID."""
        self.last_used_ms = time.time() * 1000
        tracks = self.tracker.update(boxes.cpu().numpy())
        # rows: x1, y1, x2, y2, track_id, score, cls, det_index
        return {int(row[-1]): int(row[4]) for row in tracks}


class Engine:
    def __init__(self):
        self.lock = threading.Lock()  # one GPU job at a time; Node.js also sends one frame at a time
        self.current: LoadedModel | None = None
        self.trackers: dict[str, CartTracker] = {}
        self.track_cfg = SimpleNamespace(**YAML.load(check_yaml("bytetrack.yaml")))
        self.device = pick_device(S.device)

    def check_path(self, raw: str) -> Path:
        path = Path(raw).expanduser().resolve()
        default = Path(S.model_path).expanduser().resolve()
        if path != default and not path.is_relative_to(S.weights_root):
            raise HTTPException(403, {"error": "PATH_NOT_ALLOWED", "message": f"weights must be under {S.weights_root}"})
        if path.suffix.lower() not in WEIGHT_SUFFIXES:
            raise HTTPException(422, {"error": "UNSUPPORTED_FORMAT", "message": f"expected one of {sorted(WEIGHT_SUFFIXES)}"})
        if not path.is_file():
            raise HTTPException(404, {"error": "WEIGHTS_NOT_FOUND", "message": str(path)})
        return path

    def load(self, raw_path: str, name: str | None = None) -> LoadedModel:
        path = self.check_path(raw_path)
        try:
            loaded = LoadedModel(path, name or model_name_from_path(path), self.device, S.imgsz)
        except HTTPException:
            raise
        except Exception as exc:  # e.g. YOLOv6/v7/v13 checkpoints need their own repos, not Ultralytics
            log.exception("failed to load %s", path)
            raise HTTPException(422, {"error": "MODEL_LOAD_FAILED", "message": f"{type(exc).__name__}: {exc}"}) from exc
        with self.lock:
            old, self.current = self.current, loaded
            self.trackers.clear()
        if old is not None:
            del old
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        log.info("model %s ready on %s (load %.0f ms, warm-up median %.1f ms)", loaded.name, self.device,
                 loaded.load_ms, loaded.warmup_ms)
        return loaded

    def infer(self, img: np.ndarray, cart_id: str | None, track: bool) -> dict:
        with self.lock:
            m = self.current
            t0 = time.perf_counter()
            result = m.predict(img, S.conf)
            infer_ms = (time.perf_counter() - t0) * 1000
            ids: dict[int, int] = {}
            if track:
                key = cart_id or "_"
                tracker = self.trackers.get(key)
                if tracker is None:
                    tracker = self.trackers[key] = CartTracker(self.track_cfg)
                ids = tracker.update(result.boxes)
            self._evict_idle()
        b = result.boxes
        xyxyn = b.xyxyn.cpu().numpy().tolist()
        cls = b.cls.cpu().numpy().astype(int).tolist()
        conf = b.conf.cpu().numpy().tolist()
        detections = []
        for i, (box, c, p) in enumerate(zip(xyxyn, cls, conf)):
            d = {
                "class_name": m.names[c] if c < len(m.names) else str(c),
                "class_id": c,
                "conf": round(p, 4),
                "x1": round(box[0], 5), "y1": round(box[1], 5), "x2": round(box[2], 5), "y2": round(box[3], 5),
            }
            if track:
                d["track_id"] = ids.get(i)
            detections.append(d)
        # w/h = the decoded frame the boxes are normalised to (after EXIF orientation, before letterboxing)
        return {
            "detections": detections,
            "model": m.name,
            "infer_ms": round(infer_ms, 2),
            "speed": {k: round(v, 2) for k, v in result.speed.items()},
            "w": int(img.shape[1]),
            "h": int(img.shape[0]),
        }

    def reset_tracks(self, cart_id: str) -> bool:
        with self.lock:
            return self.trackers.pop(cart_id, None) is not None

    def _evict_idle(self) -> None:
        now = time.time() * 1000
        for key in [k for k, t in self.trackers.items() if now - t.last_used_ms > S.track_idle_ms]:
            del self.trackers[key]


engine = Engine()

# Every prediction runs on ONE long-lived thread. The first CUDA call on a new thread costs ~1.5 s on this machine
# (per-thread cuBLAS/cuDNN setup, measured on the RTX 3050 Laptop), and the shared FastAPI threadpool hands requests
# to fresh threads (idle workers exit; a concurrent DELETE /tracks at session start pushes /infer onto a new one) —
# that stalled the first frame of every session for ~1.6 s and the frame queue dropped what arrived meanwhile.
GPU_THREAD = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gpu")


async def on_gpu_thread(fn, *args):
    return await asyncio.get_running_loop().run_in_executor(GPU_THREAD, fn, *args)


def warm_gpu_thread() -> float:
    """Dummy predictions on the GPU thread so its per-thread CUDA/cuDNN setup happens at start, not on a customer
    frame — for each letterbox shape a phone sends: 4:3 landscape, 3:4 portrait, 1:1 (one setup per shape)."""
    t0 = time.perf_counter()
    s = S.imgsz
    for h, w in ((s * 3 // 4, s), (s, s * 3 // 4), (s, s)):
        engine.current.predict(np.zeros((h, w, 3), np.uint8), S.conf)
    return (time.perf_counter() - t0) * 1000


@asynccontextmanager
async def lifespan(_: FastAPI):
    await run_in_threadpool(engine.load, S.model_path, S.model_name)
    log.info("gpu thread ready (first call %.0f ms)", await on_gpu_thread(warm_gpu_thread))
    yield


app = FastAPI(title="Smart Cart inference", version="0.1.0", lifespan=lifespan)


@app.exception_handler(HTTPException)
async def http_error(_: Request, exc: HTTPException):
    body = exc.detail if isinstance(exc.detail, dict) else {"error": "HTTP_ERROR", "message": str(exc.detail)}
    return JSONResponse(body, status_code=exc.status_code)


@app.get("/health")
def health():
    m = engine.current
    return {
        "status": "ok" if m else "loading",
        "model": m.name if m else None,
        "model_path": str(m.path) if m else None,
        "names": m.names if m else [],
        "nc": len(m.names) if m else 0,
        "device": engine.device,
        "device_name": torch.cuda.get_device_name(0) if engine.device.startswith("cuda") else platform.processor(),
        "half": m.half if m else None,
        "imgsz": S.imgsz,
        "conf": S.conf,
        "load_ms": m.load_ms if m else None,
        "warmup_ms": m.warmup_ms if m else None,
        "loaded_at_ms": m.loaded_at_ms if m else None,
        "trackers": len(engine.trackers),
        "versions": {"python": platform.python_version(), "torch": torch.__version__, "ultralytics": ultralytics.__version__},
    }


def decode_image(data: bytes) -> np.ndarray | None:
    """JPEG/PNG bytes -> upright BGR image, or None if the bytes are not an image.

    cv2.IMREAD_COLOR applies the EXIF Orientation tag (OpenCV >= 3.1; IMREAD_IGNORE_ORIENTATION is NOT set), so a
    phone photo stored sideways with Orientation=6/8 comes out upright, with the width/height the user saw.
    Canvas-encoded frames from device.html carry no EXIF and are decoded as they are. No resize, no crop here.
    """
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    return img if img is not None and img.size else None


async def read_image(request: Request) -> bytes:
    ctype = request.headers.get("content-type", "")
    if ctype.startswith("multipart/form-data"):
        form = await request.form()
        file = form.get("image")
        if file is None or isinstance(file, str):
            raise HTTPException(400, {"error": "BAD_IMAGE", "message": 'multipart field "image" is required'})
        data = await file.read()
    else:
        data = await request.body()
    if not data:
        raise HTTPException(400, {"error": "BAD_IMAGE", "message": "empty body"})
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(413, {"error": "IMAGE_TOO_LARGE", "message": f"max {MAX_IMAGE_BYTES} bytes"})
    return data


@app.post("/infer")
async def infer(
    request: Request,
    cart_id: str | None = Query(None, max_length=64),
    seq: int | None = Query(None),
    track: bool = Query(False),
):
    t0 = time.perf_counter()
    data = await read_image(request)
    img = decode_image(data)
    if img is None:
        raise HTTPException(400, {"error": "BAD_IMAGE", "message": "cannot decode image (expected JPEG/PNG)"})
    decode_ms = (time.perf_counter() - t0) * 1000
    out = await on_gpu_thread(engine.infer, img, cart_id, track)
    out.update({"cart_id": cart_id, "seq": seq, "decode_ms": round(decode_ms, 2)})
    return out


class ModelRequest(BaseModel):
    path: str
    name: str | None = None


@app.post("/model")
async def switch_model(req: ModelRequest):
    m = await run_in_threadpool(engine.load, req.path, req.name)
    await on_gpu_thread(warm_gpu_thread)  # the new layers get their GPU-thread setup now, not on the next customer frame
    return {"model": m.name, "model_path": str(m.path), "names": m.names, "load_ms": m.load_ms, "warmup_ms": m.warmup_ms}


@app.delete("/tracks/{cart_id}")
def reset_tracks(cart_id: str):
    return {"cart_id": cart_id, "reset": engine.reset_tracks(cart_id)}


if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # access_log off: one line per frame would flood the console
    uvicorn.run(app, host=S.host, port=S.port, access_log=False, log_level="info")
