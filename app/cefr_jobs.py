from __future__ import annotations

import threading
from pathlib import Path

from app.db import DB_PATH, get_connection
from app.library import enrich_book_part_cefr, get_cefr_job_status, next_pending_cefr_part, start_cefr_job, update_cefr_job_progress


class CEFRBatchRunner:
    def __init__(self, db_path: Path = DB_PATH) -> None:
        self.db_path = db_path
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    def start(self) -> dict[str, object]:
        with self._lock:
            if self._thread and self._thread.is_alive():
                with get_connection(self.db_path) as connection:
                    return get_cefr_job_status(connection)

            with get_connection(self.db_path) as connection:
                job = start_cefr_job(connection)
                if job["status"] != "running":
                    return job
                job_id = int(job["id"])

            self._thread = threading.Thread(target=self._run, args=(job_id,), daemon=True)
            self._thread.start()

        with get_connection(self.db_path) as connection:
            return get_cefr_job_status(connection)

    def status(self) -> dict[str, object]:
        with get_connection(self.db_path) as connection:
            return get_cefr_job_status(connection)

    def _run(self, job_id: int) -> None:
        while True:
            with get_connection(self.db_path) as connection:
                target = next_pending_cefr_part(connection)
                if target is None:
                    update_cefr_job_progress(connection, job_id, status="complete", finished=True)
                    return
                book_id, part_index, label = target
                update_cefr_job_progress(connection, job_id, current_label=label)

            with get_connection(self.db_path) as connection:
                try:
                    enrich_book_part_cefr(connection, book_id, part_index)
                except Exception as exc:
                    update_cefr_job_progress(connection, job_id, error_message=str(exc))
                else:
                    update_cefr_job_progress(connection, job_id)
