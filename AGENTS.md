# Repository Guidelines

## Project Structure & Module Organization
This repository now builds the active desktop reader as a Tauri app at the repository root. Unless a task explicitly mentions `legacy/`, assume all requested changes apply to the new Tauri app.

- `src/`: active React + TypeScript reader UI.
- `src/components/ui/`: local shadcn-style UI primitives.
- `src/lib/`: frontend command/API helpers and utilities.
- `src-tauri/`: active Rust backend, Tauri configuration, SQLite persistence, EPUB parsing, and desktop bundling.
- `src-tauri/src/`: Rust command handlers, storage, EPUB extraction, and shared models.
- `dist/`: generated Vite build output, ignored by Git.
- `src-tauri/target/`: generated Rust/Tauri build output, ignored by Git.
- `legacy/python/`: preserved Python prototype, FastAPI backend, scripts, tests, and sample artifacts.
- `legacy/frontend/`: preserved React + Vite web reader UI.
- `data/books/`: local source `.epub` files, ignored by Git.
- `data/audio/`: local generated audiobook assets and chunked WAV files, ignored by Git.

Keep archived code intact unless the task is explicitly about maintaining, comparing, or extracting behavior from the legacy implementation.

## Build, Test, and Development Commands
Use the root commands for the active Tauri app.

- `bun install`
  Installs frontend and Tauri CLI dependencies.
- `bun run dev`
  Runs the Vite frontend only.
- `bun run build`
  Type-checks and builds the frontend.
- `bun run tauri:dev`
  Runs the full desktop app in development.
- `bun run tauri:build`
  Builds the frontend, Rust backend, and macOS `.app` bundle.
- `cd src-tauri && cargo check`
  Checks Rust code and Tauri configuration.
- `cd src-tauri && cargo test`
  Runs Rust unit tests.

Legacy commands should only be used when the task explicitly targets `legacy/`.

- `cd legacy/frontend && bun run build`
  Builds the archived web frontend.
- `cd legacy/python && python3 gemini_audiobook.py --self-check`
  Runs the built-in chunking/audio sanity check.
- `cd legacy/python && python3 oxford_cefr.py --self-check`
  Verifies the CEFR HTML renderer without hitting Oxford.
- `cd legacy/python && python3 oxford_cefr.py my-youth-comedy.txt --output cefr-reader.html --json-output cefr-reader.json`
  Builds a local CEFR reader from a text file.

## Coding Style & Naming Conventions
Follow the existing style for each app layer:

- TypeScript/React in `src/`, using functional components, strict types, local shadcn-style primitives, semantic Tailwind tokens, and `@/` imports.
- Rust in `src-tauri/src/`, keeping Tauri commands thin and pushing parsing/persistence into focused modules.
- Python in `legacy/python/` only for legacy work, preserving 4-space indentation, type hints where useful, and standard-library-first solutions.
- Avoid a single giant script that mixes parsing, API calls, rendering, and persistence.
- Keep comments rare and practical; explain only non-obvious behavior.

There is no formatter config yet, so match the surrounding file style exactly. Do not port new behavior into `legacy/` unless asked.

## Testing Guidelines
For non-trivial logic, add the smallest runnable check that proves the behavior:

- Prefer `bun run build` for frontend UI/type changes.
- Prefer `cd src-tauri && cargo test` for Rust parsing, storage, and command-adjacent logic.
- Prefer `bun run tauri:build` when changes affect Tauri configuration, Rust command registration, app assets, or bundling.
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
