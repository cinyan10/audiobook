use serde::{Deserialize, Serialize};

use crate::cefr::ReaderToken;

#[derive(Debug, Serialize)]
pub struct BookSummary {
    pub id: i64,
    pub title: String,
    pub author: String,
    pub cover_asset_path: Option<String>,
    pub progress_percent: f64,
    pub last_read_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct ChapterPartSummary {
    pub part_index: i64,
    pub title: String,
    pub start_block_index: i64,
    pub end_block_index: i64,
}

#[derive(Debug, Serialize)]
pub struct ChapterSummary {
    pub chapter_index: i64,
    pub title: String,
    pub start_block_index: i64,
    pub end_block_index: i64,
    pub progress_start_unit: i64,
    pub progress_end_unit: i64,
    pub progress_units: i64,
    pub contributes_to_progress: bool,
    pub parts: Vec<ChapterPartSummary>,
}

#[derive(Debug, Serialize)]
pub struct ReadingProgress {
    pub last_read_at: Option<String>,
    pub last_chapter_index: i64,
    pub last_part_index: i64,
    pub last_block_index: i64,
    pub last_scroll_ratio: f64,
    pub last_audio_time_seconds: Option<f64>,
    pub last_audio_duration_seconds: Option<f64>,
    pub last_playing_block_index: Option<i64>,
    pub last_playing_token_index: Option<i64>,
    pub progress_percent: f64,
}

#[derive(Debug, Serialize)]
pub struct ReaderPayload {
    pub id: i64,
    pub title: String,
    pub author: String,
    pub cover_asset_path: Option<String>,
    pub chapters: Vec<ChapterSummary>,
    pub progress: ReadingProgress,
    pub total_blocks: i64,
    pub total_progress_units: i64,
}

#[derive(Debug, Serialize)]
pub struct ChapterBlock {
    pub block_index: i64,
    pub kind: String,
    pub text: String,
    pub asset_path: Option<String>,
    pub alt: String,
    pub tokens: Vec<ReaderToken>,
}

#[derive(Debug, Serialize)]
pub struct ChapterPayload {
    pub book_id: i64,
    pub chapter_index: i64,
    pub title: String,
    pub blocks: Vec<ChapterBlock>,
}

#[derive(Debug, Serialize)]
pub struct PartAudioPayload {
    pub book_id: i64,
    pub chapter_index: i64,
    pub part_index: i64,
    pub voice: String,
    pub audio_path: String,
    pub paragraph_count: i64,
    pub duration_seconds: f64,
    pub generated_at: String,
    pub alignment_available: bool,
    pub alignment_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AlignmentToken {
    pub block_index: i64,
    pub token_index: usize,
    pub text: String,
    pub start_time: f64,
    pub end_time: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PartAlignmentPayload {
    pub book_id: i64,
    pub chapter_index: i64,
    pub part_index: i64,
    pub voice: String,
    pub audio_path: String,
    pub duration_seconds: f64,
    pub mapped_token_count: usize,
    pub source_token_count: usize,
    pub transcript_word_count: usize,
    pub tokens: Vec<AlignmentToken>,
}

#[derive(Debug, Serialize)]
pub struct ImportFailure {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct ImportSummary {
    pub imported: usize,
    pub skipped: usize,
    pub failed: Vec<ImportFailure>,
    pub books: Vec<BookSummary>,
}
