# Product Requirements Document

## Product

Web Book Reader

## Goal

Build a single project that includes both:

- a web-based book reader for learners
- a backend pipeline that generates high-quality book audio and timing metadata

The first version is a local app that runs on a user's own machine for their personal use.

The product helps learners read English books with optional audio playback, Oxford CEFR word coloring, and word-level playback highlighting.

## Primary User Value

- Read books in a clean browser reader
- Play high-quality generated audio while reading
- See word difficulty by CEFR level
- Follow the currently spoken word during playback
- Jump back into books quickly from recent history

## Scope

### In Scope

- Web reader UI
- Book library page
- Read history and last-read ordering
- Reading with or without audio files
- Audio playback controls
- Word CEFR tier lookup using Oxford-derived data
- Current-word highlight during audio playback
- Word actions for dictionary lookup and marking
- Backend pipeline inside this project to generate high-quality audio playback files for books

### Out of Scope For V1

- User accounts and multi-device sync
- Hosted multi-user deployment
- Mobile apps
- Social features
- Notes sharing
- Full annotation system beyond simple mark/highlight
- Manual audio editing UI

## Users

### Primary User

An English learner running the app locally on their own machine, reading books in the browser, sometimes with audio and sometimes silently.

## Core User Stories

- As a reader, I want to see my books ordered by last read so I can continue quickly.
- As a reader, I want to open a book and read it even if audio has not been generated yet.
- As a reader, I want to play book audio and see the current spoken word highlighted.
- As a reader, I want CEFR-colored words so I can judge difficulty while reading.
- As a reader, I want to double-click a word to open its Oxford definition.
- As a reader, I want to press Space to show a tooltip with the currently selected word's Oxford definition.
- As a reader, I want to right-click a word to mark or highlight it for later review.
- As a reader, I want playback skip controls that feel natural for reading.
- As an operator, I want this project to generate high-quality audio playback assets for books.

## Functional Requirements

### 1. Library

- The main page must show a list of books.
- Books must be ordered by `last_read_at` descending by default.
- Each book entry must show at least:
  - title
  - author if available
  - reading progress
  - whether audio is available
- The user must be able to open a book from the library.

### 2. Reader

- The reader must display the book text in a readable long-form layout.
- The reader must support reading when no audio file exists.
- The reader must preserve paragraph and sentence structure from the source text.
- The reader must render words as individually addressable tokens when CEFR or playback metadata exists.
- The reader must support keyboard word actions for the current text selection.

### 3. Word Difficulty

- The system must store a CEFR tier per word token when available from Oxford-derived processing.
- Supported visible tiers for V1:
  - A1
  - A2
  - B1
  - B2
  - C1
- Words without a known tier must still render normally.
- Hover or focus on a word may show Oxford metadata such as part of speech and CEFR note when available.

### 4. Word Actions

- Double-clicking a word must open its Oxford definition page.
- Pressing `Space` with a single word selected must show a tooltip with that word's Oxford definition.
- The tooltip should appear near the selected word and dismiss on `Escape`, selection change, or clicking elsewhere.
- Right-clicking a word must open a contextual action menu.
- The context menu must support:
  - highlight word
  - mark word
- Highlighted or marked words must persist for that book.

### 5. Audio Playback

- The reader must support playback of generated audio files when available.
- The reader must support:
  - play
  - pause
  - seek
  - skip forward 10 seconds
  - skip backward 10 seconds
- Skip forward and backward should snap to the nearest sentence start rather than landing at an arbitrary timestamp.
- If no sentence anchor is found in a small nearby range, the system may fall back to exact time seeking.

### 6. Current Word Highlight

- During audio playback, the currently spoken word must be highlighted in the reader.
- Highlight must update smoothly enough to feel word-synced.
- Current-word highlight must coexist with CEFR coloring.
- Clicking a word with timing metadata may seek playback to that word.

### 7. History

- The system must track per-book reading history.
- At minimum, history must store:
  - last opened time
  - last read location
  - last playback position if audio was used
- The library ordering must use the most recent reading activity.

### 8. Backend Audio Generation

- The backend must be part of this project.
- The backend must accept a book source text and generate high-quality audio playback files.
- The backend must support chunked generation for long books.
- The backend must produce:
  - final playback audio
  - alignment metadata for word highlighting
  - sentence timing metadata for sentence snapping
- The backend should allow regeneration if audio generation fails for some chunks.
- The backend should be usable without requiring a separate manually managed project.

### 9. Alignment and Timing

- After audio generation, the system must run one alignment step to assign start and end times to spoken words.
- The alignment output must map back to the exact displayed reader tokens.
- Punctuation and whitespace do not need independent timing, but must preserve display order.
- Sentence start anchors must be generated from the aligned transcript.

## Data Requirements

### Book

- `id`
- `title`
- `author`
- `source_text_path` or equivalent source reference
- `audio_path` if available
- `created_at`
- `updated_at`

### Reading Progress

- `book_id`
- `last_read_at`
- `last_token_index` or equivalent reading location
- `last_audio_time`

### Token Metadata

- `book_id`
- `token_index`
- `text`
- `normalized_text`
- `cefr_level`
- `oxford_tip`
- `is_marked`
- `is_highlighted`
- `start_time`
- `end_time`
- `sentence_id`

## Non-Functional Requirements

- The first version must run locally on a user's machine without requiring a hosted backend.
- Reader should load fast for a normal-length book.
- Playback and current-word highlighting should feel responsive.
- The product must remain usable without audio assets.
- The UI should work on desktop first and remain usable on mobile browsers.
- The system should degrade safely when Oxford or alignment metadata is missing.

## UX Notes

- The main reading surface should prioritize text readability over dashboards or chrome.
- CEFR colors should remain readable and not fight with the active playback highlight.
- The active spoken word should be visually obvious but not distracting.
- Sentence snapping should feel helpful rather than surprising.

## Suggested V1 Delivery

### Phase 1

- Import books
- Show library ordered by last read
- Open and read a book without audio
- Render Oxford CEFR colors

### Phase 2

- Generate audio for books
- Add playback controls
- Save reading history and playback position

### Phase 3

- Add alignment metadata
- Highlight current spoken word
- Add sentence-snapped skip back and skip forward

### Phase 4

- Add word marking and highlighting
- Add Oxford double-click dictionary lookup

## Success Criteria

- A user can open a book and continue from recent history.
- A user can read the same book with or without audio.
- A user can play generated audio and see the currently spoken word highlighted.
- A user can identify word difficulty from CEFR coloring.
- A user can jump to Oxford definitions and mark words for later review.
- A developer or operator can generate high-quality audio for a book from within this project.

## Open Questions

- Should marks and highlights be per user only, or shared across all local usage?
- Should Oxford definitions open in a new tab, side panel, or external page?
- Should marked words later feed a saved vocabulary list?
- Should sentence snapping prefer the previous sentence start, the nearest one, or the next one?
- Should books be plain text only in V1, or should EPUB import be part of the product surface?

## Assumptions

- The first release is a personal local-use app, not a shared cloud product.
- High-quality audio generation belongs inside this project rather than in an external companion service.
- Audio quality should continue to come from the generation pipeline rather than browser TTS.
- Word-level highlighting will depend on a post-generation alignment step.
- Oxford CEFR data is derived during preprocessing and stored locally for reader use.
