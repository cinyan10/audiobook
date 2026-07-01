from __future__ import annotations

from contextlib import asynccontextmanager
from io import BytesIO
import mimetypes
from pathlib import Path
import posixpath
import sys
from typing import Annotated
from urllib.parse import unquote

from fastapi import FastAPI, File, HTTPException, Path as PathParam, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

from app.cefr import fetch_indexed_paragraph_tokens
from app.epub import read_epub_zip_asset

try:
    from PIL import Image
except ModuleNotFoundError:
    fallback_site_packages = Path(sys.base_prefix) / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"
    if fallback_site_packages.exists():
        sys.path.append(str(fallback_site_packages))
    from PIL import Image

from app.cefr_jobs import CEFRBatchRunner
from app.db import get_connection, init_db
from app.library import ensure_cefr_parts, enrich_book_part_cefr, get_book_asset, get_cefr_job_status, get_cefr_part_payload, get_chapter_payload, get_reader_payload, import_book, list_books, save_progress, scan_books_directory, store_uploaded_book
from app.schemas import BookSummary, CEFRCheckPayload, CEFRCheckSummary, CEFRJobSummary, CEFRPartLoadSummary, ChapterPayload, ProgressPayload, ProgressSummary, ReaderPayload, ScanSummary, UploadSummary


BOOKS_DIR = Path("books")
FRONTEND_DIST = Path("frontend") / "dist"
cefr_batch_runner = CEFRBatchRunner()


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    with get_connection() as connection:
        scan_books_directory(connection, BOOKS_DIR, with_cefr=False)
        for book in list_books(connection):
            ensure_cefr_parts(connection, int(book["id"]))
    yield


app = FastAPI(title="Web Book Reader", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def transparent_illustration_asset(content: bytes, asset_path: str) -> tuple[bytes, str] | None:
    basename = posixpath.basename(asset_path)
    if not (basename.startswith("Art_P") and basename.lower().endswith(".jpg")):
        return None

    image = Image.open(BytesIO(content)).convert("RGBA")
    converted: list[tuple[int, int, int, int]] = []
    for red, green, blue, _ in image.getdata():
        lightest = min(red, green, blue)
        if lightest >= 245:
            alpha = 0
        elif lightest >= 220:
            alpha = max(0, min(255, int((245 - lightest) * (255 / 25))))
        else:
            alpha = 255
        converted.append((red, green, blue, alpha))
    image.putdata(converted)

    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue(), "image/png"


@app.get("/api/books", response_model=list[BookSummary])
def books() -> list[dict[str, object]]:
    with get_connection() as connection:
        return list_books(connection)


@app.post("/api/books/scan", response_model=ScanSummary)
def scan_books() -> dict[str, object]:
    with get_connection() as connection:
        return scan_books_directory(connection, BOOKS_DIR, with_cefr=False)


@app.post("/api/books/upload", response_model=UploadSummary)
async def upload_book(file: Annotated[UploadFile, File()]) -> dict[str, object]:
    if not file.filename or not file.filename.lower().endswith(".epub"):
        raise HTTPException(status_code=400, detail="Upload an EPUB file.")
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    path = store_uploaded_book(file.filename, content, BOOKS_DIR)
    with get_connection() as connection:
        book, _ = import_book(connection, path, with_cefr=False)
    return {"book": book}


@app.get("/api/books/{book_id}", response_model=ReaderPayload)
def get_book(book_id: Annotated[int, PathParam(ge=1)]) -> dict[str, object]:
    with get_connection() as connection:
        payload = get_reader_payload(connection, book_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="Book not found.")
    return payload


@app.get("/api/books/{book_id}/chapters/{chapter_index}", response_model=ChapterPayload)
def get_book_chapter(
    book_id: Annotated[int, PathParam(ge=1)],
    chapter_index: Annotated[int, PathParam(ge=0)],
) -> dict[str, object]:
    with get_connection() as connection:
        payload = get_chapter_payload(connection, book_id, chapter_index)
    if payload is None:
        raise HTTPException(status_code=404, detail="Chapter not found.")
    return payload


@app.get("/api/books/{book_id}/assets/{chapter_index}/{asset_href:path}")
def get_book_chapter_asset(
    book_id: Annotated[int, PathParam(ge=1)],
    chapter_index: Annotated[int, PathParam(ge=0)],
    asset_href: str,
) -> Response:
    with get_connection() as connection:
        payload = get_book_asset(connection, book_id, chapter_index, asset_href)
    if payload is None:
        raise HTTPException(status_code=404, detail="Asset not found.")
    content, asset_path = payload
    transparent_asset = transparent_illustration_asset(content, asset_path)
    if transparent_asset is not None:
        transparent_content, media_type = transparent_asset
        return Response(
            content=transparent_content,
            media_type=media_type,
            headers={"Cache-Control": "no-store"},
        )
    media_type = mimetypes.guess_type(asset_path)[0] or "application/octet-stream"
    return Response(
        content=content,
        media_type=media_type,
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/books/{book_id}/cover/{cover_href:path}")
def get_book_cover(
    book_id: Annotated[int, PathParam(ge=1)],
    cover_href: str,
) -> Response:
    with get_connection() as connection:
        book = connection.execute("SELECT source_path, cover_path FROM books WHERE id = ?", (book_id,)).fetchone()
    if not book:
        raise HTTPException(status_code=404, detail="Book not found.")
    cover_path = str(book["cover_path"] or "")
    if not cover_path or unquote(cover_href) != cover_path:
        raise HTTPException(status_code=404, detail="Cover not found.")
    content, asset_path = read_epub_zip_asset(Path(str(book["source_path"])), cover_path)
    media_type = mimetypes.guess_type(asset_path)[0] or "application/octet-stream"
    return Response(content=content, media_type=media_type, headers={"Cache-Control": "no-store"})


@app.post("/api/books/{book_id}/cefr-parts/{part_index}/load", response_model=CEFRPartLoadSummary)
def load_book_part_cefr(
    book_id: Annotated[int, PathParam(ge=1)],
    part_index: Annotated[int, PathParam(ge=0)],
) -> dict[str, object]:
    with get_connection() as connection:
        book = get_reader_payload(connection, book_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Book not found.")
        try:
            return enrich_book_part_cefr(connection, book_id, part_index)
        except Exception:
            return get_cefr_part_payload(connection, book_id, part_index)


@app.post("/api/cefr/check", response_model=CEFRCheckSummary)
def check_cefr(payload: CEFRCheckPayload) -> dict[str, object]:
    paragraphs = [paragraph.model_dump() for paragraph in payload.paragraphs if paragraph.text]
    try:
        return {"paragraphs": fetch_indexed_paragraph_tokens(paragraphs)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/books/{book_id}/progress", response_model=ProgressSummary)
def update_progress(book_id: Annotated[int, PathParam(ge=1)], payload: ProgressPayload) -> dict[str, object]:
    with get_connection() as connection:
        book = get_reader_payload(connection, book_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Book not found.")
        return save_progress(connection, book_id, payload.paragraph_index, payload.token_index)


@app.get("/api/cefr/initialize", response_model=CEFRJobSummary)
def cefr_initialize_status() -> dict[str, object]:
    with get_connection() as connection:
        return get_cefr_job_status(connection)


@app.post("/api/cefr/initialize", response_model=CEFRJobSummary)
def cefr_initialize_start() -> dict[str, object]:
    return cefr_batch_runner.start()


if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
else:
    @app.get("/", response_class=HTMLResponse)
    def root() -> str:
        return """
        <!doctype html>
        <html lang="en">
        <meta charset="utf-8">
        <title>Web Book Reader</title>
        <body style="font-family: system-ui; padding: 2rem">
          <h1>Web Book Reader API is running.</h1>
          <p>Run <code>python3 run.py dev</code> for local development or <code>python3 run.py prod</code> to serve the built app here.</p>
        </body>
        </html>
        """
