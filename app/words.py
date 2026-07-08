from __future__ import annotations

import re

try:
    from lemminflect import getAllLemmas
except ModuleNotFoundError:  # pragma: no cover - dependency is declared, fallback keeps dev server alive pre-sync.
    getAllLemmas = None


WORD_RE = re.compile(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*")


def normalize_word_text(text: str) -> str:
    stripped = text.strip().replace("’", "'").lower()
    return stripped if WORD_RE.fullmatch(stripped) else ""


def root_word(text: str) -> str:
    normalized = normalize_word_text(text)
    if not normalized:
        return ""
    if getAllLemmas is None:
        return fallback_root(normalized)
    lemmas = getAllLemmas(normalized)
    for part in ("VERB", "NOUN", "ADJ", "ADV"):
        candidates = lemmas.get(part)
        if candidates:
            return normalize_word_text(candidates[0]) or normalized
    return normalized


def fallback_root(normalized: str) -> str:
    if len(normalized) > 4 and normalized.endswith("ied"):
        return f"{normalized[:-3]}y"
    return normalized
