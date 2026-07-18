from __future__ import annotations

from html.parser import HTMLParser
import json
import os
import re
import ssl
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


OXFORD_BASE_URL = "https://www.oxfordlearnersdictionaries.com/definition/english"
WORD_RE = re.compile(r"[A-Za-z]+(?:['-][A-Za-z]+)*")


def load_dotenv(path: str = ".env") -> None:
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as file:
        for line in file:
            key, separator, value = line.strip().partition("=")
            if separator and key and key not in os.environ:
                os.environ[key] = value


load_dotenv()
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash")


def lookup_word(word: str, context: str, cefr_level: str = "") -> dict[str, object]:
    normalized = normalize_word(word)
    if not normalized:
        raise ValueError("Select one English word to look up.")

    entry = fetch_oxford_entry(normalized)
    entry["word"] = normalized
    if cefr_level and not entry["cefr_level"]:
        entry["cefr_level"] = cefr_level
    context = re.sub(re.escape(word), normalized, context, flags=re.IGNORECASE)
    choice = choose_definition(normalized, context, entry["definitions"])
    return {**entry, "context_definition": choice}


def normalize_word(word: str) -> str:
    match = WORD_RE.search(word.strip())
    return match.group(0).lower() if match else ""


def fetch_oxford_entry(word: str) -> dict[str, object]:
    url = f"{OXFORD_BASE_URL}/{quote(word)}?q={quote(word)}"
    for attempt in range(2):
        try:
            return read_oxford_entry(url, word)
        except HTTPError as exc:
            if exc.code == 404:
                try:
                    return read_oxford_entry(f"{OXFORD_BASE_URL.replace('/definition/english', '')}/search/english/direct/?q={quote(word)}", word)
                except (HTTPError, URLError, TimeoutError) as fallback_exc:
                    exc = fallback_exc
            if attempt == 1:
                raise RuntimeError("Oxford lookup failed.") from exc
            time.sleep(0.35)
        except (URLError, TimeoutError) as exc:
            if attempt == 1:
                raise RuntimeError("Oxford lookup failed.") from exc
            time.sleep(0.35)
    raise RuntimeError("Oxford lookup failed.")


def read_oxford_entry(url: str, word: str) -> dict[str, object]:
    request = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with open_request(request, timeout=12) as response:
        html = response.read().decode("utf-8", "replace")
        source_url = response.geturl()
    return parse_oxford_html(html, source_url, fallback_word=word)


def open_request(request: Request, timeout: int):
    try:
        return urlopen(request, timeout=timeout)
    except URLError as exc:
        if isinstance(exc.reason, ssl.SSLCertVerificationError):
            # ponytail: local macOS Python may miss CA roots; remove this when a cert bundle is configured.
            return urlopen(request, timeout=timeout, context=ssl._create_unverified_context())
        raise


def parse_oxford_html(html: str, url: str, fallback_word: str = "") -> dict[str, object]:
    parser = OxfordEntryParser()
    parser.feed(html)
    word = parser.headword or fallback_word
    return {
        "word": word,
        "word_type": parser.part_of_speech,
        "cefr_level": parser.cefr_level,
        "phonetics": parser.phonetics,
        "audio_url": parser.preferred_audio_url(fallback_word),
        "source_url": url,
        "definitions": parser.definitions,
    }


def choose_definition(word: str, context: str, definitions: list[dict[str, object]]) -> dict[str, object]:
    if not os.environ.get("DEEPSEEK_API_KEY") or not definitions:
        return fallback_choice(definitions)

    payload = {
        "model": DEEPSEEK_MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Pick the Oxford definition that matches the word in context. "
                    "The selected word is present in the context; match it case-insensitively. "
                    "Sentence fragments are valid context. "
                    "If the context is short or ambiguous, choose the most likely Oxford definition. "
                    "Return compact JSON: definition_number, explanation. "
                    "Use definition_number null only when the contextual meaning is slang, internet usage, "
                    "a proper-name usage, or otherwise not covered by any Oxford definition; then explain it yourself."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {"word": word, "context": context, "definitions": definitions},
                    ensure_ascii=True,
                ),
            },
        ],
        "stream": False,
    }
    request = Request(
        "https://api.deepseek.com/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {os.environ['DEEPSEEK_API_KEY']}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with open_request(request, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))
        content = data["choices"][0]["message"]["content"]
        parsed = json.loads(extract_json(content))
    except Exception:
        return fallback_choice(definitions)

    number = parsed.get("definition_number")
    match = next((item for item in definitions if item["number"] == number), None)
    if match:
        return {
            "definition_number": number,
            "definition": match["definition"],
            "examples": match["examples"],
            "ai_explanation": str(parsed.get("explanation") or ""),
            "matched": True,
        }
    explanation = str(parsed.get("explanation") or "")
    if word_in_context(word, context) and re.search(r"\b(not|doesn't|does not)\s+(appear|used|present)\b", explanation, re.IGNORECASE):
        return fallback_choice(definitions)
    if explanation:
        return {
            "definition_number": None,
            "definition": explanation,
            "examples": [],
            "ai_explanation": explanation,
            "matched": False,
        }
    return fallback_choice(definitions)


def word_in_context(word: str, context: str) -> bool:
    return re.search(rf"\b{re.escape(word)}\b", context, re.IGNORECASE) is not None


def extract_json(text: str) -> str:
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError("No JSON object in model response.")
    return text[start : end + 1]


def fallback_choice(definitions: list[dict[str, object]]) -> dict[str, object]:
    first = definitions[0] if definitions else {"number": None, "definition": "", "examples": []}
    return {
        "definition_number": first["number"],
        "definition": first["definition"],
        "examples": first["examples"],
        "ai_explanation": "",
        "matched": bool(definitions),
    }


class OxfordEntryParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.headword = ""
        self.part_of_speech = ""
        self.cefr_level = ""
        self.phonetics: list[str] = []
        self.audio_url = ""
        self.uk_audio_url = ""
        self.audio_urls: list[str] = []
        self.uk_audio_urls: list[str] = []
        self.definitions: list[dict[str, object]] = []
        self._capture: str | None = None
        self._buffer: list[str] = []
        self._current_definition: dict[str, object] | None = None
        self._definition_number = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_dict = dict(attrs)
        classes = set((attrs_dict.get("class") or "").split())
        audio = attrs_dict.get("data-src-mp3") or attrs_dict.get("src") or ""
        if audio.endswith(".mp3"):
            if audio not in self.audio_urls:
                self.audio_urls.append(audio)
            if not self.audio_url:
                self.audio_url = audio
            if "_gb_" in audio:
                if audio not in self.uk_audio_urls:
                    self.uk_audio_urls.append(audio)
                if not self.uk_audio_url:
                    self.uk_audio_url = audio
        if tag == "h1":
            self._start_capture("headword")
        elif "pos" in classes and not self.part_of_speech:
            self._start_capture("pos")
        elif "phon" in classes:
            self._start_capture("phon")
        elif "def" in classes:
            self._definition_number += 1
            self._start_capture("def")
        elif "x" in classes and self._current_definition is not None:
            self._start_capture("example")
        elif "belong-to" in classes or "symbols" in classes:
            self._start_capture("cefr")

    def handle_data(self, data: str) -> None:
        if self._capture:
            self._buffer.append(data)

    def handle_endtag(self, tag: str) -> None:
        if not self._capture:
            return
        if self._capture == "headword" and tag == "h1":
            self.headword = clean_text("".join(self._buffer))
            self._stop_capture()
        elif self._capture == "pos" and tag in {"span", "div"}:
            self.part_of_speech = clean_text("".join(self._buffer))
            self._stop_capture()
        elif self._capture == "phon" and tag in {"span", "div"}:
            phonetic = clean_text("".join(self._buffer))
            if phonetic and phonetic not in self.phonetics:
                self.phonetics.append(phonetic)
            self._stop_capture()
        elif self._capture == "def" and tag in {"span", "div"}:
            definition = clean_text("".join(self._buffer))
            self._current_definition = {"number": self._definition_number, "definition": definition, "examples": []}
            self.definitions.append(self._current_definition)
            self._stop_capture()
        elif self._capture == "example" and tag in {"span", "li", "div"}:
            example = clean_text("".join(self._buffer))
            if example:
                examples = self._current_definition["examples"] if self._current_definition else []
                if isinstance(examples, list):
                    examples.append(example)
            self._stop_capture()
        elif self._capture == "cefr" and tag in {"span", "a", "div"}:
            text = clean_text("".join(self._buffer)).upper()
            match = re.search(r"\bA1|A2|B1|B2|C1|C2\b", text)
            if match and not self.cefr_level:
                self.cefr_level = match.group(0)
            self._stop_capture()

    def _start_capture(self, name: str) -> None:
        if self._capture is None:
            self._capture = name
            self._buffer = []

    def _stop_capture(self) -> None:
        self._capture = None
        self._buffer = []

    def preferred_audio_url(self, word: str) -> str:
        word = word.lower()
        for audio in self.uk_audio_urls:
            if re.search(rf"/{re.escape(word)}__gb_", audio.lower()):
                return audio
        for audio in self.audio_urls:
            if re.search(rf"/{re.escape(word)}__", audio.lower()):
                return audio
        return self.uk_audio_url or self.audio_url


def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()
