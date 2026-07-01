from __future__ import annotations

import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from zipfile import ZipFile

from app.db import connect, init_db
from app.cefr import fetch_paragraph_tokens
from app.library import enrich_book_part_cefr, get_cefr_job_status, get_reader_payload, import_book, save_progress, scan_books_directory


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
            self.assertEqual(len(payload["paragraphs"]), 2)
            self.assertEqual(payload["paragraphs"][0]["text"], "This is a test paragraph.")
            self.assertEqual(payload["cefr"]["ready_parts"], 0)

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
            self.assertEqual(refreshed["paragraphs"][0]["tokens"][0]["cefr_level"], "A1")

            scanned = scan_books_directory(connection, books_dir)
            self.assertEqual(scanned["skipped"], 1)
            self.assertEqual(len(scanned["books"]), 1)
            self.assertEqual(get_cefr_job_status(connection)["ready_parts"], 1)
            connection.close()

    def test_fetch_paragraph_tokens_falls_back_to_per_paragraph(self) -> None:
        calls: list[str] = []

        def fake_fetch_tokens(text: str) -> list[dict[str, str]]:
            calls.append(text)
            if text == "First paragraph.\n\nSecond paragraph.":
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
            return [
                {"text": text[:-1], "level": "A1", "tip": "n=A1"},
                {"text": ".", "level": "", "tip": ""},
            ]

        with patch("app.cefr.can_fetch_cefr", return_value=True), patch("app.cefr.fetch_tokens", side_effect=fake_fetch_tokens):
            grouped = fetch_paragraph_tokens(["First paragraph.", "Second paragraph."])

        self.assertEqual(len(grouped), 2)
        self.assertEqual("".join(token["text"] for token in grouped[0]), "First paragraph.")
        self.assertEqual("".join(token["text"] for token in grouped[1]), "Second paragraph.")
        self.assertEqual(calls[0], "First paragraph.\n\nSecond paragraph.")

    def _write_epub(self, path: Path) -> None:
        with ZipFile(path, "w") as book:
            book.writestr("META-INF/container.xml", CONTAINER_XML)
            book.writestr("OEBPS/content.opf", OPF_XML)
            book.writestr("OEBPS/chapter1.xhtml", CHAPTER_HTML)


if __name__ == "__main__":
    unittest.main()
