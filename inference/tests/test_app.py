"""Inference service tests with the real weights (skipped when MODEL_PATH is not on this machine).

    npm run inference:test      (= uv run --directory inference pytest -q)
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app as service

ROOT = Path(__file__).resolve().parents[2]
CAMERA = ROOT / "web" / "assets" / "camera"
CLASSES_11 = [
    "bengbeng_pack12", "doritos_mid_nacho", "koalas_march_chocolate", "kohkae_small_wasabi", "lay_big_nori",
    "lay_big_ori", "lay_party_ori", "mama_cup_ok_cheeseGo", "mama_cup_ok_hotKR", "pringles_norm_ori", "rosdee_mid_pork",
]

pytestmark = pytest.mark.skipif(not Path(service.S.model_path).is_file(), reason="MODEL_PATH weights not found")


@pytest.fixture(scope="module")
def client():
    with TestClient(service.app) as c:  # runs the lifespan: load + warm-up
        yield c


def jpeg(name="img-1321.jpg") -> bytes:
    return (CAMERA / name).read_bytes()


def test_health_lists_the_11_trained_classes(client):
    h = client.get("/health").json()
    assert h["status"] == "ok"
    assert h["model"] == "yolo11s-s0-20261025"
    assert h["names"] == CLASSES_11
    assert h["nc"] == 11
    assert h["device"] in ("cpu", "cuda:0")
    assert h["warmup_ms"] > 0


def test_infer_raw_jpeg_returns_normalised_boxes(client):
    r = client.post("/infer?cart_id=A-08&seq=7", content=jpeg(), headers={"content-type": "image/jpeg"})
    assert r.status_code == 200
    body = r.json()
    assert body["seq"] == 7 and body["cart_id"] == "A-08"
    assert body["model"] == "yolo11s-s0-20261025"
    assert body["infer_ms"] > 0
    names = sorted(d["class_name"] for d in body["detections"])
    # web/assets/camera/img-1321.jpg is the A-08 basket of the prototype
    assert names == ["bengbeng_pack12", "koalas_march_chocolate", "rosdee_mid_pork"]
    for d in body["detections"]:
        assert 0 <= d["x1"] < d["x2"] <= 1 and 0 <= d["y1"] < d["y2"] <= 1
        assert 0.25 <= d["conf"] <= 1
        assert "track_id" not in d


def test_infer_multipart_upload(client):
    r = client.post("/infer", files={"image": ("f.jpg", jpeg("img-1001.jpg"), "image/jpeg")})
    assert r.status_code == 200
    assert {d["class_name"] for d in r.json()["detections"]} == {"doritos_mid_nacho", "lay_big_ori"}


def test_track_ids_are_stable_and_separate_per_cart(client):
    def ids(cart):
        r = client.post(f"/infer?cart_id={cart}&track=true", content=jpeg(), headers={"content-type": "image/jpeg"})
        return {d["class_name"]: d["track_id"] for d in r.json()["detections"]}

    first = [ids("T-01") for _ in range(3)]
    assert first[1] == first[2] and all(isinstance(v, int) for v in first[2].values())
    other = ids("T-02")
    assert sorted(other.values()) == sorted(first[0].values()), "a new cart starts its own id sequence"
    assert client.delete("/tracks/T-01").json()["reset"] is True
    assert client.delete("/tracks/T-01").json()["reset"] is False


def test_bad_images_are_rejected(client):
    assert client.post("/infer", content=b"not a jpeg", headers={"content-type": "image/jpeg"}).json()["error"] == "BAD_IMAGE"
    assert client.post("/infer", content=b"", headers={"content-type": "image/jpeg"}).status_code == 400
    big = b"\xff" * (service.MAX_IMAGE_BYTES + 1)
    assert client.post("/infer", content=big, headers={"content-type": "image/jpeg"}).status_code == 413


def test_model_switch_is_limited_to_weights_root(client, tmp_path):
    outside = tmp_path / "x.pt"
    outside.write_bytes(b"0")
    r = client.post("/model", json={"path": str(outside)})
    assert r.status_code == 403 and r.json()["error"] == "PATH_NOT_ALLOWED"
    r = client.post("/model", json={"path": str(service.S.weights_root / "missing" / "best.pt")})
    assert r.status_code == 404
    r = client.post("/model", json={"path": str(service.S.weights_root / "README_YOLOV.md")})
    assert r.status_code == 422 and r.json()["error"] == "UNSUPPORTED_FORMAT"
    assert client.get("/health").json()["model"] == "yolo11s-s0-20261025", "failed switches keep the current model"
