from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from kokoro import KModel, KPipeline


SAMPLE_RATE = 24_000
REPO_ID = "hexgrad/Kokoro-82M"


def load_preview_text(path: Path, max_words: int) -> str:
    text = path.read_text(encoding="utf-8").strip()
    paragraphs = [line.strip() for line in text.splitlines() if line.strip()]
    words: list[str] = []

    for paragraph in paragraphs:
        for word in paragraph.split():
            if len(words) >= max_words:
                break
            words.append(word)
        if len(words) >= max_words:
            break

    return normalize_text(" ".join(words))


def normalize_text(text: str) -> str:
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
    silence = np.zeros(int(SAMPLE_RATE * 0.18), dtype=np.float32)

    with torch.inference_mode():
        for result in pipeline(text, voice=voice, speed=speed):
            if result.audio is None:
                continue
            chunks.append(result.audio.detach().cpu().numpy())
            chunks.append(silence)

    if not chunks:
        raise RuntimeError(f"No audio generated for voice {voice}")

    return np.concatenate(chunks)


def write_clip(
    pipeline: KPipeline,
    output_dir: Path,
    name: str,
    text: str,
    voice: str,
    speed: float,
) -> dict[str, object]:
    audio = render_audio(pipeline, text, voice, speed)
    path = output_dir / f"{name}.wav"
    sf.write(path, audio, SAMPLE_RATE)
    return {
        "name": name,
        "voice": voice,
        "path": str(path),
        "duration_seconds": round(len(audio) / SAMPLE_RATE, 2),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source",
        type=Path,
        default=Path("legacy/python/my-youth-comedy.txt"),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("data/audio/kokoro-preview-youth-comedy-v3-p4"),
    )
    parser.add_argument("--max-words", type=int, default=95)
    parser.add_argument("--speed", type=float, default=0.95)
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)

    preview_text = load_preview_text(args.source, args.max_words)
    japanese_names = (
        "比企谷小町。比企谷八幡。雪ノ下雪乃。由比ヶ浜結衣。"
        "小町は静かに作戦を考えています。"
    )

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = KModel(repo_id=REPO_ID).to(device).eval()
    us_pipeline = KPipeline(lang_code="a", repo_id=REPO_ID, model=model)
    gb_pipeline = KPipeline(lang_code="b", repo_id=REPO_ID, model=model)
    ja_pipeline = KPipeline(lang_code="j", repo_id=REPO_ID, model=model)

    clips = [
        write_clip(us_pipeline, args.output_dir, "american_female_af_heart", preview_text, "af_heart", args.speed),
        write_clip(us_pipeline, args.output_dir, "american_male_am_adam", preview_text, "am_adam", args.speed),
        write_clip(gb_pipeline, args.output_dir, "british_female_bf_emma", preview_text, "bf_emma", args.speed),
        write_clip(gb_pipeline, args.output_dir, "british_male_bm_george", preview_text, "bm_george", args.speed),
        write_clip(ja_pipeline, args.output_dir, "japanese_names_jf_alpha", japanese_names, "jf_alpha", 0.92),
    ]

    cast_segments = [
        render_audio(us_pipeline, preview_text, "am_adam", args.speed),
        np.zeros(int(SAMPLE_RATE * 0.35), dtype=np.float32),
        render_audio(gb_pipeline, preview_text, "bf_emma", args.speed),
    ]
    cast_path = args.output_dir / "mixed_cast_us_male_gb_female.wav"
    cast_audio = np.concatenate(cast_segments)
    sf.write(cast_path, cast_audio, SAMPLE_RATE)
    clips.append(
        {
            "name": "mixed_cast_us_male_gb_female",
            "voice": "am_adam + bf_emma",
            "path": str(cast_path),
            "duration_seconds": round(len(cast_audio) / SAMPLE_RATE, 2),
        }
    )

    manifest = {
        "source": str(args.source),
        "source_note": "Local user-provided preview text. Not fetched from the internet.",
        "model": REPO_ID,
        "sample_rate": SAMPLE_RATE,
        "max_words": args.max_words,
        "speed": args.speed,
        "pronunciation_strategy": "English clips use simple spelling replacements for Japanese names; Japanese clip uses Kokoro Japanese G2P.",
        "clips": clips,
    }
    (args.output_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    print(json.dumps(manifest, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
