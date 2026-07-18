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

export type ChapterSummary = {
  chapter_index: number;
  title: string;
  start_block_index: number;
  end_block_index: number;
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
};

export type ChapterPayload = {
  book_id: number;
  chapter_index: number;
  title: string;
  blocks: ChapterBlock[];
};

export type ImportSummary = {
  imported: number;
  skipped: number;
  failed: { path: string; message: string }[];
  books: BookSummary[];
};
