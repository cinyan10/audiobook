use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::epub;
use crate::models::{BookSummary, ChapterBlock, ChapterPayload, ChapterSummary, ReaderPayload, ReadingProgress};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL UNIQUE,
    original_filename TEXT NOT NULL,
    stored_path TEXT NOT NULL UNIQUE,
    cover_asset_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS book_chapters (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_index INTEGER NOT NULL,
    title TEXT NOT NULL,
    source_href TEXT NOT NULL DEFAULT '',
    start_block_index INTEGER NOT NULL,
    end_block_index INTEGER NOT NULL,
    PRIMARY KEY(book_id, chapter_index)
);

CREATE TABLE IF NOT EXISTS chapter_blocks (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_index INTEGER NOT NULL,
    block_index INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    asset_path TEXT,
    alt TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(book_id, block_index)
);

CREATE TABLE IF NOT EXISTS reading_progress (
    book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    last_read_at TEXT NOT NULL,
    last_chapter_index INTEGER NOT NULL DEFAULT 0,
    last_block_index INTEGER NOT NULL DEFAULT 0,
    progress_percent REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
CREATE INDEX IF NOT EXISTS idx_book_chapters_book ON book_chapters(book_id, chapter_index);
CREATE INDEX IF NOT EXISTS idx_chapter_blocks_book ON chapter_blocks(book_id, chapter_index, block_index);
CREATE INDEX IF NOT EXISTS idx_reading_progress_last_read ON reading_progress(last_read_at DESC);
"#;

pub enum ImportOutcome {
    Imported,
    Skipped,
}

pub fn connect(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.execute_batch(SCHEMA)?;
    Ok(connection)
}

pub fn list_books(connection: &Connection) -> Result<Vec<BookSummary>> {
    let mut statement = connection.prepare(
        r#"
        SELECT
            b.id,
            b.title,
            b.author,
            b.cover_asset_path,
            COALESCE(rp.progress_percent, 0.0) AS progress_percent,
            rp.last_read_at,
            b.created_at,
            b.updated_at
        FROM books b
        LEFT JOIN reading_progress rp ON rp.book_id = b.id
        ORDER BY COALESCE(rp.last_read_at, b.updated_at) DESC, b.title COLLATE NOCASE ASC
        "#,
    )?;
    let rows = statement.query_map([], |row| {
        Ok(BookSummary {
            id: row.get(0)?,
            title: row.get(1)?,
            author: row.get(2)?,
            cover_asset_path: row.get(3)?,
            progress_percent: row.get(4)?,
            last_read_at: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

pub fn import_book(connection: &mut Connection, data_dir: &Path, source_path: &Path) -> Result<ImportOutcome> {
    if !source_path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("epub"))
    {
        return Err(anyhow!("Only EPUB files can be imported in phase 1."));
    }

    let bytes = fs::read(source_path).with_context(|| format!("Unable to read {}", source_path.display()))?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let existing: Option<i64> = connection
        .query_row("SELECT id FROM books WHERE content_hash = ?", params![hash], |row| row.get(0))
        .optional()?;
    if existing.is_some() {
        return Ok(ImportOutcome::Skipped);
    }

    let extracted = epub::read_epub(source_path).with_context(|| format!("Unable to parse {}", source_path.display()))?;
    if extracted.chapters.is_empty() {
        return Err(anyhow!("No readable chapters were found."));
    }

    let books_dir = data_dir.join("books");
    let assets_dir = data_dir.join("assets").join(&hash);
    fs::create_dir_all(&books_dir)?;
    fs::create_dir_all(&assets_dir)?;

    let stored_path = books_dir.join(format!("{hash}.epub"));
    fs::write(&stored_path, bytes)?;

    let cover_asset_path = if let Some(cover) = extracted.cover {
        let extension = Path::new(&cover.path)
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("img");
        let path = assets_dir.join(format!("cover.{extension}"));
        fs::write(&path, cover.bytes)?;
        Some(path_to_string(path))
    } else {
        None
    };

    let timestamp = now_iso();
    let tx = connection.transaction()?;
    tx.execute(
        r#"
        INSERT INTO books (
            slug, title, author, content_hash, original_filename, stored_path, cover_asset_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
        params![
            slugify(&extracted.title),
            extracted.title,
            extracted.author,
            hash,
            source_path.file_name().and_then(|value| value.to_str()).unwrap_or("book.epub"),
            path_to_string(stored_path),
            cover_asset_path,
            timestamp,
            timestamp
        ],
    )?;
    let book_id = tx.last_insert_rowid();

    let mut block_index = 0_i64;
    for (chapter_index, chapter) in extracted.chapters.iter().enumerate() {
        let start_block_index = block_index;
        for block in &chapter.blocks {
            tx.execute(
                r#"
                INSERT INTO chapter_blocks (book_id, chapter_index, block_index, kind, text, asset_path, alt)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                "#,
                params![
                    book_id,
                    chapter_index as i64,
                    block_index,
                    "paragraph",
                    block.text,
                    Option::<String>::None,
                    ""
                ],
            )?;
            block_index += 1;
        }
        tx.execute(
            r#"
            INSERT INTO book_chapters (
                book_id, chapter_index, title, source_href, start_block_index, end_block_index
            ) VALUES (?, ?, ?, ?, ?, ?)
            "#,
            params![
                book_id,
                chapter_index as i64,
                chapter.title,
                chapter.source_href,
                start_block_index,
                block_index.saturating_sub(1)
            ],
        )?;
    }
    tx.commit()?;

    Ok(ImportOutcome::Imported)
}

pub fn get_reader(connection: &Connection, book_id: i64) -> Result<Option<ReaderPayload>> {
    let book = connection
        .query_row(
            "SELECT id, title, author, cover_asset_path FROM books WHERE id = ?",
            params![book_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((id, title, author, cover_asset_path)) = book else {
        return Ok(None);
    };

    let chapters = chapter_summaries(connection, book_id)?;
    let total_blocks: i64 = connection.query_row(
        "SELECT COUNT(*) FROM chapter_blocks WHERE book_id = ?",
        params![book_id],
        |row| row.get(0),
    )?;
    let progress = connection
        .query_row(
            r#"
            SELECT last_read_at, last_chapter_index, last_block_index, progress_percent
            FROM reading_progress
            WHERE book_id = ?
            "#,
            params![book_id],
            |row| {
                Ok(ReadingProgress {
                    last_read_at: row.get(0)?,
                    last_chapter_index: row.get(1)?,
                    last_block_index: row.get(2)?,
                    progress_percent: row.get(3)?,
                })
            },
        )
        .optional()?
        .unwrap_or(ReadingProgress {
            last_read_at: None,
            last_chapter_index: 0,
            last_block_index: 0,
            progress_percent: 0.0,
        });

    Ok(Some(ReaderPayload {
        id,
        title,
        author,
        cover_asset_path,
        chapters,
        progress,
        total_blocks,
    }))
}

pub fn get_chapter(connection: &Connection, book_id: i64, chapter_index: i64) -> Result<Option<ChapterPayload>> {
    let title = connection
        .query_row(
            "SELECT title FROM book_chapters WHERE book_id = ? AND chapter_index = ?",
            params![book_id, chapter_index],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(title) = title else {
        return Ok(None);
    };

    let mut statement = connection.prepare(
        r#"
        SELECT block_index, kind, text, asset_path, alt
        FROM chapter_blocks
        WHERE book_id = ? AND chapter_index = ?
        ORDER BY block_index
        "#,
    )?;
    let rows = statement.query_map(params![book_id, chapter_index], |row| {
        Ok(ChapterBlock {
            block_index: row.get(0)?,
            kind: row.get(1)?,
            text: row.get(2)?,
            asset_path: row.get(3)?,
            alt: row.get(4)?,
        })
    })?;

    Ok(Some(ChapterPayload {
        book_id,
        chapter_index,
        title,
        blocks: rows.collect::<rusqlite::Result<Vec<_>>>()?,
    }))
}

pub fn save_progress(
    connection: &Connection,
    book_id: i64,
    chapter_index: i64,
    block_index: i64,
    progress_percent: f64,
) -> Result<()> {
    let timestamp = now_iso();
    let progress = progress_percent.clamp(0.0, 100.0);
    connection.execute(
        r#"
        INSERT INTO reading_progress (
            book_id, last_read_at, last_chapter_index, last_block_index, progress_percent
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(book_id) DO UPDATE SET
            last_read_at = excluded.last_read_at,
            last_chapter_index = excluded.last_chapter_index,
            last_block_index = excluded.last_block_index,
            progress_percent = excluded.progress_percent
        "#,
        params![book_id, timestamp, chapter_index, block_index, progress],
    )?;
    Ok(())
}

fn chapter_summaries(connection: &Connection, book_id: i64) -> Result<Vec<ChapterSummary>> {
    let mut statement = connection.prepare(
        r#"
        SELECT chapter_index, title, start_block_index, end_block_index
        FROM book_chapters
        WHERE book_id = ?
        ORDER BY chapter_index
        "#,
    )?;
    let rows = statement.query_map(params![book_id], |row| {
        Ok(ChapterSummary {
            chapter_index: row.get(0)?,
            title: row.get(1)?,
            start_block_index: row.get(2)?,
            end_block_index: row.get(3)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut previous_dash = false;
    for character in value.to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            previous_dash = false;
        } else if !previous_dash {
            slug.push('-');
            previous_dash = true;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "book".to_string()
    } else {
        slug
    }
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugifies_titles_for_storage() {
        assert_eq!(slugify("My Youth Romantic Comedy, Vol. 1"), "my-youth-romantic-comedy-vol-1");
        assert_eq!(slugify("!!!"), "book");
    }
}
