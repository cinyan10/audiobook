use std::path::Path;

use tauri::State;

use crate::db::{self, ImportOutcome};
use crate::models::{BookSummary, ChapterPayload, ImportFailure, ImportSummary, ReaderPayload};
use crate::AppState;

#[tauri::command]
pub fn list_books(state: State<'_, AppState>) -> Result<Vec<BookSummary>, String> {
    let connection = state.db.lock().map_err(|_| "Database lock failed.".to_string())?;
    db::list_books(&connection).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn import_books(paths: Vec<String>, state: State<'_, AppState>) -> Result<ImportSummary, String> {
    let mut imported = 0;
    let mut skipped = 0;
    let mut failed = Vec::new();
    let mut connection = state.db.lock().map_err(|_| "Database lock failed.".to_string())?;

    for path in paths {
        match db::import_book(&mut connection, &state.data_dir, Path::new(&path)) {
            Ok(ImportOutcome::Imported) => imported += 1,
            Ok(ImportOutcome::Skipped) => skipped += 1,
            Err(error) => failed.push(ImportFailure {
                path,
                message: error.to_string(),
            }),
        }
    }

    let books = db::list_books(&connection).map_err(|error| error.to_string())?;
    Ok(ImportSummary {
        imported,
        skipped,
        failed,
        books,
    })
}

#[tauri::command]
pub fn get_reader(book_id: i64, state: State<'_, AppState>) -> Result<ReaderPayload, String> {
    let connection = state.db.lock().map_err(|_| "Database lock failed.".to_string())?;
    db::get_reader(&connection, book_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Book not found.".to_string())
}

#[tauri::command]
pub fn get_chapter(book_id: i64, chapter_index: i64, state: State<'_, AppState>) -> Result<ChapterPayload, String> {
    let connection = state.db.lock().map_err(|_| "Database lock failed.".to_string())?;
    db::get_chapter(&connection, book_id, chapter_index)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Chapter not found.".to_string())
}

#[tauri::command]
pub fn save_progress(
    book_id: i64,
    chapter_index: i64,
    block_index: i64,
    progress_percent: f64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let connection = state.db.lock().map_err(|_| "Database lock failed.".to_string())?;
    db::save_progress(&connection, book_id, chapter_index, block_index, progress_percent)
        .map_err(|error| error.to_string())
}
