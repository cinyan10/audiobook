# Legacy Python Prototype

This directory preserves the pre-Tauri Python implementation for reference while the desktop app is rebuilt.

Useful reference areas:

- `app/`: FastAPI backend modules for EPUB import, library persistence, CEFR jobs, dictionary lookup, audio generation, and alignment.
- `gemini_audiobook.py`: original EPUB chunking and Gemini TTS audiobook generation experiment.
- `oxford_cefr.py`: Oxford Text Checker scraping and CEFR reader rendering experiment.
- `sample-cefr-reader.html` and `sample-cefr-reader.json`: generated sample reader artifacts.
- `PRD-web-book-reader.md` and `tech-stack.md`: product and architecture notes from the prototype phase.

The Tauri app should port behavior from here gradually instead of depending on this directory as a runtime backend.
