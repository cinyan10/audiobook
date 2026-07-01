from __future__ import annotations

from pydantic import BaseModel, Field


class ProgressPayload(BaseModel):
    paragraph_index: int = Field(ge=0)
    token_index: int | None = Field(default=None, ge=0)


class ProgressSummary(BaseModel):
    last_read_at: str | None = None
    last_paragraph_index: int = 0
    last_token_index: int | None = None
    percent: float = 0.0


class BookSummary(BaseModel):
    id: int
    title: str
    author: str
    has_cefr: bool
    cefr_status: str
    cefr_ready_parts: int
    cefr_total_parts: int
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


class CEFRPartRecord(BaseModel):
    part_index: int
    start_paragraph_index: int
    end_paragraph_index: int
    status: str


class ChapterRecord(BaseModel):
    chapter_index: int
    title: str
    start_paragraph_index: int
    end_paragraph_index: int


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
    paragraphs: list[ParagraphRecord]


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


class CEFRJobSummary(BaseModel):
    id: int | None = None
    status: str
    total_parts: int
    completed_parts: int
    ready_parts: int
    current_label: str | None = None
    error_message: str | None = None
