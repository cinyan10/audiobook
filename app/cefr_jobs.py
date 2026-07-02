from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Callable

from uvicorn.logging import DefaultFormatter

from app.db import DB_PATH, get_connection
from app.library import enrich_book_part_cefr, get_cefr_job_status, next_pending_cefr_part, start_cefr_job, update_cefr_job_progress

JobListener = Callable[[dict[str, object]], None]
logger = logging.getLogger("uvicorn.error")


def configure_worker_logger() -> None:
    formatter = DefaultFormatter("%(asctime)s %(levelprefix)s %(message)s", "%H:%M:%S", use_colors=True)
    for name in ("uvicorn", "uvicorn.error"):
        for handler in logging.getLogger(name).handlers:
            handler.setFormatter(formatter)


class CEFRBatchRunner:
    def __init__(self, db_path: Path = DB_PATH) -> None:
        self.db_path = db_path
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._listeners: list[JobListener] = []

    def start(self, book_id: int | None = None) -> dict[str, object]:
        with self._lock:
            if self._thread and self._thread.is_alive():
                with get_connection(self.db_path) as connection:
                    return get_cefr_job_status(connection)

            with get_connection(self.db_path) as connection:
                job = start_cefr_job(connection, book_id)
                if job["status"] != "running":
                    return job
                job_id = int(job["id"])

            self._thread = threading.Thread(target=self._run, args=(job_id, book_id), daemon=True)
            self._thread.start()

        with get_connection(self.db_path) as connection:
            job = get_cefr_job_status(connection)
        self._notify(job)
        return job

    def status(self) -> dict[str, object]:
        with get_connection(self.db_path) as connection:
            return get_cefr_job_status(connection)

    def add_listener(self, listener: JobListener) -> None:
        with self._lock:
            self._listeners.append(listener)

    def remove_listener(self, listener: JobListener) -> None:
        with self._lock:
            if listener in self._listeners:
                self._listeners.remove(listener)

    def _notify(self, job: dict[str, object]) -> None:
        with self._lock:
            listeners = list(self._listeners)
        for listener in listeners:
            listener(job)

    def _run(self, job_id: int, book_id: int | None = None) -> None:
        while True:
            configure_worker_logger()
            with get_connection(self.db_path) as connection:
                target = next_pending_cefr_part(connection, book_id)
                if target is None:
                    update_cefr_job_progress(connection, job_id, status="complete", finished=True)
                    self._notify(get_cefr_job_status(connection))
                    return
                target_book_id, part_index, label = target
                started = time.perf_counter()
                logger.info("CEFR checking book %s: %s", target_book_id, label)
                update_cefr_job_progress(connection, job_id, current_label=label)
                self._notify(get_cefr_job_status(connection))

            with get_connection(self.db_path) as connection:
                try:
                    enrich_book_part_cefr(connection, target_book_id, part_index)
                except Exception as exc:
                    elapsed = time.perf_counter() - started
                    logger.info("CEFR failed book %s after %.1fs: %s", target_book_id, elapsed, exc)
                    update_cefr_job_progress(connection, job_id, error_message=str(exc))
                else:
                    elapsed = time.perf_counter() - started
                    logger.info("CEFR finished book %s in %.1fs: %s", target_book_id, elapsed, label)
                    update_cefr_job_progress(connection, job_id)
                self._notify(get_cefr_job_status(connection))
