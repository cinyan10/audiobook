from __future__ import annotations

import argparse
import math
import os
import posixpath
import re
import struct
import sys
import time
import wave
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET

from google import genai
from google.genai import types


MODEL = "gemini-3.1-flash-tts-preview"
VOICE = "charon"
MAX_CHARS = 8000
MAX_SILENCE_SECONDS = 1.2
KEEP_SILENCE_SECONDS = 0.6
START_TEXT = (
    "I parted ways with Totsuka and Zaimokuza at the ticket gates. "
    "At the ramen shop, Zaimokuza had been mistaken for staff, and people kept "
    "trying to give him orders, but he and Totsuka appeared satisfied at having "
    "been able to eat delicious ramen."
)


class EpubTextParser(HTMLParser):
    block_tags = {"p", "div", "br", "h1", "h2", "h3", "h4", "li"}

    def __init__(self) -> None:
        super().__init__()
        self.out: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = dict(attrs)
        if tag == "img" and "Art_orn" in attr.get("src", ""):
            self.out.append("\n\nX X X\n\n")
        elif tag in self.block_tags:
            self.out.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.block_tags:
            self.out.append("\n")

    def handle_data(self, data: str) -> None:
        self.out.append(data)

    def text(self) -> str:
        text = unescape("".join(self.out))
        text = re.sub(r"[ \t]+", " ", text)
        return re.sub(r"\n{3,}", "\n\n", text).strip()


def extract_epub_text(path: Path) -> str:
    with ZipFile(path) as book:
        container = ET.fromstring(book.read("META-INF/container.xml"))
        opf_path = container.find(".//{*}rootfile").attrib["full-path"]
        opf = ET.fromstring(book.read(opf_path))
        manifest = {
            item.attrib["id"]: item.attrib["href"]
            for item in opf.findall(".//{*}manifest/{*}item")
        }
        base = posixpath.dirname(opf_path)
        texts: list[str] = []
        for itemref in opf.findall(".//{*}spine/{*}itemref"):
            href = manifest[itemref.attrib["idref"]]
            if not href.endswith((".xhtml", ".html")):
                continue
            parser = EpubTextParser()
            parser.feed(book.read(posixpath.normpath(posixpath.join(base, href))).decode("utf-8", "ignore"))
            text = parser.text()
            if text:
                texts.append(text)
        return "\n\n".join(texts)


def trim_to_start(text: str, start_text: str) -> str:
    index = text.find(start_text)
    if index == -1:
        raise RuntimeError("Start text was not found in the input.")
    return text[index:].strip()


def split_parts(text: str) -> list[str]:
    return [part.strip() for part in re.split(r"\n\s*X\s+X\s+X\s*\n", text) if part.strip()]


def book_slug(path: Path) -> str:
    slug = path.stem.lower()
    slug = re.sub(r"\s*\([^)]*\)", "", slug)
    slug = slug.replace("volume", "vol")
    slug = re.sub(r"\bvol\.?\s*(\d+)\b", r"vol-\1", slug)
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    return re.sub(r"-+", "-", slug).strip("-")


def part_stem(chapter: int, part: int) -> str:
    return f"chapter-{chapter:02d}-part-{part:03d}"


def retry_wait(error: Exception, attempt: int) -> int:
    match = re.search(r"retryDelay['\"]?: ['\"]?(\d+)s", str(error))
    if match:
        return int(match.group(1)) + 2
    match = re.search(r"retry in (\d+)", str(error), re.IGNORECASE)
    if match:
        return int(match.group(1)) + 2
    return min(300, 20 * 2**attempt)


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


def synthesize_chunk(client: genai.Client, model: str, text: str, retries: int = 6) -> tuple[str, bytes]:
    for attempt in range(retries):
        try:
            response = client.models.generate_content(
                model=model,
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
            break
        except Exception as error:
            if attempt == retries - 1:
                raise
            # ponytail: coarse retry is enough for rate limits; add provider-specific parsing if failures need it.
            wait = retry_wait(error, attempt)
            print(f"  retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)
    else:
        raise RuntimeError("Gemini TTS failed.")

    audio_parts = [
        (part.inline_data.mime_type, part.inline_data.data)
        for part in response.parts or []
        if getattr(part, "inline_data", None) and part.inline_data.data
    ]
    if not audio_parts:
        raise RuntimeError("Gemini returned no audio data.")
    mime_types = {mime for mime, _ in audio_parts}
    if len(mime_types) != 1:
        raise RuntimeError(f"Gemini returned mixed audio mime types: {mime_types}")
    return audio_parts[0][0], b"".join(data for _, data in audio_parts)


def synthesize_file(
    client: genai.Client,
    model: str,
    text: str,
    output_path: Path,
    delay: float,
    retries: int,
    max_chars: int,
) -> bool:
    audio_chunks: list[tuple[str, bytes]] = []
    chunks = chunk_text(text, max_chars=max_chars)
    chunk_dir = output_path.parent / "chunks" / output_path.stem
    chunk_dir.mkdir(parents=True, exist_ok=True)

    for index, chunk in enumerate(chunks, start=1):
        chunk_path = chunk_dir / f"chunk-{index:03}.wav"
        if chunk_path.exists():
            print(f"  skipping existing chunk {index}/{len(chunks)}", file=sys.stderr)
            audio_chunks.append(read_wav(chunk_path))
            continue

        print(f"  chunk {index}/{len(chunks)}", file=sys.stderr)
        try:
            audio_chunk = synthesize_chunk(client, model, chunk, retries=retries)
        except Exception as error:
            print(f"  failed chunk {index}/{len(chunks)}: {error}", file=sys.stderr)
            return False
        write_wav(audio_chunk, chunk_path)
        audio_chunks.append(audio_chunk)
        if delay:
            time.sleep(delay)

    combine_pcm_chunks(audio_chunks, output_path)
    return True


def input_text(path: Path) -> str:
    if path.suffix.lower() == ".epub":
        return extract_epub_text(path)
    return path.read_text(encoding="utf-8")


def parse_pcm_mime_type(mime_type: str) -> tuple[int, int, int]:
    if not mime_type.lower().startswith("audio/l16"):
        raise RuntimeError(f"Unsupported audio format: {mime_type}")

    rate_match = re.search(r"rate=(\d+)", mime_type)
    channels_match = re.search(r"channels=(\d+)", mime_type)
    sample_rate = int(rate_match.group(1)) if rate_match else 24000
    channels = int(channels_match.group(1)) if channels_match else 1
    sample_width = 2
    return channels, sample_width, sample_rate


def squash_silence(mime_type: str, frames: bytes) -> bytes:
    channels, sample_width, sample_rate = parse_pcm_mime_type(mime_type)
    if channels != 1 or sample_width != 2:
        return frames

    window_frames = sample_rate // 10
    window_bytes = window_frames * sample_width
    max_silent_windows = math.ceil(MAX_SILENCE_SECONDS * 10)
    keep_silent_windows = math.ceil(KEEP_SILENCE_SECONDS * 10)
    out: list[bytes] = []
    silent: list[bytes] = []

    for start in range(0, len(frames), window_bytes):
        block = frames[start : start + window_bytes]
        samples = struct.unpack("<" + "h" * (len(block) // 2), block)
        rms = math.sqrt(sum(sample * sample for sample in samples) / len(samples)) if samples else 0
        if rms < 700:
            silent.append(block)
            continue

        if silent:
            out.extend(silent[:keep_silent_windows] if len(silent) > max_silent_windows else silent)
            silent.clear()
        out.append(block)

    if silent:
        out.extend(silent[:keep_silent_windows] if len(silent) > max_silent_windows else silent)

    return b"".join(out)


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
            out.writeframes(squash_silence(mime_type, frame_block))


def write_wav(audio_chunk: tuple[str, bytes], output_path: Path) -> None:
    mime_type, frames = audio_chunk
    channels, sample_width, sample_rate = parse_pcm_mime_type(mime_type)
    with wave.open(str(output_path), "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(sample_width)
        out.setframerate(sample_rate)
        out.writeframes(frames)


def read_wav(path: Path) -> tuple[str, bytes]:
    with wave.open(str(path), "rb") as src:
        mime_type = f"audio/L16;codec=pcm;rate={src.getframerate()};channels={src.getnchannels()}"
        return mime_type, src.readframes(src.getnframes())


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate an audiobook WAV with Gemini TTS.")
    parser.add_argument("input", nargs="?", type=Path, help="Input text file")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="Output folder for parts, or a WAV path with --single-file. Defaults to audio/<book-name>.",
    )
    parser.add_argument(
        "--start",
        default=START_TEXT,
        help="Start generating audio from this exact text.",
    )
    parser.add_argument(
        "--model",
        default=MODEL,
        help="Gemini TTS model to use.",
    )
    parser.add_argument(
        "--single-file",
        action="store_true",
        help="Write one WAV instead of one WAV per ornament-separated part.",
    )
    parser.add_argument(
        "--chapter",
        type=int,
        default=4,
        help="Chapter number to use in generated audio filenames.",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=5,
        help="Seconds to wait after each TTS request.",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=6,
        help="Retries per TTS request with exponential backoff.",
    )
    parser.add_argument(
        "--max-chars",
        type=int,
        default=MAX_CHARS,
        help="Maximum input characters per TTS request.",
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
        sample = "intro\n\n" + START_TEXT + "\n\none\n\nX X X\n\ntwo " + ("x" * 5000)
        assert len(split_parts(trim_to_start(sample, START_TEXT))) == 2
        chunks = chunk_text(sample, max_chars=1000)
        assert chunks
        assert all(len(chunk) <= 1000 for chunk in chunks)
        assert parse_pcm_mime_type("audio/L16;codec=pcm;rate=24000") == (1, 2, 24000)
        assert book_slug(Path("My Book, Volume 01 (Someone).epub")) == "my-book-vol-01"
        assert part_stem(4, 1) == "chapter-04-part-001"
        assert retry_wait(Exception("{'retryDelay': '56s'}"), 0) == 58
        frames = b"\0\0" * 24000 * 3 + struct.pack("<24000h", *([2000] * 24000))
        assert len(squash_silence("audio/L16;codec=pcm;rate=24000", frames)) < len(frames)
        check_path = Path(os.environ.get("TMPDIR", "/tmp")) / "gemini-audiobook-self-check.wav"
        write_wav(("audio/L16;codec=pcm;rate=24000", frames), check_path)
        assert read_wav(check_path)[1] == frames
        check_path.unlink()
        print("self-check passed")
        return 0

    if args.input is None:
        print("input is required unless --self-check is used.", file=sys.stderr)
        return 1

    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        print("GEMINI_API_KEY or GOOGLE_API_KEY is not set.", file=sys.stderr)
        return 1

    text = trim_to_start(input_text(args.input), args.start)
    if not text:
        print(f"{args.input} is empty.", file=sys.stderr)
        return 1

    client = genai.Client(api_key=api_key)
    output = args.output or Path("audio") / book_slug(args.input)

    if args.single_file:
        print(f"Synthesizing {output}...", file=sys.stderr)
        if not synthesize_file(client, args.model, text, output, args.delay, args.retries, args.max_chars):
            return 1
        print(output)
        return 0

    parts = split_parts(text)
    failed = False
    output.mkdir(parents=True, exist_ok=True)
    for index, part in enumerate(parts, start=1):
        path = output / f"{part_stem(args.chapter, index)}.wav"
        if path.exists():
            print(f"Skipping existing {path}", file=sys.stderr)
            continue
        print(f"Synthesizing part {index}/{len(parts)}: {path}", file=sys.stderr)
        if not synthesize_file(client, args.model, part, path, args.delay, args.retries, args.max_chars):
            failed = True
    print(output)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
