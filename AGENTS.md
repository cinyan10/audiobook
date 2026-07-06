# Repository Guidelines

## Project Structure & Module Organization
This repository is a small Python-first prototype for audiobook generation and reader experiments.

- `gemini_audiobook.py`: EPUB text extraction, chunking, and Gemini TTS audio generation.
- `oxford_cefr.py`: Oxford Text Checker scraping via `playwright-cli`, plus HTML/JSON CEFR output.
- `data/books/`: local source `.epub` files, ignored by Git.
- `data/audio/`: local generated audiobook assets and chunked WAV files, ignored by Git.
- `sample-cefr-reader.html` and `sample-cefr-reader.json`: example output artifacts.
- `PRD-web-book-reader.md` and `tech-stack.md`: product and architecture notes.

Keep new code near the script or data flow it belongs to, but do not grow one file into a catch-all. Prefer small focused modules over a monolith, for example `epub_parser.py`, `audio_pipeline.py`, or `cefr_renderer.py` when responsibilities split cleanly.

## Build, Test, and Development Commands
Use plain Python entrypoints from the repo root.

- `python3 gemini_audiobook.py --self-check`
  Runs the built-in chunking/audio sanity check.
- `python3 oxford_cefr.py --self-check`
  Verifies the CEFR HTML renderer without hitting Oxford.
- `python3 oxford_cefr.py my-youth-comedy.txt --output cefr-reader.html --json-output cefr-reader.json`
  Builds a local CEFR reader from a text file.
- `python3 gemini_audiobook.py --help`
  Shows the current audiobook pipeline options.

If you add new automation, keep it scriptable from the command line with `argparse`.

## Coding Style & Naming Conventions
Follow the existing Python style:

- 4-space indentation, type hints where useful, and standard-library-first solutions.
- `snake_case` for functions, variables, and file names.
- Small focused helpers over large classes.
- Favor multiple cohesive files with one clear responsibility each.
- Avoid a single giant script that mixes parsing, API calls, rendering, and persistence.
- Keep comments rare and practical; explain only non-obvious behavior.

There is no formatter config yet, so match the surrounding file style exactly.

## Testing Guidelines
There is no formal test suite yet. For non-trivial logic, add the smallest runnable check that proves the behavior:

- Prefer `--self-check` for script-level validation.
- If a standalone test file becomes necessary, use `test_*.py`.
- Keep tests deterministic and avoid network calls unless the change is specifically about integrations.

## Commit & Pull Request Guidelines
Recent history uses short, imperative commit subjects such as `Add tech stack note`. Follow that pattern.

Pull requests should include:

- a brief summary of the user-visible or pipeline change
- any new command needed to run or verify it
- sample output paths when artifacts change, such as `data/audio/...` or `sample-cefr-reader.html`

## Security & Configuration Tips
Do not commit `.env`. Keep API keys local, and read them from environment variables. Generated audio can be large, so avoid committing temporary artifacts unless they are intentional fixtures or examples.
