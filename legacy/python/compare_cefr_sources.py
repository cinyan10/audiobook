from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from html import escape
from pathlib import Path

from app.cefr import count_words
from app.epub import ExtractedBook, read_epub
from app.olp_cefr import check_text
from oxford_cefr import LEVEL_COLORS


BOOK_PATH = Path("data/books/my-youth-romantic-comedy-is-wrong-as-i-expected-vol-1.epub")
OUTPUT_PATH = Path("cefr-source-comparison.html")
LEVELS = ("A1", "A2", "B1", "B2", "C1", "C2")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compare Oxford Text Checker and OLP-EN-CEFRJ CEFR coloring.")
    parser.add_argument("--book", type=Path, default=BOOK_PATH, help="EPUB to read")
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH, help="Static HTML comparison output")
    parser.add_argument("--max-words", type=int, default=1500, help="Maximum words to check from the first prose chapter")
    parser.add_argument("--api-base", default="http://127.0.0.1:8000", help="Backend API base URL for Oxford checks")
    parser.add_argument("--self-check", action="store_true", help="Run a tiny offline renderer check and exit")
    return parser.parse_args()


def first_prose_chapter(book: ExtractedBook) -> tuple[str, list[str]]:
    fallback: tuple[str, list[str]] | None = None
    for chapter in book.chapters:
        if chapter.end_paragraph_index < chapter.start_paragraph_index:
            continue
        paragraphs = book.paragraphs[chapter.start_paragraph_index : chapter.end_paragraph_index + 1]
        if sum(count_words(paragraph) for paragraph in paragraphs) < 100:
            continue
        if re.match(r"^\s*\d+\b", chapter.title) or "chapter" in Path(chapter.source_href).stem.lower():
            return chapter.title, paragraphs
        if fallback is None:
            fallback = (chapter.title, paragraphs)
    if fallback is not None:
        return fallback
    raise RuntimeError("No prose chapter with at least 100 words was found.")


def cap_paragraphs(paragraphs: list[str], max_words: int) -> list[str]:
    capped: list[str] = []
    remaining = max_words
    for paragraph in paragraphs:
        words = count_words(paragraph)
        if words <= remaining:
            capped.append(paragraph)
            remaining -= words
        else:
            capped.append(_first_words(paragraph, remaining))
            break
        if remaining <= 0:
            break
    return [paragraph for paragraph in capped if paragraph.strip()]


def _first_words(text: str, max_words: int) -> str:
    if max_words <= 0:
        return ""
    words_seen = 0
    for index, char in enumerate(text):
        if char.isalnum() and (index == 0 or not text[index - 1].isalnum()):
            words_seen += 1
            if words_seen > max_words:
                return text[:index].rstrip()
    return text


def render_panel(title: str, tokens: list[dict[str, str]]) -> str:
    counts = Counter(token.get("level", "") for token in tokens if token.get("level"))
    summary = render_legend(counts)
    body = "".join(render_token(token) for token in tokens)
    return f"""
    <section class="panel">
      <header>
        <h2>{escape(title)}</h2>
        <div class="legend">{summary}</div>
      </header>
      <div class="reader">{body}</div>
    </section>
"""


def render_legend(counts: Counter[str]) -> str:
    return " ".join(
        f'<span class="legend-item"><span class="swatch" style="background:{LEVEL_COLORS[level]}"></span>{level}: {counts[level]}</span>'
        for level in LEVELS
    )


def render_token(token: dict[str, str]) -> str:
    text = escape(token["text"])
    level = token.get("level", "")
    if not level:
        return text
    color = LEVEL_COLORS.get(level, "#222")
    tip = escape(token.get("tip", ""))
    return f'<span class="token {level.lower()}" title="{tip}" style="color:{color}">{text}</span>'


def render_page(
    book_title: str,
    chapter_title: str,
    word_count: int,
    paragraphs: list[str],
    olp_tokens: list[dict[str, str]],
    api_base: str,
) -> str:
    paragraph_payload = [{"paragraph_index": index, "text": text} for index, text in enumerate(paragraphs)]
    return f"""<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CEFR Source Comparison</title>
<style>
:root {{
  color-scheme: light;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}}
body {{
  margin: 0;
  background: #f7f4ef;
  color: #1f2933;
}}
main {{
  max-width: 1440px;
  margin: 0 auto;
  padding: 28px 20px 40px;
}}
h1 {{
  margin: 0 0 8px;
  font-size: 1.65rem;
  line-height: 1.2;
}}
.meta {{
  margin: 0 0 20px;
  color: #57606a;
}}
.grid {{
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
}}
.panel {{
  background: rgba(255,255,255,0.86);
  border: 1px solid rgba(31,41,51,0.12);
  border-radius: 8px;
  overflow: hidden;
}}
.panel header {{
  padding: 16px 18px 12px;
  border-bottom: 1px solid rgba(31,41,51,0.1);
}}
.panel-title-row {{
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}}
h2 {{
  margin: 0 0 10px;
  font-size: 1.05rem;
}}
button {{
  border: 1px solid rgba(31,41,51,0.18);
  border-radius: 6px;
  background: #ffffff;
  color: #1f2933;
  cursor: pointer;
  font: 600 0.82rem/1 ui-sans-serif, system-ui, sans-serif;
  padding: 7px 10px;
}}
button:disabled {{
  cursor: wait;
  opacity: 0.62;
}}
.legend {{
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  font-size: 0.84rem;
  color: #48515c;
}}
.legend-item {{
  display: inline-flex;
  align-items: center;
  gap: 5px;
}}
.swatch {{
  width: 0.7rem;
  height: 0.7rem;
  border-radius: 50%;
}}
.reader {{
  padding: 18px;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 1.08rem;
  line-height: 1.85;
  white-space: pre-wrap;
}}
.token {{
  border-radius: 3px;
}}
.token:hover {{
  background: rgba(0,0,0,0.08);
}}
.error {{
  margin: 0;
  color: #9f1239;
  font-family: ui-sans-serif, system-ui, sans-serif;
}}
.status {{
  margin: 0;
  color: #57606a;
  font-family: ui-sans-serif, system-ui, sans-serif;
}}
@media (max-width: 900px) {{
  .grid {{
    grid-template-columns: 1fr;
  }}
}}
</style>
<main>
  <h1>{escape(book_title)}</h1>
  <p class="meta">{escape(chapter_title)} · {word_count} words checked · Unknown offline words are rendered as C2.</p>
  <div class="grid">
    <section class="panel">
      <header>
        <div class="panel-title-row">
          <h2>Oxford Text Checker</h2>
          <button id="reload-oxford" type="button">Reload</button>
        </div>
        <div class="legend" id="oxford-legend">{render_legend(Counter())}</div>
      </header>
      <div class="reader" id="oxford-reader"><p class="status">Waiting for backend...</p></div>
    </section>
    {render_panel("OLP-EN-CEFRJ Offline", olp_tokens)}
  </div>
</main>
<script>
const API_BASE = {json.dumps(api_base.rstrip("/"))};
const LEVELS = {json.dumps(LEVELS)};
const LEVEL_COLORS = {json.dumps(LEVEL_COLORS)};
const PARAGRAPHS = {json.dumps(paragraph_payload)};

function escapeHtml(value) {{
  return value.replace(/[&<>"']/g, char => ({{
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\\"": "&quot;",
    "'": "&#39;"
  }}[char]));
}}

function renderLegend(tokens) {{
  const counts = Object.fromEntries(LEVELS.map(level => [level, 0]));
  for (const token of tokens) {{
    const level = token.level || token.cefr_level || "";
    if (level) counts[level] = (counts[level] || 0) + 1;
  }}
  return LEVELS.map(level =>
    '<span class="legend-item"><span class="swatch" style="background:' + LEVEL_COLORS[level] + '"></span>' +
    level + ': ' + (counts[level] || 0) + '</span>'
  ).join(" ");
}}

function renderTokens(tokens) {{
  return tokens.map(token => {{
    const text = escapeHtml(token.text || "");
    const level = token.level || token.cefr_level || "";
    if (!level) return text;
    const tip = escapeHtml(token.tip || token.oxford_tip || "");
    const color = LEVEL_COLORS[level] || "#222";
    return '<span class="token ' + level.toLowerCase() + '" title="' + tip + '" style="color:' + color + '">' + text + '</span>';
  }}).join("");
}}

async function loadOxford() {{
  const button = document.getElementById("reload-oxford");
  const reader = document.getElementById("oxford-reader");
  const legend = document.getElementById("oxford-legend");
  button.disabled = true;
  reader.innerHTML = '<p class="status">Fetching Oxford levels from local backend...</p>';
  try {{
    const response = await fetch(API_BASE + "/api/cefr/check", {{
      method: "POST",
      headers: {{"Content-Type": "application/json"}},
      body: JSON.stringify({{paragraphs: PARAGRAPHS}})
    }});
    if (!response.ok) {{
      const text = await response.text();
      throw new Error("Backend returned " + response.status + ": " + text);
    }}
    const payload = await response.json();
    const tokens = payload.paragraphs.flatMap(paragraph => paragraph.tokens || []);
    legend.innerHTML = renderLegend(tokens);
    reader.innerHTML = renderTokens(tokens);
  }} catch (error) {{
    reader.innerHTML = '<p class="error">' + escapeHtml(error.message || String(error)) + '</p>';
  }} finally {{
    button.disabled = false;
  }}
}}

document.getElementById("reload-oxford").addEventListener("click", loadOxford);
loadOxford();
</script>
</html>
"""


def main() -> int:
    args = parse_args()
    if args.self_check:
        tokens = check_text("This abandoned ability is incandescent.")
        assert [token["level"] for token in tokens if token["text"].strip()] == ["A1", "B2", "A2", "A1", "C2", ""]
        html = render_page("Book", "Chapter", 5, ["This abandoned ability is incandescent."], tokens, args.api_base)
        assert "OLP-EN-CEFRJ Offline" in html
        assert "/api/cefr/check" in html
        print("self-check passed")
        return 0

    book = read_epub(args.book)
    chapter_title, paragraphs = first_prose_chapter(book)
    paragraphs = cap_paragraphs(paragraphs, args.max_words)
    text = "\n\n".join(paragraphs)
    olp_tokens = check_text(text)

    args.output.write_text(
        render_page(book.title, chapter_title, count_words(text), paragraphs, olp_tokens, args.api_base),
        encoding="utf-8",
    )
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
