from __future__ import annotations

from pydantic import BaseModel, Field


class ProgressPayload(BaseModel):
    paragraph_index: int = Field(ge=0)
    token_index: int | None = Field(default=None, ge=0)
    audio_chapter_index: int | None = Field(default=None, ge=0)
    audio_part_index: int | None = Field(default=None, ge=0)
    audio_time_seconds: float | None = Field(default=None, ge=0)


class ProgressSummary(BaseModel):
    last_read_at: str | None = None
    last_paragraph_index: int = 0
    last_token_index: int | None = None
    last_audio_chapter_index: int | None = None
    last_audio_part_index: int | None = None
    last_audio_time_seconds: float = 0.0
    percent: float = 0.0


class BookSummary(BaseModel):
    id: int
    title: str
    author: str
    cover_url: str | None = None
    has_cefr: bool
    cefr_status: str
    cefr_ready_parts: int
    cefr_total_parts: int
    cefr_percent: float
    progress_percent: float
    progress_label: str
    last_read_at: str | None = None


class TokenRecord(BaseModel):
    token_index: int
    text: str
    normalized_text: str
    cefr_level: str | None = None
    oxford_tip: str | None = None


class ParagraphRecord(BaseModel):
    paragraph_index: int
    text: str
    tokens: list[TokenRecord]


class ImageRecord(BaseModel):
    src: str
    alt: str = ""


class ChapterBlockRecord(BaseModel):
    kind: str
    paragraph: ParagraphRecord | None = None
    image: ImageRecord | None = None


class CEFRPartRecord(BaseModel):
    part_index: int
    start_paragraph_index: int
    end_paragraph_index: int
    status: str


class ChapterPartRecord(BaseModel):
    part_index: int
    title: str
    start_paragraph_index: int
    end_paragraph_index: int
    audio_available: bool = False


class ChapterRecord(BaseModel):
    chapter_index: int
    title: str
    start_paragraph_index: int
    end_paragraph_index: int
    parts: list[ChapterPartRecord]


class CEFRSummary(BaseModel):
    status: str
    ready_parts: int
    total_parts: int


class ReaderPayload(BaseModel):
    id: int
    title: str
    author: str
    cefr_status: str
    cefr: CEFRSummary
    chapters: list[ChapterRecord]
    cefr_parts: list[CEFRPartRecord]
    progress: ProgressSummary
    total_paragraphs: int


class ChapterPayload(BaseModel):
    book_id: int
    chapter_index: int
    title: str
    blocks: list[ChapterBlockRecord]


class ScanSummary(BaseModel):
    imported: int
    updated: int
    skipped: int
    books: list[BookSummary]


class UploadSummary(BaseModel):
    book: BookSummary


class CEFRPartLoadSummary(BaseModel):
    book_id: int
    part_index: int
    status: str
    paragraphs: list[ParagraphRecord]
    cefr: CEFRSummary


class CEFRCheckParagraphInput(BaseModel):
    paragraph_index: int = Field(ge=0)
    text: str


class CEFRCheckPayload(BaseModel):
    paragraphs: list[CEFRCheckParagraphInput]


class CEFRCheckSummary(BaseModel):
    paragraphs: list[ParagraphRecord]


class CEFRJobSummary(BaseModel):
    id: int | None = None
    status: str
    total_parts: int
    completed_parts: int
    ready_parts: int
    current_label: str | None = None
    error_message: str | None = None
