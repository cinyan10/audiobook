from __future__ import annotations

import tempfile
import unittest
import json
from unittest.mock import patch
from pathlib import Path
from zipfile import ZipFile

from app.db import connect, init_db
from app.alignment import map_transcript_to_tokens
from app.cefr import fetch_indexed_paragraph_tokens, fetch_paragraph_tokens
from app.library import chapter_heading_paragraphs_to_skip, enrich_book_part_cefr, get_book_part_alignment_payload, get_book_part_audio_path, get_cefr_job_status, get_chapter_payload, get_reader_payload, import_book, list_wordlist_entries, next_pending_cefr_part, part_alignment_path, recover_interrupted_cefr_jobs, save_progress, save_wordlist_entry, scan_books_directory, start_cefr_job
from app.words import root_word


CONTAINER_XML = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

OPF_XML = """<?xml version="1.0" encoding="utf-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test Book</dc:title>
    <dc:creator>Test Author</dc:creator>
  </metadata>
  <manifest>
    <item id="chap1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chap1"/>
  </spine>
</package>
"""

CHAPTER_HTML = """<html xmlns="http://www.w3.org/1999/xhtml"><body>
<p>This is a test paragraph.</p>
<p>Another paragraph appears here.</p>
</body></html>
"""

ORNAMENT_CHAPTER_HTML = """<html xmlns="http://www.w3.org/1999/xhtml"><body>
<p>First part.</p>
<img src="images/Art_orn.jpg" alt="" />
<p>Second part.</p>
</body></html>
"""

REDUNDANT_TITLE_CHAPTER_HTML = """<html xmlns="http://www.w3.org/1999/xhtml"><body>
<p>-- Test Book</p>
<p>Chapter line.</p>
</body></html>
"""


class Phase1ImportTests(unittest.TestCase):
    def test_import_scan_and_progress(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            books_dir = root / "books"
            books_dir.mkdir()
            epub_path = books_dir / "test-book.epub"
            self._write_epub(epub_path)

            db_path = root / "reader.sqlite3"
            init_db(db_path)
            connection = connect(db_path)

            summary, status = import_book(connection, epub_path)
            self.assertEqual(status, "imported")
            self.assertEqual(summary["title"], "Test Book")
            self.assertFalse(summary["has_cefr"])
            self.assertEqual(summary["cefr_total_parts"], 1)

            payload = get_reader_payload(connection, int(summary["id"]))
            self.assertIsNotNone(payload)
            assert payload is not None
            self.assertEqual(payload["cefr"]["ready_parts"], 0)
            chapter_payload = get_chapter_payload(connection, int(summary["id"]), 0)
            self.assertIsNotNone(chapter_payload)
            assert chapter_payload is not None
            self.assertEqual(len(chapter_payload["blocks"]), 2)
            self.assertEqual(chapter_payload["blocks"][0]["paragraph"]["text"], "This is a test paragraph.")

            progress = save_progress(connection, int(summary["id"]), 1, None)
            self.assertEqual(progress["last_paragraph_index"], 1)

            mocked_tokens = [
                [
                    {"text": "This", "level": "A1", "tip": "det=A1"},
                    {"text": " ", "level": "", "tip": ""},
                    {"text": "is", "level": "A1", "tip": "v=A1"},
                    {"text": " ", "level": "", "tip": ""},
                    {"text": "a", "level": "A1", "tip": "article=A1"},
                    {"text": " ", "level": "", "tip": ""},
                    {"text": "test", "level": "A2", "tip": "adj=A2"},
                    {"text": " ", "level": "", "tip": ""},
                    {"text": "paragraph", "level": "B1", "tip": "n=B1"},
                    {"text": ".", "level": "", "tip": ""},
                ],
                [
                    {"text": "Another", "level": "A2", "tip": "adj=A2"},
                    {"text": " ", "level": "", "tip": ""},
                    {"text": "paragraph", "level": "B1", "tip": "n=B1"},
                    {"text": " ", "level": "", "tip": ""},
                    {"text": "appears", "level": "B1", "tip": "v=B1"},
                    {"text": " ", "level": "", "tip": ""},
                    {"text": "here", "level": "A1", "tip": "adv=A1"},
                    {"text": ".", "level": "", "tip": ""},
                ],
            ]
            with patch("app.library.fetch_paragraph_tokens", return_value=mocked_tokens):
                part_payload = enrich_book_part_cefr(connection, int(summary["id"]), 0)
            self.assertEqual(part_payload["status"], "ready")
            self.assertEqual(part_payload["cefr"]["ready_parts"], 1)
            refreshed = get_reader_payload(connection, int(summary["id"]))
            assert refreshed is not None
            refreshed_chapter = get_chapter_payload(connection, int(summary["id"]), 0)
            self.assertIsNotNone(refreshed_chapter)
            assert refreshed_chapter is not None
            self.assertEqual(refreshed_chapter["blocks"][0]["paragraph"]["tokens"][0]["cefr_level"], "A1")

            scanned = scan_books_directory(connection, books_dir)
            self.assertEqual(scanned["skipped"], 1)
            self.assertEqual(len(scanned["books"]), 1)
            self.assertEqual(get_cefr_job_status(connection)["ready_parts"], 1)
            connection.close()

    def test_wordlist_saves_root_word_and_context_once(self) -> None:
        self.assertEqual(root_word("worried"), "worry")
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            books_dir = root / "books"
            books_dir.mkdir()
            epub_path = books_dir / "test-book.epub"
            self._write_epub(epub_path, """<html xmlns="http://www.w3.org/1999/xhtml"><body>
<p>She was worried about the test.</p>
</body></html>
""")

            db_path = root / "reader.sqlite3"
            init_db(db_path)
            connection = connect(db_path)
            summary, _ = import_book(connection, epub_path)
            book_id = int(summary["id"])
            chapter_payload = get_chapter_payload(connection, book_id, 0)
            assert chapter_payload is not None
            token = next(
                token
                for token in chapter_payload["blocks"][0]["paragraph"]["tokens"]
                if token["normalized_text"] == "worried"
            )

            entry = save_wordlist_entry(
                connection,
                book_id,
                "worried",
                "She was worried about the test.",
                0,
                int(token["token_index"]),
            )
            self.assertEqual(entry["root_word"], "worry")
            self.assertEqual(entry["context"], "She was worried about the test.")
            duplicate = save_wordlist_entry(connection, book_id, "worried", "Changed context.", 0, int(token["token_index"]))
            self.assertEqual(duplicate["id"], entry["id"])
            entries = list_wordlist_entries(connection)
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0]["book_title"], "Test Book")
            connection.close()

    def test_fetch_paragraph_tokens_aligns_normalized_oxford_output(self) -> None:
        calls: list[str] = []

        def fake_fetch_tokens(text: str, scope: str | None = None) -> list[dict[str, str]]:
            calls.append(text)
            return [
                {"text": "First", "level": "A1", "tip": "n=A1"},
                {"text": " ", "level": "", "tip": ""},
                {"text": "paragraph", "level": "A2", "tip": "n=A2"},
                {"text": ".", "level": "", "tip": ""},
                {"text": " ", "level": "", "tip": ""},
                {"text": "Second", "level": "A1", "tip": "n=A1"},
                {"text": " ", "level": "", "tip": ""},
                {"text": "paragraph", "level": "A2", "tip": "n=A2"},
                {"text": ".", "level": "", "tip": ""},
            ]

        with patch("app.cefr.can_fetch_cefr", return_value=True), patch("app.cefr.fetch_tokens", side_effect=fake_fetch_tokens):
            grouped = fetch_paragraph_tokens(["First paragraph.", "Second paragraph."])

        self.assertEqual(len(grouped), 2)
        self.assertEqual("".join(token["text"] for token in grouped[0]), "First paragraph.")
        self.assertEqual("".join(token["text"] for token in grouped[1]), "Second paragraph.")
        self.assertEqual(calls, ["First paragraph.\n\nSecond paragraph."])

    def test_fetch_indexed_paragraph_tokens_is_stateless(self) -> None:
        mocked_tokens = [[{"text": "Simple", "level": "A1", "tip": "adj=A1"}]]
        with patch("app.cefr.fetch_paragraph_tokens_tolerant", return_value=mocked_tokens):
            grouped = fetch_indexed_paragraph_tokens([{"paragraph_index": 7, "text": "Simple"}])

        self.assertEqual(grouped[0]["paragraph_index"], 7)
        self.assertEqual(grouped[0]["tokens"][0]["token_index"], 0)
        self.assertEqual(grouped[0]["tokens"][0]["cefr_level"], "A1")

    def test_fetch_indexed_paragraph_tokens_checks_once_for_live_payload(self) -> None:
        calls: list[str] = []

        def fake_fetch_tokens(text: str, scope: str | None = None) -> list[dict[str, str]]:
            calls.append(text)
            return [
                {"text": "First", "level": "A1", "tip": "n=A1"},
                {"text": " ", "level": "", "tip": ""},
                {"text": "paragraph", "level": "A2", "tip": "n=A2"},
                {"text": ".", "level": "", "tip": ""},
                {"text": "\n\n", "level": "", "tip": ""},
                {"text": "Second", "level": "A1", "tip": "n=A1"},
                {"text": " ", "level": "", "tip": ""},
                {"text": "paragraph", "level": "A2", "tip": "n=A2"},
                {"text": ".", "level": "", "tip": ""},
            ]

        with patch("app.cefr.can_fetch_cefr", return_value=True), patch("app.cefr.fetch_tokens", side_effect=fake_fetch_tokens):
            grouped = fetch_indexed_paragraph_tokens(
                [
                    {"paragraph_index": 1, "text": "First paragraph."},
                    {"paragraph_index": 2, "text": "Second paragraph."},
                ]
            )

        self.assertEqual(calls, ["First paragraph.\n\nSecond paragraph."])
        self.assertEqual(len(grouped), 2)

    def test_book_scoped_cefr_job_uses_only_that_book(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            books_dir = root / "books"
            books_dir.mkdir()
            first_epub = books_dir / "first-book.epub"
            second_epub = books_dir / "second-book.epub"
            self._write_epub(first_epub)
            self._write_epub(second_epub)

            db_path = root / "reader.sqlite3"
            init_db(db_path)
            connection = connect(db_path)

            first, _ = import_book(connection, first_epub)
            second, _ = import_book(connection, second_epub)
            job = start_cefr_job(connection, int(second["id"]))
            target = next_pending_cefr_part(connection, int(second["id"]))

            self.assertEqual(job["status"], "running")
            self.assertIsNotNone(target)
            assert target is not None
            self.assertEqual(target[0], int(second["id"]))
            self.assertNotEqual(target[0], int(first["id"]))
            self.assertEqual(target[2], "Test Book · Chapter1")
            connection.close()

    def test_running_cefr_job_is_recovered_after_restart(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            books_dir = root / "books"
            books_dir.mkdir()
            epub_path = books_dir / "test-book.epub"
            self._write_epub(epub_path)

            db_path = root / "reader.sqlite3"
            init_db(db_path)
            connection = connect(db_path)

            summary, _ = import_book(connection, epub_path)
            start_cefr_job(connection, int(summary["id"]))
            recover_interrupted_cefr_jobs(connection)
            status = get_cefr_job_status(connection)

            self.assertEqual(status["status"], "interrupted")
            self.assertNotEqual(next_pending_cefr_part(connection, int(summary["id"])), None)
            connection.close()

    def test_ornament_divider_is_not_rendered_as_image_block(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            books_dir = root / "books"
            books_dir.mkdir()
            epub_path = books_dir / "test-book.epub"
            self._write_epub(epub_path, ORNAMENT_CHAPTER_HTML)

            db_path = root / "reader.sqlite3"
            init_db(db_path)
            connection = connect(db_path)

            summary, status = import_book(connection, epub_path)
            self.assertEqual(status, "imported")

            chapter = get_chapter_payload(connection, int(summary["id"]), 0)
            assert chapter is not None
            self.assertEqual([block["kind"] for block in chapter["blocks"]], ["paragraph", "paragraph"])
            self.assertEqual(chapter["blocks"][0]["paragraph"]["text"], "First part.")
            self.assertEqual(chapter["blocks"][1]["paragraph"]["text"], "Second part.")
            connection.close()

    def test_stale_divider_paragraph_is_skipped_from_rendered_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            books_dir = root / "books"
            books_dir.mkdir()
            epub_path = books_dir / "test-book.epub"
            self._write_epub(epub_path, ORNAMENT_CHAPTER_HTML)

            db_path = root / "reader.sqlite3"
            init_db(db_path)
            connection = connect(db_path)

            summary, status = import_book(connection, epub_path)
            self.assertEqual(status, "imported")
            book_id = int(summary["id"])

            connection.execute(
                "UPDATE book_paragraphs SET paragraph_index = 2 WHERE book_id = ? AND paragraph_index = 1",
                (book_id,),
            )
            connection.execute(
                "UPDATE book_tokens SET paragraph_index = 2 WHERE book_id = ? AND paragraph_index = 1",
                (book_id,),
            )
            connection.execute(
                "INSERT INTO book_paragraphs (book_id, paragraph_index, text) VALUES (?, 1, ?)",
                (book_id, "X X X"),
            )
            connection.executemany(
                """
                INSERT INTO book_tokens (book_id, token_index, paragraph_index, text, normalized_text, cefr_level, oxford_tip)
                VALUES (?, ?, 1, ?, ?, NULL, NULL)
                """,
                [
                    (book_id, 100, "X", "x"),
                    (book_id, 101, " ", ""),
                    (book_id, 102, "X", "x"),
                    (book_id, 103, " ", ""),
                    (book_id, 104, "X", "x"),
                ],
            )
            connection.execute(
                "UPDATE book_chapters SET end_paragraph_index = 2 WHERE book_id = ? AND chapter_index = 0",
                (book_id,),
            )
            connection.commit()

            chapter = get_chapter_payload(connection, book_id, 0)
            assert chapter is not None
            self.assertEqual([block["kind"] for block in chapter["blocks"]], ["paragraph", "paragraph"])
            self.assertEqual(chapter["blocks"][0]["paragraph"]["text"], "First part.")
            self.assertEqual(chapter["blocks"][1]["paragraph"]["text"], "Second part.")
            self.assertEqual("".join(token["text"] for token in chapter["blocks"][1]["paragraph"]["tokens"]), "Second part.")
            connection.close()

    def test_part_audio_is_discovered_and_audio_progress_is_saved(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            books_dir = root / "books"
            books_dir.mkdir()
            epub_path = books_dir / "test-book.epub"
            self._write_epub(epub_path, ORNAMENT_CHAPTER_HTML)

            audio_path = root / "audio" / "test-book" / "chapter-01-part-002.wav"
            audio_path.parent.mkdir(parents=True)
            audio_path.write_bytes(b"fake wav")
            alignment_path = root / "audio" / "test-book" / "chapter-01-part-002.alignment.json"
            alignment_payload = {
                "book_id": 1,
                "chapter_index": 0,
                "part_index": 1,
                "audio_path": str(audio_path),
                "duration_seconds": 1.0,
                "tokens": [
                    {
                        "token_index": 0,
                        "paragraph_index": 2,
                        "text": "Second",
                        "start_time": 0.0,
                        "end_time": 0.4,
                    }
                ],
            }

            db_path = root / "reader.sqlite3"
            init_db(db_path)
            connection = connect(db_path)

            summary, status = import_book(connection, epub_path)
            self.assertEqual(status, "imported")
            book_id = int(summary["id"])

            connection.execute(
                "UPDATE book_paragraphs SET paragraph_index = 2 WHERE book_id = ? AND paragraph_index = 1",
                (book_id,),
            )
            connection.execute(
                "UPDATE book_tokens SET paragraph_index = 2 WHERE book_id = ? AND paragraph_index = 1",
                (book_id,),
            )
            connection.execute(
                "INSERT INTO book_paragraphs (book_id, paragraph_index, text) VALUES (?, 1, ?)",
                (book_id, "X X X"),
            )
            connection.executemany(
                """
                INSERT INTO book_tokens (book_id, token_index, paragraph_index, text, normalized_text, cefr_level, oxford_tip)
                VALUES (?, ?, 1, ?, ?, NULL, NULL)
                """,
                [
                    (book_id, 100, "X", "x"),
                    (book_id, 101, " ", ""),
                    (book_id, 102, "X", "x"),
                    (book_id, 103, " ", ""),
                    (book_id, 104, "X", "x"),
                ],
            )
            connection.execute(
                "UPDATE book_chapters SET end_paragraph_index = 2 WHERE book_id = ? AND chapter_index = 0",
                (book_id,),
            )
            connection.commit()
            alignment_payload["book_id"] = book_id
            alignment_path.write_text(json.dumps(alignment_payload), encoding="utf-8")

            with patch("app.library.AUDIO_DIR", root / "audio"):
                reader = get_reader_payload(connection, book_id)
                assert reader is not None
                self.assertEqual(
                    [part["audio_available"] for part in reader["chapters"][0]["parts"]],
                    [False, True],
                )
                self.assertEqual(
                    [part["alignment_available"] for part in reader["chapters"][0]["parts"]],
                    [False, True],
                )
                self.assertIsNone(get_book_part_audio_path(connection, book_id, 0, 0))
                self.assertEqual(get_book_part_audio_path(connection, book_id, 0, 1), audio_path)
                self.assertEqual(part_alignment_path("test-book", 1, 1), alignment_path)
                self.assertEqual(get_book_part_alignment_payload(connection, book_id, 0, 1), alignment_payload)

                progress = save_progress(
                    connection,
                    book_id,
                    2,
                    None,
                    audio_chapter_index=0,
                    audio_part_index=1,
                    audio_time_seconds=12.5,
                )

            self.assertEqual(progress["last_audio_chapter_index"], 0)
            self.assertEqual(progress["last_audio_part_index"], 1)
            self.assertAlmostEqual(progress["last_audio_time_seconds"], 12.5)
            connection.close()

    def test_transcript_words_are_mapped_to_reader_tokens(self) -> None:
        mapped = map_transcript_to_tokens(
            [
                {"token_index": 10, "paragraph_index": 2, "text": "Hello", "normalized_text": "hello"},
                {"token_index": 12, "paragraph_index": 2, "text": "world", "normalized_text": "world"},
            ],
            [
                {"normalized_text": "hello", "start_time": 0.1, "end_time": 0.4},
                {"normalized_text": "world", "start_time": 0.45, "end_time": 0.8},
            ],
        )
        self.assertEqual(
            mapped,
            [
                {"token_index": 10, "paragraph_index": 2, "text": "Hello", "start_time": 0.1, "end_time": 0.4},
                {"token_index": 12, "paragraph_index": 2, "text": "world", "start_time": 0.45, "end_time": 0.8},
            ],
        )

    def test_redundant_title_with_leading_dashes_is_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            books_dir = root / "books"
            books_dir.mkdir()
            epub_path = books_dir / "test-book.epub"
            self._write_epub(epub_path, REDUNDANT_TITLE_CHAPTER_HTML)

            db_path = root / "reader.sqlite3"
            init_db(db_path)
            connection = connect(db_path)

            summary, status = import_book(connection, epub_path)
            self.assertEqual(status, "imported")

            chapter = get_chapter_payload(connection, int(summary["id"]), 0)
            assert chapter is not None
            self.assertEqual([block["kind"] for block in chapter["blocks"]], ["paragraph"])
            self.assertEqual(chapter["blocks"][0]["paragraph"]["text"], "Chapter line.")
            connection.close()

    def test_cefr_enrichment_skips_hidden_title_paragraphs(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            books_dir = root / "books"
            books_dir.mkdir()
            epub_path = books_dir / "test-book.epub"
            self._write_epub(epub_path, REDUNDANT_TITLE_CHAPTER_HTML)

            db_path = root / "reader.sqlite3"
            init_db(db_path)
            connection = connect(db_path)

            summary, _ = import_book(connection, epub_path)
            mocked_tokens = [
                [
                    {"text": "Chapter", "level": "A2", "tip": "n=A2"},
                    {"text": " ", "level": "", "tip": ""},
                    {"text": "line", "level": "A1", "tip": "n=A1"},
                    {"text": ".", "level": "", "tip": ""},
                ]
            ]
            with patch("app.library.fetch_paragraph_tokens", return_value=mocked_tokens) as fetch:
                part_payload = enrich_book_part_cefr(connection, int(summary["id"]), 0)

            fetch.assert_called_once_with(["Chapter line."], scope=None)
            self.assertEqual(part_payload["status"], "ready")
            self.assertEqual(part_payload["paragraphs"][0]["text"], "Chapter line.")
            self.assertEqual(part_payload["paragraphs"][0]["tokens"][0]["cefr_level"], "A2")
            connection.close()

    def test_chapter_heading_paragraphs_to_skip(self) -> None:
        self.assertEqual(
            chapter_heading_paragraphs_to_skip(
                "4 Saki Kawasaki has some stuff going on, so she’s sulking.",
                ["4", "Saki Kawasaki has some stuff going on, so she’s sulking."],
            ),
            2,
        )
        self.assertEqual(
            chapter_heading_paragraphs_to_skip(
                "4 Saki Kawasaki has some stuff going on, so she’s sulking.",
                ["Saki Kawasaki has some stuff going on, so she’s sulking."],
            ),
            1,
        )

    def _write_epub(self, path: Path, chapter_html: str = CHAPTER_HTML) -> None:
        with ZipFile(path, "w") as book:
            book.writestr("META-INF/container.xml", CONTAINER_XML)
            book.writestr("OEBPS/content.opf", OPF_XML)
            book.writestr("OEBPS/chapter1.xhtml", chapter_html)


if __name__ == "__main__":
    unittest.main()
