from __future__ import annotations

import posixpath
import re
from dataclasses import dataclass
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile


@dataclass(slots=True)
class ExtractedBook:
    title: str
    author: str
    paragraphs: list[str]
    chapters: list["ExtractedChapter"]


@dataclass(slots=True)
class ExtractedChapter:
    title: str
    source_href: str
    start_paragraph_index: int
    end_paragraph_index: int


class EpubTextParser(HTMLParser):
    block_tags = {"p", "div", "br", "h1", "h2", "h3", "h4", "li"}

    def __init__(self) -> None:
        super().__init__()
        self.out: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = dict(attrs)
        if tag == "img" and "Art_orn" in attr.get("src", ""):
            self.out.append("\n\nX X X\n\n")
        elif tag in self.block_tags:
            self.out.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.block_tags:
            self.out.append("\n")

    def handle_data(self, data: str) -> None:
        self.out.append(data)

    def text(self) -> str:
        text = unescape("".join(self.out))
        text = re.sub(r"[ \t]+", " ", text)
        return re.sub(r"\n{3,}", "\n\n", text).strip()


def split_paragraphs(text: str) -> list[str]:
    return [paragraph.strip() for paragraph in text.split("\n\n") if paragraph.strip()]


def read_epub(path: Path) -> ExtractedBook:
    with ZipFile(path) as book:
        container = ET.fromstring(book.read("META-INF/container.xml"))
        opf_path = container.find(".//{*}rootfile").attrib["full-path"]
        opf = ET.fromstring(book.read(opf_path))
        manifest = {
            item.attrib["id"]: item.attrib["href"]
            for item in opf.findall(".//{*}manifest/{*}item")
        }
        metadata = opf.find(".//{*}metadata")
        title = _first_metadata_text(metadata, "title") or path.stem
        author = _first_metadata_text(metadata, "creator") or ""
        base = posixpath.dirname(opf_path)
        chapters: list[ExtractedChapter] = []
        paragraphs: list[str] = []
        chapter_titles = _read_toc_labels(book, opf, base)
        for itemref in opf.findall(".//{*}spine/{*}itemref"):
            href = manifest.get(itemref.attrib["idref"], "")
            if not href.endswith((".xhtml", ".html")):
                continue
            source_href = posixpath.normpath(href)
            parser = EpubTextParser()
            parser.feed(book.read(posixpath.normpath(posixpath.join(base, href))).decode("utf-8", "ignore"))
            text = parser.text()
            if text:
                chapter_paragraphs = split_paragraphs(text)
                if not chapter_paragraphs:
                    continue
                start = len(paragraphs)
                paragraphs.extend(chapter_paragraphs)
                chapters.append(
                    ExtractedChapter(
                        title=chapter_titles.get(source_href) or _fallback_chapter_title(source_href, len(chapters)),
                        source_href=source_href,
                        start_paragraph_index=start,
                        end_paragraph_index=len(paragraphs) - 1,
                    )
                )

    return ExtractedBook(title=title.strip() or path.stem, author=author.strip(), paragraphs=paragraphs, chapters=chapters)


def slugify(value: str) -> str:
    slug = value.lower().replace("volume", "vol")
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    return re.sub(r"-+", "-", slug).strip("-") or "book"


def _first_metadata_text(metadata: ET.Element | None, name: str) -> str:
    if metadata is None:
        return ""
    for child in metadata:
        if child.tag.endswith(name) and child.text:
            return child.text
    return ""


def _read_toc_labels(book: ZipFile, opf: ET.Element, base: str) -> dict[str, str]:
    labels: dict[str, str] = {}
    manifest_nodes = opf.findall(".//{*}manifest/{*}item")
    ncx_href = next((item.attrib.get("href", "") for item in manifest_nodes if item.attrib.get("media-type") == "application/x-dtbncx+xml"), "")
    if not ncx_href:
        return labels
    try:
        toc = ET.fromstring(book.read(posixpath.normpath(posixpath.join(base, ncx_href))))
    except KeyError:
        return labels
    for nav in toc.findall(".//{*}navPoint"):
        content = nav.find(".//{*}content")
        label = nav.find(".//{*}text")
        if content is None or label is None or not label.text:
            continue
        source_href = content.attrib.get("src", "").split("#", 1)[0]
        if not source_href:
            continue
        labels[posixpath.normpath(source_href)] = " ".join(label.text.split())
    return labels


def _fallback_chapter_title(source_href: str, chapter_index: int) -> str:
    stem = Path(source_href).stem.replace("_", " ").replace("-", " ").strip()
    return stem.title() if stem else f"Chapter {chapter_index + 1}"
