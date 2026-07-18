import { invoke } from "@tauri-apps/api/core";

import type { BookSummary, ChapterPayload, ImportSummary, PartAudioPayload, ReaderPayload } from "@/types";

export function listBooks() {
  return invoke<BookSummary[]>("list_books");
}

export function importBooks(paths: string[]) {
  return invoke<ImportSummary>("import_books", { paths });
}

export function getReader(bookId: number) {
  return invoke<ReaderPayload>("get_reader", { bookId });
}

export function getChapter(bookId: number, chapterIndex: number) {
  return invoke<ChapterPayload>("get_chapter", { bookId, chapterIndex });
}

export function getPartAudio(bookId: number, chapterIndex: number, partIndex: number) {
  return invoke<PartAudioPayload | null>("get_part_audio", { bookId, chapterIndex, partIndex });
}

export function generatePartAudio(bookId: number, chapterIndex: number, partIndex: number, regenerate: boolean) {
  return invoke<PartAudioPayload>("generate_part_audio", {
    bookId,
    chapterIndex,
    partIndex,
    regenerate,
  });
}

export function saveProgress(bookId: number, chapterIndex: number, blockIndex: number, progressPercent: number) {
  return invoke<void>("save_progress", {
    bookId,
    chapterIndex,
    blockIndex,
    progressPercent,
  });
}
