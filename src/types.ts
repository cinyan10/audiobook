export type BookSummary = {
  id: number;
  title: string;
  author: string;
  cover_asset_path: string | null;
  progress_percent: number;
  last_read_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ChapterPartSummary = {
  part_index: number;
  title: string;
  start_block_index: number;
  end_block_index: number;
};

export type ChapterSummary = {
  chapter_index: number;
  title: string;
  start_block_index: number;
  end_block_index: number;
  parts: ChapterPartSummary[];
};

export type ReadingProgress = {
  last_read_at: string | null;
  last_chapter_index: number;
  last_block_index: number;
  progress_percent: number;
};

export type ReaderPayload = {
  id: number;
  title: string;
  author: string;
  cover_asset_path: string | null;
  chapters: ChapterSummary[];
  progress: ReadingProgress;
  total_blocks: number;
};

export type ChapterBlock = {
  block_index: number;
  kind: "paragraph" | "image";
  text: string;
  asset_path: string | null;
  alt: string;
  tokens: ReaderToken[];
};

export type ReaderToken = {
  text: string;
  normalized_text: string;
  root_text: string;
  cefr_level: CEFRLevel | null;
};

export type CEFRLevel = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";

export type ChapterPayload = {
  book_id: number;
  chapter_index: number;
  title: string;
  blocks: ChapterBlock[];
};

export type PartAudioPayload = {
  book_id: number;
  chapter_index: number;
  part_index: number;
  voice: string;
  audio_path: string;
  paragraph_count: number;
  duration_seconds: number;
  generated_at: string;
  alignment_available: boolean;
  alignment_error: string | null;
};

export type TimedToken = {
  block_index: number;
  token_index: number;
  text: string;
  start_time: number;
  end_time: number;
};

export type PartAlignmentPayload = {
  book_id: number;
  chapter_index: number;
  part_index: number;
  voice: string;
  audio_path: string;
  duration_seconds: number;
  mapped_token_count: number;
  source_token_count: number;
  transcript_word_count: number;
  tokens: TimedToken[];
};

export type ImportSummary = {
  imported: number;
  skipped: number;
  failed: { path: string; message: string }[];
  books: BookSummary[];
};
