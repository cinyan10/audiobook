mod cefr;
mod commands;
mod db;
mod dictionary;
mod epub;
mod models;

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;
use tauri::Manager;

pub struct AppState {
    data_dir: PathBuf,
    db: Mutex<Connection>,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&data_dir)?;
            let connection = db::connect(&data_dir.join("readalong.sqlite3"))?;
            app.manage(AppState {
                data_dir,
                db: Mutex::new(connection),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_books,
            commands::import_books,
            commands::get_reader,
            commands::get_chapter,
            commands::search_book,
            commands::lookup_word,
            commands::list_wordlist_entries,
            commands::list_book_wordlist_entries,
            commands::add_wordlist_entry,
            commands::delete_wordlist_entry,
            commands::get_part_audio,
            commands::get_part_alignment,
            commands::generate_part_audio,
            commands::sync_part_alignment,
            commands::save_progress,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Readalong");
}
