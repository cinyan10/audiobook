from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path


DB_PATH = Path("data") / "web_book_reader.sqlite3"

SCHEMA = """
CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    source_path TEXT NOT NULL UNIQUE,
    source_mtime REAL NOT NULL,
    source_size INTEGER NOT NULL,
    cover_path TEXT,
    text_status TEXT NOT NULL DEFAULT 'ready',
    cefr_status TEXT NOT NULL DEFAULT 'missing',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS book_paragraphs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    paragraph_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    UNIQUE(book_id, paragraph_index)
);

CREATE TABLE IF NOT EXISTS book_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    token_index INTEGER NOT NULL,
    paragraph_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    normalized_text TEXT NOT NULL DEFAULT '',
    cefr_level TEXT,
    oxford_tip TEXT,
    UNIQUE(book_id, token_index)
);

CREATE TABLE IF NOT EXISTS book_cefr_parts (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    part_index INTEGER NOT NULL,
    start_paragraph_index INTEGER NOT NULL,
    end_paragraph_index INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    updated_at TEXT NOT NULL,
    error_message TEXT,
    PRIMARY KEY(book_id, part_index)
);

CREATE TABLE IF NOT EXISTS book_chapters (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_index INTEGER NOT NULL,
    title TEXT NOT NULL,
    source_href TEXT NOT NULL DEFAULT '',
    start_paragraph_index INTEGER NOT NULL,
    end_paragraph_index INTEGER NOT NULL,
    PRIMARY KEY(book_id, chapter_index)
);

CREATE TABLE IF NOT EXISTS reading_progress (
    book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    last_read_at TEXT NOT NULL,
    last_paragraph_index INTEGER NOT NULL DEFAULT 0,
    last_token_index INTEGER,
    last_audio_chapter_index INTEGER,
    last_audio_part_index INTEGER,
    last_audio_time_seconds REAL
);

CREATE TABLE IF NOT EXISTS cefr_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL,
    total_parts INTEGER NOT NULL DEFAULT 0,
    completed_parts INTEGER NOT NULL DEFAULT 0,
    current_label TEXT,
    error_message TEXT,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
CREATE INDEX IF NOT EXISTS idx_book_paragraphs_book ON book_paragraphs(book_id, paragraph_index);
CREATE INDEX IF NOT EXISTS idx_book_tokens_book ON book_tokens(book_id, paragraph_index, token_index);
CREATE INDEX IF NOT EXISTS idx_book_cefr_parts_book ON book_cefr_parts(book_id, part_index);
CREATE INDEX IF NOT EXISTS idx_book_chapters_book ON book_chapters(book_id, chapter_index);
CREATE INDEX IF NOT EXISTS idx_reading_progress_last_read ON reading_progress(last_read_at DESC);
CREATE INDEX IF NOT EXISTS idx_cefr_jobs_updated ON cefr_jobs(updated_at DESC);
"""


def connect(db_path: Path = DB_PATH) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db(db_path: Path = DB_PATH) -> None:
    with connect(db_path) as connection:
        connection.executescript(SCHEMA)
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(reading_progress)")}
        if "last_audio_chapter_index" not in columns:
            connection.execute("ALTER TABLE reading_progress ADD COLUMN last_audio_chapter_index INTEGER")
        if "last_audio_part_index" not in columns:
            connection.execute("ALTER TABLE reading_progress ADD COLUMN last_audio_part_index INTEGER")
        if "last_audio_time_seconds" not in columns:
            connection.execute("ALTER TABLE reading_progress ADD COLUMN last_audio_time_seconds REAL")
        connection.commit()


@contextmanager
def get_connection(db_path: Path = DB_PATH) -> sqlite3.Connection:
    connection = connect(db_path)
    try:
        yield connection
    finally:
        connection.close()
