use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, State, Window};

use crate::cefr;
use crate::db::{self, GeneratedAudioParagraph, GeneratedPartAudio, ImportOutcome};
use crate::models::{
    BookSummary, ChapterPayload, ImportFailure, ImportSummary, PartAlignmentPayload,
    PartAudioPayload, ReaderPayload,
};
use crate::AppState;

const DEFAULT_AUDIO_VOICE: &str = "bf_emma";
const DEFAULT_AUDIO_SPEED: f64 = 0.95;
const PARAGRAPH_SILENCE_SECONDS: f64 = 0.22;

#[tauri::command]
pub fn list_books(state: State<'_, AppState>) -> Result<Vec<BookSummary>, String> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Database lock failed.".to_string())?;
    db::list_books(&connection).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn import_books(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<ImportSummary, String> {
    let mut imported = 0;
    let mut skipped = 0;
    let mut failed = Vec::new();
    let mut connection = state
        .db
        .lock()
        .map_err(|_| "Database lock failed.".to_string())?;

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
    let connection = state
        .db
        .lock()
        .map_err(|_| "Database lock failed.".to_string())?;
    db::get_reader(&connection, book_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Book not found.".to_string())
}

#[tauri::command]
pub fn get_chapter(
    book_id: i64,
    chapter_index: i64,
    state: State<'_, AppState>,
) -> Result<ChapterPayload, String> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Database lock failed.".to_string())?;
    db::get_chapter(&connection, book_id, chapter_index)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Chapter not found.".to_string())
}

#[tauri::command]
pub fn get_part_audio(
    book_id: i64,
    chapter_index: i64,
    part_index: i64,
    state: State<'_, AppState>,
) -> Result<Option<PartAudioPayload>, String> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Database lock failed.".to_string())?;
    let audio = db::get_part_audio(
        &connection,
        book_id,
        chapter_index,
        part_index,
        DEFAULT_AUDIO_VOICE,
    )
    .map_err(|error| error.to_string())?;
    Ok(audio.filter(|payload| Path::new(&payload.audio_path).exists()))
}

#[tauri::command]
pub fn get_part_alignment(
    book_id: i64,
    chapter_index: i64,
    part_index: i64,
    state: State<'_, AppState>,
) -> Result<Option<PartAlignmentPayload>, String> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Database lock failed.".to_string())?;
    db::get_part_alignment(
        &connection,
        book_id,
        chapter_index,
        part_index,
        DEFAULT_AUDIO_VOICE,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn sync_part_alignment(
    book_id: i64,
    chapter_index: i64,
    part_index: i64,
    regenerate: bool,
    state: State<'_, AppState>,
) -> Result<PartAlignmentPayload, String> {
    if !regenerate {
        let connection = state
            .db
            .lock()
            .map_err(|_| "Database lock failed.".to_string())?;
        if let Some(alignment) = db::get_part_alignment(
            &connection,
            book_id,
            chapter_index,
            part_index,
            DEFAULT_AUDIO_VOICE,
        )
        .map_err(|error| error.to_string())?
        {
            return Ok(alignment);
        }
    }

    let (audio, paragraphs, generated_paragraphs) = {
        let connection = state
            .db
            .lock()
            .map_err(|_| "Database lock failed.".to_string())?;
        let audio = db::get_part_audio(
            &connection,
            book_id,
            chapter_index,
            part_index,
            DEFAULT_AUDIO_VOICE,
        )
        .map_err(|error| error.to_string())?
        .filter(|payload| Path::new(&payload.audio_path).exists())
        .ok_or_else(|| "Generate audio before syncing words.".to_string())?;
        let paragraphs = db::part_audio_paragraphs(&connection, book_id, chapter_index, part_index)
            .map_err(|error| error.to_string())?;
        let generated_paragraphs = db::generated_audio_paragraphs(
            &connection,
            book_id,
            chapter_index,
            part_index,
            DEFAULT_AUDIO_VOICE,
        )
        .map_err(|error| error.to_string())?;
        (audio, paragraphs, generated_paragraphs)
    };

    let output_dir = Path::new(&audio.audio_path)
        .parent()
        .ok_or_else(|| "Audio path has no parent directory.".to_string())?
        .to_path_buf();
    run_and_store_part_alignment(
        &state,
        book_id,
        chapter_index,
        part_index,
        &audio.voice,
        &audio.audio_path,
        audio.duration_seconds,
        &paragraphs,
        &generated_paragraphs,
        &output_dir,
    )
    .await
}

#[tauri::command]
pub async fn generate_part_audio(
    book_id: i64,
    chapter_index: i64,
    part_index: i64,
    regenerate: bool,
    state: State<'_, AppState>,
    window: Window,
) -> Result<PartAudioPayload, String> {
    {
        let connection = state
            .db
            .lock()
            .map_err(|_| "Database lock failed.".to_string())?;
        if !regenerate {
            if let Some(audio) = db::get_part_audio(
                &connection,
                book_id,
                chapter_index,
                part_index,
                DEFAULT_AUDIO_VOICE,
            )
            .map_err(|error| error.to_string())?
            .filter(|payload| Path::new(&payload.audio_path).exists())
            {
                return Ok(audio);
            }
        }
    }

    let paragraphs = {
        let connection = state
            .db
            .lock()
            .map_err(|_| "Database lock failed.".to_string())?;
        db::part_audio_paragraphs(&connection, book_id, chapter_index, part_index)
            .map_err(|error| error.to_string())?
    };
    if paragraphs.is_empty() {
        return Err("No paragraphs found for this part.".to_string());
    }

    let output_dir = state
        .data_dir
        .join("audio")
        .join(format!("book-{book_id}"))
        .join(format!("chapter-{chapter_index}"))
        .join(format!("part-{part_index}"))
        .join(DEFAULT_AUDIO_VOICE);
    fs::create_dir_all(&output_dir).map_err(|error| error.to_string())?;

    let request_path = output_dir.join("request.json");
    let response_path = output_dir.join("response.json");
    let part_output_path = output_dir.join("part.wav");
    let mut paragraph_hashes = HashMap::new();
    let request_paragraphs = paragraphs
        .iter()
        .map(|paragraph| {
            let text_hash = hash_text(&paragraph.text);
            paragraph_hashes.insert(paragraph.block_index, text_hash);
            GeneratorRequestParagraph {
                block_index: paragraph.block_index,
                text: paragraph.text.clone(),
                output_path: path_to_string(
                    output_dir.join(format!("block-{}.wav", paragraph.block_index)),
                ),
            }
        })
        .collect();

    let request = GeneratorRequest {
        voice: DEFAULT_AUDIO_VOICE.to_string(),
        speed: DEFAULT_AUDIO_SPEED,
        part_output_path: path_to_string(part_output_path),
        paragraphs: request_paragraphs,
    };
    fs::write(
        &request_path,
        serde_json::to_vec_pretty(&request).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    let generator_request_path = request_path.clone();
    let generator_response_path = response_path.clone();
    let generator_window = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_kokoro_generator(
            &generator_request_path,
            &generator_response_path,
            move |line| {
                let percent = match line.stage.as_str() {
                    "loading_model" => 2.0,
                    "rendering" => {
                        let rendered = line.completed as f64 / line.total.max(1) as f64;
                        5.0 + rendered * 85.0
                    }
                    "assembling" => 95.0,
                    _ => 0.0,
                };
                emit_audio_generation_progress(
                    &generator_window,
                    book_id,
                    chapter_index,
                    part_index,
                    line.completed,
                    line.total,
                    percent,
                    &line.stage,
                );
            },
        )
    })
    .await
    .map_err(|error| format!("Kokoro generation task failed: {error}"))??;

    let response: GeneratorResponse = serde_json::from_slice(
        &fs::read(&response_path)
            .map_err(|error| format!("Unable to read generator response: {error}"))?,
    )
    .map_err(|error| format!("Invalid generator response: {error}"))?;

    let response_paragraphs = response.paragraphs.clone();
    let generated = GeneratedPartAudio {
        book_id,
        chapter_index,
        part_index,
        voice: response.voice,
        audio_path: response.part_path,
        duration_seconds: response.duration_seconds,
        paragraphs: response
            .paragraphs
            .into_iter()
            .map(|paragraph| GeneratedAudioParagraph {
                block_index: paragraph.block_index,
                text_hash: paragraph_hashes
                    .remove(&paragraph.block_index)
                    .unwrap_or_else(|| "".to_string()),
                audio_path: paragraph.path,
                duration_seconds: paragraph.duration_seconds,
            })
            .collect(),
    };

    let saved = {
        let mut connection = state
            .db
            .lock()
            .map_err(|_| "Database lock failed.".to_string())?;
        let saved = db::save_part_audio(&mut connection, &generated).map_err(|error| error.to_string())?;
        db::delete_part_alignment(
            &connection,
            book_id,
            chapter_index,
            part_index,
            DEFAULT_AUDIO_VOICE,
        )
        .map_err(|error| error.to_string())?;
        saved
    };

    let alignment_paragraphs = response_paragraphs
        .iter()
        .map(|paragraph| GeneratedAudioParagraph {
            block_index: paragraph.block_index,
            text_hash: String::new(),
            audio_path: paragraph.path.clone(),
            duration_seconds: paragraph.duration_seconds,
        })
        .collect::<Vec<_>>();
    let saved = match run_and_store_part_alignment(
        &state,
        book_id,
        chapter_index,
        part_index,
        &saved.voice,
        &saved.audio_path,
        saved.duration_seconds,
        &paragraphs,
        &alignment_paragraphs,
        &output_dir,
    )
    .await
    {
        Ok(_) => PartAudioPayload {
            alignment_available: true,
            alignment_error: None,
            ..saved
        },
        Err(error) => {
            let connection = state
                .db
                .lock()
                .map_err(|_| "Database lock failed.".to_string())?;
            db::save_part_alignment_error(
                &connection,
                book_id,
                chapter_index,
                part_index,
                &saved.voice,
                &saved.audio_path,
                &error,
            )
            .map_err(|error| error.to_string())?;
            PartAudioPayload {
                alignment_available: false,
                alignment_error: Some(error),
                ..saved
            }
        }
    };
    emit_audio_generation_progress(
        &window,
        book_id,
        chapter_index,
        part_index,
        saved.paragraph_count.max(0) as usize,
        saved.paragraph_count.max(0) as usize,
        100.0,
        "complete",
    );
    Ok(saved)
}

#[tauri::command]
pub fn save_progress(
    book_id: i64,
    chapter_index: i64,
    block_index: i64,
    progress_percent: f64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Database lock failed.".to_string())?;
    db::save_progress(
        &connection,
        book_id,
        chapter_index,
        block_index,
        progress_percent,
    )
    .map_err(|error| error.to_string())
}

#[derive(Debug, Serialize)]
struct GeneratorRequest {
    voice: String,
    speed: f64,
    part_output_path: String,
    paragraphs: Vec<GeneratorRequestParagraph>,
}

#[derive(Debug, Serialize)]
struct GeneratorRequestParagraph {
    block_index: i64,
    text: String,
    output_path: String,
}

#[derive(Clone, Debug, Deserialize)]
struct GeneratorResponse {
    voice: String,
    part_path: String,
    duration_seconds: f64,
    paragraphs: Vec<GeneratorResponseParagraph>,
}

#[derive(Clone, Debug, Deserialize)]
struct GeneratorResponseParagraph {
    block_index: i64,
    path: String,
    duration_seconds: f64,
}

#[derive(Debug, Deserialize)]
struct GeneratorProgressLine {
    event: String,
    stage: String,
    completed: usize,
    total: usize,
}

#[derive(Debug, Serialize)]
struct AlignmentRequest {
    book_id: i64,
    chapter_index: i64,
    part_index: i64,
    voice: String,
    audio_path: String,
    duration_seconds: f64,
    paragraphs: Vec<AlignmentRequestParagraph>,
}

#[derive(Debug, Serialize)]
struct AlignmentRequestParagraph {
    block_index: i64,
    text: String,
    audio_path: String,
    offset_seconds: f64,
    duration_seconds: f64,
    tokens: Vec<AlignmentRequestToken>,
}

#[derive(Debug, Serialize)]
struct AlignmentRequestToken {
    token_index: usize,
    block_index: i64,
    text: String,
    normalized_text: String,
}

#[derive(Clone, Debug, Serialize)]
struct AudioGenerationProgress {
    book_id: i64,
    chapter_index: i64,
    part_index: i64,
    completed: usize,
    total: usize,
    percent: f64,
    stage: String,
}

fn emit_audio_generation_progress(
    window: &Window,
    book_id: i64,
    chapter_index: i64,
    part_index: i64,
    completed: usize,
    total: usize,
    percent: f64,
    stage: &str,
) {
    let _ = window.emit(
        "part-audio-progress",
        AudioGenerationProgress {
            book_id,
            chapter_index,
            part_index,
            completed,
            total,
            percent: percent.clamp(0.0, 100.0),
            stage: stage.to_string(),
        },
    );
}

async fn run_and_store_part_alignment(
    state: &State<'_, AppState>,
    book_id: i64,
    chapter_index: i64,
    part_index: i64,
    voice: &str,
    audio_path: &str,
    duration_seconds: f64,
    paragraphs: &[db::AudioParagraphSource],
    generated_paragraphs: &[GeneratedAudioParagraph],
    output_dir: &Path,
) -> Result<PartAlignmentPayload, String> {
    let request_path = output_dir.join("alignment-request.json");
    let response_path = output_dir.join("alignment.json");
    let request = build_alignment_request(
        book_id,
        chapter_index,
        part_index,
        voice,
        audio_path,
        duration_seconds,
        paragraphs,
        generated_paragraphs,
    )?;
    fs::write(
        &request_path,
        serde_json::to_vec_pretty(&request).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    let alignment_request_path = request_path.clone();
    let alignment_response_path = response_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_alignment_worker(&alignment_request_path, &alignment_response_path)
    })
    .await
    .map_err(|error| format!("Alignment task failed: {error}"))??;

    let alignment: PartAlignmentPayload = serde_json::from_slice(
        &fs::read(&response_path)
            .map_err(|error| format!("Unable to read alignment response: {error}"))?,
    )
    .map_err(|error| format!("Invalid alignment response: {error}"))?;

    let connection = state
        .db
        .lock()
        .map_err(|_| "Database lock failed.".to_string())?;
    db::save_part_alignment(&connection, &alignment, &response_path)
        .map_err(|error| error.to_string())?;
    Ok(alignment)
}

fn build_alignment_request(
    book_id: i64,
    chapter_index: i64,
    part_index: i64,
    voice: &str,
    audio_path: &str,
    duration_seconds: f64,
    paragraphs: &[db::AudioParagraphSource],
    generated_paragraphs: &[GeneratedAudioParagraph],
) -> Result<AlignmentRequest, String> {
    let generated_by_block = generated_paragraphs
        .iter()
        .map(|paragraph| (paragraph.block_index, paragraph))
        .collect::<HashMap<_, _>>();
    let mut offset_seconds = 0.0;
    let mut request_paragraphs = Vec::new();

    for paragraph in paragraphs {
        let generated = generated_by_block
            .get(&paragraph.block_index)
            .ok_or_else(|| format!("Generated audio missing for block {}.", paragraph.block_index))?;
        let tokens = cefr::tokenize_text(&paragraph.text)
            .into_iter()
            .enumerate()
            .map(|(token_index, token)| AlignmentRequestToken {
                token_index,
                block_index: paragraph.block_index,
                text: token.text,
                normalized_text: token.normalized_text,
            })
            .collect();
        request_paragraphs.push(AlignmentRequestParagraph {
            block_index: paragraph.block_index,
            text: paragraph.text.clone(),
            audio_path: generated.audio_path.clone(),
            offset_seconds: round_seconds(offset_seconds),
            duration_seconds: generated.duration_seconds,
            tokens,
        });
        offset_seconds += generated.duration_seconds + PARAGRAPH_SILENCE_SECONDS;
    }

    Ok(AlignmentRequest {
        book_id,
        chapter_index,
        part_index,
        voice: voice.to_string(),
        audio_path: audio_path.to_string(),
        duration_seconds,
        paragraphs: request_paragraphs,
    })
}

fn run_alignment_worker(request_path: &Path, response_path: &Path) -> Result<(), String> {
    let repo_root = repo_root();
    let python_path = worker_python_path(&repo_root);
    let script_path = std::env::var_os("READALONG_ALIGN_SCRIPT")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo_root.join("scripts").join("align_part_audio.py"));
    let model = std::env::var("READALONG_ALIGN_MODEL").unwrap_or_else(|_| "small.en".to_string());

    if !python_path.exists() {
        return Err(format!(
            "Python environment not found at {}. Create .venv or set READALONG_PYTHON.",
            python_path.display()
        ));
    }
    if !script_path.exists() {
        return Err(format!(
            "Alignment script not found at {}. Set READALONG_ALIGN_SCRIPT if it lives elsewhere.",
            script_path.display()
        ));
    }

    let output = Command::new(&python_path)
        .arg(&script_path)
        .arg("--request")
        .arg(request_path)
        .arg("--response")
        .arg(response_path)
        .arg("--model")
        .arg(model)
        .output()
        .map_err(|error| format!("Unable to start alignment worker: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let details = if stderr.is_empty() { stdout } else { stderr };
    Err(format!("Alignment failed: {details}"))
}

fn run_kokoro_generator<F>(
    request_path: &Path,
    response_path: &Path,
    mut on_progress: F,
) -> Result<(), String>
where
    F: FnMut(GeneratorProgressLine),
{
    let repo_root = repo_root();
    let python_path = worker_python_path(&repo_root);
    let script_path = std::env::var_os("READALONG_KOKORO_SCRIPT")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo_root.join("scripts").join("kokoro_generate_part.py"));

    if !python_path.exists() {
        return Err(format!(
            "Python environment not found at {}. Create .venv or set READALONG_PYTHON.",
            python_path.display()
        ));
    }
    if !script_path.exists() {
        return Err(format!(
            "Kokoro generator script not found at {}. Set READALONG_KOKORO_SCRIPT if it lives elsewhere.",
            script_path.display()
        ));
    }

    let mut child = Command::new(&python_path)
        .arg(&script_path)
        .arg("--request")
        .arg(request_path)
        .arg("--response")
        .arg(response_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Unable to start Kokoro generator: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Unable to read Kokoro generator stdout.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Unable to read Kokoro generator stderr.".to_string())?;
    let stderr_reader = thread::spawn(move || {
        let mut details = String::new();
        let mut reader = BufReader::new(stderr);
        let _ = reader.read_to_string(&mut details);
        details
    });

    let mut stdout_details = Vec::new();
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|error| format!("Unable to read Kokoro generator output: {error}"))?;
        if let Ok(progress) = serde_json::from_str::<GeneratorProgressLine>(&line) {
            if progress.event == "progress" {
                on_progress(progress);
                continue;
            }
        }
        stdout_details.push(line);
    }

    let status = child
        .wait()
        .map_err(|error| format!("Unable to wait for Kokoro generator: {error}"))?;
    let stderr = stderr_reader.join().unwrap_or_default();

    if status.success() {
        return Ok(());
    }

    let details = if stderr.trim().is_empty() {
        stdout_details.join("\n")
    } else {
        stderr.trim().to_string()
    };
    Err(format!("Kokoro generation failed: {details}"))
}

fn repo_root() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir.parent().unwrap_or(&manifest_dir).to_path_buf()
}

fn worker_python_path(repo_root: &Path) -> PathBuf {
    std::env::var_os("READALONG_PYTHON")
        .or_else(|| std::env::var_os("READALONG_KOKORO_PYTHON"))
        .map(PathBuf::from)
        .unwrap_or_else(|| default_python_path(repo_root))
}

fn default_python_path(repo_root: &Path) -> PathBuf {
    if cfg!(windows) {
        repo_root
            .join(".venv")
            .join("Scripts")
            .join("python.exe")
    } else {
        repo_root.join(".venv").join("bin").join("python")
    }
}

fn hash_text(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

fn round_seconds(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}
