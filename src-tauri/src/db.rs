use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row};
use sha2::{Digest, Sha256};

use crate::cefr;
use crate::cefr::{CefrLevel, ReaderToken};
use crate::epub;
use crate::epub::ExtractedBlockKind;
use crate::models::{
    BookSearchResult, BookSummary, ChapterBlock, ChapterPartSummary, ChapterPayload,
    ChapterSummary, PartAlignmentPayload, PartAudioPayload, ReaderPayload, ReadingProgress,
    WordlistEntry,
};

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
    last_part_index INTEGER NOT NULL DEFAULT 0,
    last_block_index INTEGER NOT NULL DEFAULT 0,
    last_scroll_ratio REAL NOT NULL DEFAULT 0,
    last_audio_time_seconds REAL,
    last_audio_duration_seconds REAL,
    last_playing_block_index INTEGER,
    last_playing_token_index INTEGER,
    progress_percent REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audio_paragraphs (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_index INTEGER NOT NULL,
    part_index INTEGER NOT NULL,
    block_index INTEGER NOT NULL,
    voice TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    audio_path TEXT NOT NULL,
    duration_seconds REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(book_id, block_index, voice)
);

CREATE TABLE IF NOT EXISTS audio_parts (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_index INTEGER NOT NULL,
    part_index INTEGER NOT NULL,
    voice TEXT NOT NULL,
    audio_path TEXT NOT NULL,
    paragraph_count INTEGER NOT NULL DEFAULT 0,
    duration_seconds REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(book_id, chapter_index, part_index, voice)
);

CREATE TABLE IF NOT EXISTS audio_alignments (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_index INTEGER NOT NULL,
    part_index INTEGER NOT NULL,
    voice TEXT NOT NULL,
    audio_path TEXT NOT NULL,
    alignment_path TEXT NOT NULL DEFAULT '',
    token_count INTEGER NOT NULL DEFAULT 0,
    duration_seconds REAL NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(book_id, chapter_index, part_index, voice)
);

CREATE TABLE IF NOT EXISTS book_word_frequencies (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    word_key TEXT NOT NULL,
    frequency_count INTEGER NOT NULL,
    frequency_level TEXT NOT NULL,
    PRIMARY KEY(book_id, word_key)
);

CREATE TABLE IF NOT EXISTS book_word_frequency_cache (
    book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    generated_at TEXT NOT NULL,
    algorithm_version INTEGER NOT NULL DEFAULT 6
);

CREATE TABLE IF NOT EXISTS wordlist_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    book_title TEXT NOT NULL DEFAULT '',
    chapter_index INTEGER NOT NULL,
    block_index INTEGER NOT NULL,
    token_index INTEGER NOT NULL,
    root_word TEXT NOT NULL,
    original_word TEXT NOT NULL,
    word_type TEXT NOT NULL DEFAULT '',
    cefr_level TEXT NOT NULL DEFAULT '',
    definition_number INTEGER,
    definition TEXT NOT NULL DEFAULT '',
    definition_examples TEXT NOT NULL DEFAULT '[]',
    definition_phonetics TEXT NOT NULL DEFAULT '[]',
    definition_audio_url TEXT NOT NULL DEFAULT '',
    definition_source_url TEXT NOT NULL DEFAULT '',
    definition_lookup_error TEXT NOT NULL DEFAULT '',
    simple_meaning TEXT NOT NULL DEFAULT '',
    in_context_meaning TEXT NOT NULL DEFAULT '',
    original_meaning TEXT NOT NULL DEFAULT '',
    ai_explanation TEXT NOT NULL DEFAULT '',
    context TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(root_word)
);

CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
CREATE INDEX IF NOT EXISTS idx_book_chapters_book ON book_chapters(book_id, chapter_index);
CREATE INDEX IF NOT EXISTS idx_chapter_blocks_book ON chapter_blocks(book_id, chapter_index, block_index);
CREATE INDEX IF NOT EXISTS idx_reading_progress_last_read ON reading_progress(last_read_at DESC);
CREATE INDEX IF NOT EXISTS idx_audio_paragraphs_part ON audio_paragraphs(book_id, chapter_index, part_index, voice);
CREATE INDEX IF NOT EXISTS idx_book_word_frequencies_book ON book_word_frequencies(book_id);
CREATE INDEX IF NOT EXISTS idx_wordlist_entries_book ON wordlist_entries(book_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wordlist_entries_root ON wordlist_entries(root_word);
"#;

pub enum ImportOutcome {
    Imported,
    Skipped,
}

const WORD_FREQUENCY_ALGORITHM_VERSION: i64 = 6;

#[derive(Debug)]
pub struct AudioParagraphSource {
    pub block_index: i64,
    pub text: String,
}

#[derive(Debug)]
pub struct GeneratedAudioParagraph {
    pub block_index: i64,
    pub text_hash: String,
    pub audio_path: String,
    pub duration_seconds: f64,
}

#[derive(Debug)]
pub struct GeneratedPartAudio {
    pub book_id: i64,
    pub chapter_index: i64,
    pub part_index: i64,
    pub voice: String,
    pub audio_path: String,
    pub duration_seconds: f64,
    pub paragraphs: Vec<GeneratedAudioParagraph>,
}

pub fn connect(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.execute_batch(SCHEMA)?;
    migrate_reading_progress(&connection)?;
    migrate_word_frequency_cache(&connection)?;
    migrate_wordlist_entries(&connection)?;
    Ok(connection)
}

fn migrate_reading_progress(connection: &Connection) -> Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(reading_progress)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let has_column = |name: &str| columns.iter().any(|column| column == name);

    let migrations = [
        (
            "last_part_index",
            "ALTER TABLE reading_progress ADD COLUMN last_part_index INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "last_scroll_ratio",
            "ALTER TABLE reading_progress ADD COLUMN last_scroll_ratio REAL NOT NULL DEFAULT 0",
        ),
        (
            "last_audio_time_seconds",
            "ALTER TABLE reading_progress ADD COLUMN last_audio_time_seconds REAL",
        ),
        (
            "last_audio_duration_seconds",
            "ALTER TABLE reading_progress ADD COLUMN last_audio_duration_seconds REAL",
        ),
        (
            "last_playing_block_index",
            "ALTER TABLE reading_progress ADD COLUMN last_playing_block_index INTEGER",
        ),
        (
            "last_playing_token_index",
            "ALTER TABLE reading_progress ADD COLUMN last_playing_token_index INTEGER",
        ),
    ];

    for (column, sql) in migrations {
        if !has_column(column) {
            connection.execute(sql, [])?;
        }
    }

    Ok(())
}

fn migrate_word_frequency_cache(connection: &Connection) -> Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(book_word_frequency_cache)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !columns.iter().any(|column| column == "algorithm_version") {
        connection.execute(
            "ALTER TABLE book_word_frequency_cache ADD COLUMN algorithm_version INTEGER NOT NULL DEFAULT 1",
            [],
        )?;
    }
    Ok(())
}

fn migrate_wordlist_entries(connection: &Connection) -> Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(wordlist_entries)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let has_column = |name: &str| columns.iter().any(|column| column == name);

    let migrations = [
        (
            "simple_meaning",
            "ALTER TABLE wordlist_entries ADD COLUMN simple_meaning TEXT NOT NULL DEFAULT ''",
        ),
        (
            "in_context_meaning",
            "ALTER TABLE wordlist_entries ADD COLUMN in_context_meaning TEXT NOT NULL DEFAULT ''",
        ),
        (
            "original_meaning",
            "ALTER TABLE wordlist_entries ADD COLUMN original_meaning TEXT NOT NULL DEFAULT ''",
        ),
        (
            "ai_explanation",
            "ALTER TABLE wordlist_entries ADD COLUMN ai_explanation TEXT NOT NULL DEFAULT ''",
        ),
    ];

    for (column, sql) in migrations {
        if !has_column(column) {
            connection.execute(sql, [])?;
        }
    }

    Ok(())
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
            rp.last_block_index,
            b.created_at,
            b.updated_at
        FROM books b
        LEFT JOIN reading_progress rp ON rp.book_id = b.id
        ORDER BY COALESCE(rp.last_read_at, b.updated_at) DESC, b.title COLLATE NOCASE ASC
        "#,
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            BookSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                author: row.get(2)?,
                cover_asset_path: row.get(3)?,
                progress_percent: row.get(4)?,
                last_read_at: row.get(5)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            },
            row.get::<_, Option<i64>>(6)?,
        ))
    })?;
    let rows = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(mut book, last_block_index)| {
            if let Some(block_index) = last_block_index {
                if let Some(percent) = progress_percent_for_block(connection, book.id, block_index)?
                {
                    book.progress_percent = percent;
                }
            }
            Ok(book)
        })
        .collect()
}

pub fn import_book(
    connection: &mut Connection,
    data_dir: &Path,
    source_path: &Path,
) -> Result<ImportOutcome> {
    if !source_path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("epub"))
    {
        return Err(anyhow!("Only EPUB files can be imported in phase 1."));
    }

    let bytes = fs::read(source_path)
        .with_context(|| format!("Unable to read {}", source_path.display()))?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let existing: Option<i64> = connection
        .query_row(
            "SELECT id FROM books WHERE content_hash = ?",
            params![hash],
            |row| row.get(0),
        )
        .optional()?;
    if existing.is_some() {
        return Ok(ImportOutcome::Skipped);
    }

    let extracted = epub::read_epub(source_path)
        .with_context(|| format!("Unable to parse {}", source_path.display()))?;
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
            let asset_path = if matches!(block.kind, ExtractedBlockKind::Image) {
                block
                    .asset_path
                    .as_deref()
                    .and_then(|path| {
                        materialize_epub_asset(source_path, &assets_dir, path)
                            .ok()
                            .flatten()
                    })
                    .or_else(|| block.asset_path.clone())
            } else {
                None
            };
            tx.execute(
                r#"
                INSERT INTO chapter_blocks (book_id, chapter_index, block_index, kind, text, asset_path, alt)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                "#,
                params![
                    book_id,
                    chapter_index as i64,
                    block_index,
                    match block.kind {
                        ExtractedBlockKind::Paragraph => "paragraph",
                        ExtractedBlockKind::Image => "image",
                    },
                    block.text,
                    asset_path,
                    block.alt.clone()
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
    ensure_book_word_frequency_cache(&tx, book_id)?;
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
    let total_progress_units = chapters
        .iter()
        .map(|chapter| chapter.progress_units)
        .sum::<i64>();
    let total_blocks: i64 = connection.query_row(
        "SELECT COUNT(*) FROM chapter_blocks WHERE book_id = ?",
        params![book_id],
        |row| row.get(0),
    )?;
    let progress = connection
        .query_row(
            r#"
            SELECT
                last_read_at,
                last_chapter_index,
                last_part_index,
                last_block_index,
                last_scroll_ratio,
                last_audio_time_seconds,
                last_audio_duration_seconds,
                last_playing_block_index,
                last_playing_token_index,
                progress_percent
            FROM reading_progress
            WHERE book_id = ?
            "#,
            params![book_id],
            |row| {
                Ok(ReadingProgress {
                    last_read_at: row.get(0)?,
                    last_chapter_index: row.get(1)?,
                    last_part_index: row.get(2)?,
                    last_block_index: row.get(3)?,
                    last_scroll_ratio: row.get(4)?,
                    last_audio_time_seconds: row.get(5)?,
                    last_audio_duration_seconds: row.get(6)?,
                    last_playing_block_index: row.get(7)?,
                    last_playing_token_index: row.get(8)?,
                    progress_percent: row.get(9)?,
                })
            },
        )
        .optional()?
        .unwrap_or(ReadingProgress {
            last_read_at: None,
            last_chapter_index: 0,
            last_part_index: 0,
            last_block_index: 0,
            last_scroll_ratio: 0.0,
            last_audio_time_seconds: None,
            last_audio_duration_seconds: None,
            last_playing_block_index: None,
            last_playing_token_index: None,
            progress_percent: 0.0,
        });
    let mut progress = normalize_reading_progress(progress, &chapters);
    if let Some(percent) =
        progress_percent_for_block(connection, book_id, progress.last_block_index)?
    {
        progress.progress_percent = percent;
    }

    Ok(Some(ReaderPayload {
        id,
        title,
        author,
        cover_asset_path,
        chapters,
        progress,
        total_blocks,
        total_progress_units,
    }))
}

pub fn get_chapter(
    connection: &Connection,
    book_id: i64,
    chapter_index: i64,
) -> Result<Option<ChapterPayload>> {
    let raw_chapters = raw_chapter_summaries(connection, book_id)?;
    let chapters = build_reader_chapters(
        &raw_chapters,
        &block_markers(connection, book_id, &raw_chapters)?,
    )?;
    let Some(chapter) = chapters
        .into_iter()
        .find(|item| item.chapter_index == chapter_index)
    else {
        return Ok(None);
    };

    let book_asset_source = connection
        .query_row(
            "SELECT stored_path, content_hash FROM books WHERE id = ?",
            params![book_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;

    let mut statement = connection.prepare(
        r#"
        SELECT block_index, kind, text, asset_path, alt
        FROM chapter_blocks
        WHERE book_id = ?
          AND block_index BETWEEN ? AND ?
          AND NOT (kind = 'image' AND (asset_path LIKE '%Art_orn%' OR lower(COALESCE(asset_path, '')) LIKE '%orn%'))
        ORDER BY block_index
        "#,
    )?;
    let rows = statement.query_map(
        params![book_id, chapter.start_block_index, chapter.end_block_index],
        |row| {
            Ok(ChapterBlock {
                block_index: row.get(0)?,
                kind: row.get(1)?,
                text: row.get(2)?,
                asset_path: row.get(3)?,
                alt: row.get(4)?,
                tokens: Vec::new(),
            })
        },
    )?;

    let mut blocks = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    if let Some((stored_path, content_hash)) = book_asset_source {
        resolve_chapter_image_assets(
            connection,
            book_id,
            Path::new(&stored_path),
            &content_hash,
            &mut blocks,
        )?;
    }
    let frequencies = book_word_frequency_map(connection, book_id)?;
    let blocks = readable_chapter_blocks(&chapter.title, blocks)
        .into_iter()
        .map(|block| with_reader_tokens(block, &frequencies))
        .collect();

    Ok(Some(ChapterPayload {
        book_id,
        chapter_index,
        title: chapter.title,
        blocks,
    }))
}

pub fn reader_chapter_title(
    connection: &Connection,
    book_id: i64,
    chapter_index: i64,
) -> Result<Option<String>> {
    let raw_chapters = raw_chapter_summaries(connection, book_id)?;
    let chapters = build_reader_chapters(
        &raw_chapters,
        &block_markers(connection, book_id, &raw_chapters)?,
    )?;
    Ok(chapters
        .into_iter()
        .find(|item| item.chapter_index == chapter_index)
        .map(|chapter| chapter.title))
}

pub fn search_book(
    connection: &Connection,
    book_id: i64,
    query: &str,
) -> Result<Vec<BookSearchResult>> {
    let Some(query) = normalized_search_query(query) else {
        return Ok(Vec::new());
    };
    let chapters = chapter_summaries(connection, book_id)?;
    if chapters.is_empty() {
        return Ok(Vec::new());
    }

    let mut statement = connection.prepare(
        r#"
        SELECT block_index, text
        FROM chapter_blocks
        WHERE book_id = ?
          AND kind = 'paragraph'
          AND text != ''
        ORDER BY block_index
        "#,
    )?;
    let rows = statement.query_map(params![book_id], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;

    let mut results = Vec::new();
    for row in rows {
        let (block_index, text) = row?;
        let Some((match_start, match_end)) = case_insensitive_match_range(&text, &query) else {
            continue;
        };
        let Some(chapter) = chapters.iter().find(|chapter| {
            block_index >= chapter.start_block_index && block_index <= chapter.end_block_index
        }) else {
            continue;
        };
        let (snippet, snippet_match_start, snippet_match_end) =
            search_snippet(&text, match_start, match_end);
        results.push(BookSearchResult {
            book_id,
            chapter_index: chapter.chapter_index,
            chapter_title: chapter.title.clone(),
            block_index,
            snippet,
            match_start: snippet_match_start,
            match_end: snippet_match_end,
            match_count: count_case_insensitive_matches(&text, &query),
        });
        if results.len() >= 100 {
            break;
        }
    }

    Ok(results)
}

pub fn list_wordlist_entries(connection: &Connection) -> Result<Vec<WordlistEntry>> {
    list_wordlist_entries_for_book(connection, None)
}

pub fn list_book_wordlist_entries(
    connection: &Connection,
    book_id: i64,
) -> Result<Vec<WordlistEntry>> {
    list_wordlist_entries_for_book(connection, Some(book_id))
}

pub fn save_wordlist_entry(
    connection: &Connection,
    book_id: i64,
    chapter_index: i64,
    block_index: i64,
    token_index: usize,
    word: &str,
    root_word: &str,
    context: &str,
    cefr_level: &str,
) -> Result<WordlistEntry> {
    let book_title = connection
        .query_row(
            "SELECT title FROM books WHERE id = ?",
            params![book_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| anyhow!("Book not found."))?;
    let block_text = connection
        .query_row(
            r#"
            SELECT text
            FROM chapter_blocks
            WHERE book_id = ?
              AND block_index = ?
              AND kind = 'paragraph'
            "#,
            params![book_id, block_index],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| anyhow!("Word token not found."))?;
    let tokens = cefr::tokenize_text(&block_text);
    let token = tokens
        .get(token_index)
        .ok_or_else(|| anyhow!("Word token not found."))?;
    let root = (if !token.root_text.is_empty() {
        Some(token.root_text.clone())
    } else {
        normalized_word_root(root_word).or_else(|| normalized_word_root(word))
    })
    .ok_or_else(|| anyhow!("Select one English word."))?;
    let original_word = if !token.normalized_text.is_empty() {
        token.text.clone()
    } else {
        word.trim().to_string()
    };
    if original_word.trim().is_empty() {
        return Err(anyhow!("Select one English word."));
    }
    let stored_context = token_sentence_context(&tokens, token_index)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| clean_context(context));
    let stored_cefr = token
        .cefr_level
        .map(cefr_level_to_storage)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| cefr_level.trim().to_string());
    let timestamp = now_iso();
    connection.execute(
        r#"
        INSERT OR IGNORE INTO wordlist_entries (
            book_id, book_title, chapter_index, block_index, token_index,
            root_word, original_word, cefr_level, context, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
        params![
            book_id,
            book_title,
            chapter_index,
            block_index,
            token_index as i64,
            root,
            original_word,
            stored_cefr,
            stored_context,
            timestamp,
            timestamp
        ],
    )?;
    wordlist_entry_by_root(connection, &root)?.ok_or_else(|| anyhow!("Word list entry not found."))
}

pub fn delete_wordlist_entry(connection: &Connection, root_word: &str) -> Result<bool> {
    let root = normalized_word_root(root_word).unwrap_or_else(|| root_word.trim().to_lowercase());
    if root.is_empty() {
        return Err(anyhow!("Select one English word."));
    }
    let removed = connection.execute(
        "DELETE FROM wordlist_entries WHERE root_word = ?",
        params![root],
    )?;
    Ok(removed > 0)
}

pub fn wordlist_entry_for_lookup(
    connection: &Connection,
    entry_id: i64,
) -> Result<Option<WordlistEntry>> {
    wordlist_entry_by_id(connection, entry_id)
}

pub fn update_wordlist_entry_lookup(
    connection: &Connection,
    entry_id: i64,
    lookup: Option<&crate::dictionary::DictionaryLookup>,
    lookup_error: &str,
) -> Result<Option<WordlistEntry>> {
    let timestamp = now_iso();
    if let Some(lookup) = lookup {
        let choice = &lookup.context_definition;
        connection.execute(
            r#"
            UPDATE wordlist_entries
            SET
                word_type = COALESCE(NULLIF(?, ''), word_type),
                cefr_level = COALESCE(NULLIF(?, ''), cefr_level),
                definition_number = ?,
                definition = ?,
                definition_examples = ?,
                definition_phonetics = ?,
                definition_audio_url = ?,
                definition_source_url = ?,
                definition_lookup_error = '',
                simple_meaning = ?,
                in_context_meaning = ?,
                original_meaning = ?,
                ai_explanation = ?,
                updated_at = ?
            WHERE id = ?
            "#,
            params![
                &lookup.word_type,
                &lookup.cefr_level,
                choice.definition_number.map(|number| number as i64),
                &choice.definition,
                serde_json::to_string(&choice.examples)?,
                serde_json::to_string(&lookup.phonetics)?,
                &lookup.audio_url,
                &lookup.source_url,
                &lookup.simple_meaning,
                &lookup.in_context_meaning,
                &lookup.original_meaning,
                &choice.ai_explanation,
                timestamp,
                entry_id
            ],
        )?;
    } else {
        connection.execute(
            r#"
            UPDATE wordlist_entries
            SET definition_lookup_error = ?, updated_at = ?
            WHERE id = ?
            "#,
            params![lookup_error, timestamp, entry_id],
        )?;
    }
    wordlist_entry_by_id(connection, entry_id)
}

fn list_wordlist_entries_for_book(
    connection: &Connection,
    book_id: Option<i64>,
) -> Result<Vec<WordlistEntry>> {
    let sql = format!(
        r#"
        SELECT
            w.id,
            w.book_id,
            COALESCE(NULLIF(b.title, ''), w.book_title) AS book_title,
            w.chapter_index,
            w.block_index,
            w.token_index,
            w.root_word,
            w.original_word,
            w.word_type,
            w.cefr_level,
            w.definition_number,
            w.definition,
            w.definition_examples,
            w.definition_phonetics,
            w.definition_audio_url,
            w.definition_source_url,
            w.definition_lookup_error,
            w.simple_meaning,
            w.in_context_meaning,
            w.original_meaning,
            w.ai_explanation,
            w.context,
            w.created_at,
            w.updated_at
        FROM wordlist_entries w
        LEFT JOIN books b ON b.id = w.book_id
        {}
        ORDER BY w.created_at DESC, w.id DESC
        "#,
        if book_id.is_some() {
            "WHERE w.book_id = ?"
        } else {
            ""
        }
    );
    let mut statement = connection.prepare(&sql)?;
    let rows = if let Some(book_id) = book_id {
        statement.query_map(params![book_id], wordlist_entry_from_row)?
    } else {
        statement.query_map([], wordlist_entry_from_row)?
    };
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn wordlist_entry_by_root(
    connection: &Connection,
    root_word: &str,
) -> Result<Option<WordlistEntry>> {
    wordlist_entry_by_column(connection, "root_word", root_word)
}

fn wordlist_entry_by_id(connection: &Connection, entry_id: i64) -> Result<Option<WordlistEntry>> {
    connection
        .query_row(
            r#"
            SELECT
                w.id,
                w.book_id,
                COALESCE(NULLIF(b.title, ''), w.book_title) AS book_title,
                w.chapter_index,
                w.block_index,
                w.token_index,
                w.root_word,
                w.original_word,
                w.word_type,
                w.cefr_level,
                w.definition_number,
                w.definition,
                w.definition_examples,
                w.definition_phonetics,
                w.definition_audio_url,
                w.definition_source_url,
                w.definition_lookup_error,
                w.simple_meaning,
                w.in_context_meaning,
                w.original_meaning,
                w.ai_explanation,
                w.context,
                w.created_at,
                w.updated_at
            FROM wordlist_entries w
            LEFT JOIN books b ON b.id = w.book_id
            WHERE w.id = ?
            "#,
            params![entry_id],
            wordlist_entry_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn wordlist_entry_by_column(
    connection: &Connection,
    column: &str,
    value: &str,
) -> Result<Option<WordlistEntry>> {
    let sql = format!(
        r#"
        SELECT
            w.id,
            w.book_id,
            COALESCE(NULLIF(b.title, ''), w.book_title) AS book_title,
            w.chapter_index,
            w.block_index,
            w.token_index,
            w.root_word,
            w.original_word,
            w.word_type,
            w.cefr_level,
            w.definition_number,
            w.definition,
            w.definition_examples,
            w.definition_phonetics,
            w.definition_audio_url,
            w.definition_source_url,
            w.definition_lookup_error,
            w.simple_meaning,
            w.in_context_meaning,
            w.original_meaning,
            w.ai_explanation,
            w.context,
            w.created_at,
            w.updated_at
        FROM wordlist_entries w
        LEFT JOIN books b ON b.id = w.book_id
        WHERE w.{column} = ?
        "#
    );
    connection
        .query_row(&sql, params![value], wordlist_entry_from_row)
        .optional()
        .map_err(Into::into)
}

fn wordlist_entry_from_row(row: &Row<'_>) -> rusqlite::Result<WordlistEntry> {
    let definition_examples: String = row.get(12)?;
    let definition_phonetics: String = row.get(13)?;
    let definition_number = row
        .get::<_, Option<i64>>(10)?
        .map(|number| number.max(0) as usize);
    Ok(WordlistEntry {
        id: row.get(0)?,
        book_id: row.get(1)?,
        book_title: row.get(2)?,
        chapter_index: row.get(3)?,
        block_index: row.get(4)?,
        token_index: row.get::<_, i64>(5)?.max(0) as usize,
        root_word: row.get(6)?,
        original_word: row.get(7)?,
        word_type: row.get(8)?,
        cefr_level: row.get(9)?,
        definition_number,
        definition: row.get(11)?,
        definition_examples: json_string_vec(&definition_examples),
        definition_phonetics: json_string_vec(&definition_phonetics),
        definition_audio_url: row.get(14)?,
        definition_source_url: row.get(15)?,
        definition_lookup_error: row.get(16)?,
        simple_meaning: row.get(17)?,
        in_context_meaning: row.get(18)?,
        original_meaning: row.get(19)?,
        ai_explanation: row.get(20)?,
        context: row.get(21)?,
        created_at: row.get(22)?,
        updated_at: row.get(23)?,
    })
}

fn json_string_vec(value: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(value).unwrap_or_default()
}

fn normalized_word_root(value: &str) -> Option<String> {
    cefr::tokenize_text(value)
        .into_iter()
        .find_map(|token| {
            if !token.root_text.is_empty() {
                Some(token.root_text)
            } else if !token.normalized_text.is_empty() {
                Some(token.normalized_text)
            } else {
                None
            }
        })
}

fn token_sentence_context(tokens: &[ReaderToken], token_index: usize) -> Option<String> {
    if token_index >= tokens.len() || tokens[token_index].normalized_text.is_empty() {
        return None;
    }
    let mut start = 0;
    for index in (0..token_index).rev() {
        if matches!(tokens[index].text.as_str(), "." | "!" | "?") {
            start = index + 1;
            break;
        }
    }
    let mut end = tokens.len();
    for index in token_index..tokens.len() {
        if matches!(tokens[index].text.as_str(), "." | "!" | "?") {
            end = (index + 1).min(tokens.len());
            while end < tokens.len() && matches!(tokens[end].text.trim(), "\"" | "'" | ")" | "]")
            {
                end += 1;
            }
            break;
        }
    }
    Some(clean_context(
        &tokens[start..end]
            .iter()
            .map(|token| token.text.as_str())
            .collect::<String>(),
    ))
}

fn clean_context(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|character| matches!(character, '"' | '\'' | '“' | '”' | '‘' | '’'))
        .to_string()
}

pub fn get_part_audio(
    connection: &Connection,
    book_id: i64,
    chapter_index: i64,
    part_index: i64,
    voice: &str,
) -> Result<Option<PartAudioPayload>> {
    connection
        .query_row(
            r#"
            SELECT
                p.book_id,
                p.chapter_index,
                p.part_index,
                p.voice,
                p.audio_path,
                p.paragraph_count,
                p.duration_seconds,
                p.updated_at,
                COALESCE(a.alignment_path, ''),
                COALESCE(a.last_error, '')
            FROM audio_parts p
            LEFT JOIN audio_alignments a
              ON a.book_id = p.book_id
             AND a.chapter_index = p.chapter_index
             AND a.part_index = p.part_index
             AND a.voice = p.voice
            WHERE p.book_id = ?
              AND p.chapter_index = ?
              AND p.part_index = ?
              AND p.voice = ?
            "#,
            params![book_id, chapter_index, part_index, voice],
            |row| {
                let alignment_path: String = row.get(8)?;
                let alignment_error: String = row.get(9)?;
                Ok(PartAudioPayload {
                    book_id: row.get(0)?,
                    chapter_index: row.get(1)?,
                    part_index: row.get(2)?,
                    voice: row.get(3)?,
                    audio_path: row.get(4)?,
                    paragraph_count: row.get(5)?,
                    duration_seconds: row.get(6)?,
                    generated_at: row.get(7)?,
                    alignment_available: !alignment_path.is_empty()
                        && Path::new(&alignment_path).exists(),
                    alignment_error: if alignment_error.is_empty() {
                        None
                    } else {
                        Some(alignment_error)
                    },
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

pub fn part_audio_paragraphs(
    connection: &Connection,
    book_id: i64,
    chapter_index: i64,
    part_index: i64,
) -> Result<Vec<AudioParagraphSource>> {
    let raw_chapters = raw_chapter_summaries(connection, book_id)?;
    let chapters = build_reader_chapters(
        &raw_chapters,
        &block_markers(connection, book_id, &raw_chapters)?,
    )?;
    let Some(chapter) = chapters
        .into_iter()
        .find(|item| item.chapter_index == chapter_index)
    else {
        return Err(anyhow!("Chapter not found."));
    };
    let Some(part) = chapter
        .parts
        .iter()
        .find(|item| item.part_index == part_index)
    else {
        return Err(anyhow!("Part not found."));
    };

    let mut statement = connection.prepare(
        r#"
        SELECT block_index, kind, text, asset_path, alt
        FROM chapter_blocks
        WHERE book_id = ?
          AND block_index BETWEEN ? AND ?
          AND kind = 'paragraph'
        ORDER BY block_index
        "#,
    )?;
    let rows = statement.query_map(
        params![book_id, part.start_block_index, part.end_block_index],
        |row| {
            Ok(ChapterBlock {
                block_index: row.get(0)?,
                kind: row.get(1)?,
                text: row.get(2)?,
                asset_path: row.get(3)?,
                alt: row.get(4)?,
                tokens: Vec::new(),
            })
        },
    )?;
    let blocks = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(readable_chapter_blocks(&chapter.title, blocks)
        .into_iter()
        .filter(|block| !block.text.trim().is_empty())
        .map(|block| AudioParagraphSource {
            block_index: block.block_index,
            text: block.text,
        })
        .collect())
}

pub fn generated_audio_paragraphs(
    connection: &Connection,
    book_id: i64,
    chapter_index: i64,
    part_index: i64,
    voice: &str,
) -> Result<Vec<GeneratedAudioParagraph>> {
    let mut statement = connection.prepare(
        r#"
        SELECT block_index, text_hash, audio_path, duration_seconds
        FROM audio_paragraphs
        WHERE book_id = ?
          AND chapter_index = ?
          AND part_index = ?
          AND voice = ?
        ORDER BY block_index
        "#,
    )?;
    let rows = statement.query_map(params![book_id, chapter_index, part_index, voice], |row| {
        Ok(GeneratedAudioParagraph {
            block_index: row.get(0)?,
            text_hash: row.get(1)?,
            audio_path: row.get(2)?,
            duration_seconds: row.get(3)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

pub fn save_part_audio(
    connection: &mut Connection,
    audio: &GeneratedPartAudio,
) -> Result<PartAudioPayload> {
    let timestamp = now_iso();
    let tx = connection.transaction()?;

    tx.execute(
        r#"
        INSERT INTO audio_parts (
            book_id, chapter_index, part_index, voice, audio_path, paragraph_count, duration_seconds, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(book_id, chapter_index, part_index, voice) DO UPDATE SET
            audio_path = excluded.audio_path,
            paragraph_count = excluded.paragraph_count,
            duration_seconds = excluded.duration_seconds,
            updated_at = excluded.updated_at
        "#,
        params![
            audio.book_id,
            audio.chapter_index,
            audio.part_index,
            audio.voice,
            audio.audio_path,
            audio.paragraphs.len() as i64,
            audio.duration_seconds,
            timestamp,
            timestamp
        ],
    )?;

    for paragraph in &audio.paragraphs {
        tx.execute(
            r#"
            INSERT INTO audio_paragraphs (
                book_id, chapter_index, part_index, block_index, voice, text_hash, audio_path,
                duration_seconds, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(book_id, block_index, voice) DO UPDATE SET
                chapter_index = excluded.chapter_index,
                part_index = excluded.part_index,
                text_hash = excluded.text_hash,
                audio_path = excluded.audio_path,
                duration_seconds = excluded.duration_seconds,
                updated_at = excluded.updated_at
            "#,
            params![
                audio.book_id,
                audio.chapter_index,
                audio.part_index,
                paragraph.block_index,
                audio.voice,
                paragraph.text_hash,
                paragraph.audio_path,
                paragraph.duration_seconds,
                timestamp,
                timestamp
            ],
        )?;
    }

    tx.commit()?;
    Ok(PartAudioPayload {
        book_id: audio.book_id,
        chapter_index: audio.chapter_index,
        part_index: audio.part_index,
        voice: audio.voice.clone(),
        audio_path: audio.audio_path.clone(),
        paragraph_count: audio.paragraphs.len() as i64,
        duration_seconds: audio.duration_seconds,
        generated_at: timestamp,
        alignment_available: false,
        alignment_error: None,
    })
}

pub fn get_part_alignment(
    connection: &Connection,
    book_id: i64,
    chapter_index: i64,
    part_index: i64,
    voice: &str,
) -> Result<Option<PartAlignmentPayload>> {
    let path: Option<String> = connection
        .query_row(
            r#"
            SELECT alignment_path
            FROM audio_alignments
            WHERE book_id = ?
              AND chapter_index = ?
              AND part_index = ?
              AND voice = ?
              AND alignment_path != ''
            "#,
            params![book_id, chapter_index, part_index, voice],
            |row| row.get(0),
        )
        .optional()?;
    let Some(path) = path else {
        return Ok(None);
    };
    if !Path::new(&path).exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).with_context(|| format!("Unable to read alignment {}", path))?;
    serde_json::from_slice(&bytes)
        .with_context(|| format!("Invalid alignment JSON {}", path))
        .map(Some)
}

pub fn save_part_alignment(
    connection: &Connection,
    alignment: &PartAlignmentPayload,
    alignment_path: &Path,
) -> Result<()> {
    let timestamp = now_iso();
    connection.execute(
        r#"
        INSERT INTO audio_alignments (
            book_id, chapter_index, part_index, voice, audio_path, alignment_path, token_count,
            duration_seconds, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)
        ON CONFLICT(book_id, chapter_index, part_index, voice) DO UPDATE SET
            audio_path = excluded.audio_path,
            alignment_path = excluded.alignment_path,
            token_count = excluded.token_count,
            duration_seconds = excluded.duration_seconds,
            last_error = '',
            updated_at = excluded.updated_at
        "#,
        params![
            alignment.book_id,
            alignment.chapter_index,
            alignment.part_index,
            alignment.voice,
            alignment.audio_path,
            path_to_string(alignment_path.to_path_buf()),
            alignment.tokens.len() as i64,
            alignment.duration_seconds,
            timestamp,
            timestamp
        ],
    )?;
    Ok(())
}

pub fn save_part_alignment_error(
    connection: &Connection,
    book_id: i64,
    chapter_index: i64,
    part_index: i64,
    voice: &str,
    audio_path: &str,
    error: &str,
) -> Result<()> {
    let timestamp = now_iso();
    connection.execute(
        r#"
        INSERT INTO audio_alignments (
            book_id, chapter_index, part_index, voice, audio_path, alignment_path, token_count,
            duration_seconds, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, '', 0, 0, ?, ?, ?)
        ON CONFLICT(book_id, chapter_index, part_index, voice) DO UPDATE SET
            audio_path = excluded.audio_path,
            alignment_path = '',
            token_count = 0,
            duration_seconds = 0,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at
        "#,
        params![
            book_id,
            chapter_index,
            part_index,
            voice,
            audio_path,
            error,
            timestamp,
            timestamp
        ],
    )?;
    Ok(())
}

pub fn delete_part_alignment(
    connection: &Connection,
    book_id: i64,
    chapter_index: i64,
    part_index: i64,
    voice: &str,
) -> Result<()> {
    connection.execute(
        r#"
        DELETE FROM audio_alignments
        WHERE book_id = ?
          AND chapter_index = ?
          AND part_index = ?
          AND voice = ?
        "#,
        params![book_id, chapter_index, part_index, voice],
    )?;
    Ok(())
}

pub fn save_progress(
    connection: &Connection,
    book_id: i64,
    chapter_index: i64,
    part_index: i64,
    block_index: i64,
    scroll_ratio: f64,
    audio_time_seconds: Option<f64>,
    audio_duration_seconds: Option<f64>,
    last_playing_block_index: Option<i64>,
    last_playing_token_index: Option<i64>,
    progress_percent: f64,
) -> Result<()> {
    let timestamp = now_iso();
    let progress = progress_percent.clamp(0.0, 100.0);
    let scroll = scroll_ratio.clamp(0.0, 1.0);
    let duration = audio_duration_seconds.filter(|value| value.is_finite() && *value > 0.0);
    let audio_time = audio_time_seconds
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| duration.map_or(value, |duration| value.min(duration)));
    let normalized = normalize_reading_progress(
        ReadingProgress {
            last_read_at: Some(timestamp.clone()),
            last_chapter_index: chapter_index,
            last_part_index: part_index,
            last_block_index: block_index,
            last_scroll_ratio: scroll,
            last_audio_time_seconds: audio_time,
            last_audio_duration_seconds: duration,
            last_playing_block_index,
            last_playing_token_index,
            progress_percent: progress,
        },
        &chapter_summaries(connection, book_id)?,
    );
    let progress_percent =
        progress_percent_for_block(connection, book_id, normalized.last_block_index)?
            .unwrap_or(normalized.progress_percent);
    connection.execute(
        r#"
        INSERT INTO reading_progress (
            book_id,
            last_read_at,
            last_chapter_index,
            last_part_index,
            last_block_index,
            last_scroll_ratio,
            last_audio_time_seconds,
            last_audio_duration_seconds,
            last_playing_block_index,
            last_playing_token_index,
            progress_percent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(book_id) DO UPDATE SET
            last_read_at = excluded.last_read_at,
            last_chapter_index = excluded.last_chapter_index,
            last_part_index = excluded.last_part_index,
            last_block_index = excluded.last_block_index,
            last_scroll_ratio = excluded.last_scroll_ratio,
            last_audio_time_seconds = CASE
                WHEN excluded.last_audio_time_seconds IS NULL
                 AND excluded.last_chapter_index = reading_progress.last_chapter_index
                 AND excluded.last_part_index = reading_progress.last_part_index
                THEN reading_progress.last_audio_time_seconds
                ELSE excluded.last_audio_time_seconds
            END,
            last_audio_duration_seconds = CASE
                WHEN excluded.last_audio_duration_seconds IS NULL
                 AND excluded.last_chapter_index = reading_progress.last_chapter_index
                 AND excluded.last_part_index = reading_progress.last_part_index
                THEN reading_progress.last_audio_duration_seconds
                ELSE excluded.last_audio_duration_seconds
            END,
            last_playing_block_index = CASE
                WHEN excluded.last_playing_block_index IS NULL
                 AND excluded.last_chapter_index = reading_progress.last_chapter_index
                 AND excluded.last_part_index = reading_progress.last_part_index
                THEN reading_progress.last_playing_block_index
                ELSE excluded.last_playing_block_index
            END,
            last_playing_token_index = CASE
                WHEN excluded.last_playing_token_index IS NULL
                 AND excluded.last_chapter_index = reading_progress.last_chapter_index
                 AND excluded.last_part_index = reading_progress.last_part_index
                THEN reading_progress.last_playing_token_index
                ELSE excluded.last_playing_token_index
            END,
            progress_percent = excluded.progress_percent
        "#,
        params![
            book_id,
            timestamp,
            normalized.last_chapter_index,
            normalized.last_part_index,
            normalized.last_block_index,
            normalized.last_scroll_ratio,
            normalized.last_audio_time_seconds,
            normalized.last_audio_duration_seconds,
            normalized.last_playing_block_index,
            normalized.last_playing_token_index,
            progress_percent
        ],
    )?;
    Ok(())
}

fn normalize_reading_progress(
    mut progress: ReadingProgress,
    chapters: &[ChapterSummary],
) -> ReadingProgress {
    if let Some(chapter) = chapters.iter().find(|chapter| {
        progress.last_block_index >= chapter.start_block_index
            && progress.last_block_index <= chapter.end_block_index
    }) {
        progress.last_chapter_index = chapter.chapter_index;
        progress.last_part_index = chapter
            .parts
            .iter()
            .find(|part| {
                progress.last_block_index >= part.start_block_index
                    && progress.last_block_index <= part.end_block_index
            })
            .map(|part| part.part_index)
            .unwrap_or(0);
        return progress;
    }

    if let Some(chapter) = chapters
        .iter()
        .find(|chapter| chapter.chapter_index == progress.last_chapter_index)
    {
        if !chapter
            .parts
            .iter()
            .any(|part| part.part_index == progress.last_part_index)
        {
            progress.last_part_index = 0;
        }
        return progress;
    }

    progress.last_chapter_index = 0;
    progress.last_part_index = 0;
    progress.last_block_index = 0;
    progress
}

fn progress_percent_for_block(
    connection: &Connection,
    book_id: i64,
    block_index: i64,
) -> Result<Option<f64>> {
    let chapters = chapter_summaries(connection, book_id)?;
    let total_units = chapters
        .iter()
        .map(|chapter| chapter.progress_units)
        .sum::<i64>();
    if total_units <= 0 {
        return Ok(None);
    }

    let Some(chapter) = chapters.iter().find(|chapter| {
        block_index >= chapter.start_block_index && block_index <= chapter.end_block_index
    }) else {
        return Ok(None);
    };

    let mut units = chapter.progress_start_unit;
    if chapter.contributes_to_progress {
        let chapter_units: i64 = connection.query_row(
            r#"
            SELECT COALESCE(SUM(length(text)), 0)
            FROM chapter_blocks
            WHERE book_id = ?
              AND kind = 'paragraph'
              AND block_index >= ?
              AND block_index < ?
            "#,
            params![book_id, chapter.start_block_index, block_index],
            |row| row.get(0),
        )?;
        units += chapter_units.max(0);
    }

    let percent = (units as f64 / total_units as f64) * 100.0;
    Ok(Some((percent.clamp(0.0, 100.0) * 10.0).round() / 10.0))
}

fn chapter_summaries(connection: &Connection, book_id: i64) -> Result<Vec<ChapterSummary>> {
    let raw_chapters = raw_chapter_summaries(connection, book_id)?;
    let chapters = build_reader_chapters(
        &raw_chapters,
        &block_markers(connection, book_id, &raw_chapters)?,
    )?;
    with_progress_units(connection, book_id, chapters)
}

fn with_progress_units(
    connection: &Connection,
    book_id: i64,
    mut chapters: Vec<ChapterSummary>,
) -> Result<Vec<ChapterSummary>> {
    let mut progress_start = 0_i64;
    for chapter in &mut chapters {
        chapter.contributes_to_progress = is_progress_chapter_title(&chapter.title);
        if chapter.contributes_to_progress {
            let units: i64 = connection.query_row(
                r#"
                SELECT COALESCE(SUM(length(text)), 0)
                FROM chapter_blocks
                WHERE book_id = ?
                  AND kind = 'paragraph'
                  AND block_index BETWEEN ? AND ?
                "#,
                params![book_id, chapter.start_block_index, chapter.end_block_index],
                |row| row.get(0),
            )?;
            chapter.progress_start_unit = progress_start;
            chapter.progress_units = units.max(0);
            progress_start += chapter.progress_units;
            chapter.progress_end_unit = progress_start;
        } else {
            chapter.progress_start_unit = progress_start;
            chapter.progress_end_unit = progress_start;
            chapter.progress_units = 0;
        }
    }
    Ok(chapters)
}

#[derive(Debug)]
struct RawChapterSummary {
    title: String,
    source_href: String,
    start_block_index: i64,
    end_block_index: i64,
}

#[derive(Debug)]
struct BlockMarker {
    block_index: i64,
    kind: String,
    asset_path: Option<String>,
    consumes_block: bool,
}

fn raw_chapter_summaries(connection: &Connection, book_id: i64) -> Result<Vec<RawChapterSummary>> {
    let mut statement = connection.prepare(
        r#"
        SELECT title, source_href, start_block_index, end_block_index
        FROM book_chapters
        WHERE book_id = ?
        ORDER BY chapter_index
        "#,
    )?;
    let rows = statement.query_map(params![book_id], |row| {
        Ok(RawChapterSummary {
            title: row.get(0)?,
            source_href: row.get(1)?,
            start_block_index: row.get(2)?,
            end_block_index: row.get(3)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn block_markers(
    connection: &Connection,
    book_id: i64,
    raw_chapters: &[RawChapterSummary],
) -> Result<Vec<BlockMarker>> {
    let mut statement = connection.prepare(
        r#"
        SELECT block_index, kind, asset_path
        FROM chapter_blocks
        WHERE book_id = ?
        ORDER BY block_index
        "#,
    )?;
    let rows = statement.query_map(params![book_id], |row| {
        Ok(BlockMarker {
            block_index: row.get(0)?,
            kind: row.get(1)?,
            asset_path: row.get(2)?,
            consumes_block: true,
        })
    })?;
    let markers = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    if markers.iter().any(is_divider_marker) {
        return Ok(markers);
    }

    let stored_path = connection
        .query_row(
            "SELECT stored_path FROM books WHERE id = ?",
            params![book_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(stored_path) = stored_path else {
        return Ok(markers);
    };
    let derived = derive_divider_markers(Path::new(&stored_path), raw_chapters);
    if derived.is_empty() {
        Ok(markers)
    } else {
        Ok(derived)
    }
}

fn derive_divider_markers(
    source_path: &Path,
    raw_chapters: &[RawChapterSummary],
) -> Vec<BlockMarker> {
    let mut markers = Vec::new();
    for chapter in raw_chapters {
        let Ok(blocks) = epub::read_chapter_blocks(source_path, &chapter.source_href) else {
            continue;
        };
        let mut block_index = chapter.start_block_index;
        for block in blocks {
            match block.kind {
                ExtractedBlockKind::Paragraph => block_index += 1,
                ExtractedBlockKind::Image => {
                    if block.asset_path.as_deref().is_some_and(is_divider_path) {
                        markers.push(BlockMarker {
                            block_index,
                            kind: "image".to_string(),
                            asset_path: block.asset_path,
                            consumes_block: false,
                        });
                    }
                }
            }
        }
    }
    markers
}

fn build_reader_chapters(
    raw_chapters: &[RawChapterSummary],
    markers: &[BlockMarker],
) -> Result<Vec<ChapterSummary>> {
    let mut groups: Vec<Vec<&RawChapterSummary>> = Vec::new();
    let mut previous_key = String::new();

    for chapter in raw_chapters {
        let Some(key) = chapter_group_key(&chapter.title, &chapter.source_href) else {
            continue;
        };
        if groups.is_empty() || previous_key != key {
            previous_key = key;
            groups.push(vec![chapter]);
        } else if let Some(group) = groups.last_mut() {
            group.push(chapter);
        }
    }

    Ok(groups
        .into_iter()
        .enumerate()
        .filter_map(|(index, group)| {
            let first = group.first()?;
            let last = group.last()?;
            let start_block_index = first.start_block_index;
            let end_block_index = last.end_block_index;
            Some(ChapterSummary {
                chapter_index: index as i64,
                title: chapter_group_title(&first.title, &first.source_href),
                start_block_index,
                end_block_index,
                progress_start_unit: 0,
                progress_end_unit: 0,
                progress_units: 0,
                contributes_to_progress: false,
                parts: build_chapter_parts(start_block_index, end_block_index, markers),
            })
        })
        .collect())
}

fn build_chapter_parts(
    start_block_index: i64,
    end_block_index: i64,
    markers: &[BlockMarker],
) -> Vec<ChapterPartSummary> {
    let mut parts = Vec::new();
    let mut current_start = start_block_index;
    let mut splits = markers
        .iter()
        .filter(|marker| is_divider_marker(marker))
        .map(|marker| (marker.block_index, marker.consumes_block))
        .filter(|(block_index, _)| {
            *block_index > start_block_index && *block_index <= end_block_index
        })
        .collect::<Vec<_>>();
    splits.sort_unstable();
    splits.dedup();

    for (split_block_index, consumes_block) in splits {
        if split_block_index > current_start {
            parts.push(ChapterPartSummary {
                part_index: parts.len() as i64,
                title: format!("Part {}", parts.len() + 1),
                start_block_index: current_start,
                end_block_index: if consumes_block {
                    split_block_index - 1
                } else {
                    split_block_index
                },
            });
        }
        current_start = split_block_index + 1;
    }
    if end_block_index >= current_start {
        parts.push(ChapterPartSummary {
            part_index: parts.len() as i64,
            title: format!("Part {}", parts.len() + 1),
            start_block_index: current_start,
            end_block_index,
        })
    }
    parts
}

fn is_divider_marker(marker: &BlockMarker) -> bool {
    marker.kind == "image" && marker.asset_path.as_deref().is_some_and(is_divider_path)
}

fn is_divider_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    path.contains("Art_orn") || lower.contains("orn")
}

fn readable_chapter_blocks(chapter_title: &str, blocks: Vec<ChapterBlock>) -> Vec<ChapterBlock> {
    blocks
        .into_iter()
        .filter(|block| {
            block.kind != "paragraph" || !is_redundant_chapter_text(chapter_title, &block.text)
        })
        .collect()
}

fn normalized_search_query(query: &str) -> Option<String> {
    let query = query.trim();
    (query.chars().count() >= 2).then(|| query.to_string())
}

fn case_insensitive_match_range(text: &str, query: &str) -> Option<(usize, usize)> {
    let query_chars = query
        .chars()
        .flat_map(|character| character.to_lowercase())
        .collect::<Vec<_>>();
    if query_chars.is_empty() {
        return None;
    }
    let text_chars = text.char_indices().collect::<Vec<_>>();
    for start in 0..text_chars.len() {
        let mut matched = 0_usize;
        for end in start..text_chars.len() {
            for character in text_chars[end].1.to_lowercase() {
                if query_chars.get(matched) != Some(&character) {
                    matched = 0;
                    break;
                }
                matched += 1;
                if matched == query_chars.len() {
                    let start_byte = text_chars[start].0;
                    let end_byte = text_chars
                        .get(end + 1)
                        .map(|(index, _)| *index)
                        .unwrap_or(text.len());
                    return Some((start_byte, end_byte));
                }
            }
            if matched == 0 {
                break;
            }
        }
    }
    None
}

fn count_case_insensitive_matches(text: &str, query: &str) -> usize {
    let mut count = 0_usize;
    let mut remaining = text;
    while let Some((_, end)) = case_insensitive_match_range(remaining, query) {
        count += 1;
        remaining = &remaining[end..];
    }
    count
}

fn search_snippet(text: &str, match_start: usize, match_end: usize) -> (String, usize, usize) {
    const BEFORE: usize = 56;
    const AFTER: usize = 76;

    let match_start_char = text[..match_start].chars().count();
    let match_end_char = text[..match_end].chars().count();
    let total_chars = text.chars().count();
    let start_char = match_start_char.saturating_sub(BEFORE);
    let end_char = (match_end_char + AFTER).min(total_chars);
    let prefix = if start_char > 0 { "..." } else { "" };
    let suffix = if end_char < total_chars { "..." } else { "" };
    let body = text
        .chars()
        .skip(start_char)
        .take(end_char.saturating_sub(start_char))
        .collect::<String>();
    let snippet = format!("{prefix}{body}{suffix}");
    let match_offset = prefix.len() + match_start_char.saturating_sub(start_char);
    let snippet_match_start = match_offset;
    let snippet_match_end = snippet_match_start + match_end_char.saturating_sub(match_start_char);
    (snippet, snippet_match_start, snippet_match_end)
}

#[derive(Clone, Copy, Debug)]
struct WordFrequency {
    count: usize,
    level: CefrLevel,
}

fn with_reader_tokens(
    mut block: ChapterBlock,
    frequencies: &HashMap<String, WordFrequency>,
) -> ChapterBlock {
    if block.kind == "paragraph" {
        block.tokens = cefr::tokenize_text(&block.text);
        for token in &mut block.tokens {
            let Some(key) = canonical_frequency_key(token) else {
                continue;
            };
            if let Some(frequency) = frequencies.get(&key) {
                token.frequency_level = Some(frequency.level);
                token.frequency_count = Some(frequency.count);
            }
        }
    }
    block
}

fn book_word_frequency_map(
    connection: &Connection,
    book_id: i64,
) -> Result<HashMap<String, WordFrequency>> {
    ensure_book_word_frequency_cache(connection, book_id)?;
    let mut statement = connection.prepare(
        r#"
        SELECT word_key, frequency_count, frequency_level
        FROM book_word_frequencies
        WHERE book_id = ?
        "#,
    )?;
    let rows = statement.query_map(params![book_id], |row| {
        let level_text: String = row.get(2)?;
        Ok((
            row.get::<_, String>(0)?,
            WordFrequency {
                count: row.get::<_, i64>(1)?.max(0) as usize,
                level: cefr_level_from_storage(&level_text).unwrap_or(CefrLevel::C2),
            },
        ))
    })?;
    rows.collect::<rusqlite::Result<HashMap<_, _>>>()
        .map_err(Into::into)
}

fn ensure_book_word_frequency_cache(connection: &Connection, book_id: i64) -> Result<()> {
    let cache_version: Option<i64> = connection
        .query_row(
            "SELECT algorithm_version FROM book_word_frequency_cache WHERE book_id = ?",
            params![book_id],
            |row| row.get(0),
        )
        .optional()?;
    if cache_version.is_some_and(|version| version >= WORD_FREQUENCY_ALGORITHM_VERSION) {
        return Ok(());
    }

    let entries = build_book_word_frequency_entries(connection, book_id)?;
    connection.execute(
        "DELETE FROM book_word_frequencies WHERE book_id = ?",
        params![book_id],
    )?;
    for (word_key, frequency) in entries {
        connection.execute(
            r#"
            INSERT OR REPLACE INTO book_word_frequencies (
                book_id, word_key, frequency_count, frequency_level
            ) VALUES (?, ?, ?, ?)
            "#,
            params![
                book_id,
                word_key,
                frequency.count as i64,
                cefr_level_to_storage(frequency.level)
            ],
        )?;
    }
    connection.execute(
        r#"
        INSERT OR REPLACE INTO book_word_frequency_cache (book_id, generated_at, algorithm_version)
        VALUES (?, ?, ?)
        "#,
        params![book_id, now_iso(), WORD_FREQUENCY_ALGORITHM_VERSION],
    )?;
    Ok(())
}

fn build_book_word_frequency_entries(
    connection: &Connection,
    book_id: i64,
) -> Result<Vec<(String, WordFrequency)>> {
    let raw_chapters = raw_chapter_summaries(connection, book_id)?;
    let chapters = build_reader_chapters(
        &raw_chapters,
        &block_markers(connection, book_id, &raw_chapters)?,
    )?;
    let mut counts: HashMap<String, usize> = HashMap::new();

    for chapter in chapters
        .into_iter()
        .filter(|chapter| is_progress_chapter_title(&chapter.title))
    {
        let mut statement = connection.prepare(
            r#"
            SELECT block_index, kind, text, asset_path, alt
            FROM chapter_blocks
            WHERE book_id = ?
              AND kind = 'paragraph'
              AND block_index BETWEEN ? AND ?
            ORDER BY block_index
            "#,
        )?;
        let rows = statement.query_map(
            params![book_id, chapter.start_block_index, chapter.end_block_index],
            |row| {
                Ok(ChapterBlock {
                    block_index: row.get(0)?,
                    kind: row.get(1)?,
                    text: row.get(2)?,
                    asset_path: row.get(3)?,
                    alt: row.get(4)?,
                    tokens: Vec::new(),
                })
            },
        )?;
        let blocks = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        for block in readable_chapter_blocks(&chapter.title, blocks) {
            for token in cefr::tokenize_text(&block.text) {
                if let Some(key) = canonical_frequency_key(&token) {
                    *counts.entry(key).or_default() += 1;
                }
            }
        }
    }

    let mut ranked = counts.into_iter().collect::<Vec<_>>();
    ranked.sort_by(|(left_word, left_count), (right_word, right_count)| {
        right_count
            .cmp(left_count)
            .then_with(|| left_word.cmp(right_word))
    });
    let total = ranked.len();
    if total == 0 {
        return Ok(Vec::new());
    }
    let non_a1_max_count = ranked
        .iter()
        .filter(|(word_key, _)| !cefr::is_oxford_3000_a1_word(word_key))
        .map(|(_, count)| *count)
        .max()
        .unwrap_or(1);

    let mut entries = Vec::with_capacity(total);
    let mut index = 0;
    while index < ranked.len() {
        let count = ranked[index].1;
        let mut end = index + 1;
        while end < ranked.len() && ranked[end].1 == count {
            end += 1;
        }
        for (word_key, _) in &ranked[index..end] {
            let level = if cefr::is_oxford_3000_a1_word(word_key) {
                CefrLevel::A1
            } else {
                frequency_level_for_non_a1_count(count, non_a1_max_count)
            };
            entries.push((word_key.clone(), WordFrequency { count, level }));
        }
        index = end;
    }
    Ok(entries)
}

fn token_frequency_key(token: &ReaderToken) -> Option<&str> {
    if !token.normalized_text.is_empty() {
        Some(&token.normalized_text)
    } else {
        None
    }
}

fn canonical_frequency_key(token: &ReaderToken) -> Option<String> {
    token_frequency_key(token).and_then(cefr::frequency_key)
}

fn frequency_level_for_non_a1_count(count: usize, max_count: usize) -> CefrLevel {
    if max_count <= 1 {
        return CefrLevel::C2;
    }
    // Zipfian word frequencies have a long tail, so compare non-A1 counts in log space.
    let score = (count.max(1) as f64).ln() / (max_count as f64).ln();
    if score >= 4.0 / 5.0 {
        CefrLevel::A2
    } else if score >= 3.0 / 5.0 {
        CefrLevel::B1
    } else if score >= 2.0 / 5.0 {
        CefrLevel::B2
    } else if score >= 1.0 / 5.0 {
        CefrLevel::C1
    } else {
        CefrLevel::C2
    }
}

fn cefr_level_to_storage(level: CefrLevel) -> &'static str {
    match level {
        CefrLevel::A1 => "A1",
        CefrLevel::A2 => "A2",
        CefrLevel::B1 => "B1",
        CefrLevel::B2 => "B2",
        CefrLevel::C1 => "C1",
        CefrLevel::C2 => "C2",
    }
}

fn cefr_level_from_storage(value: &str) -> Option<CefrLevel> {
    match value {
        "A1" => Some(CefrLevel::A1),
        "A2" => Some(CefrLevel::A2),
        "B1" => Some(CefrLevel::B1),
        "B2" => Some(CefrLevel::B2),
        "C1" => Some(CefrLevel::C1),
        "C2" => Some(CefrLevel::C2),
        _ => None,
    }
}

fn is_redundant_chapter_text(chapter_title: &str, text: &str) -> bool {
    let normalized_title = normalize_inline(chapter_title);
    let normalized_text = normalize_inline(text);
    if normalized_text == normalized_title {
        return true;
    }
    if let Some((number, title_without_number)) = normalized_title.split_once(' ') {
        if number.chars().all(|character| character.is_ascii_digit())
            && (normalized_text == number || normalized_text == title_without_number)
        {
            return true;
        }
    }
    normalized_text.len() > normalized_title.len() + 500
        && normalized_text.starts_with(&normalized_title)
}

fn normalize_inline(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn chapter_group_key(title: &str, source_href: &str) -> Option<String> {
    let stem = source_stem(source_href).to_lowercase();
    if matches!(stem.as_str(), "toc" | "newslettersignup") {
        return None;
    }
    if stem.starts_with("insert") {
        return Some("insert".to_string());
    }
    if let Some(base) = chapter_number_stem(&stem) {
        return Some(base);
    }
    title.split_whitespace().next().and_then(|first| {
        if first.chars().all(|character| character.is_ascii_digit()) {
            Some(first.to_string())
        } else {
            Some(stem)
        }
    })
}

fn chapter_group_title(title: &str, source_href: &str) -> String {
    let stem = source_stem(source_href).to_lowercase();
    if stem.starts_with("insert") {
        "Insert".to_string()
    } else {
        title.to_string()
    }
}

fn is_progress_chapter_title(title: &str) -> bool {
    title
        .split_whitespace()
        .next()
        .is_some_and(|first| first.chars().all(|character| character.is_ascii_digit()))
}

fn chapter_number_stem(stem: &str) -> Option<String> {
    let rest = stem.strip_prefix("chapter")?;
    let digits = rest
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();
    if digits.is_empty() {
        return None;
    }
    let suffix = &rest[digits.len()..];
    if suffix.is_empty()
        || (suffix.len() == 2
            && suffix.starts_with('_')
            && suffix
                .chars()
                .nth(1)
                .is_some_and(|value| value.is_ascii_lowercase()))
    {
        Some(format!("chapter{digits}"))
    } else {
        None
    }
}

fn source_stem(source_href: &str) -> String {
    source_href
        .rsplit('/')
        .next()
        .and_then(|value| value.rsplit_once('.').map(|(stem, _)| stem).or(Some(value)))
        .unwrap_or_default()
        .to_string()
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

fn resolve_chapter_image_assets(
    connection: &Connection,
    book_id: i64,
    stored_path: &Path,
    content_hash: &str,
    blocks: &mut [ChapterBlock],
) -> Result<()> {
    let Some(data_dir) = stored_path.parent().and_then(Path::parent) else {
        return Ok(());
    };
    let assets_dir = data_dir.join("assets").join(content_hash);

    for block in blocks {
        if block.kind != "image" {
            continue;
        }
        let Some(asset_path) = block.asset_path.clone() else {
            continue;
        };
        if Path::new(&asset_path).exists() {
            continue;
        }
        if let Some(local_path) = materialize_epub_asset(stored_path, &assets_dir, &asset_path)? {
            connection.execute(
                "UPDATE chapter_blocks SET asset_path = ? WHERE book_id = ? AND block_index = ?",
                params![local_path, book_id, block.block_index],
            )?;
            block.asset_path = Some(local_path);
        }
    }

    Ok(())
}

fn materialize_epub_asset(
    epub_path: &Path,
    assets_dir: &Path,
    asset_path: &str,
) -> Result<Option<String>> {
    if asset_path.trim().is_empty() || Path::new(asset_path).exists() {
        return Ok(Some(asset_path.to_string()));
    }

    let bytes = match epub::read_asset_bytes(epub_path, asset_path) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    let local_path = assets_dir
        .join("images")
        .join(normalized_relative_path(asset_path));
    if let Some(parent) = local_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&local_path, bytes)?;
    Ok(Some(path_to_string(local_path)))
}

fn normalized_relative_path(path: &str) -> PathBuf {
    let mut relative = PathBuf::new();
    for part in path.replace('\\', "/").split('/') {
        match part {
            "" | "." | ".." => {}
            value => relative.push(value),
        }
    }
    if relative.as_os_str().is_empty() {
        PathBuf::from("image")
    } else {
        relative
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugifies_titles_for_storage() {
        assert_eq!(
            slugify("My Youth Romantic Comedy, Vol. 1"),
            "my-youth-romantic-comedy-vol-1"
        );
        assert_eq!(slugify("!!!"), "book");
    }

    #[test]
    fn groups_split_chapter_files_and_ornamental_dividers_into_parts() {
        let raw_chapters = vec![
            RawChapterSummary {
                title: "4 Komachi Hikigaya is shrewdly scheming.".to_string(),
                source_href: "Text/chapter004.xhtml".to_string(),
                start_block_index: 10,
                end_block_index: 19,
            },
            RawChapterSummary {
                title: "Chapter004 B".to_string(),
                source_href: "Text/chapter004_b.xhtml".to_string(),
                start_block_index: 20,
                end_block_index: 29,
            },
            RawChapterSummary {
                title: "Chapter004 D".to_string(),
                source_href: "Text/chapter004_d.xhtml".to_string(),
                start_block_index: 30,
                end_block_index: 39,
            },
        ];
        let markers = vec![
            BlockMarker {
                block_index: 15,
                kind: "image".to_string(),
                asset_path: Some("../Images/Art_orn.jpg".to_string()),
                consumes_block: true,
            },
            BlockMarker {
                block_index: 19,
                kind: "image".to_string(),
                asset_path: Some("../Images/Art_orn.jpg".to_string()),
                consumes_block: true,
            },
            BlockMarker {
                block_index: 24,
                kind: "image".to_string(),
                asset_path: Some("../Images/Art_orn.jpg".to_string()),
                consumes_block: true,
            },
            BlockMarker {
                block_index: 29,
                kind: "image".to_string(),
                asset_path: Some("../Images/Art_orn.jpg".to_string()),
                consumes_block: true,
            },
        ];

        let chapters = build_reader_chapters(&raw_chapters, &markers).expect("chapters");

        assert_eq!(chapters.len(), 1);
        assert_eq!(
            chapters[0].title,
            "4 Komachi Hikigaya is shrewdly scheming."
        );
        assert_eq!(chapters[0].start_block_index, 10);
        assert_eq!(chapters[0].end_block_index, 39);
        assert_eq!(
            chapters[0]
                .parts
                .iter()
                .map(|part| (
                    part.title.as_str(),
                    part.start_block_index,
                    part.end_block_index
                ))
                .collect::<Vec<_>>(),
            vec![
                ("Part 1", 10, 14),
                ("Part 2", 16, 18),
                ("Part 3", 20, 23),
                ("Part 4", 25, 28),
                ("Part 5", 30, 39),
            ]
        );
    }

    #[test]
    fn removes_repeated_chapter_heading_blocks_from_display_blocks() {
        let blocks = readable_chapter_blocks(
            "4 Komachi Hikigaya is shrewdly scheming.",
            vec![
                ChapterBlock {
                    block_index: 1,
                    kind: "paragraph".to_string(),
                    text: "4 Komachi Hikigaya is shrewdly scheming. It was Sunday. The clear skies provided a brief respite from the rainy season. ".repeat(20),
                    asset_path: None,
                    alt: String::new(),
                    tokens: Vec::new(),
                },
                ChapterBlock {
                    block_index: 2,
                    kind: "paragraph".to_string(),
                    text: "4".to_string(),
                    asset_path: None,
                    alt: String::new(),
                    tokens: Vec::new(),
                },
                ChapterBlock {
                    block_index: 3,
                    kind: "paragraph".to_string(),
                    text: "Komachi Hikigaya is shrewdly scheming.".to_string(),
                    asset_path: None,
                    alt: String::new(),
                    tokens: Vec::new(),
                },
                ChapterBlock {
                    block_index: 4,
                    kind: "paragraph".to_string(),
                    text: "It was Sunday.".to_string(),
                    asset_path: None,
                    alt: String::new(),
                    tokens: Vec::new(),
                },
            ],
        );

        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].block_index, 4);
        assert_eq!(blocks[0].text, "It was Sunday.");
    }

    #[test]
    fn caches_frequency_counts_for_progress_chapters_only() {
        let connection = frequency_test_connection();

        ensure_book_word_frequency_cache(&connection, 1).expect("cache");
        let frequencies = book_word_frequency_map(&connection, 1).expect("frequencies");

        assert_eq!(
            frequencies.get("the").map(|frequency| frequency.count),
            Some(1)
        );
        assert_eq!(
            frequencies.get("wugalpha").map(|frequency| frequency.count),
            Some(4)
        );
        assert_eq!(
            frequencies.get("wugbeta").map(|frequency| frequency.count),
            Some(2)
        );
        assert_eq!(
            frequencies.get("wuggamma").map(|frequency| frequency.count),
            Some(1)
        );
        assert!(!frequencies.contains_key("copyrightonly"));
        assert!(!frequencies.contains_key("headingonly"));
    }

    #[test]
    fn assigns_more_frequent_words_to_earlier_levels() {
        let connection = frequency_test_connection();
        let frequencies = book_word_frequency_map(&connection, 1).expect("frequencies");

        assert_eq!(frequencies["the"].level, CefrLevel::A1);
        assert_eq!(frequencies["wugalpha"].level, CefrLevel::A2);
        assert_eq!(frequencies["wuggamma"].level, CefrLevel::C2);
        assert!(
            frequency_level_rank(frequencies["wugalpha"].level)
                < frequency_level_rank(frequencies["wuggamma"].level)
        );
    }

    #[test]
    fn annotates_chapter_tokens_from_cached_frequency_counts() {
        let connection = frequency_test_connection();
        let chapter = get_chapter(&connection, 1, 1)
            .expect("chapter")
            .expect("chapter");
        let token = chapter.blocks[0]
            .tokens
            .iter()
            .find(|token| token.normalized_text == "wugalpha")
            .expect("wugalpha token");

        assert_eq!(token.frequency_count, Some(4));
        assert_eq!(token.frequency_level, Some(CefrLevel::A2));
    }

    #[test]
    fn reuses_existing_frequency_cache_without_recounting() {
        let connection = frequency_test_connection();
        ensure_book_word_frequency_cache(&connection, 1).expect("cache");
        connection
            .execute(
                r#"
                INSERT INTO chapter_blocks (book_id, chapter_index, block_index, kind, text, asset_path, alt)
                VALUES (1, 1, 5, 'paragraph', 'wugalpha newword', NULL, '')
                "#,
                [],
            )
            .expect("extra block");

        ensure_book_word_frequency_cache(&connection, 1).expect("cached");
        let frequencies = book_word_frequency_map(&connection, 1).expect("frequencies");

        assert_eq!(
            frequencies.get("wugalpha").map(|frequency| frequency.count),
            Some(4)
        );
        assert!(!frequencies.contains_key("newword"));
    }

    #[test]
    fn saves_wordlist_entry_from_reader_token() {
        let connection = frequency_test_connection();

        let entry = save_wordlist_entry(
            &connection,
            1,
            1,
            2,
            2,
            "wugalpha",
            "wugalpha",
            "Fallback context.",
            "",
        )
        .expect("entry");
        let entries = list_wordlist_entries(&connection).expect("entries");

        assert_eq!(entries.len(), 1);
        assert_eq!(entry.root_word, "wugalpha");
        assert_eq!(entry.book_title, "Book");
        assert_eq!(entry.chapter_index, 1);
        assert_eq!(entry.block_index, 2);
        assert_eq!(entry.token_index, 2);
        assert!(entry.context.contains("wugalpha"));
    }

    #[test]
    fn saves_wordlist_entry_when_reader_chapter_differs_from_raw_block() {
        let connection = frequency_test_connection();
        let text = "The girl in the seat beside me hadn’t spoken a word to me today, either. Maybe the reason English education in Japan doesn’t work is because they force you into pairs for compulsory conversation.";
        connection
            .execute(
                r#"
                INSERT INTO chapter_blocks (book_id, chapter_index, block_index, kind, text, asset_path, alt)
                VALUES (1, 1, 6, 'paragraph', ?, NULL, '')
                "#,
                params![text],
            )
            .expect("block");
        let token_index = cefr::tokenize_text(text)
            .iter()
            .position(|token| token.normalized_text == "compulsory")
            .expect("compulsory token");

        let entry = save_wordlist_entry(
            &connection,
            1,
            99,
            6,
            token_index,
            "compulsory",
            "compulsory",
            text,
            "",
        )
        .expect("entry");

        assert_eq!(entry.chapter_index, 99);
        assert_eq!(entry.block_index, 6);
        assert_eq!(entry.root_word, "compulsory");
        assert!(entry.context.contains("compulsory conversation"));
    }

    #[test]
    fn wordlist_reuses_existing_root_entry() {
        let connection = frequency_test_connection();

        let first = save_wordlist_entry(
            &connection,
            1,
            1,
            2,
            2,
            "wugalpha",
            "wugalpha",
            "",
            "",
        )
        .expect("first entry");
        let duplicate = save_wordlist_entry(
            &connection,
            1,
            1,
            3,
            0,
            "wugalpha",
            "wugalpha",
            "",
            "",
        )
        .expect("duplicate entry");
        let entries = list_wordlist_entries(&connection).expect("entries");

        assert_eq!(first.id, duplicate.id);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].block_index, 2);
    }

    #[test]
    fn deletes_wordlist_entry_by_root() {
        let connection = frequency_test_connection();
        save_wordlist_entry(&connection, 1, 1, 2, 2, "wugalpha", "wugalpha", "", "")
            .expect("entry");

        assert!(delete_wordlist_entry(&connection, "wugalpha").expect("delete"));
        assert!(list_wordlist_entries(&connection).expect("entries").is_empty());
    }

    #[test]
    fn wordlist_lookup_error_keeps_saved_entry() {
        let connection = frequency_test_connection();
        let entry =
            save_wordlist_entry(&connection, 1, 1, 2, 2, "wugalpha", "wugalpha", "", "")
                .expect("entry");

        let updated =
            update_wordlist_entry_lookup(&connection, entry.id, None, "offline").expect("update");
        let entries = list_wordlist_entries(&connection).expect("entries");

        assert_eq!(updated.expect("updated").definition_lookup_error, "offline");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].definition, "");
    }

    #[test]
    fn wordlist_lookup_cache_preserves_ai_enrichment() {
        let connection = frequency_test_connection();
        let entry =
            save_wordlist_entry(&connection, 1, 1, 2, 2, "wugalpha", "wugalpha", "", "")
                .expect("entry");
        let lookup = crate::dictionary::DictionaryLookup {
            word: "wugalpha".to_string(),
            selected_word: "wugalpha".to_string(),
            word_type: "adjective".to_string(),
            cefr_level: "C2".to_string(),
            phonetics: vec!["/wug-alpha/".to_string()],
            audio_url: "https://example.com/wugalpha.mp3".to_string(),
            source_url: "https://example.com/wugalpha".to_string(),
            definitions: vec![crate::dictionary::DictionaryDefinition {
                entry_id: "wugalpha".to_string(),
                word_type: "adjective".to_string(),
                number: 2,
                definition: "required by rule".to_string(),
                examples: vec!["A compulsory task.".to_string()],
                source_url: "https://example.com/wugalpha".to_string(),
            }],
            context_definition: crate::dictionary::DictionaryChoice {
                entry_id: Some("wugalpha".to_string()),
                definition_number: Some(2),
                definition: "required by rule".to_string(),
                examples: vec!["A compulsory task.".to_string()],
                ai_explanation: "The context is about being forced into pairs.".to_string(),
                matched: true,
            },
            simple_meaning: "required".to_string(),
            in_context_meaning: "The conversation exercise is mandatory.".to_string(),
            original_meaning: "From a sense of compulsion.".to_string(),
        };

        let updated = update_wordlist_entry_lookup(&connection, entry.id, Some(&lookup), "")
            .expect("update")
            .expect("updated");

        assert_eq!(updated.simple_meaning, "required");
        assert_eq!(
            updated.in_context_meaning,
            "The conversation exercise is mandatory."
        );
        assert_eq!(updated.original_meaning, "From a sense of compulsion.");
        assert_eq!(
            updated.ai_explanation,
            "The context is about being forced into pairs."
        );
    }

    #[test]
    fn virtual_dividers_split_after_their_previous_paragraph() {
        let parts = build_chapter_parts(
            10,
            20,
            &[BlockMarker {
                block_index: 14,
                kind: "image".to_string(),
                asset_path: Some("../Images/Art_orn.jpg".to_string()),
                consumes_block: false,
            }],
        );

        assert_eq!(
            parts
                .iter()
                .map(|part| (part.start_block_index, part.end_block_index))
                .collect::<Vec<_>>(),
            vec![(10, 14), (15, 20)]
        );
    }

    #[test]
    fn search_book_ignores_empty_and_short_queries() {
        let connection = search_test_connection();

        assert!(search_book(&connection, 1, "").expect("empty").is_empty());
        assert!(search_book(&connection, 1, "a").expect("short").is_empty());
    }

    #[test]
    fn search_book_finds_case_insensitive_paragraph_matches_in_order() {
        let connection = search_test_connection();

        let results = search_book(&connection, 1, "Lantern").expect("results");

        assert_eq!(
            results
                .iter()
                .map(|result| (result.chapter_index, result.block_index))
                .collect::<Vec<_>>(),
            vec![(0, 1), (1, 3)]
        );
        assert_eq!(results[0].chapter_title, "1 One");
        assert_eq!(results[0].match_count, 2);
        assert!(results[0].snippet.contains("Lantern"));
    }

    #[test]
    fn search_book_ignores_image_blocks() {
        let connection = search_test_connection();

        let results = search_book(&connection, 1, "imageonly").expect("results");

        assert!(results.is_empty());
    }

    #[test]
    fn search_book_caps_results() {
        let connection = Connection::open_in_memory().expect("connection");
        connection.execute_batch(SCHEMA).expect("schema");
        let timestamp = now_iso();
        connection
            .execute(
                r#"
                INSERT INTO books (
                    id, slug, title, author, content_hash, original_filename, stored_path,
                    cover_asset_path, created_at, updated_at
                ) VALUES (1, 'book', 'Book', '', 'hash-search-cap', 'book.epub', '/tmp/book.epub', NULL, ?, ?)
                "#,
                params![timestamp, timestamp],
            )
            .expect("book");
        connection
            .execute(
                r#"
                INSERT INTO book_chapters (
                    book_id, chapter_index, title, source_href, start_block_index, end_block_index
                ) VALUES (1, 0, '1 One', 'chapter001.xhtml', 0, 120)
                "#,
                [],
            )
            .expect("chapter");
        for block_index in 0..120 {
            connection
                .execute(
                    r#"
                    INSERT INTO chapter_blocks (book_id, chapter_index, block_index, kind, text, asset_path, alt)
                    VALUES (1, 0, ?, 'paragraph', 'needle text', NULL, '')
                    "#,
                    params![block_index],
                )
                .expect("block");
        }

        let results = search_book(&connection, 1, "needle").expect("results");

        assert_eq!(results.len(), 100);
        assert_eq!(results[99].block_index, 99);
    }

    #[test]
    fn migrates_legacy_reading_progress_columns() {
        let connection = Connection::open_in_memory().expect("connection");
        connection
            .execute_batch(
                r#"
                CREATE TABLE reading_progress (
                    book_id INTEGER PRIMARY KEY,
                    last_read_at TEXT NOT NULL,
                    last_chapter_index INTEGER NOT NULL DEFAULT 0,
                    last_block_index INTEGER NOT NULL DEFAULT 0,
                    progress_percent REAL NOT NULL DEFAULT 0
                );
                "#,
            )
            .expect("legacy schema");

        migrate_reading_progress(&connection).expect("migration");

        let columns = table_columns(&connection, "reading_progress");
        for column in [
            "last_part_index",
            "last_scroll_ratio",
            "last_audio_time_seconds",
            "last_audio_duration_seconds",
            "last_playing_block_index",
            "last_playing_token_index",
        ] {
            assert!(columns.iter().any(|item| item == column), "{column}");
        }
    }

    #[test]
    fn saves_and_reads_rich_progress_with_clamps() {
        let connection = Connection::open_in_memory().expect("connection");
        connection.execute_batch(SCHEMA).expect("schema");
        migrate_reading_progress(&connection).expect("migration");
        let timestamp = now_iso();
        connection
            .execute(
                r#"
                INSERT INTO books (
                    id, slug, title, author, content_hash, original_filename, stored_path,
                    cover_asset_path, created_at, updated_at
                ) VALUES (1, 'book', 'Book', '', 'hash', 'book.epub', '/tmp/book.epub', NULL, ?, ?)
                "#,
                params![timestamp, timestamp],
            )
            .expect("book");
        connection
            .execute(
                r#"
                INSERT INTO book_chapters (
                    book_id, chapter_index, title, source_href, start_block_index, end_block_index
                ) VALUES (1, 2, 'Chapter', 'chapter.xhtml', 40, 50)
                "#,
                [],
            )
            .expect("chapter");
        connection
            .execute(
                r#"
                INSERT INTO chapter_blocks (book_id, chapter_index, block_index, kind, text, asset_path, alt)
                VALUES (1, 2, 42, 'paragraph', 'Text', NULL, '')
                "#,
                [],
            )
            .expect("block");

        save_progress(
            &connection,
            1,
            2,
            3,
            42,
            1.25,
            Some(12.5),
            Some(10.0),
            Some(41),
            Some(7),
            125.0,
        )
        .expect("save");

        let reader = get_reader(&connection, 1).expect("reader").expect("book");
        assert_eq!(reader.progress.last_chapter_index, 0);
        assert_eq!(reader.progress.last_part_index, 0);
        assert_eq!(reader.progress.last_block_index, 42);
        assert_eq!(reader.progress.last_scroll_ratio, 1.0);
        assert_eq!(reader.progress.last_audio_time_seconds, Some(10.0));
        assert_eq!(reader.progress.last_audio_duration_seconds, Some(10.0));
        assert_eq!(reader.progress.last_playing_block_index, Some(41));
        assert_eq!(reader.progress.last_playing_token_index, Some(7));
        assert_eq!(reader.progress.progress_percent, 100.0);
    }

    #[test]
    fn normalizes_saved_chapter_from_saved_block_on_read() {
        let connection = Connection::open_in_memory().expect("connection");
        connection.execute_batch(SCHEMA).expect("schema");
        migrate_reading_progress(&connection).expect("migration");
        let timestamp = now_iso();
        connection
            .execute(
                r#"
                INSERT INTO books (
                    id, slug, title, author, content_hash, original_filename, stored_path,
                    cover_asset_path, created_at, updated_at
                ) VALUES (1, 'book', 'Book', '', 'hash', 'book.epub', '/tmp/book.epub', NULL, ?, ?)
                "#,
                params![timestamp, timestamp],
            )
            .expect("book");
        for (chapter_index, title, source_href, start_block, end_block) in [
            (1, "1 One", "chapter001.xhtml", 1, 10),
            (2, "2 Two", "chapter002.xhtml", 40, 50),
        ] {
            connection
                .execute(
                    r#"
                    INSERT INTO book_chapters (
                        book_id, chapter_index, title, source_href, start_block_index, end_block_index
                    ) VALUES (1, ?, ?, ?, ?, ?)
                    "#,
                    params![chapter_index, title, source_href, start_block, end_block],
                )
                .expect("chapter");
        }
        connection
            .execute(
                r#"
                INSERT INTO chapter_blocks (book_id, chapter_index, block_index, kind, text, asset_path, alt)
                VALUES (1, 2, 42, 'paragraph', 'Text', NULL, '')
                "#,
                [],
            )
            .expect("block");
        connection
            .execute(
                r#"
                INSERT INTO reading_progress (
                    book_id, last_read_at, last_chapter_index, last_part_index, last_block_index,
                    last_scroll_ratio, progress_percent
                ) VALUES (1, ?, 1, 0, 42, 0.5, 25)
                "#,
                params![timestamp],
            )
            .expect("progress");

        let reader = get_reader(&connection, 1).expect("reader").expect("book");
        assert_eq!(reader.progress.last_chapter_index, 1);
        assert_eq!(reader.progress.last_part_index, 0);
        assert_eq!(reader.progress.last_block_index, 42);
    }

    #[test]
    fn preserves_audio_progress_when_same_part_save_omits_audio() {
        let connection = Connection::open_in_memory().expect("connection");
        connection.execute_batch(SCHEMA).expect("schema");
        migrate_reading_progress(&connection).expect("migration");
        let timestamp = now_iso();
        connection
            .execute(
                r#"
                INSERT INTO books (
                    id, slug, title, author, content_hash, original_filename, stored_path,
                    cover_asset_path, created_at, updated_at
                ) VALUES (1, 'book', 'Book', '', 'hash', 'book.epub', '/tmp/book.epub', NULL, ?, ?)
                "#,
                params![timestamp, timestamp],
            )
            .expect("book");
        connection
            .execute(
                r#"
                INSERT INTO book_chapters (
                    book_id, chapter_index, title, source_href, start_block_index, end_block_index
                ) VALUES (1, 0, '1 One', 'chapter001.xhtml', 40, 50)
                "#,
                [],
            )
            .expect("chapter");
        connection
            .execute(
                r#"
                INSERT INTO chapter_blocks (book_id, chapter_index, block_index, kind, text, asset_path, alt)
                VALUES (1, 0, 42, 'paragraph', 'Text', NULL, '')
                "#,
                [],
            )
            .expect("block");

        save_progress(
            &connection,
            1,
            0,
            0,
            42,
            0.1,
            Some(12.0),
            Some(100.0),
            Some(42),
            Some(3),
            10.0,
        )
        .expect("audio save");
        save_progress(&connection, 1, 0, 0, 42, 0.2, None, None, None, None, 10.0)
            .expect("scroll save");

        let reader = get_reader(&connection, 1).expect("reader").expect("book");
        assert_eq!(reader.progress.last_scroll_ratio, 0.2);
        assert_eq!(reader.progress.last_audio_time_seconds, Some(12.0));
        assert_eq!(reader.progress.last_audio_duration_seconds, Some(100.0));
        assert_eq!(reader.progress.last_playing_block_index, Some(42));
        assert_eq!(reader.progress.last_playing_token_index, Some(3));
    }

    #[test]
    fn progress_percent_counts_only_numbered_chapter_characters() {
        let connection = Connection::open_in_memory().expect("connection");
        connection.execute_batch(SCHEMA).expect("schema");
        migrate_reading_progress(&connection).expect("migration");
        let timestamp = now_iso();
        connection
            .execute(
                r#"
                INSERT INTO books (
                    id, slug, title, author, content_hash, original_filename, stored_path,
                    cover_asset_path, created_at, updated_at
                ) VALUES (1, 'book', 'Book', '', 'hash', 'book.epub', '/tmp/book.epub', NULL, ?, ?)
                "#,
                params![timestamp, timestamp],
            )
            .expect("book");

        for (chapter_index, title, source_href, block_index) in [
            (0, "Copyright", "copyright.xhtml", 0),
            (1, "1 One", "chapter001.xhtml", 1),
            (2, "2 Two", "chapter002.xhtml", 2),
            (3, "BT Bonus track!", "bonus.xhtml", 3),
        ] {
            connection
                .execute(
                    r#"
                    INSERT INTO book_chapters (
                        book_id, chapter_index, title, source_href, start_block_index, end_block_index
                    ) VALUES (1, ?, ?, ?, ?, ?)
                    "#,
                    params![chapter_index, title, source_href, block_index, block_index],
                )
                .expect("chapter");
            connection
                .execute(
                    r#"
                    INSERT INTO chapter_blocks (book_id, chapter_index, block_index, kind, text, asset_path, alt)
                    VALUES (1, ?, ?, 'paragraph', ?, NULL, '')
                    "#,
                    params![chapter_index, block_index, "x".repeat(100)],
                )
                .expect("block");
        }

        save_progress(&connection, 1, 2, 0, 2, 0.0, None, None, None, None, 99.0).expect("save");

        let reader = get_reader(&connection, 1).expect("reader").expect("book");
        assert_eq!(reader.total_progress_units, 200);
        assert_eq!(reader.progress.progress_percent, 50.0);

        let books = list_books(&connection).expect("books");
        assert_eq!(books[0].progress_percent, 50.0);
    }

    fn frequency_test_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("connection");
        connection.execute_batch(SCHEMA).expect("schema");
        let timestamp = now_iso();
        connection
            .execute(
                r#"
                INSERT INTO books (
                    id, slug, title, author, content_hash, original_filename, stored_path,
                    cover_asset_path, created_at, updated_at
                ) VALUES (1, 'book', 'Book', '', 'hash-frequency', 'book.epub', '/tmp/book.epub', NULL, ?, ?)
                "#,
                params![timestamp, timestamp],
            )
            .expect("book");
        for (chapter_index, title, source_href, start_block_index, end_block_index) in [
            (0, "Copyright", "copyright.xhtml", 0, 0),
            (1, "0 Headingonly", "chapter000.xhtml", 1, 3),
            (2, "Translation Notes", "notes.xhtml", 4, 4),
        ] {
            connection
                .execute(
                    r#"
                    INSERT INTO book_chapters (
                        book_id, chapter_index, title, source_href, start_block_index, end_block_index
                    ) VALUES (1, ?, ?, ?, ?, ?)
                    "#,
                    params![chapter_index, title, source_href, start_block_index, end_block_index],
                )
                .expect("chapter");
        }
        for (chapter_index, block_index, text) in [
            (0, 0, "copyrightonly copyrightonly"),
            (1, 1, "0 Headingonly"),
            (1, 2, "the wugalpha wugalpha wugalpha wugbeta wuggamma"),
            (1, 3, "wugalpha wugbeta"),
            (2, 4, "notesonly notesonly notesonly"),
        ] {
            connection
                .execute(
                    r#"
                    INSERT INTO chapter_blocks (book_id, chapter_index, block_index, kind, text, asset_path, alt)
                    VALUES (1, ?, ?, 'paragraph', ?, NULL, '')
                    "#,
                    params![chapter_index, block_index, text],
                )
                .expect("block");
        }
        connection
    }

    fn search_test_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("connection");
        connection.execute_batch(SCHEMA).expect("schema");
        let timestamp = now_iso();
        connection
            .execute(
                r#"
                INSERT INTO books (
                    id, slug, title, author, content_hash, original_filename, stored_path,
                    cover_asset_path, created_at, updated_at
                ) VALUES (1, 'book', 'Book', '', 'hash-search', 'book.epub', '/tmp/book.epub', NULL, ?, ?)
                "#,
                params![timestamp, timestamp],
            )
            .expect("book");
        for (chapter_index, title, source_href, start_block_index, end_block_index) in [
            (0, "1 One", "chapter001.xhtml", 0, 2),
            (1, "2 Two", "chapter002.xhtml", 3, 4),
        ] {
            connection
                .execute(
                    r#"
                    INSERT INTO book_chapters (
                        book_id, chapter_index, title, source_href, start_block_index, end_block_index
                    ) VALUES (1, ?, ?, ?, ?, ?)
                    "#,
                    params![chapter_index, title, source_href, start_block_index, end_block_index],
                )
                .expect("chapter");
        }
        for (chapter_index, block_index, kind, text, asset_path, alt) in [
            (0, 0, "paragraph", "A quiet opening paragraph", None, ""),
            (
                0,
                1,
                "paragraph",
                "Lantern light and another lantern on the wall",
                None,
                "",
            ),
            (0, 2, "image", "", Some("imageonly.png"), "imageonly"),
            (
                1,
                3,
                "paragraph",
                "The final LANTERN waited upstairs",
                None,
                "",
            ),
            (1, 4, "paragraph", "No matching term here", None, ""),
        ] {
            connection
                .execute(
                    r#"
                    INSERT INTO chapter_blocks (book_id, chapter_index, block_index, kind, text, asset_path, alt)
                    VALUES (1, ?, ?, ?, ?, ?, ?)
                    "#,
                    params![chapter_index, block_index, kind, text, asset_path, alt],
                )
                .expect("block");
        }
        connection
    }

    fn frequency_level_rank(level: CefrLevel) -> u8 {
        match level {
            CefrLevel::A1 => 1,
            CefrLevel::A2 => 2,
            CefrLevel::B1 => 3,
            CefrLevel::B2 => 4,
            CefrLevel::C1 => 5,
            CefrLevel::C2 => 6,
        }
    }

    fn table_columns(connection: &Connection, table: &str) -> Vec<String> {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("table info");
        statement
            .query_map([], |row| row.get::<_, String>(1))
            .expect("columns")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("column names")
    }
}
