# Repository Guidelines

## Project Structure & Module Organization
This repository currently preserves the pre-rewrite audiobook reader project under `legacy/`.

- `legacy/python/`: preserved Python prototype, FastAPI backend, scripts, tests, and sample artifacts.
- `legacy/frontend/`: preserved React + Vite web reader UI.
- `data/books/`: local source `.epub` files, ignored by Git.
- `data/audio/`: local generated audiobook assets and chunked WAV files, ignored by Git.

Keep archived code intact unless the task is explicitly about maintaining or extracting behavior from the legacy implementation.

## Build, Test, and Development Commands
Run archived commands from their new legacy directories.

- `cd legacy/frontend && bun install`
  Installs frontend dependencies.
- `cd legacy/frontend && bun run dev`
  Runs the Vite frontend only.
- `cd legacy/frontend && bun run build`
  Builds the frontend.
- `cd legacy/python && python3 gemini_audiobook.py --self-check`
  Runs the built-in chunking/audio sanity check.
- `cd legacy/python && python3 oxford_cefr.py --self-check`
  Verifies the CEFR HTML renderer without hitting Oxford.
- `cd legacy/python && python3 oxford_cefr.py my-youth-comedy.txt --output cefr-reader.html --json-output cefr-reader.json`
  Builds a local CEFR reader from a text file.

## Coding Style & Naming Conventions
Follow the existing style for each app layer:

- TypeScript/React in `legacy/frontend/`, matching the current Vite app style.
- Python in `legacy/python/`, preserving 4-space indentation, type hints where useful, and standard-library-first solutions.
- Avoid a single giant script that mixes parsing, API calls, rendering, and persistence.
- Keep comments rare and practical; explain only non-obvious behavior.

There is no formatter config yet, so match the surrounding file style exactly.

## Testing Guidelines
There is no formal test suite yet. For non-trivial logic, add the smallest runnable check that proves the behavior:

- Prefer frontend build checks for UI changes.
- Prefer `--self-check` for legacy Python script validation.
- If a standalone test file becomes necessary, use `test_*.py`.
- Keep tests deterministic and avoid network calls unless the change is specifically about integrations.

## Commit & Pull Request Guidelines
Recent history uses short, imperative commit subjects such as `Add tech stack note`. Follow that pattern.

Pull requests should include:

- a brief summary of the user-visible or pipeline change
- any new command needed to run or verify it
- sample output paths when artifacts change, such as `data/audio/...`

## Security & Configuration Tips
Do not commit `.env`. Keep API keys local, and read them from environment variables. Generated audio can be large, so avoid committing temporary artifacts unless they are intentional fixtures or examples.
