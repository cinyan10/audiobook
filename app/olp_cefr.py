from __future__ import annotations

import csv
from functools import lru_cache
from pathlib import Path

from app.cefr import plain_tokens
from app.words import normalize_word_text, root_word


DEFAULT_PROFILE_PATH = Path("data/cefrj-vocabulary-profile-1.5.csv")
CEFR_ORDER = {"A1": 1, "A2": 2, "B1": 3, "B2": 4, "C1": 5, "C2": 6}
LOCAL_LEVELS = {"A1", "A2", "B1", "B2", "C1"}
IRREGULAR_ROOTS = {
    "been": "be",
    "came": "come",
    "did": "do",
    "done": "do",
    "gone": "go",
    "got": "get",
    "had": "have",
    "held": "hold",
    "knew": "know",
    "known": "know",
    "made": "make",
    "met": "meet",
    "said": "say",
    "saw": "see",
    "seen": "see",
    "told": "tell",
    "was": "be",
    "went": "go",
    "were": "be",
    "written": "write",
    "wrote": "write",
}
CONTRACTION_ROOTS = {
    "aren't": "be",
    "can't": "can",
    "couldn't": "could",
    "didn't": "do",
    "doesn't": "do",
    "don't": "do",
    "hadn't": "have",
    "hasn't": "have",
    "haven't": "have",
    "he'd": "he",
    "he'll": "he",
    "he's": "he",
    "i'd": "i",
    "i'll": "i",
    "i'm": "i",
    "i've": "i",
    "isn't": "be",
    "it'd": "it",
    "it'll": "it",
    "it's": "it",
    "she'd": "she",
    "she'll": "she",
    "she's": "she",
    "shouldn't": "should",
    "that's": "that",
    "they'd": "they",
    "they'll": "they",
    "they're": "they",
    "they've": "they",
    "wasn't": "be",
    "we'd": "we",
    "we'll": "we",
    "we're": "we",
    "we've": "we",
    "weren't": "be",
    "won't": "will",
    "wouldn't": "would",
    "you'd": "you",
    "you'll": "you",
    "you're": "you",
    "you've": "you",
}


@lru_cache(maxsize=4)
def load_profile(path: str = str(DEFAULT_PROFILE_PATH)) -> dict[str, str]:
    profile_path = Path(path)
    if not profile_path.exists():
        raise FileNotFoundError(
            f"OLP CEFR-J profile not found at {profile_path}. "
            "Download cefrj-vocabulary-profile-1.5.csv from openlanguageprofiles/olp-en-cefrj."
        )

    levels: dict[str, str] = {}
    with profile_path.open(encoding="utf-8", newline="") as file:
        for row in csv.DictReader(file):
            level = (row.get("CEFR") or "").strip().upper()
            if level not in LOCAL_LEVELS:
                continue
            for word in _headword_variants(row.get("headword") or ""):
                previous = levels.get(word)
                if previous is None or CEFR_ORDER[level] < CEFR_ORDER[previous]:
                    levels[word] = level
    return levels


def check_text(text: str, profile_path: Path | str = DEFAULT_PROFILE_PATH) -> list[dict[str, str]]:
    levels = load_profile(str(profile_path))
    checked: list[dict[str, str]] = []
    for token in plain_tokens(text):
        normalized = normalize_word_text(token["text"])
        if not normalized:
            checked.append({**token, "level": "", "tip": ""})
            continue

        tip_word, level = lookup_level(normalized, levels)
        checked.append({**token, "level": level, "tip": f"{tip_word}=OLP-EN-CEFRJ {level}"})
    return checked


def lookup_level(word: str, levels: dict[str, str]) -> tuple[str, str]:
    for candidate in _lookup_candidates(word):
        level = levels.get(candidate)
        if level:
            return candidate, level
    return word, "C2"


def _lookup_candidates(word: str) -> list[str]:
    candidates = [word, root_word(word)]
    if word in CONTRACTION_ROOTS:
        candidates.append(CONTRACTION_ROOTS[word])
    if word in IRREGULAR_ROOTS:
        candidates.append(IRREGULAR_ROOTS[word])
    if "'" in word:
        base, suffix = word.split("'", 1)
        candidates.append(base)
        if suffix in {"m", "re", "s"}:
            candidates.append("be")
        elif suffix in {"d", "ll", "ve"}:
            candidates.extend(["would", "will", "have"])
    if len(word) > 4 and word.endswith("ies"):
        candidates.append(f"{word[:-3]}y")
    if len(word) > 4 and word.endswith("es"):
        candidates.append(word[:-2])
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        candidates.append(word[:-1])
    if len(word) > 5 and word.endswith("ied"):
        candidates.append(f"{word[:-3]}y")
    if len(word) > 4 and word.endswith("ed"):
        stem = word[:-2]
        candidates.extend([stem, f"{stem}e"])
    if len(word) > 5 and word.endswith("ing"):
        stem = word[:-3]
        candidates.extend([stem, f"{stem}e"])
        if len(stem) > 2 and stem[-1] == stem[-2]:
            candidates.append(stem[:-1])
    if len(word) > 4 and word.endswith("er"):
        candidates.append(word[:-2])
    if len(word) > 5 and word.endswith("est"):
        candidates.append(word[:-3])
    return _unique(candidates)


def _headword_variants(headword: str) -> list[str]:
    variants: list[str] = []
    for part in headword.replace("’", "'").split("/"):
        normalized = normalize_word_text(part)
        if normalized and normalized not in variants:
            variants.append(normalized)
    return variants


def _unique(values: list[str]) -> list[str]:
    unique: list[str] = []
    for value in values:
        normalized = normalize_word_text(value)
        if normalized and normalized not in unique:
            unique.append(normalized)
    return unique
