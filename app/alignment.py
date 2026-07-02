from __future__ import annotations

import json
import subprocess
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from app.cefr import normalize_text, plain_tokens
from app.library import get_book_part_audio_path, get_reader_payload, part_alignment_path, chapter_audio_number


def normalize_alignment_word(text: str) -> str:
    words = [normalized for token in plain_tokens(text.strip()) if (normalized := normalize_text(token["text"]))]
    return words[0] if len(words) == 1 else ""


def get_part_word_tokens(connection: Any, book_id: int, chapter_index: int, part_index: int) -> list[dict[str, object]]:
    reader = get_reader_payload(connection, book_id)
    if reader is None:
        raise ValueError(f"Book {book_id} does not exist.")
    chapter = next((item for item in reader["chapters"] if int(item["chapter_index"]) == chapter_index), None)
    if chapter is None:
        raise ValueError(f"Chapter {chapter_index} was not found for book {book_id}.")
    part = next((item for item in chapter["parts"] if int(item["part_index"]) == part_index), None)
    if part is None:
        raise ValueError(f"Part {part_index} was not found for book {book_id}.")

    rows = connection.execute(
        """
        SELECT token_index, paragraph_index, text, normalized_text
        FROM book_tokens
        WHERE book_id = ?
          AND paragraph_index BETWEEN ? AND ?
          AND normalized_text != ''
        ORDER BY token_index
        """,
        (book_id, part["start_paragraph_index"], part["end_paragraph_index"]),
    ).fetchall()
    return [
        {
            "token_index": int(row["token_index"]),
            "paragraph_index": int(row["paragraph_index"]),
            "text": row["text"],
            "normalized_text": row["normalized_text"],
        }
        for row in rows
    ]


def map_transcript_to_tokens(
    source_tokens: list[dict[str, object]],
    transcript_words: list[dict[str, float | str]],
) -> list[dict[str, object]]:
    mapped: list[dict[str, object]] = []
    source_words = [str(token["normalized_text"]) for token in source_tokens]
    transcript_normalized = [str(word["normalized_text"]) for word in transcript_words]
    matcher = SequenceMatcher(None, source_words, transcript_normalized, autojunk=False)
    for tag, source_start, source_end, transcript_start, transcript_end in matcher.get_opcodes():
        if tag != "equal":
            continue
        for source_index, transcript_index in zip(range(source_start, source_end), range(transcript_start, transcript_end)):
            token = source_tokens[source_index]
            word = transcript_words[transcript_index]
            mapped.append(
                {
                    "token_index": token["token_index"],
                    "paragraph_index": token["paragraph_index"],
                    "text": token["text"],
                    "start_time": round(float(word["start_time"]), 3),
                    "end_time": round(float(word["end_time"]), 3),
                }
            )
    return mapped


def audio_duration_seconds(audio_path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nokey=1:noprint_wrappers=1",
            str(audio_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return round(float(result.stdout.strip()), 3)


def generate_part_alignment(
    connection: Any,
    book_id: int,
    chapter_index: int,
    part_index: int,
    *,
    model_name: str = "small.en",
) -> dict[str, object]:
    audio_path = get_book_part_audio_path(connection, book_id, chapter_index, part_index)
    if audio_path is None:
        raise ValueError(f"Audio not found for book {book_id} chapter {chapter_index} part {part_index}.")

    try:
        from faster_whisper import WhisperModel
    except ModuleNotFoundError as exc:
        raise RuntimeError("Install faster-whisper before running alignment.") from exc

    source_tokens = get_part_word_tokens(connection, book_id, chapter_index, part_index)
    model = WhisperModel(model_name, device="auto", compute_type="default")
    segments, _ = model.transcribe(str(audio_path), language="en", word_timestamps=True)
    transcript_words: list[dict[str, float | str]] = []
    for segment in segments:
        for word in segment.words or []:
            normalized = normalize_alignment_word(word.word)
            if normalized:
                transcript_words.append(
                    {
                        "normalized_text": normalized,
                        "start_time": float(word.start),
                        "end_time": float(word.end),
                    }
                )

    tokens = map_transcript_to_tokens(source_tokens, transcript_words)
    if transcript_words and len(tokens) < max(20, len(transcript_words) * 0.6):
        raise RuntimeError(f"Alignment mapped only {len(tokens)} of {len(transcript_words)} transcript words.")

    reader = get_reader_payload(connection, book_id)
    assert reader is not None
    chapter = next(item for item in reader["chapters"] if int(item["chapter_index"]) == chapter_index)
    book = connection.execute("SELECT slug FROM books WHERE id = ?", (book_id,)).fetchone()
    output_path = part_alignment_path(str(book["slug"]), chapter_audio_number(str(chapter["title"]), chapter_index), part_index)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "book_id": book_id,
        "chapter_index": chapter_index,
        "part_index": part_index,
        "audio_path": str(audio_path),
        "duration_seconds": audio_duration_seconds(audio_path),
        "tokens": tokens,
    }
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload
