from __future__ import annotations

import os
import sqlite3

from app.alignment import generate_part_alignment
from gemini_audiobook import (
    MAX_CHARS,
    MODEL,
    OPENAI_MODEL,
    OPENAI_VOICE,
    VOICE,
    genai,
    load_dotenv,
    part_stem,
    reader_part_source,
    synthesize_file,
)


def generate_part_audio_and_alignment(
    connection: sqlite3.Connection,
    book_id: int,
    chapter_index: int,
    part_index: int,
) -> dict[str, object]:
    load_dotenv()
    provider = os.environ.get("AUDIOBOOK_TTS_PROVIDER") or ("gemini" if genai is not None else "openai")
    if provider not in {"gemini", "openai"}:
        raise RuntimeError("AUDIOBOOK_TTS_PROVIDER must be gemini or openai.")

    text, output, chapter_number, reader_part_number = reader_part_source(book_id, chapter_index, part_index)
    if not text:
        raise ValueError(f"Book {book_id} chapter {chapter_index} part {part_index} has no text.")

    if provider == "openai":
        client = os.environ.get("OPENAI_API_KEY")
        model = os.environ.get("AUDIOBOOK_TTS_MODEL", OPENAI_MODEL)
        voice = os.environ.get("AUDIOBOOK_TTS_VOICE", OPENAI_VOICE)
        if not client:
            raise RuntimeError("OPENAI_API_KEY is not set.")
    else:
        api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        model = os.environ.get("AUDIOBOOK_TTS_MODEL", MODEL)
        voice = os.environ.get("AUDIOBOOK_TTS_VOICE", VOICE)
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY or GOOGLE_API_KEY is not set.")
        if genai is None:
            raise RuntimeError("google-genai is not installed.")
        client = genai.Client(api_key=api_key)

    output.mkdir(parents=True, exist_ok=True)
    audio_path = output / f"{part_stem(chapter_number, reader_part_number)}.wav"
    ok = synthesize_file(provider, client, model, voice, text, audio_path, delay=0, retries=6, max_chars=MAX_CHARS)
    if not ok:
        raise RuntimeError("Audio generation failed.")
    return generate_part_alignment(
        connection,
        book_id,
        chapter_index,
        part_index,
        model_name=os.environ.get("AUDIOBOOK_ALIGNMENT_MODEL", "tiny.en"),
    )
