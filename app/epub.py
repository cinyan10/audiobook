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
    cover_path: str | None = None


@dataclass(slots=True)
class ExtractedChapter:
    title: str
    source_href: str
    start_paragraph_index: int
    end_paragraph_index: int


@dataclass(slots=True)
class ExtractedChapterBlock:
    kind: str
    text: str = ""
    image_src: str = ""
    alt: str = ""


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


def parse_chapter_blocks(content: str, source_href: str) -> list[ExtractedChapterBlock]:
    parser = EpubContentParser(source_href)
    parser.feed(content)
    return parser.blocks()


def read_epub(path: Path) -> ExtractedBook:
    with ZipFile(path) as book:
        container = ET.fromstring(book.read("META-INF/container.xml"))
        opf_path = container.find(".//{*}rootfile").attrib["full-path"]
        opf = ET.fromstring(book.read(opf_path))
        manifest_items = opf.findall(".//{*}manifest/{*}item")
        manifest = {item.attrib["id"]: item.attrib["href"] for item in manifest_items}
        metadata = opf.find(".//{*}metadata")
        title = _first_metadata_text(metadata, "title") or path.stem
        author = _first_metadata_text(metadata, "creator") or ""
        base = posixpath.dirname(opf_path)
        cover_path = _find_cover_path(book, opf, manifest_items, manifest, metadata, base)
        chapters: list[ExtractedChapter] = []
        paragraphs: list[str] = []
        chapter_titles = _read_toc_labels(book, opf, base)
        for itemref in opf.findall(".//{*}spine/{*}itemref"):
            href = manifest.get(itemref.attrib["idref"], "")
            if not href.endswith((".xhtml", ".html")):
                continue
            source_href = posixpath.normpath(href)
            content = book.read(posixpath.normpath(posixpath.join(base, href))).decode("utf-8", "ignore")
            chapter_blocks = parse_chapter_blocks(content, source_href)
            if not chapter_blocks:
                continue
            chapter_paragraphs = [block.text for block in chapter_blocks if block.kind == "paragraph"]
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

    return ExtractedBook(
        title=title.strip() or path.stem,
        author=author.strip(),
        paragraphs=paragraphs,
        chapters=chapters,
        cover_path=cover_path,
    )


def read_epub_chapter_blocks(path: Path, source_href: str) -> list[ExtractedChapterBlock]:
    with ZipFile(path) as book:
        container = ET.fromstring(book.read("META-INF/container.xml"))
        opf_path = container.find(".//{*}rootfile").attrib["full-path"]
        base = posixpath.dirname(opf_path)
        full_path = posixpath.normpath(posixpath.join(base, source_href))
        content = book.read(full_path).decode("utf-8", "ignore")
        return parse_chapter_blocks(content, source_href)


def read_epub_asset(path: Path, source_href: str, asset_href: str) -> tuple[bytes, str]:
    with ZipFile(path) as book:
        container = ET.fromstring(book.read("META-INF/container.xml"))
        opf_path = container.find(".//{*}rootfile").attrib["full-path"]
        base = posixpath.dirname(opf_path)
        asset_path = posixpath.normpath(posixpath.join(base, posixpath.dirname(source_href), asset_href))
        return book.read(asset_path), asset_path


def read_epub_zip_asset(path: Path, asset_path: str) -> tuple[bytes, str]:
    with ZipFile(path) as book:
        normalized = posixpath.normpath(asset_path)
        return book.read(normalized), normalized


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


def _find_cover_path(
    book: ZipFile,
    opf: ET.Element,
    manifest_items: list[ET.Element],
    manifest: dict[str, str],
    metadata: ET.Element | None,
    base: str,
) -> str | None:
    if metadata is not None:
        for meta in metadata.findall(".//{*}meta"):
            if meta.attrib.get("name", "").lower() != "cover":
                continue
            cover_id = meta.attrib.get("content", "")
            candidate = _manifest_href_to_zip_path(manifest.get(cover_id, ""), base)
            if candidate and _zip_has_file(book, candidate):
                return candidate

    for item in manifest_items:
        properties = item.attrib.get("properties", "")
        if "cover-image" not in properties.split():
            continue
        candidate = _manifest_href_to_zip_path(item.attrib.get("href", ""), base)
        if candidate and _zip_has_file(book, candidate):
            return candidate

    fallback_names = {"cover", "coverimage", "cover-image"}
    best_named: str | None = None
    first_image: str | None = None
    for item in manifest_items:
        href = item.attrib.get("href", "")
        media_type = item.attrib.get("media-type", "")
        if not media_type.startswith("image/"):
            continue
        candidate = _manifest_href_to_zip_path(href, base)
        if not candidate or not _zip_has_file(book, candidate):
            continue
        basename = Path(candidate).stem.lower().replace("-", "").replace("_", "")
        if basename in fallback_names:
            return candidate
        if "cover" in basename and best_named is None:
            best_named = candidate
        if first_image is None and not _looks_ornamental(candidate):
            first_image = candidate
    return best_named or first_image


def _manifest_href_to_zip_path(href: str, base: str) -> str | None:
    if not href:
        return None
    return posixpath.normpath(posixpath.join(base, href))


def _zip_has_file(book: ZipFile, path: str) -> bool:
    try:
        book.getinfo(path)
    except KeyError:
        return False
    return True


def _looks_ornamental(path: str) -> bool:
    name = Path(path).stem.lower()
    return any(token in name for token in ("orn", "logo", "icon", "toc", "title", "backcover", "back-cover"))


class EpubContentParser(HTMLParser):
    paragraph_tags = {"p", "div", "li", "h1", "h2", "h3", "h4"}

    def __init__(self, source_href: str) -> None:
        super().__init__()
        self.source_href = source_href
        self.current_tag: str | None = None
        self.current_text: list[str] = []
        self.current_href: str | None = None
        self.current_img_alt: str = ""
        self._blocks: list[ExtractedChapterBlock] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = dict(attrs)
        if tag == "img":
            src = attr.get("src", "")
            if "Art_orn" in src:
                self._blocks.append(
                    ExtractedChapterBlock(
                        kind="image",
                        image_src=posixpath.normpath(src),
                        alt=(attr.get("alt") or "").strip(),
                    )
                )
                return
            inline_symbol = inline_image_symbol(src, attr.get("class", ""), attr.get("style", ""))
            if inline_symbol is not None:
                self.current_text.append(inline_symbol)
                return
            if src:
                self._blocks.append(
                    ExtractedChapterBlock(
                        kind="image",
                        image_src=posixpath.normpath(src),
                        alt=(attr.get("alt") or "").strip(),
                    )
                )
            return
        if tag == "a":
            self.current_href = attr.get("href")
        if tag in self.paragraph_tags:
            self._flush_text()
            self.current_tag = tag
            self.current_text = []
            return
        if tag == "br":
            self.current_text.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag == "a":
            self.current_href = None
        if tag == self.current_tag:
            self._flush_text()
            self.current_tag = None

    def handle_data(self, data: str) -> None:
        if self.current_tag:
            self.current_text.append(data)

    def blocks(self) -> list[ExtractedChapterBlock]:
        self._flush_text()
        return self._blocks

    def _flush_text(self) -> None:
        if not self.current_text:
            return
        text = unescape("".join(self.current_text))
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{2,}", "\n", text).strip()
        self.current_text = []
        if not text:
            return
        if self.current_tag and self.current_tag.startswith("h") and self.current_href and "toc.xhtml" in self.current_href:
            return
        self._append_paragraph(text)

    def _append_paragraph(self, text: str) -> None:
        self._blocks.append(ExtractedChapterBlock(kind="paragraph", text=text))


def inline_image_symbol(src: str, class_name: str, style: str) -> str | None:
    normalized_src = posixpath.basename(src)
    normalized_class = class_name or ""
    normalized_style = style or ""
    if normalized_src == "Art_1.jpg" or "orn2" in normalized_class:
        return "⑧"
    if normalized_src in {"Art_star1.jpg", "Art_star2.jpg"} or "orn1" in normalized_class:
        return "★"
    if normalized_src == "Art_music.jpg":
        return "♪"
    if "vertical-align" in normalized_style:
        return ""
    return None
