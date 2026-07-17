from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import uuid
from html import escape
from pathlib import Path


CHECKER_URL = "https://www.oxfordlearnersdictionaries.com/text-checker/"
CLI_TIMEOUT_SECONDS = 20
_ACTIVE_PROCESS_LOCK = threading.Lock()
_ACTIVE_PROCESSES: dict[str, list[subprocess.Popen[str]]] = {}
LEVEL_COLORS = {
    "A1": "#0069b4",
    "A2": "#c91352",
    "B1": "#b95b0b",
    "B2": "#1a873b",
    "C1": "#964db0",
    "C2": "#475569",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract Oxford Text Checker CEFR markup and build a colored HTML reader."
    )
    parser.add_argument("input", nargs="?", type=Path, help="Input text file")
    parser.add_argument("--text", help="Input text literal")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("cefr-reader.html"),
        help="Output HTML file",
    )
    parser.add_argument("--json-output", type=Path, help="Optional JSON dump of extracted tokens")
    parser.add_argument(
        "--self-check",
        action="store_true",
        help="Run a tiny parser/render check and exit.",
    )
    return parser.parse_args()


def kill_process_group(process: subprocess.Popen[str]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def cancel_active_cli(scope: str) -> None:
    with _ACTIVE_PROCESS_LOCK:
        processes = list(_ACTIVE_PROCESSES.get(scope, []))
    for process in processes:
        kill_process_group(process)


def run_cli(session: str, *args: str, raw: bool = False, scope: str | None = None) -> str:
    cmd = ["playwright-cli", f"-s={session}"]
    if raw:
        cmd.append("--raw")
    cmd.extend(args)
    process = subprocess.Popen(
        cmd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    if scope:
        with _ACTIVE_PROCESS_LOCK:
            _ACTIVE_PROCESSES.setdefault(scope, []).append(process)
    try:
        try:
            stdout, stderr = process.communicate(timeout=CLI_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired as exc:
            kill_process_group(process)
            process.communicate()
            raise RuntimeError(f"playwright-cli timed out after {CLI_TIMEOUT_SECONDS}s") from exc
    finally:
        if scope:
            with _ACTIVE_PROCESS_LOCK:
                processes = _ACTIVE_PROCESSES.get(scope, [])
                if process in processes:
                    processes.remove(process)
                if not processes:
                    _ACTIVE_PROCESSES.pop(scope, None)
    if process.returncode:
        raise RuntimeError(stderr.strip() or stdout.strip() or "playwright-cli failed")
    return stdout


def input_text(args: argparse.Namespace) -> str:
    if args.text:
        return args.text.strip()
    if args.input:
        return args.input.read_text(encoding="utf-8").strip()
    raise RuntimeError("Provide an input file or --text.")


def fetch_tokens(text: str, scope: str | None = None) -> list[dict[str, str]]:
    session = f"oxford-{uuid.uuid4().hex[:8]}"
    script = f"""
async page => {{
  await page.goto({json.dumps(CHECKER_URL)});
  const accept = page.getByRole('button', {{ name: 'I Accept' }});
  if (await accept.count()) {{
    await accept.first().click().catch(() => {{}});
  }}
  const box = page.getByRole('textbox', {{ name: 'Put your text in the box:' }});
  await box.waitFor();
  await box.fill({json.dumps(text)});
  await page.getByRole('button', {{ name: 'Check text' }}).click();
  await page.waitForURL(/\\/text-checker\\/result$/);
  await page.locator('.text-spans span').first().waitFor();
}}
"""
    extract = """
JSON.stringify(
  [...document.querySelectorAll('.text-spans span')].map((el) => {
    const match = (el.className || '').match(/(a1|a2|b1|b2|c1)(?:_ul)?/i);
    const level = match ? match[1].toUpperCase() : '';
    return {
      text: el.textContent || '',
      level,
      tip: el.getAttribute('data-tip') || '',
      className: el.className || ''
    };
  })
)
"""
    try:
        run_cli(session, "open", CHECKER_URL, scope=scope)
        run_cli(session, "run-code", script, scope=scope)
        raw = run_cli(session, "eval", extract, raw=True, scope=scope)
        parsed = json.loads(raw)
        return json.loads(parsed) if isinstance(parsed, str) else parsed
    finally:
        subprocess.run(
            ["playwright-cli", f"-s={session}", "close"],
            text=True,
            capture_output=True,
        )


def render_html(text: str, tokens: list[dict[str, str]]) -> str:
    spans: list[str] = []
    for token in tokens:
        level = token["level"]
        color = LEVEL_COLORS.get(level, "#222")
        tip = escape(token["tip"])
        content = escape(token["text"])
        spans.append(
            f'<span class="token {level.lower()}" data-tip="{tip}" title="{tip}" style="color:{color}">{content}</span>'
        )

    legend = "".join(
        f'<span class="legend-item" style="color:{color}">{level}</span>'
        for level, color in LEVEL_COLORS.items()
    )
    return f"""<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Oxford CEFR Reader</title>
<style>
:root {{
  color-scheme: light;
  font-family: Georgia, serif;
}}
body {{
  margin: 0;
  background: #f6f1e8;
  color: #222;
}}
main {{
  max-width: 860px;
  margin: 0 auto;
  padding: 40px 20px 64px;
}}
h1 {{
  margin: 0 0 8px;
  font: 700 2rem/1.1 Georgia, serif;
}}
p {{
  margin: 0 0 24px;
  color: #5a5247;
}}
.legend {{
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 24px;
  font: 700 0.95rem/1.2 system-ui, sans-serif;
}}
.reader {{
  padding: 28px;
  border-radius: 18px;
  background: rgba(255,255,255,0.8);
  box-shadow: 0 18px 50px rgba(80, 56, 24, 0.12);
  font-size: 1.35rem;
  line-height: 1.9;
  white-space: pre-wrap;
}}
.token {{
  transition: background-color 0.15s ease;
}}
.token:hover {{
  background: rgba(0,0,0,0.08);
}}
.source {{
  margin-top: 18px;
  font: 0.9rem/1.4 system-ui, sans-serif;
}}
</style>
<main>
  <h1>Oxford CEFR Reader</h1>
  <p>Colored with Oxford Text Checker output. Hover a word to see the part of speech and CEFR tag Oxford returned.</p>
  <div class="legend">{legend}</div>
  <div class="reader">{''.join(spans)}</div>
  <div class="source">Source text length: {len(text)} characters.</div>
</main>
</html>
"""


def main() -> int:
    args = parse_args()

    if args.self_check:
        sample = [
            {"text": "This", "level": "A1", "tip": "det=A1", "className": "a1"},
            {"text": " ", "level": "", "tip": "", "className": ""},
            {"text": "works", "level": "B1", "tip": "v=B1", "className": "b1"},
        ]
        html = render_html("This works", sample)
        assert "det=A1" in html
        assert "color:#0069b4" in html
        assert "This works" not in html
        print("self-check passed")
        return 0

    text = input_text(args)
    if not text:
        raise RuntimeError("Input text is empty.")

    tokens = fetch_tokens(text)
    args.output.write_text(render_html(text, tokens), encoding="utf-8")
    if args.json_output:
        args.json_output.write_text(json.dumps(tokens, indent=2), encoding="utf-8")
    print(args.output)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(1)
