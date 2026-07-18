use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::cefr;
use crate::epub;
use crate::epub::ExtractedBlockKind;
use crate::models::{BookSummary, ChapterBlock, ChapterPartSummary, ChapterPayload, ChapterSummary, ReaderPayload, ReadingProgress};

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
                    match block.kind {
                        ExtractedBlockKind::Paragraph => "paragraph",
                        ExtractedBlockKind::Image => "image",
                    },
                    block.text,
                    block.asset_path.clone(),
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
    let raw_chapters = raw_chapter_summaries(connection, book_id)?;
    let chapters = build_reader_chapters(&raw_chapters, &block_markers(connection, book_id, &raw_chapters)?)?;
    let Some(chapter) = chapters.into_iter().find(|item| item.chapter_index == chapter_index) else {
        return Ok(None);
    };

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
    let rows = statement.query_map(params![book_id, chapter.start_block_index, chapter.end_block_index], |row| {
        Ok(ChapterBlock {
            block_index: row.get(0)?,
            kind: row.get(1)?,
            text: row.get(2)?,
            asset_path: row.get(3)?,
            alt: row.get(4)?,
            tokens: Vec::new(),
        })
    })?;

    let blocks = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    let blocks = readable_chapter_blocks(&chapter.title, blocks)
        .into_iter()
        .map(with_cefr_tokens)
        .collect();

    Ok(Some(ChapterPayload {
        book_id,
        chapter_index,
        title: chapter.title,
        blocks,
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
    let raw_chapters = raw_chapter_summaries(connection, book_id)?;
    build_reader_chapters(&raw_chapters, &block_markers(connection, book_id, &raw_chapters)?)
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
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

fn block_markers(connection: &Connection, book_id: i64, raw_chapters: &[RawChapterSummary]) -> Result<Vec<BlockMarker>> {
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
        .query_row("SELECT stored_path FROM books WHERE id = ?", params![book_id], |row| {
            row.get::<_, String>(0)
        })
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

fn derive_divider_markers(source_path: &Path, raw_chapters: &[RawChapterSummary]) -> Vec<BlockMarker> {
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

fn build_reader_chapters(raw_chapters: &[RawChapterSummary], markers: &[BlockMarker]) -> Result<Vec<ChapterSummary>> {
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
        .filter(|(block_index, _)| *block_index > start_block_index && *block_index <= end_block_index)
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
        .filter(|block| block.kind != "paragraph" || !is_redundant_chapter_text(chapter_title, &block.text))
        .collect()
}

fn with_cefr_tokens(mut block: ChapterBlock) -> ChapterBlock {
    if block.kind == "paragraph" {
        block.tokens = cefr::tokenize_text(&block.text);
    }
    block
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
    normalized_text.len() > normalized_title.len() + 500 && normalized_text.starts_with(&normalized_title)
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
            && suffix.chars().nth(1).is_some_and(|value| value.is_ascii_lowercase()))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugifies_titles_for_storage() {
        assert_eq!(slugify("My Youth Romantic Comedy, Vol. 1"), "my-youth-romantic-comedy-vol-1");
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
        assert_eq!(chapters[0].title, "4 Komachi Hikigaya is shrewdly scheming.");
        assert_eq!(chapters[0].start_block_index, 10);
        assert_eq!(chapters[0].end_block_index, 39);
        assert_eq!(
            chapters[0]
                .parts
                .iter()
                .map(|part| (part.title.as_str(), part.start_block_index, part.end_block_index))
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
}
