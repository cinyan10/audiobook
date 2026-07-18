from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
import torch
from kokoro import KModel, KPipeline


SAMPLE_RATE = 24_000
REPO_ID = "hexgrad/Kokoro-82M"
DEFAULT_VOICE = "bf_emma"


def emit_progress(stage: str, completed: int, total: int) -> None:
    print(
        json.dumps(
            {
                "event": "progress",
                "stage": stage,
                "completed": completed,
                "total": total,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


def normalize_for_speech(text: str) -> str:
    replacements = {
        "Hikigaya": "Hee-kee-gah-yah",
        "Komachi": "Koh-mah-chee",
        "Yukino": "Yoo-kee-no",
        "Yukinoshita": "Yoo-kee-no-shee-tah",
        "Yuigahama": "Yoo-ee-gah-hah-mah",
        "Hachiman": "Hah-chee-mahn",
    }
    for source, spoken in replacements.items():
        text = re.sub(rf"\b{re.escape(source)}\b", spoken, text)
    return text


def render_audio(pipeline: KPipeline, text: str, voice: str, speed: float) -> np.ndarray:
    chunks: list[np.ndarray] = []

    with torch.inference_mode():
        for result in pipeline(normalize_for_speech(text), voice=voice, speed=speed):
            if result.audio is None:
                continue
            chunks.append(result.audio.detach().cpu().numpy())

    if not chunks:
        raise RuntimeError("No audio generated.")

    return np.concatenate(chunks)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--response", type=Path, required=True)
    args = parser.parse_args()

    request = json.loads(args.request.read_text(encoding="utf-8"))
    voice = request.get("voice") or DEFAULT_VOICE
    speed = float(request.get("speed") or 0.95)
    part_output_path = Path(request["part_output_path"])
    paragraphs: list[dict[str, Any]] = request["paragraphs"]

    part_output_path.parent.mkdir(parents=True, exist_ok=True)
    for paragraph in paragraphs:
        Path(paragraph["output_path"]).parent.mkdir(parents=True, exist_ok=True)

    emit_progress("loading_model", 0, len(paragraphs))
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = KModel(repo_id=REPO_ID).to(device).eval()
    pipeline = KPipeline(lang_code="b", repo_id=REPO_ID, model=model)
    silence = np.zeros(int(SAMPLE_RATE * 0.22), dtype=np.float32)

    rendered: list[dict[str, Any]] = []
    part_chunks: list[np.ndarray] = []

    for paragraph in paragraphs:
        output_path = Path(paragraph["output_path"])
        audio = render_audio(pipeline, paragraph["text"], voice, speed)
        sf.write(output_path, audio, SAMPLE_RATE)
        part_chunks.append(audio)
        part_chunks.append(silence)
        rendered.append(
            {
                "block_index": paragraph["block_index"],
                "path": str(output_path),
                "duration_seconds": round(len(audio) / SAMPLE_RATE, 3),
            }
        )
        emit_progress("rendering", len(rendered), len(paragraphs))

    if not part_chunks:
        raise RuntimeError("No paragraph audio generated.")

    emit_progress("assembling", len(paragraphs), len(paragraphs))
    part_audio = np.concatenate(part_chunks)
    sf.write(part_output_path, part_audio, SAMPLE_RATE)

    response = {
        "voice": voice,
        "sample_rate": SAMPLE_RATE,
        "part_path": str(part_output_path),
        "duration_seconds": round(len(part_audio) / SAMPLE_RATE, 3),
        "paragraphs": rendered,
    }
    args.response.write_text(json.dumps(response, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(response, ensure_ascii=False))


if __name__ == "__main__":
    main()
