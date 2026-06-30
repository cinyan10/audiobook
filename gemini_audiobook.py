from __future__ import annotations

import argparse
import os
import re
import sys
import wave
from pathlib import Path

from google import genai
from google.genai import types


MODEL = "gemini-2.5-flash-preview-tts"
VOICE = "charon"
MAX_CHARS = 2200


def chunk_text(text: str, max_chars: int = MAX_CHARS) -> list[str]:
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks: list[str] = []
    current = ""

    for paragraph in paragraphs:
        candidate = paragraph if not current else f"{current}\n\n{paragraph}"
        if len(candidate) <= max_chars:
            current = candidate
            continue

        if current:
            chunks.append(current)
            current = ""

        if len(paragraph) <= max_chars:
            current = paragraph
            continue

        start = 0
        while start < len(paragraph):
            end = min(start + max_chars, len(paragraph))
            if end < len(paragraph):
                split_at = paragraph.rfind(" ", start, end)
                if split_at > start:
                    end = split_at
            piece = paragraph[start:end].strip()
            if piece:
                chunks.append(piece)
            start = end
            while start < len(paragraph) and paragraph[start] == " ":
                start += 1

    if current:
        chunks.append(current)

    return chunks


def synthesize_chunk(client: genai.Client, text: str) -> tuple[str, bytes]:
    response = client.models.generate_content(
        model=MODEL,
        contents=(
            "Read this excerpt naturally as an audiobook narrator. "
            "Keep the wording exactly as written.\n\n"
            f"{text}"
        ),
        config=types.GenerateContentConfig(
            response_modalities=["audio"],
            speech_config=VOICE,
        ),
    )

    audio_parts = [
        (part.inline_data.mime_type, part.inline_data.data)
        for part in response.parts
        if getattr(part, "inline_data", None) and part.inline_data.data
    ]
    if not audio_parts:
        raise RuntimeError("Gemini returned no audio data.")
    mime_types = {mime for mime, _ in audio_parts}
    if len(mime_types) != 1:
        raise RuntimeError(f"Gemini returned mixed audio mime types: {mime_types}")
    return audio_parts[0][0], b"".join(data for _, data in audio_parts)


def parse_pcm_mime_type(mime_type: str) -> tuple[int, int, int]:
    if not mime_type.startswith("audio/L16"):
        raise RuntimeError(f"Unsupported audio format: {mime_type}")

    rate_match = re.search(r"rate=(\d+)", mime_type)
    channels_match = re.search(r"channels=(\d+)", mime_type)
    sample_rate = int(rate_match.group(1)) if rate_match else 24000
    channels = int(channels_match.group(1)) if channels_match else 1
    sample_width = 2
    return channels, sample_width, sample_rate


def combine_pcm_chunks(audio_chunks: list[tuple[str, bytes]], output_path: Path) -> None:
    if not audio_chunks:
        raise RuntimeError("No audio data to write.")

    mime_type = audio_chunks[0][0]
    if any(current_mime != mime_type for current_mime, _ in audio_chunks):
        raise RuntimeError("Incompatible PCM chunks returned by Gemini.")

    channels, sample_width, sample_rate = parse_pcm_mime_type(mime_type)

    with wave.open(str(output_path), "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(sample_width)
        out.setframerate(sample_rate)
        for _, frame_block in audio_chunks:
            out.writeframes(frame_block)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate an audiobook WAV with Gemini TTS.")
    parser.add_argument("input", nargs="?", type=Path, help="Input text file")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path("my-youth-comedy-audiobook.wav"),
        help="Output WAV path",
    )
    parser.add_argument(
        "--self-check",
        action="store_true",
        help="Run a tiny chunking self-check and exit.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if args.self_check:
        sample = "one two\n\nthree four " + ("x" * 5000)
        chunks = chunk_text(sample, max_chars=1000)
        assert chunks
        assert all(len(chunk) <= 1000 for chunk in chunks)
        assert parse_pcm_mime_type("audio/L16;codec=pcm;rate=24000") == (1, 2, 24000)
        print("self-check passed")
        return 0

    if args.input is None:
        print("input is required unless --self-check is used.", file=sys.stderr)
        return 1

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("GEMINI_API_KEY is not set.", file=sys.stderr)
        return 1

    text = args.input.read_text(encoding="utf-8").strip()
    if not text:
        print(f"{args.input} is empty.", file=sys.stderr)
        return 1

    chunks = chunk_text(text)
    client = genai.Client(api_key=api_key)
    audio_chunks: list[tuple[str, bytes]] = []

    for index, chunk in enumerate(chunks, start=1):
        print(f"Synthesizing chunk {index}/{len(chunks)}...", file=sys.stderr)
        audio_chunks.append(synthesize_chunk(client, chunk))

    combine_pcm_chunks(audio_chunks, args.output)
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
