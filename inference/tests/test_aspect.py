"""The phone frame keeps its aspect ratio all the way to the model, and boxes come back normalised to it.

    npm run inference:test

- decode: EXIF orientation is applied (no weights needed)
- letterbox: the network input keeps the frame's ratio (no plain resize to imgsz x imgsz, no crop)
- boxes: 4:3, 3:4 and 1:1 frames of the same basket -> the same boxes in each frame's own 0-1 coordinates
"""

import io
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

import app as service

ROOT = Path(__file__).resolve().parents[2]
CAMERA = ROOT / "web" / "assets" / "camera"  # 1600x1200 (4:3) basket photos of the prototype
needs_model = pytest.mark.skipif(not Path(service.S.model_path).is_file(), reason="MODEL_PATH weights not found")


def upright(name: str = "img-1321.jpg") -> np.ndarray:
    return cv2.imread(str(CAMERA / name), cv2.IMREAD_COLOR)


def encode(img: np.ndarray, quality: int = 95) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    assert ok
    return buf.tobytes()


def with_exif_orientation(stored_bgr: np.ndarray, orientation: int) -> bytes:
    exif = Image.Exif()
    exif[0x0112] = orientation
    out = io.BytesIO()
    Image.fromarray(stored_bgr[:, :, ::-1]).save(out, "JPEG", quality=95, exif=exif.tobytes())
    return out.getvalue()


# --------------------------------------------------------------------------- decode (no weights)


@pytest.mark.parametrize(
    ("orientation", "stored"),
    [
        # Orientation 6 = "rotate 90° clockwise to view": the camera stored the upright picture turned counter-clockwise
        (6, cv2.ROTATE_90_COUNTERCLOCKWISE),
        (8, cv2.ROTATE_90_CLOCKWISE),
        (3, cv2.ROTATE_180),
    ],
)
def test_decode_applies_exif_orientation(orientation, stored):
    up = cv2.resize(upright(), (400, 300), interpolation=cv2.INTER_AREA)  # small: fast, still 4:3
    data = with_exif_orientation(cv2.rotate(up, stored), orientation)
    img = service.decode_image(data)
    assert img.shape == up.shape, "decoded with the width/height the user saw (EXIF applied)"
    assert float(np.mean(np.abs(img.astype(int) - up.astype(int)))) < 6, "pixels upright, not just the shape"


def test_decode_keeps_size_and_rejects_non_images():
    for w, h in ((480, 640), (640, 480), (512, 512)):
        img = service.decode_image(encode(np.full((h, w, 3), 128, np.uint8)))
        assert img.shape == (h, w, 3), "no resize or crop while decoding"
    assert service.decode_image(b"not a jpeg") is None


# --------------------------------------------------------------------------- model (real weights)


@pytest.fixture(scope="module")
def client():
    with TestClient(service.app) as c:  # lifespan: load + warm-up
        yield c


def detect(client, img: np.ndarray) -> dict:
    r = client.post("/infer", content=encode(img), headers={"content-type": "image/jpeg"})
    assert r.status_code == 200, r.text
    return r.json()


def iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def boxes(body: dict) -> list[tuple[str, list[float]]]:
    return sorted((d["class_name"], [d["x1"], d["y1"], d["x2"], d["y2"]]) for d in body["detections"])


def pad_to(img: np.ndarray, ratio_w: int, ratio_h: int):
    """Grey bars around the frame so it becomes ratio_w:ratio_h; returns the new frame and the pixel offset."""
    h, w = img.shape[:2]
    if w * ratio_h >= h * ratio_w:
        H, W = round(w * ratio_h / ratio_w), w
    else:
        H, W = h, round(h * ratio_w / ratio_h)
    oy, ox = (H - h) // 2, (W - w) // 2
    out = np.full((H, W, 3), 114, np.uint8)
    out[oy:oy + h, ox:ox + w] = img
    return out, ox, oy


@needs_model
@pytest.mark.parametrize(("w", "h"), [(640, 480), (480, 640), (640, 640), (1280, 720)])
def test_network_input_is_letterboxed_not_stretched(client, w, h):
    m = service.engine.current
    img = np.full((h, w, 3), 128, np.uint8)
    m.predict(img, 0.25)  # creates / configures the predictor for this call
    lb = m.model.predictor.pre_transform([img])[0]
    s = min(m.imgsz / w, m.imgsz / h)  # one scale factor for both axes
    new_w, new_h = round(w * s), round(h * s)
    assert max(lb.shape[:2]) == m.imgsz
    # the picture keeps its ratio; only padding (at most one stride) is added, nothing is cut
    assert 0 <= lb.shape[1] - new_w < 32 and 0 <= lb.shape[0] - new_h < 32, (lb.shape, new_w, new_h)


@needs_model
def test_boxes_are_normalised_to_each_original_frame_43_34_11(client):
    base = upright()  # 4:3 landscape, 1600x1200
    ref = boxes(detect(client, base))
    assert [c for c, _ in ref] == ["bengbeng_pack12", "koalas_march_chocolate", "rosdee_mid_pork"]
    h, w = base.shape[:2]

    # 4:3 at phone size (what device.html sends: long side 640, short side from the ratio)
    small = cv2.resize(base, (640, 480), interpolation=cv2.INTER_AREA)
    body = detect(client, small)
    assert (body["w"], body["h"]) == (640, 480)
    got = boxes(body)
    assert [c for c, _ in got] == [c for c, _ in ref]
    for (_, a), (_, b) in zip(ref, got):
        assert iou(a, b) > 0.9

    # 3:4 portrait (phone held upright) and 1:1: same basket inside a frame of another shape.
    # Expected box = reference box moved into the new frame, then normalised to the NEW frame's own size.
    for rw, rh in ((3, 4), (1, 1)):
        frame, ox, oy = pad_to(base, rw, rh)
        H, W = frame.shape[:2]
        assert abs(W / H - rw / rh) < 1e-3
        body = detect(client, frame)
        assert (body["w"], body["h"]) == (W, H), "boxes refer to the frame as sent, not the padded network input"
        got = boxes(body)
        assert [c for c, _ in got] == [c for c, _ in ref], f"{rw}:{rh}"
        for (cls, a), (_, b) in zip(ref, got):
            expect = [(a[0] * w + ox) / W, (a[1] * h + oy) / H, (a[2] * w + ox) / W, (a[3] * h + oy) / H]
            assert iou(expect, b) > 0.85, f"{rw}:{rh} {cls}: expected {expect}, got {b}"
            assert all(0 <= v <= 1 for v in b)

    # portrait for real: the phone turned 90° (pixels rotated, not padded) -> boxes rotate with the frame
    rot = cv2.rotate(base, cv2.ROTATE_90_CLOCKWISE)  # 1200x1600
    body = detect(client, rot)
    assert (body["w"], body["h"]) == (h, w)
    got = boxes(body)
    # (x, y) -> (1 - y, x) under a clockwise turn
    rotated = [(c, [1 - a[3], a[0], 1 - a[1], a[2]]) for c, a in ref]
    for cls, e in rotated:
        best = max((iou(e, b) for c, b in got if c == cls), default=0)
        assert best > 0.8, f"rotated {cls}: best IoU {best:.2f} ({got})"
