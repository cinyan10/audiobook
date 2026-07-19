from __future__ import annotations

import argparse
import json
import re
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any


WORD_PATTERN = re.compile(r"[A-Za-z0-9]+(?:['’.-][A-Za-z0-9]+)*")


def normalize_word(text: str) -> str:
    words = [
        word.replace("’", "'").lower()
        for word in WORD_PATTERN.findall(text.strip())
    ]
    return words[0] if len(words) == 1 else ""


def map_transcript_to_tokens(
    source_tokens: list[dict[str, Any]],
    transcript_words: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    mapped: list[dict[str, Any]] = []
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
                    "block_index": int(token["block_index"]),
                    "token_index": int(token["token_index"]),
                    "text": str(token["text"]),
                    "start_time": round(float(word["start_time"]), 3),
                    "end_time": round(float(word["end_time"]), 3),
                }
            )

    return mapped


def transcribe_words(audio_path: Path, model: Any) -> list[dict[str, Any]]:
    segments, _ = model.transcribe(str(audio_path), language="en", word_timestamps=True)
    transcript_words: list[dict[str, Any]] = []
    for segment in segments:
        for word in segment.words or []:
            normalized = normalize_word(word.word)
            if normalized:
                transcript_words.append(
                    {
                        "normalized_text": normalized,
                        "start_time": float(word.start),
                        "end_time": float(word.end),
                    }
                )
    return transcript_words


def align_paragraph(paragraph: dict[str, Any], model: Any) -> tuple[list[dict[str, Any]], int]:
    source_tokens = [
        token
        for token in paragraph["tokens"]
        if str(token.get("normalized_text") or "")
    ]
    if not source_tokens:
        return [], 0

    transcript_words = transcribe_words(Path(paragraph["audio_path"]), model)
    tokens = map_transcript_to_tokens(source_tokens, transcript_words)
    return tokens, len(transcript_words)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate word alignment JSON for a generated part.")
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--response", type=Path, required=True)
    parser.add_argument("--model", default="small.en")
    args = parser.parse_args()

    request = json.loads(args.request.read_text(encoding="utf-8"))
    all_tokens: list[dict[str, Any]] = []
    transcript_count = 0

    try:
        from faster_whisper import WhisperModel
    except ModuleNotFoundError as exc:
        raise RuntimeError("Install faster-whisper before running alignment.") from exc
    model = WhisperModel(args.model, device="auto", compute_type="float32")

    for paragraph in request["paragraphs"]:
        paragraph_tokens, paragraph_transcript_count = align_paragraph(paragraph, model)
        offset = float(paragraph["offset_seconds"])
        for token in paragraph_tokens:
            all_tokens.append(
                {
                    **token,
                    "start_time": round(offset + float(token["start_time"]), 3),
                    "end_time": round(offset + float(token["end_time"]), 3),
                }
            )
        transcript_count += paragraph_transcript_count

    source_count = sum(
        1
        for paragraph in request["paragraphs"]
        for token in paragraph["tokens"]
        if str(token.get("normalized_text") or "")
    )
    if transcript_count and len(all_tokens) < max(20, int(transcript_count * 0.6)):
        raise RuntimeError(f"Alignment mapped only {len(all_tokens)} of {transcript_count} transcript words.")
    response = {
        "book_id": int(request["book_id"]),
        "chapter_index": int(request["chapter_index"]),
        "part_index": int(request["part_index"]),
        "voice": str(request["voice"]),
        "audio_path": str(request["audio_path"]),
        "duration_seconds": float(request["duration_seconds"]),
        "mapped_token_count": len(all_tokens),
        "source_token_count": source_count,
        "transcript_word_count": transcript_count,
        "tokens": all_tokens,
    }
    args.response.write_text(json.dumps(response, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(response, ensure_ascii=False))


if __name__ == "__main__":
    main()
