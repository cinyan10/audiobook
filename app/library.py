from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

from app.cefr import MAX_CEFR_CHARS, fetch_paragraph_tokens, normalize_text, plain_tokens
from app.epub import read_epub, slugify


CEFR_FETCH_LOCK = threading.Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


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
        "SELECT id, source_mtime, source_size FROM books WHERE source_path = ?",
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
        ensure_cefr_parts(connection, int(existing["id"]))
        return summarize_book_row(connection, int(existing["id"])), "skipped"

    extracted = read_epub(path)
    grouped_tokens = [plain_tokens(paragraph) for paragraph in extracted.paragraphs]
    paragraph_rows: list[tuple[int, str]] = []
    token_rows: list[tuple[int, int, str, str, str | None, str | None]] = []
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
            SET slug = ?, title = ?, author = ?, source_mtime = ?, source_size = ?, text_status = ?, cefr_status = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                slugify(extracted.title or path.stem),
                extracted.title or path.stem,
                extracted.author,
                stat.st_mtime,
                stat.st_size,
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
                None,
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
        INSERT INTO book_tokens (book_id, token_index, paragraph_index, text, normalized_text, cefr_level, oxford_tip)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            (book_id, token_index_value, paragraph_index, text, normalized_text, cefr_level, oxford_tip)
            for token_index_value, paragraph_index, text, normalized_text, cefr_level, oxford_tip in token_rows
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
        "SELECT id, title, author, cefr_status FROM books WHERE id = ?",
        (book_id,),
    ).fetchone()
    if not book:
        return None

    progress_row = connection.execute(
        "SELECT last_read_at, last_paragraph_index, last_token_index FROM reading_progress WHERE book_id = ?",
        (book_id,),
    ).fetchone()
    chapter_rows = connection.execute(
        """
        SELECT chapter_index, title, start_paragraph_index, end_paragraph_index
        FROM book_chapters
        WHERE book_id = ?
        ORDER BY chapter_index
        """,
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
            }
            for chapter in chapter_rows
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
            "percent": round((last_paragraph_index / progress_total) * 100, 1) if total_paragraphs else 0.0,
        },
        "total_paragraphs": total_paragraphs,
    }


def get_chapter_payload(connection: sqlite3.Connection, book_id: int, chapter_index: int) -> dict[str, object] | None:
    chapter = connection.execute(
        """
        SELECT chapter_index, title, start_paragraph_index, end_paragraph_index
        FROM book_chapters
        WHERE book_id = ? AND chapter_index = ?
        """,
        (book_id, chapter_index),
    ).fetchone()
    if not chapter:
        return None
    paragraphs = connection.execute(
        """
        SELECT paragraph_index, text
        FROM book_paragraphs
        WHERE book_id = ? AND paragraph_index BETWEEN ? AND ?
        ORDER BY paragraph_index
        """,
        (book_id, chapter["start_paragraph_index"], chapter["end_paragraph_index"]),
    ).fetchall()
    tokens = connection.execute(
        """
        SELECT token_index, paragraph_index, text, normalized_text, cefr_level, oxford_tip
        FROM book_tokens
        WHERE book_id = ? AND paragraph_index BETWEEN ? AND ?
        ORDER BY token_index
        """,
        (book_id, chapter["start_paragraph_index"], chapter["end_paragraph_index"]),
    ).fetchall()
    tokens_by_paragraph: dict[int, list[dict[str, object]]] = {}
    for token in tokens:
        tokens_by_paragraph.setdefault(token["paragraph_index"], []).append(
            {
                "token_index": token["token_index"],
                "text": token["text"],
                "normalized_text": token["normalized_text"],
                "cefr_level": token["cefr_level"],
                "oxford_tip": token["oxford_tip"],
            }
        )
    return {
        "book_id": book_id,
        "chapter_index": chapter["chapter_index"],
        "title": chapter["title"],
        "paragraphs": [
            {
                "paragraph_index": paragraph["paragraph_index"],
                "text": paragraph["text"],
                "tokens": tokens_by_paragraph.get(paragraph["paragraph_index"], []),
            }
            for paragraph in paragraphs
        ],
    }


def enrich_book_part_cefr(connection: sqlite3.Connection, book_id: int, part_index: int) -> dict[str, object]:
    ensure_cefr_parts(connection, book_id)
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

    connection.execute(
        "UPDATE book_cefr_parts SET status = ?, updated_at = ?, error_message = NULL WHERE book_id = ? AND part_index = ?",
        ("loading", now_iso(), book_id, part_index),
    )
    connection.commit()

    try:
        with CEFR_FETCH_LOCK:
            grouped_tokens = fetch_paragraph_tokens([paragraph["text"] for paragraph in paragraphs])
        for offset, paragraph in enumerate(paragraphs):
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
        SELECT token_index, paragraph_index, text, normalized_text, cefr_level, oxford_tip
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
        ],
        "cefr": {
            "status": cefr_status,
            "ready_parts": int(ready_parts["count"] or 0) if ready_parts else 0,
            "total_parts": int(total_parts["count"] or 0) if total_parts else 0,
        },
    }


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


def next_pending_cefr_part(connection: sqlite3.Connection) -> tuple[int, int, str] | None:
    row = connection.execute(
        """
        SELECT cp.book_id, cp.part_index, b.title
        FROM book_cefr_parts cp
        JOIN books b ON b.id = cp.book_id
        WHERE cp.status IN ('pending', 'error')
        ORDER BY COALESCE((SELECT last_read_at FROM reading_progress rp WHERE rp.book_id = b.id), b.updated_at) DESC,
                 b.id ASC,
                 cp.part_index ASC
        LIMIT 1
        """
    ).fetchone()
    if not row:
        return None
    return int(row["book_id"]), int(row["part_index"]), f"{row['title']} · part {int(row['part_index']) + 1}"


def start_cefr_job(connection: sqlite3.Connection) -> dict[str, object]:
    running = connection.execute(
        "SELECT id FROM cefr_jobs WHERE status = 'running' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if running:
        return get_cefr_job_status(connection)
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


def save_progress(connection: sqlite3.Connection, book_id: int, paragraph_index: int, token_index: int | None) -> dict[str, object]:
    timestamp = now_iso()
    connection.execute(
        """
        INSERT INTO reading_progress (book_id, last_read_at, last_paragraph_index, last_token_index)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(book_id) DO UPDATE SET
            last_read_at = excluded.last_read_at,
            last_paragraph_index = excluded.last_paragraph_index,
            last_token_index = excluded.last_token_index
        """,
        (book_id, timestamp, paragraph_index, token_index),
    )
    connection.commit()
    payload = get_reader_payload(connection, book_id)
    if payload is None:
        raise ValueError(f"Book {book_id} does not exist.")
    return payload["progress"]


def summarize_book_row(connection: sqlite3.Connection, book_id: int) -> dict[str, object]:
    row = connection.execute(
        """
        SELECT
            b.id,
            b.title,
            b.author,
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
    return {
        "id": int(row["id"]),
        "title": row["title"],
        "author": row["author"],
        "has_cefr": ready_parts > 0,
        "cefr_status": row["cefr_status"],
        "cefr_ready_parts": ready_parts,
        "cefr_total_parts": total_parts,
        "progress_percent": percent,
        "progress_label": f"Paragraph {min(current_paragraph + 1, total_paragraphs)} of {total_paragraphs}",
        "last_read_at": row["last_read_at"],
    }
