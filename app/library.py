from __future__ import annotations

import sqlite3
import threading
import json
from datetime import datetime, timezone
from pathlib import Path
import re
from urllib.parse import quote, unquote

from app.cefr import MAX_CEFR_CHARS, cancel_cefr_fetch, fetch_paragraph_tokens, normalize_text, plain_tokens
from app.epub import read_epub, read_epub_asset, read_epub_chapter_blocks, slugify
from app.words import root_word


CEFR_FETCH_LOCK = threading.Lock()
AUDIO_DIR = Path("data") / "audio"


def chapter_audio_number(chapter_title: str, chapter_index: int) -> int:
    match = re.match(r"^\s*(\d+)\b", chapter_title)
    if match:
        return int(match.group(1))
    return chapter_index + 1


def audio_part_stem(chapter_number: int, part_index: int) -> str:
    return f"chapter-{chapter_number:02}-part-{part_index + 1:03}"


def part_audio_path(book_slug: str, chapter_number: int, part_index: int) -> Path:
    return AUDIO_DIR / book_slug / f"{audio_part_stem(chapter_number, part_index)}.wav"


def part_alignment_path(book_slug: str, chapter_number: int, part_index: int) -> Path:
    return AUDIO_DIR / book_slug / f"{audio_part_stem(chapter_number, part_index)}.alignment.json"


def part_audio_exists(book_slug: str, chapter_number: int, part_index: int) -> bool:
    return part_audio_path(book_slug, chapter_number, part_index).exists()


def part_alignment_exists(book_slug: str, chapter_number: int, part_index: int) -> bool:
    return part_alignment_path(book_slug, chapter_number, part_index).exists()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def is_redundant_title_paragraph(book_title: str, paragraph_text: str) -> bool:
    normalized_title = normalize_display_text(book_title)
    normalized_paragraph = normalize_display_text(paragraph_text)
    if normalized_title == normalized_paragraph:
        return True
    return normalize_display_text(re.sub(r"^[^\w]+", "", paragraph_text)) == normalized_title


def is_divider_paragraph(paragraph_text: str) -> bool:
    return " ".join(paragraph_text.split()).upper() == "X X X"


def normalize_display_text(text: str) -> str:
    return " ".join(text.replace("’", "'").split()).strip().lower()


def chapter_heading_paragraphs_to_skip(chapter_title: str, leading_paragraphs: list[str]) -> int:
    normalized_title = normalize_display_text(chapter_title)
    if not normalized_title or not leading_paragraphs:
        return 0
    if normalize_display_text(leading_paragraphs[0]) == normalized_title:
        return 1

    title_without_number = normalize_display_text(re.sub(r"^\d+\W*", "", chapter_title))
    if len(leading_paragraphs) >= 2:
        combined = normalize_display_text(" ".join(leading_paragraphs[:2]))
        if combined == normalized_title:
            return 2
        if leading_paragraphs[0].strip().isdigit() and title_without_number and normalize_display_text(leading_paragraphs[1]) == title_without_number:
            return 2
    if title_without_number and normalize_display_text(leading_paragraphs[0]) == title_without_number:
        return 1
    return 0


def build_cefr_parts(paragraphs: list[str], max_chars: int = MAX_CEFR_CHARS) -> list[tuple[int, int]]:
    parts: list[tuple[int, int]] = []
    start = 0
    current_size = 0
    for index, paragraph in enumerate(paragraphs):
        separator = 2 if index > start else 0
        if index > start and current_size + separator + len(paragraph) > max_chars:
            parts.append((start, index - 1))
            start = index
            current_size = len(paragraph)
            continue
        current_size += separator + len(paragraph)
    if paragraphs:
        parts.append((start, len(paragraphs) - 1))
    return parts


def import_book(connection: sqlite3.Connection, path: Path, *, with_cefr: bool = False) -> tuple[dict[str, object], str]:
    stat = path.stat()
    source_path = str(path.resolve())
    existing = connection.execute(
        "SELECT id, source_mtime, source_size, cover_path FROM books WHERE source_path = ?",
        (source_path,),
    ).fetchone()
    chapter_count = 0
    if existing:
        chapter_count_row = connection.execute(
            "SELECT COUNT(*) AS count FROM book_chapters WHERE book_id = ?",
            (int(existing["id"]),),
        ).fetchone()
        chapter_count = int(chapter_count_row["count"] or 0) if chapter_count_row else 0
    if existing and existing["source_mtime"] == stat.st_mtime and existing["source_size"] == stat.st_size and chapter_count:
        if not existing["cover_path"]:
            extracted = read_epub(path)
            connection.execute(
                "UPDATE books SET cover_path = ?, updated_at = ? WHERE id = ?",
                (extracted.cover_path, now_iso(), int(existing["id"])),
            )
            connection.commit()
        ensure_cefr_parts(connection, int(existing["id"]))
        return summarize_book_row(connection, int(existing["id"])), "skipped"

    extracted = read_epub(path)
    grouped_tokens = [plain_tokens(paragraph) for paragraph in extracted.paragraphs]
    paragraph_rows: list[tuple[int, str]] = []
    token_rows: list[tuple[int, int, str, str, str, str | None, str | None]] = []
    token_index = 0

    for paragraph_index, paragraph in enumerate(extracted.paragraphs):
        paragraph_rows.append((paragraph_index, paragraph))
        for token in grouped_tokens[paragraph_index]:
            token_rows.append(
                (
                    token_index,
                    paragraph_index,
                    token["text"],
                    normalize_text(token["text"]),
                    root_word(token["text"]),
                    None,
                    None,
                )
            )
            token_index += 1

    timestamp = now_iso()
    if existing:
        book_id = int(existing["id"])
        connection.execute(
            """
            UPDATE books
            SET slug = ?, title = ?, author = ?, source_mtime = ?, source_size = ?, cover_path = ?, text_status = ?, cefr_status = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                slugify(extracted.title or path.stem),
                extracted.title or path.stem,
                extracted.author,
                stat.st_mtime,
                stat.st_size,
                extracted.cover_path,
                "ready",
                "pending",
                timestamp,
                book_id,
            ),
        )
        connection.execute("DELETE FROM book_paragraphs WHERE book_id = ?", (book_id,))
        connection.execute("DELETE FROM book_tokens WHERE book_id = ?", (book_id,))
        connection.execute("DELETE FROM book_cefr_parts WHERE book_id = ?", (book_id,))
        connection.execute("DELETE FROM book_chapters WHERE book_id = ?", (book_id,))
        status = "updated"
    else:
        cursor = connection.execute(
            """
            INSERT INTO books (
                slug, title, author, source_path, source_mtime, source_size, cover_path, text_status, cefr_status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                slugify(extracted.title or path.stem),
                extracted.title or path.stem,
                extracted.author,
                source_path,
                stat.st_mtime,
                stat.st_size,
                extracted.cover_path,
                "ready",
                "pending",
                timestamp,
                timestamp,
            ),
        )
        book_id = int(cursor.lastrowid)
        status = "imported"

    connection.executemany(
        "INSERT INTO book_paragraphs (book_id, paragraph_index, text) VALUES (?, ?, ?)",
        ((book_id, paragraph_index, paragraph) for paragraph_index, paragraph in paragraph_rows),
    )
    connection.executemany(
        """
        INSERT INTO book_tokens (book_id, token_index, paragraph_index, text, normalized_text, root_text, cefr_level, oxford_tip)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            (book_id, token_index_value, paragraph_index, text, normalized_text, root_text, cefr_level, oxford_tip)
            for token_index_value, paragraph_index, text, normalized_text, root_text, cefr_level, oxford_tip in token_rows
        ),
    )

    connection.executemany(
        """
        INSERT INTO book_cefr_parts (book_id, part_index, start_paragraph_index, end_paragraph_index, status, updated_at, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            (book_id, part_index, start, end, "pending", timestamp, None)
            for part_index, (start, end) in enumerate(build_cefr_parts(extracted.paragraphs))
        ),
    )
    connection.executemany(
        """
        INSERT INTO book_chapters (book_id, chapter_index, title, source_href, start_paragraph_index, end_paragraph_index)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            (
                book_id,
                chapter_index,
                chapter.title,
                chapter.source_href,
                chapter.start_paragraph_index,
                chapter.end_paragraph_index,
            )
            for chapter_index, chapter in enumerate(extracted.chapters)
        ),
    )
    connection.commit()

    if with_cefr:
        for part_index, _ in enumerate(build_cefr_parts(extracted.paragraphs)):
            enrich_book_part_cefr(connection, book_id, part_index)
    return summarize_book_row(connection, book_id), status


def scan_books_directory(connection: sqlite3.Connection, books_dir: Path, *, with_cefr: bool = False) -> dict[str, object]:
    books_dir.mkdir(parents=True, exist_ok=True)
    counts = {"imported": 0, "updated": 0, "skipped": 0}
    for path in sorted(books_dir.glob("*.epub")):
        _, status = import_book(connection, path, with_cefr=with_cefr)
        counts[status] += 1
    counts["books"] = list_books(connection)
    return counts


def store_uploaded_book(upload_name: str, content: bytes, books_dir: Path) -> Path:
    books_dir.mkdir(parents=True, exist_ok=True)
    source_name = Path(upload_name).name or "upload.epub"
    candidate = books_dir / source_name
    stem = candidate.stem
    suffix = candidate.suffix or ".epub"
    counter = 2
    while candidate.exists():
        if candidate.read_bytes() == content:
            return candidate
        candidate = books_dir / f"{stem}-{counter}{suffix}"
        counter += 1
    candidate.write_bytes(content)
    return candidate


def ensure_cefr_parts(connection: sqlite3.Connection, book_id: int) -> None:
    existing = connection.execute("SELECT COUNT(*) AS count FROM book_cefr_parts WHERE book_id = ?", (book_id,)).fetchone()
    if existing and int(existing["count"] or 0):
        return
    paragraphs = connection.execute(
        "SELECT text FROM book_paragraphs WHERE book_id = ? ORDER BY paragraph_index",
        (book_id,),
    ).fetchall()
    timestamp = now_iso()
    connection.executemany(
        """
        INSERT INTO book_cefr_parts (book_id, part_index, start_paragraph_index, end_paragraph_index, status, updated_at, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            (book_id, part_index, start, end, "pending", timestamp, None)
            for part_index, (start, end) in enumerate(build_cefr_parts([paragraph["text"] for paragraph in paragraphs]))
        ),
    )
    connection.execute("UPDATE books SET cefr_status = ?, updated_at = ? WHERE id = ?", ("pending", timestamp, book_id))
    connection.commit()


def list_books(connection: sqlite3.Connection) -> list[dict[str, object]]:
    rows = connection.execute(
        """
        SELECT
            b.id,
            b.title,
            b.author,
            b.cover_path,
            b.cefr_status,
            rp.last_read_at,
            rp.last_paragraph_index,
            (
                SELECT COUNT(*)
                FROM book_cefr_parts cp
                WHERE cp.book_id = b.id AND cp.status = 'ready'
            ) AS ready_parts,
            (
                SELECT COUNT(*)
                FROM book_cefr_parts cp
                WHERE cp.book_id = b.id
            ) AS total_parts,
            (
                SELECT COUNT(*)
                FROM book_paragraphs p
                WHERE p.book_id = b.id
            ) AS total_paragraphs
        FROM books b
        LEFT JOIN reading_progress rp ON rp.book_id = b.id
        ORDER BY COALESCE(rp.last_read_at, b.updated_at) DESC, b.title COLLATE NOCASE ASC
        """
    ).fetchall()
    return [summarize_book_values(row) for row in rows]


def get_reader_payload(connection: sqlite3.Connection, book_id: int) -> dict[str, object] | None:
    ensure_cefr_parts(connection, book_id)
    book = connection.execute(
        "SELECT id, slug, title, author, cefr_status FROM books WHERE id = ?",
        (book_id,),
    ).fetchone()
    if not book:
        return None

    progress_row = connection.execute(
        """
        SELECT
            last_read_at,
            last_paragraph_index,
            last_token_index,
            last_audio_chapter_index,
            last_audio_part_index,
            last_audio_time_seconds
        FROM reading_progress
        WHERE book_id = ?
        """,
        (book_id,),
    ).fetchone()
    chapter_rows = connection.execute(
        """
        SELECT chapter_index, title, source_href, start_paragraph_index, end_paragraph_index
        FROM book_chapters
        WHERE book_id = ?
        ORDER BY chapter_index
        """,
        (book_id,),
    ).fetchall()
    paragraph_rows = connection.execute(
        "SELECT paragraph_index, text FROM book_paragraphs WHERE book_id = ? ORDER BY paragraph_index",
        (book_id,),
    ).fetchall()
    parts = connection.execute(
        """
        SELECT part_index, start_paragraph_index, end_paragraph_index, status
        FROM book_cefr_parts
        WHERE book_id = ?
        ORDER BY part_index
        """,
        (book_id,),
    ).fetchall()
    total_paragraphs_row = connection.execute(
        "SELECT COUNT(*) AS count FROM book_paragraphs WHERE book_id = ?",
        (book_id,),
    ).fetchone()
    total_paragraphs = int(total_paragraphs_row["count"] or 0) if total_paragraphs_row else 0
    progress_total = max(total_paragraphs, 1)
    last_paragraph_index = int(progress_row["last_paragraph_index"]) if progress_row else 0
    ready_parts = sum(1 for part in parts if part["status"] == "ready")
    grouped_chapters = build_reader_chapters(chapter_rows, paragraph_rows)
    return {
        "id": book["id"],
        "title": book["title"],
        "author": book["author"],
        "cefr_status": book["cefr_status"],
        "cefr": {
            "status": book["cefr_status"],
            "ready_parts": ready_parts,
            "total_parts": len(parts),
        },
        "chapters": [
            {
                "chapter_index": chapter["chapter_index"],
                "title": chapter["title"],
                "start_paragraph_index": chapter["start_paragraph_index"],
                "end_paragraph_index": chapter["end_paragraph_index"],
                "parts": [
                    {
                        **part,
                        "audio_available": part_audio_exists(
                            str(book["slug"]),
                            chapter_audio_number(str(chapter["title"]), int(chapter["chapter_index"])),
                            int(part["part_index"]),
                        ),
                        "alignment_available": part_alignment_exists(
                            str(book["slug"]),
                            chapter_audio_number(str(chapter["title"]), int(chapter["chapter_index"])),
                            int(part["part_index"]),
                        ),
                    }
                    for part in chapter["parts"]
                ],
            }
            for chapter in grouped_chapters
        ],
        "cefr_parts": [
            {
                "part_index": part["part_index"],
                "start_paragraph_index": part["start_paragraph_index"],
                "end_paragraph_index": part["end_paragraph_index"],
                "status": part["status"],
            }
            for part in parts
        ],
        "progress": {
            "last_read_at": progress_row["last_read_at"] if progress_row else None,
            "last_paragraph_index": last_paragraph_index,
            "last_token_index": progress_row["last_token_index"] if progress_row else None,
            "last_audio_chapter_index": int(progress_row["last_audio_chapter_index"]) if progress_row and progress_row["last_audio_chapter_index"] is not None else None,
            "last_audio_part_index": int(progress_row["last_audio_part_index"]) if progress_row and progress_row["last_audio_part_index"] is not None else None,
            "last_audio_time_seconds": float(progress_row["last_audio_time_seconds"] or 0.0) if progress_row else 0.0,
            "percent": round((last_paragraph_index / progress_total) * 100, 1) if total_paragraphs else 0.0,
        },
        "total_paragraphs": total_paragraphs,
    }


def get_chapter_payload(connection: sqlite3.Connection, book_id: int, chapter_index: int) -> dict[str, object] | None:
    raw_chapter_rows = connection.execute(
        """
        SELECT chapter_index, title, source_href, start_paragraph_index, end_paragraph_index
        FROM book_chapters
        WHERE book_id = ?
        ORDER BY chapter_index
        """,
        (book_id,),
    ).fetchall()
    paragraph_rows = connection.execute(
        "SELECT paragraph_index, text FROM book_paragraphs WHERE book_id = ? ORDER BY paragraph_index",
        (book_id,),
    ).fetchall()
    chapters = build_reader_chapters(raw_chapter_rows, paragraph_rows)
    chapter = next((item for item in chapters if int(item["chapter_index"]) == chapter_index), None)
    if chapter is None:
        return None
    book = connection.execute("SELECT title, source_path FROM books WHERE id = ?", (book_id,)).fetchone()
    if not book:
        return None
    blocks: list[dict[str, object]] = []
    raw_rows = connection.execute(
        """
        SELECT chapter_index, title, source_href, start_paragraph_index, end_paragraph_index
        FROM book_chapters
        WHERE book_id = ? AND chapter_index BETWEEN ? AND ?
        ORDER BY chapter_index
        """,
        (book_id, chapter["raw_start_chapter_index"], chapter["raw_end_chapter_index"]),
    ).fetchall()
    for raw_row in raw_rows:
        blocks.extend(build_raw_chapter_blocks(connection, book_id, raw_row, str(book["title"]), Path(str(book["source_path"]))))
    return {
        "book_id": book_id,
        "chapter_index": chapter["chapter_index"],
        "title": chapter["title"],
        "blocks": blocks,
    }


def enrich_book_part_cefr(
    connection: sqlite3.Connection,
    book_id: int,
    part_index: int,
    *,
    cancel_scope: str | None = None,
    cancel_existing: bool = False,
) -> dict[str, object]:
    ensure_cefr_parts(connection, book_id)
    book = connection.execute("SELECT title FROM books WHERE id = ?", (book_id,)).fetchone()
    if not book:
        raise ValueError(f"Book {book_id} does not exist.")
    part = connection.execute(
        """
        SELECT part_index, start_paragraph_index, end_paragraph_index, status
        FROM book_cefr_parts
        WHERE book_id = ? AND part_index = ?
        """,
        (book_id, part_index),
    ).fetchone()
    if not part:
        raise ValueError(f"Part {part_index} was not found for book {book_id}.")
    if part["status"] == "ready":
        return get_cefr_part_payload(connection, book_id, part_index)

    paragraphs = connection.execute(
        """
        SELECT paragraph_index, text
        FROM book_paragraphs
        WHERE book_id = ? AND paragraph_index BETWEEN ? AND ?
        ORDER BY paragraph_index
        """,
        (book_id, part["start_paragraph_index"], part["end_paragraph_index"]),
    ).fetchall()
    if not paragraphs:
        raise ValueError(f"Book {book_id} part {part_index} has no paragraphs.")
    visible_paragraphs = [
        paragraph
        for paragraph in paragraphs
        if not is_redundant_title_paragraph(str(book["title"]), str(paragraph["text"]))
        and not is_divider_paragraph(str(paragraph["text"]))
    ]

    connection.execute(
        "UPDATE book_cefr_parts SET status = ?, updated_at = ?, error_message = NULL WHERE book_id = ? AND part_index = ?",
        ("loading", now_iso(), book_id, part_index),
    )
    connection.commit()

    try:
        grouped_tokens: list[list[dict[str, str]]] = []
        if visible_paragraphs:
            if cancel_scope and cancel_existing:
                cancel_cefr_fetch(cancel_scope)
            with CEFR_FETCH_LOCK:
                grouped_tokens = fetch_paragraph_tokens(
                    [paragraph["text"] for paragraph in visible_paragraphs],
                    scope=cancel_scope,
                )
        for offset, paragraph in enumerate(visible_paragraphs):
            paragraph_index = int(paragraph["paragraph_index"])
            current_tokens = connection.execute(
                """
                SELECT id, text
                FROM book_tokens
                WHERE book_id = ? AND paragraph_index = ?
                ORDER BY token_index
                """,
                (book_id, paragraph_index),
            ).fetchall()
            target_tokens = grouped_tokens[offset]
            if len(current_tokens) != len(target_tokens) or any(
                row["text"] != token["text"] for row, token in zip(current_tokens, target_tokens)
            ):
                raise RuntimeError(f"Token mismatch while enriching paragraph {paragraph_index}.")
            connection.executemany(
                "UPDATE book_tokens SET cefr_level = ?, oxford_tip = ? WHERE id = ?",
                (
                    (token.get("level") or None, token.get("tip") or None, row["id"])
                    for row, token in zip(current_tokens, target_tokens)
                ),
            )
        connection.execute(
            "UPDATE book_cefr_parts SET status = ?, updated_at = ?, error_message = NULL WHERE book_id = ? AND part_index = ?",
            ("ready", now_iso(), book_id, part_index),
        )
    except Exception as exc:
        connection.execute(
            "UPDATE book_cefr_parts SET status = ?, updated_at = ?, error_message = ? WHERE book_id = ? AND part_index = ?",
            ("error", now_iso(), str(exc), book_id, part_index),
        )
        update_book_cefr_status(connection, book_id)
        connection.commit()
        raise

    update_book_cefr_status(connection, book_id)
    connection.commit()
    return get_cefr_part_payload(connection, book_id, part_index)


def get_cefr_part_payload(connection: sqlite3.Connection, book_id: int, part_index: int) -> dict[str, object]:
    part = connection.execute(
        """
        SELECT part_index, start_paragraph_index, end_paragraph_index, status
        FROM book_cefr_parts
        WHERE book_id = ? AND part_index = ?
        """,
        (book_id, part_index),
    ).fetchone()
    if not part:
        raise ValueError(f"Part {part_index} was not found for book {book_id}.")
    book = connection.execute("SELECT title FROM books WHERE id = ?", (book_id,)).fetchone()
    if not book:
        raise ValueError(f"Book {book_id} does not exist.")
    paragraphs = connection.execute(
        """
        SELECT paragraph_index, text
        FROM book_paragraphs
        WHERE book_id = ? AND paragraph_index BETWEEN ? AND ?
        ORDER BY paragraph_index
        """,
        (book_id, part["start_paragraph_index"], part["end_paragraph_index"]),
    ).fetchall()
    tokens = connection.execute(
        """
        SELECT token_index, paragraph_index, text, normalized_text, root_text, cefr_level, oxford_tip
        FROM book_tokens
        WHERE book_id = ? AND paragraph_index BETWEEN ? AND ?
        ORDER BY token_index
        """,
        (book_id, part["start_paragraph_index"], part["end_paragraph_index"]),
    ).fetchall()
    tokens_by_paragraph: dict[int, list[dict[str, object]]] = {}
    for token in tokens:
        tokens_by_paragraph.setdefault(token["paragraph_index"], []).append(
            {
                "token_index": token["token_index"],
                "text": token["text"],
                "normalized_text": token["normalized_text"],
                "root_text": token["root_text"],
                "cefr_level": token["cefr_level"],
                "oxford_tip": token["oxford_tip"],
            }
        )
    cefr_status = update_book_cefr_status(connection, book_id)
    ready_parts = connection.execute(
        "SELECT COUNT(*) AS count FROM book_cefr_parts WHERE book_id = ? AND status = 'ready'",
        (book_id,),
    ).fetchone()
    total_parts = connection.execute(
        "SELECT COUNT(*) AS count FROM book_cefr_parts WHERE book_id = ?",
        (book_id,),
    ).fetchone()
    return {
        "book_id": book_id,
        "part_index": part["part_index"],
        "status": part["status"],
        "paragraphs": [
            {
                "paragraph_index": paragraph["paragraph_index"],
                "text": paragraph["text"],
                "tokens": tokens_by_paragraph.get(paragraph["paragraph_index"], []),
            }
            for paragraph in paragraphs
            if not is_redundant_title_paragraph(str(book["title"]), str(paragraph["text"]))
        ],
        "cefr": {
            "status": cefr_status,
            "ready_parts": int(ready_parts["count"] or 0) if ready_parts else 0,
            "total_parts": int(total_parts["count"] or 0) if total_parts else 0,
        },
    }


def get_book_asset(connection: sqlite3.Connection, book_id: int, chapter_index: int, asset_href: str) -> tuple[bytes, str] | None:
    row = connection.execute(
        """
        SELECT b.source_path, c.source_href
        FROM books b
        JOIN book_chapters c ON c.book_id = b.id
        WHERE b.id = ? AND c.chapter_index = ?
        """,
        (book_id, chapter_index),
    ).fetchone()
    if not row:
        return None
    return read_epub_asset(Path(str(row["source_path"])), str(row["source_href"]), unquote(asset_href))


def get_book_part_audio_path(
    connection: sqlite3.Connection,
    book_id: int,
    chapter_index: int,
    part_index: int,
) -> Path | None:
    payload = get_reader_payload(connection, book_id)
    if payload is None:
        return None
    chapter = next((item for item in payload["chapters"] if int(item["chapter_index"]) == chapter_index), None)
    if chapter is None:
        return None
    part = next((item for item in chapter["parts"] if int(item["part_index"]) == part_index), None)
    if part is None or not part.get("audio_available"):
        return None
    book = connection.execute("SELECT slug FROM books WHERE id = ?", (book_id,)).fetchone()
    if not book:
        return None
    path = part_audio_path(
        str(book["slug"]),
        chapter_audio_number(str(chapter["title"]), chapter_index),
        part_index,
    )
    return path if path.exists() else None


def get_book_part_alignment_payload(
    connection: sqlite3.Connection,
    book_id: int,
    chapter_index: int,
    part_index: int,
) -> dict[str, object] | None:
    payload = get_reader_payload(connection, book_id)
    if payload is None:
        return None
    chapter = next((item for item in payload["chapters"] if int(item["chapter_index"]) == chapter_index), None)
    if chapter is None:
        return None
    part = next((item for item in chapter["parts"] if int(item["part_index"]) == part_index), None)
    if part is None or not part.get("alignment_available"):
        return None
    book = connection.execute("SELECT slug FROM books WHERE id = ?", (book_id,)).fetchone()
    if not book:
        return None
    path = part_alignment_path(
        str(book["slug"]),
        chapter_audio_number(str(chapter["title"]), chapter_index),
        part_index,
    )
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as file:
        alignment = json.load(file)
    if (
        int(alignment.get("book_id", -1)) != book_id
        or int(alignment.get("chapter_index", -1)) != chapter_index
        or int(alignment.get("part_index", -1)) != part_index
    ):
        return None
    return alignment


def build_raw_chapter_blocks(
    connection: sqlite3.Connection,
    book_id: int,
    raw_chapter_row: sqlite3.Row,
    book_title: str,
    source_path: Path,
) -> list[dict[str, object]]:
    paragraphs = connection.execute(
        """
        SELECT paragraph_index, text
        FROM book_paragraphs
        WHERE book_id = ? AND paragraph_index BETWEEN ? AND ?
        ORDER BY paragraph_index
        """,
        (book_id, raw_chapter_row["start_paragraph_index"], raw_chapter_row["end_paragraph_index"]),
    ).fetchall()
    tokens = connection.execute(
        """
        SELECT token_index, paragraph_index, text, normalized_text, root_text, cefr_level, oxford_tip
        FROM book_tokens
        WHERE book_id = ? AND paragraph_index BETWEEN ? AND ?
        ORDER BY token_index
        """,
        (book_id, raw_chapter_row["start_paragraph_index"], raw_chapter_row["end_paragraph_index"]),
    ).fetchall()
    tokens_by_paragraph: dict[int, list[dict[str, object]]] = {}
    for token in tokens:
        tokens_by_paragraph.setdefault(token["paragraph_index"], []).append(
            {
                "token_index": token["token_index"],
                "text": token["text"],
                "normalized_text": token["normalized_text"],
                "root_text": token["root_text"],
                "cefr_level": token["cefr_level"],
                "oxford_tip": token["oxford_tip"],
            }
        )
    chapter_blocks = read_epub_chapter_blocks(source_path, str(raw_chapter_row["source_href"]))
    paragraph_index = 0
    blocks: list[dict[str, object]] = []
    skipped_heading_paragraphs = 0
    heading_paragraphs_to_skip = chapter_heading_paragraphs_to_skip(
        str(raw_chapter_row["title"]),
        [block.text for block in chapter_blocks[:2] if block.kind == "paragraph"],
    )
    for block in chapter_blocks:
        if block.kind == "image":
            if "Art_orn" in block.image_src:
                if paragraph_index < len(paragraphs) and is_divider_paragraph(str(paragraphs[paragraph_index]["text"])):
                    paragraph_index += 1
                continue
            blocks.append(
                {
                    "kind": "image",
                    "image": {
                        "src": f"/api/books/{book_id}/assets/{raw_chapter_row['chapter_index']}/{quote(block.image_src, safe='')}",
                        "alt": block.alt,
                    },
                }
            )
            continue
        paragraph = paragraphs[paragraph_index] if paragraph_index < len(paragraphs) else None
        paragraph_index += 1
        display_text = block.text
        if skipped_heading_paragraphs < heading_paragraphs_to_skip:
            skipped_heading_paragraphs += 1
            continue
        if paragraph is None or is_redundant_title_paragraph(book_title, display_text) or is_divider_paragraph(str(paragraph["text"])):
            continue
        blocks.append(
            {
                "kind": "paragraph",
                "paragraph": {
                    "paragraph_index": paragraph["paragraph_index"],
                    "text": display_text,
                    "tokens": tokens_by_paragraph.get(paragraph["paragraph_index"], []),
                },
            }
        )
    return blocks


def build_reader_chapters(raw_chapter_rows: list[sqlite3.Row], paragraph_rows: list[sqlite3.Row]) -> list[dict[str, object]]:
    paragraph_text_by_index = {int(row["paragraph_index"]): str(row["text"]) for row in paragraph_rows}
    groups: list[dict[str, object]] = []
    for row in raw_chapter_rows:
        group_key = chapter_group_key(str(row["title"]), str(row["source_href"]))
        if group_key is None:
            continue
        if not groups or groups[-1]["group_key"] != group_key:
            groups.append(
                {
                    "group_key": group_key,
                    "title": chapter_group_title(str(row["title"]), str(row["source_href"])),
                    "raw_rows": [row],
                }
            )
        else:
            groups[-1]["raw_rows"].append(row)

    chapters: list[dict[str, object]] = []
    for section_index, group in enumerate(groups):
        raw_rows = group["raw_rows"]
        start_paragraph_index = int(raw_rows[0]["start_paragraph_index"])
        end_paragraph_index = int(raw_rows[-1]["end_paragraph_index"])
        parts = build_chapter_parts(start_paragraph_index, end_paragraph_index, paragraph_text_by_index)
        chapters.append(
            {
                "chapter_index": section_index,
                "title": group["title"],
                "start_paragraph_index": start_paragraph_index,
                "end_paragraph_index": end_paragraph_index,
                "parts": parts,
                "raw_start_chapter_index": int(raw_rows[0]["chapter_index"]),
                "raw_end_chapter_index": int(raw_rows[-1]["chapter_index"]),
            }
        )
    return chapters


def build_chapter_parts(
    start_paragraph_index: int,
    end_paragraph_index: int,
    paragraph_text_by_index: dict[int, str],
) -> list[dict[str, object]]:
    parts: list[dict[str, object]] = []
    current_start = start_paragraph_index
    for paragraph_index in range(start_paragraph_index, end_paragraph_index + 1):
        if paragraph_index == current_start:
            continue
        if is_divider_paragraph(paragraph_text_by_index.get(paragraph_index, "")):
            parts.append(
                {
                    "part_index": len(parts),
                    "title": f"Part {len(parts) + 1}",
                    "start_paragraph_index": current_start,
                    "end_paragraph_index": paragraph_index - 1,
                }
            )
            current_start = paragraph_index + 1
    if end_paragraph_index >= current_start:
        parts.append(
            {
                "part_index": len(parts),
                "title": f"Part {len(parts) + 1}",
                "start_paragraph_index": current_start,
                "end_paragraph_index": end_paragraph_index,
            }
        )
    return parts if len(parts) > 1 else []


def chapter_group_key(title: str, source_href: str) -> str | None:
    stem = Path(source_href).stem.lower()
    if stem in {"toc", "newslettersignup"}:
        return None
    if stem.startswith("insert"):
        return "insert"
    if re.match(r"prologue(?:_[a-z])?$", stem):
        return "prologue"
    if re.match(r"chapter\d{3}(?:_[a-z])?$", stem):
        return stem.split("_", 1)[0]
    return stem


def chapter_group_title(title: str, source_href: str) -> str:
    stem = Path(source_href).stem.lower()
    if stem.startswith("insert"):
        return "Insert"
    return title


def update_book_cefr_status(connection: sqlite3.Connection, book_id: int) -> str:
    counts = connection.execute(
        """
        SELECT
            COUNT(*) AS total_parts,
            SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready_parts,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_parts
        FROM book_cefr_parts
        WHERE book_id = ?
        """,
        (book_id,),
    ).fetchone()
    total_parts = int(counts["total_parts"] or 0)
    ready_parts = int(counts["ready_parts"] or 0)
    error_parts = int(counts["error_parts"] or 0)
    if total_parts and ready_parts == total_parts:
        status = "ready"
    elif ready_parts:
        status = "partial"
    elif error_parts:
        status = "error"
    else:
        status = "pending"
    connection.execute("UPDATE books SET cefr_status = ?, updated_at = ? WHERE id = ?", (status, now_iso(), book_id))
    return status


def next_pending_cefr_part(connection: sqlite3.Connection, book_id: int | None = None) -> tuple[int, int, str] | None:
    book_filter = "AND cp.book_id = ?" if book_id is not None else ""
    params = (book_id,) if book_id is not None else ()
    row = connection.execute(
        f"""
        SELECT cp.book_id, cp.part_index, cp.start_paragraph_index, b.title
        FROM book_cefr_parts cp
        JOIN books b ON b.id = cp.book_id
        WHERE cp.status IN ('pending', 'error', 'loading')
        {book_filter}
        ORDER BY COALESCE((SELECT last_read_at FROM reading_progress rp WHERE rp.book_id = b.id), b.updated_at) DESC,
                 b.id ASC,
                 cp.part_index ASC
        LIMIT 1
        """,
        params,
    ).fetchone()
    if not row:
        return None
    target_book_id = int(row["book_id"])
    return (
        target_book_id,
        int(row["part_index"]),
        cefr_sidebar_label(connection, target_book_id, int(row["start_paragraph_index"]), str(row["title"])),
    )


def cefr_sidebar_label(connection: sqlite3.Connection, book_id: int, paragraph_index: int, book_title: str) -> str:
    chapter_rows = connection.execute(
        """
        SELECT chapter_index, title, source_href, start_paragraph_index, end_paragraph_index
        FROM book_chapters
        WHERE book_id = ?
        ORDER BY chapter_index
        """,
        (book_id,),
    ).fetchall()
    paragraph_rows = connection.execute(
        "SELECT paragraph_index, text FROM book_paragraphs WHERE book_id = ? ORDER BY paragraph_index",
        (book_id,),
    ).fetchall()
    for chapter in build_reader_chapters(chapter_rows, paragraph_rows):
        if not int(chapter["start_paragraph_index"]) <= paragraph_index <= int(chapter["end_paragraph_index"]):
            continue
        for part in chapter["parts"]:
            if int(part["start_paragraph_index"]) <= paragraph_index <= int(part["end_paragraph_index"]):
                return f"{book_title} · {chapter['title']} · {part['title']}"
        return f"{book_title} · {chapter['title']}"
    return book_title


def start_cefr_job(connection: sqlite3.Connection, book_id: int | None = None) -> dict[str, object]:
    running = connection.execute(
        "SELECT id FROM cefr_jobs WHERE status = 'running' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if running:
        return get_cefr_job_status(connection)
    if book_id is not None:
        book = connection.execute("SELECT id FROM books WHERE id = ?", (book_id,)).fetchone()
        if not book:
            raise ValueError(f"Book {book_id} does not exist.")
        ensure_cefr_parts(connection, book_id)
    book_filter = "WHERE book_id = ?" if book_id is not None else ""
    params = (book_id,) if book_id is not None else ()
    counts = connection.execute(
        f"""
        SELECT
            COUNT(*) AS total_parts,
            SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready_parts
        FROM book_cefr_parts
        {book_filter}
        """,
        params,
    ).fetchone()
    total_parts = int(counts["total_parts"] or 0)
    ready_parts = int(counts["ready_parts"] or 0)
    pending_parts = max(total_parts - ready_parts, 0)
    timestamp = now_iso()
    connection.execute(
        """
        INSERT INTO cefr_jobs (status, total_parts, completed_parts, current_label, error_message, started_at, updated_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        ("running" if pending_parts else "complete", total_parts, ready_parts, None, None, timestamp, timestamp, timestamp if not pending_parts else None),
    )
    connection.commit()
    return get_cefr_job_status(connection)


def recover_interrupted_cefr_jobs(connection: sqlite3.Connection) -> None:
    timestamp = now_iso()
    connection.execute(
        """
        UPDATE cefr_jobs
        SET status = ?, error_message = COALESCE(error_message, ?), updated_at = ?, finished_at = COALESCE(finished_at, ?)
        WHERE status = ?
        """,
        ("interrupted", "Server restarted before the CEFR job finished.", timestamp, timestamp, "running"),
    )
    connection.commit()


def update_cefr_job_progress(
    connection: sqlite3.Connection,
    job_id: int,
    *,
    current_label: str | None = None,
    error_message: str | None = None,
    status: str | None = None,
    finished: bool = False,
) -> None:
    current = connection.execute(
        "SELECT completed_parts FROM cefr_jobs WHERE id = ?",
        (job_id,),
    ).fetchone()
    if not current:
        return
    completed = int(current["completed_parts"] or 0)
    if current_label is None and status is None and not finished:
        completed += 1
    connection.execute(
        """
        UPDATE cefr_jobs
        SET status = ?, completed_parts = ?, current_label = COALESCE(?, current_label), error_message = COALESCE(?, error_message),
            updated_at = ?, finished_at = COALESCE(?, finished_at)
        WHERE id = ?
        """,
        (status or "running", completed, current_label, error_message, now_iso(), now_iso() if finished else None, job_id),
    )
    connection.commit()


def get_cefr_job_status(connection: sqlite3.Connection) -> dict[str, object]:
    row = connection.execute(
        """
        SELECT id, status, total_parts, completed_parts, current_label, error_message
        FROM cefr_jobs
        ORDER BY id DESC
        LIMIT 1
        """
    ).fetchone()
    counts = connection.execute(
        """
        SELECT
            COUNT(*) AS total_parts,
            SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready_parts
        FROM book_cefr_parts
        """
    ).fetchone()
    total_parts = int(counts["total_parts"] or 0)
    ready_parts = int(counts["ready_parts"] or 0)
    if not row:
        return {
            "id": None,
            "status": "idle",
            "total_parts": total_parts,
            "completed_parts": ready_parts,
            "ready_parts": ready_parts,
            "current_label": None,
            "error_message": None,
        }
    return {
        "id": row["id"],
        "status": row["status"],
        "total_parts": int(row["total_parts"] or 0),
        "completed_parts": int(row["completed_parts"] or 0),
        "ready_parts": ready_parts,
        "current_label": row["current_label"],
        "error_message": row["error_message"],
    }


def save_progress(
    connection: sqlite3.Connection,
    book_id: int,
    paragraph_index: int,
    token_index: int | None,
    *,
    audio_chapter_index: int | None = None,
    audio_part_index: int | None = None,
    audio_time_seconds: float | None = None,
) -> dict[str, object]:
    timestamp = now_iso()
    connection.execute(
        """
        INSERT INTO reading_progress (
            book_id,
            last_read_at,
            last_paragraph_index,
            last_token_index,
            last_audio_chapter_index,
            last_audio_part_index,
            last_audio_time_seconds
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(book_id) DO UPDATE SET
            last_read_at = excluded.last_read_at,
            last_paragraph_index = excluded.last_paragraph_index,
            last_token_index = excluded.last_token_index,
            last_audio_chapter_index = COALESCE(excluded.last_audio_chapter_index, reading_progress.last_audio_chapter_index),
            last_audio_part_index = COALESCE(excluded.last_audio_part_index, reading_progress.last_audio_part_index),
            last_audio_time_seconds = COALESCE(excluded.last_audio_time_seconds, reading_progress.last_audio_time_seconds)
        """,
        (
            book_id,
            timestamp,
            paragraph_index,
            token_index,
            audio_chapter_index,
            audio_part_index,
            audio_time_seconds,
        ),
    )
    connection.commit()
    payload = get_reader_payload(connection, book_id)
    if payload is None:
        raise ValueError(f"Book {book_id} does not exist.")
    return payload["progress"]


def list_wordlist_entries(connection: sqlite3.Connection, book_id: int | None = None) -> list[dict[str, object]]:
    book_filter = "WHERE w.book_id = ?" if book_id is not None else ""
    params = (book_id,) if book_id is not None else ()
    rows = connection.execute(
        f"""
        SELECT
            w.id,
            w.book_id,
            b.title AS book_title,
            w.root_word,
            w.original_word,
            w.context,
            w.paragraph_index,
            w.token_index,
            w.created_at
        FROM wordlist_entries w
        JOIN books b ON b.id = w.book_id
        {book_filter}
        ORDER BY w.created_at DESC, w.id DESC
        """,
        params,
    ).fetchall()
    return [wordlist_entry_values(row) for row in rows]


def save_wordlist_entry(
    connection: sqlite3.Connection,
    book_id: int,
    word: str,
    context: str,
    paragraph_index: int,
    token_index: int,
) -> dict[str, object]:
    token = connection.execute(
        """
        SELECT root_text
        FROM book_tokens
        WHERE book_id = ? AND paragraph_index = ? AND token_index = ?
        """,
        (book_id, paragraph_index, token_index),
    ).fetchone()
    if not token:
        raise ValueError("Word token not found.")
    root = str(token["root_text"] or root_word(word))
    if not root:
        raise ValueError("Select one English word.")
    connection.execute(
        """
        INSERT OR IGNORE INTO wordlist_entries (
            book_id, root_word, original_word, context, paragraph_index, token_index, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (book_id, root, word, " ".join(context.split()), paragraph_index, token_index, now_iso()),
    )
    connection.commit()
    row = connection.execute(
        """
        SELECT
            w.id,
            w.book_id,
            b.title AS book_title,
            w.root_word,
            w.original_word,
            w.context,
            w.paragraph_index,
            w.token_index,
            w.created_at
        FROM wordlist_entries w
        JOIN books b ON b.id = w.book_id
        WHERE w.book_id = ? AND w.token_index = ?
        """,
        (book_id, token_index),
    ).fetchone()
    return wordlist_entry_values(row)


def summarize_book_row(connection: sqlite3.Connection, book_id: int) -> dict[str, object]:
    row = connection.execute(
        """
        SELECT
            b.id,
            b.title,
            b.author,
            b.cover_path,
            b.cefr_status,
            rp.last_read_at,
            rp.last_paragraph_index,
            (
                SELECT COUNT(*)
                FROM book_cefr_parts cp
                WHERE cp.book_id = b.id AND cp.status = 'ready'
            ) AS ready_parts,
            (
                SELECT COUNT(*)
                FROM book_cefr_parts cp
                WHERE cp.book_id = b.id
            ) AS total_parts,
            (
                SELECT COUNT(*)
                FROM book_paragraphs p
                WHERE p.book_id = b.id
            ) AS total_paragraphs
        FROM books b
        LEFT JOIN reading_progress rp ON rp.book_id = b.id
        WHERE b.id = ?
        """,
        (book_id,),
    ).fetchone()
    return summarize_book_values(row)


def summarize_book_values(row: sqlite3.Row) -> dict[str, object]:
    total_paragraphs = max(int(row["total_paragraphs"] or 0), 1)
    current_paragraph = int(row["last_paragraph_index"] or 0)
    percent = round((current_paragraph / total_paragraphs) * 100, 1) if row["total_paragraphs"] else 0.0
    ready_parts = int(row["ready_parts"] or 0)
    total_parts = int(row["total_parts"] or 0)
    cefr_percent = round((ready_parts / total_parts) * 100, 1) if total_parts else 0.0
    return {
        "id": int(row["id"]),
        "title": row["title"],
        "author": row["author"],
        "cover_url": build_cover_url(int(row["id"]), row["cover_path"]),
        "has_cefr": ready_parts > 0,
        "cefr_status": row["cefr_status"],
        "cefr_ready_parts": ready_parts,
        "cefr_total_parts": total_parts,
        "cefr_percent": cefr_percent,
        "progress_percent": percent,
        "progress_label": f"Paragraph {min(current_paragraph + 1, total_paragraphs)} of {total_paragraphs}",
        "last_read_at": row["last_read_at"],
    }


def wordlist_entry_values(row: sqlite3.Row) -> dict[str, object]:
    return {
        "id": int(row["id"]),
        "book_id": int(row["book_id"]),
        "book_title": row["book_title"],
        "root_word": row["root_word"],
        "original_word": row["original_word"],
        "context": row["context"],
        "paragraph_index": int(row["paragraph_index"]),
        "token_index": int(row["token_index"]),
        "created_at": row["created_at"],
    }


def build_cover_url(book_id: int, cover_path: str | None) -> str | None:
    if not cover_path:
        return None
    return f"/api/books/{book_id}/cover/{quote(cover_path, safe='')}"
