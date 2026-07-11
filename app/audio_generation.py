from __future__ import annotations

import os
import sqlite3

from app.alignment import generate_part_alignment, get_part_word_tokens
from app.library import get_reader_payload, is_divider_paragraph, is_redundant_title_paragraph
from gemini_audiobook import (
    MAX_CHARS,
    MODEL,
    OPENAI_MODEL,
    OPENAI_VOICE,
    VOICE,
    combine_pcm_chunks,
    genai,
    load_dotenv,
    part_stem,
    read_wav,
    reader_part_source,
    synthesize_file,
)


MIN_MISSING_WORDS = 12


def included_part_paragraphs(
    connection: sqlite3.Connection,
    book_id: int,
    chapter_index: int,
    part_index: int,
) -> set[int]:
    reader = get_reader_payload(connection, book_id)
    if reader is None:
        return set()
    chapter = next((item for item in reader["chapters"] if int(item["chapter_index"]) == chapter_index), None)
    part = next((item for item in chapter["parts"] if int(item["part_index"]) == part_index), None) if chapter else None
    if part is None:
        return set()
    book = connection.execute("SELECT title FROM books WHERE id = ?", (book_id,)).fetchone()
    rows = connection.execute(
        """
        SELECT paragraph_index, text
        FROM book_paragraphs
        WHERE book_id = ? AND paragraph_index BETWEEN ? AND ?
        ORDER BY paragraph_index
        """,
        (book_id, part["start_paragraph_index"], part["end_paragraph_index"]),
    ).fetchall()
    return {
        int(row["paragraph_index"])
        for row in rows
        if not is_redundant_title_paragraph(str(book["title"]), str(row["text"]))
        and not is_divider_paragraph(str(row["text"]))
    }


def missing_alignment_spans(
    connection: sqlite3.Connection,
    book_id: int,
    chapter_index: int,
    part_index: int,
    alignment: dict[str, object],
) -> list[list[dict[str, object]]]:
    included_paragraphs = included_part_paragraphs(connection, book_id, chapter_index, part_index)
    source_tokens = [
        token
        for token in get_part_word_tokens(connection, book_id, chapter_index, part_index)
        if int(token["paragraph_index"]) in included_paragraphs
    ]
    mapped = {int(token["token_index"]) for token in alignment["tokens"]}
    spans: list[list[dict[str, object]]] = []
    current: list[dict[str, object]] = []
    for token in source_tokens:
        if int(token["token_index"]) not in mapped:
            current.append(token)
            continue
        if len(current) >= MIN_MISSING_WORDS:
            spans.append(current)
        current = []
    if len(current) >= MIN_MISSING_WORDS:
        spans.append(current)
    return spans


def span_text(connection: sqlite3.Connection, book_id: int, span: list[dict[str, object]]) -> str:
    rows = connection.execute(
        """
        SELECT text
        FROM book_tokens
        WHERE book_id = ? AND token_index BETWEEN ? AND ?
        ORDER BY token_index
        """,
        (book_id, span[0]["token_index"], span[-1]["token_index"]),
    ).fetchall()
    return "".join(str(row["text"]) for row in rows).strip()


def append_missing_audio(
    connection: sqlite3.Connection,
    provider: str,
    client,
    model: str,
    voice: str,
    audio_path,
    book_id: int,
    spans: list[list[dict[str, object]]],
) -> None:
    missing_text = "\n\n".join(text for span in spans if (text := span_text(connection, book_id, span)))
    if not missing_text:
        return
    repair_path = audio_path.with_name(f"{audio_path.stem}.repair.wav")
    ok = synthesize_file(provider, client, model, voice, missing_text, repair_path, delay=0, retries=6, max_chars=MAX_CHARS, force=True)
    if not ok:
        raise RuntimeError("Missing audio repair failed.")
    combine_pcm_chunks([read_wav(audio_path), read_wav(repair_path)], audio_path)


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
    alignment = generate_part_alignment(
        connection,
        book_id,
        chapter_index,
        part_index,
        model_name=os.environ.get("AUDIOBOOK_ALIGNMENT_MODEL", "tiny.en"),
    )
    missing_spans = missing_alignment_spans(connection, book_id, chapter_index, part_index, alignment)
    if missing_spans:
        append_missing_audio(connection, provider, client, model, voice, audio_path, book_id, missing_spans)
        alignment = generate_part_alignment(
            connection,
            book_id,
            chapter_index,
            part_index,
            model_name=os.environ.get("AUDIOBOOK_ALIGNMENT_MODEL", "tiny.en"),
        )
    return alignment
