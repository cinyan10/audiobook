from __future__ import annotations

import re
import shutil

from oxford_cefr import LEVEL_COLORS, cancel_active_cli, fetch_tokens
from app.words import root_word


WORD_RE = re.compile(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*")
MAX_CEFR_CHARS = 4000
MAX_CEFR_WORDS = 5000


def can_fetch_cefr() -> bool:
    return shutil.which("playwright-cli") is not None


def normalize_text(text: str) -> str:
    stripped = text.strip().replace("’", "'").lower()
    return stripped if WORD_RE.fullmatch(stripped) else ""


def count_words(text: str) -> int:
    return len(WORD_RE.findall(text))


def plain_tokens(text: str) -> list[dict[str, str]]:
    pattern = re.compile(r"\s+|[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[^\w\s]", re.UNICODE)
    tokens: list[dict[str, str]] = []
    position = 0
    for match in pattern.finditer(text):
        if match.start() > position:
            tokens.append({"text": text[position : match.start()], "level": "", "tip": ""})
        tokens.append({"text": match.group(0), "level": "", "tip": ""})
        position = match.end()
    if position < len(text):
        tokens.append({"text": text[position:], "level": "", "tip": ""})
    return tokens


def cancel_cefr_fetch(scope: str) -> None:
    cancel_active_cli(scope)


def fetch_indexed_paragraph_tokens(paragraphs: list[dict[str, object]]) -> list[dict[str, object]]:
    total_words = sum(count_words(str(paragraph["text"])) for paragraph in paragraphs)
    if total_words > MAX_CEFR_WORDS:
        raise ValueError(f"Oxford CEFR checks are limited to {MAX_CEFR_WORDS} words per request.")

    grouped_tokens = fetch_paragraph_tokens_tolerant([str(paragraph["text"]) for paragraph in paragraphs])
    return [
        {
            "paragraph_index": int(paragraph["paragraph_index"]),
            "text": str(paragraph["text"]),
            "tokens": [
                {
                    "token_index": token_index,
                    "text": token["text"],
                    "normalized_text": normalize_text(token["text"]),
                    "root_text": root_word(token["text"]),
                    "cefr_level": token.get("level") or None,
                    "oxford_tip": token.get("tip") or None,
                }
                for token_index, token in enumerate(tokens)
            ],
        }
        for paragraph, tokens in zip(paragraphs, grouped_tokens)
    ]


def fetch_paragraph_tokens_tolerant(paragraphs: list[str], scope: str | None = None) -> list[list[dict[str, str]]]:
    if not paragraphs:
        return []
    if not can_fetch_cefr():
        raise RuntimeError("playwright-cli is not available for Oxford CEFR checks.")

    joined = "\n\n".join(paragraphs)
    tokens = fetch_tokens(joined, scope=scope)
    if "".join(token["text"] for token in tokens) == joined:
        return _split_tokens_by_paragraph(tokens, paragraphs)
    return _split_tokens_by_paragraph(_align_tokens_to_source(joined, tokens), paragraphs)


def fetch_paragraph_tokens(paragraphs: list[str], scope: str | None = None) -> list[list[dict[str, str]]]:
    if not paragraphs:
        return []
    if not can_fetch_cefr():
        raise RuntimeError("playwright-cli is not available for Oxford CEFR checks.")

    all_tokens: list[list[dict[str, str]]] = []
    for chunk in _paragraph_chunks(paragraphs):
        joined = "\n\n".join(chunk)
        tokens = fetch_tokens(joined, scope=scope)
        if "".join(token["text"] for token in tokens) == joined:
            all_tokens.extend(_split_tokens_by_paragraph(tokens, chunk))
            continue
        all_tokens.extend(_split_tokens_by_paragraph(_align_tokens_to_source(joined, tokens), chunk))
    return all_tokens


def _fetch_paragraphs_individually(paragraphs: list[str]) -> list[list[dict[str, str]]]:
    grouped: list[list[dict[str, str]]] = []
    for paragraph in paragraphs:
        tokens = fetch_tokens(paragraph)
        if "".join(token["text"] for token in tokens) != paragraph:
            raise RuntimeError("Oxford tokens did not match source text.")
        grouped.append(tokens)
    return grouped


def _paragraph_chunks(paragraphs: list[str], max_chars: int = MAX_CEFR_CHARS) -> list[list[str]]:
    chunks: list[list[str]] = []
    current: list[str] = []
    current_size = 0
    for paragraph in paragraphs:
        separator = 2 if current else 0
        if current and current_size + separator + len(paragraph) > max_chars:
            chunks.append(current)
            current = [paragraph]
            current_size = len(paragraph)
            continue
        current.append(paragraph)
        current_size += separator + len(paragraph)
    if current:
        chunks.append(current)
    return chunks


def _align_tokens_to_source(source: str, oxford_tokens: list[dict[str, str]]) -> list[dict[str, str]]:
    source_tokens = plain_tokens(source)
    oxford_words = [
        (normalized, token.get("level", ""), token.get("tip", ""))
        for token in oxford_tokens
        if (normalized := normalize_text(token["text"]))
    ]
    oxford_index = 0
    for token in source_tokens:
        normalized = normalize_text(token["text"])
        if not normalized:
            continue
        match_index = -1
        for candidate in range(oxford_index, min(len(oxford_words), oxford_index + 8)):
            if oxford_words[candidate][0] == normalized:
                match_index = candidate
                break
        if match_index == -1:
            continue
        _, level, tip = oxford_words[match_index]
        token["level"] = level
        token["tip"] = tip
        oxford_index = match_index + 1
    return source_tokens


def _split_tokens_by_paragraph(tokens: list[dict[str, str]], paragraphs: list[str]) -> list[list[dict[str, str]]]:
    spans: list[tuple[int, int]] = []
    cursor = 0
    for index, paragraph in enumerate(paragraphs):
        start = cursor
        end = start + len(paragraph)
        spans.append((start, end))
        cursor = end + (2 if index < len(paragraphs) - 1 else 0)

    grouped: list[list[dict[str, str]]] = [[] for _ in paragraphs]
    paragraph_index = 0
    absolute = 0
    for token in tokens:
        token_text = token["text"]
        token_start = absolute
        token_end = token_start + len(token_text)
        absolute = token_end

        while paragraph_index < len(spans) and token_start >= spans[paragraph_index][1]:
            paragraph_index += 1

        local_cursor = token_start
        while paragraph_index < len(spans) and local_cursor < token_end:
            span_start, span_end = spans[paragraph_index]
            if local_cursor < span_start:
                local_cursor = min(span_start, token_end)
                if local_cursor >= token_end:
                    break
            overlap_start = max(local_cursor, span_start)
            overlap_end = min(token_end, span_end)
            if overlap_start < overlap_end:
                piece = token_text[overlap_start - token_start : overlap_end - token_start]
                grouped[paragraph_index].append(
                    {
                        "text": piece,
                        "level": token.get("level", ""),
                        "tip": token.get("tip", ""),
                    }
                )
            local_cursor = overlap_end if overlap_end > local_cursor else token_end
            if local_cursor >= span_end:
                paragraph_index += 1
    return grouped
