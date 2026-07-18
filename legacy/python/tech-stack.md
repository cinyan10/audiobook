# Tech Stack

## Recommended Stack

- Frontend: React + Vite + TypeScript
- Backend API: FastAPI
- Database: SQLite
- ORM: SQLModel
- Background jobs: start with plain Python CLI jobs, add a queue later only if needed
- Storage: local filesystem for `.epub`, audio, and alignment JSON
- Audio/timing pipeline: keep it in Python and reuse the direction already in [gemini_audiobook.py](gemini_audiobook.py) and [oxford_cefr.py](oxford_cefr.py)
