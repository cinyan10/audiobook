use serde::Serialize;

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
    pub parts: Vec<ChapterPartSummary>,
}

#[derive(Debug, Serialize)]
pub struct ReadingProgress {
    pub last_read_at: Option<String>,
    pub last_chapter_index: i64,
    pub last_block_index: i64,
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
}

#[derive(Debug, Serialize)]
pub struct ChapterBlock {
    pub block_index: i64,
    pub kind: String,
    pub text: String,
    pub asset_path: Option<String>,
    pub alt: String,
}

#[derive(Debug, Serialize)]
pub struct ChapterPayload {
    pub book_id: i64,
    pub chapter_index: i64,
    pub title: String,
    pub blocks: Vec<ChapterBlock>,
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
