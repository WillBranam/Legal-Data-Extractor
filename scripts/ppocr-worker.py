#!/usr/bin/env python3
"""Offline PP-OCRv5 worker. Model directories must already exist locally.

Two modes:
  one-shot   ppocr-worker.py IMAGE --model-dir DIR
  serve      ppocr-worker.py --serve --model-dir DIR

Building the engine costs about 4.6 seconds, which dominated a one-shot run
whose recognition step takes about 5.5 seconds. Serve mode builds it once and
then answers one JSON request per stdin line, so a long scan pays that cost
once instead of once per page."""
import argparse
import json
import os
import sys


def model_name(model_directory: str) -> str:
    config_path = os.path.join(model_directory, "inference.yml")
    with open(config_path, "r", encoding="utf-8") as config:
        for line in config:
            if line.startswith("  model_name:"):
                return line.split(":", 1)[1].strip()
    raise ValueError(f"No model_name found in {config_path}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("image", nargs="?")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--model-dir", required=True)
    args = parser.parse_args()
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    try:
        from paddleocr import PaddleOCR
    except Exception as exc:
        print(json.dumps({"error": f"PaddleOCR unavailable: {type(exc).__name__}"}))
        return 2

    recognition_dir = os.path.join(args.model_dir, "recognition")
    detection_dir = os.path.join(args.model_dir, "detection")
    engine = PaddleOCR(
        text_recognition_model_name=model_name(recognition_dir),
        text_recognition_model_dir=recognition_dir,
        text_detection_model_name=model_name(detection_dir),
        text_detection_model_dir=detection_dir,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device="cpu",
    )
    if args.serve:
        # Signal readiness only after the models are resident, so the caller
        # never sends work to a worker that is still starting up.
        print(json.dumps({"ready": True}), flush=True)
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
                print(json.dumps(recognize(engine, request["image"]), ensure_ascii=False), flush=True)
            except Exception as exc:  # noqa: BLE001 - report, never kill the worker
                print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}), flush=True)
        return 0

    if not args.image:
        print(json.dumps({"error": "image path required unless --serve is set"}))
        return 2
    print(json.dumps(recognize(engine, args.image), ensure_ascii=False))
    return 0


def recognize(engine, image_path: str) -> dict:
    texts, scores = [], []
    for result in engine.predict(image_path):
        data = result.json if hasattr(result, "json") else result
        if callable(data):
            data = data()
        if isinstance(data, str):
            data = json.loads(data)
        payload = data.get("res", data) if isinstance(data, dict) else {}
        texts.extend(str(value) for value in payload.get("rec_texts", []) if str(value).strip())
        scores.extend(float(value) for value in payload.get("rec_scores", []))
    confidence = sum(scores) / len(scores) if scores else 0.0
    return {"text": "\n".join(texts), "confidence": confidence, "engine": "pp-ocrv5"}


if __name__ == "__main__":
    sys.exit(main())
