import { useEffect, useRef, useState, type ChangeEvent } from "react";

type BookSummary = {
  id: number;
  title: string;
  author: string;
  has_cefr: boolean;
  cefr_status: string;
  cefr_ready_parts: number;
  cefr_total_parts: number;
  progress_percent: number;
  progress_label: string;
  last_read_at: string | null;
};

type TokenRecord = {
  token_index: number;
  text: string;
  normalized_text: string;
  cefr_level: string | null;
  oxford_tip: string | null;
};

type ParagraphRecord = {
  paragraph_index: number;
  text: string;
  tokens: TokenRecord[];
};

type ImageRecord = {
  src: string;
  alt: string;
};

type ChapterBlock =
  | { kind: "paragraph"; paragraph: ParagraphRecord; image?: never }
  | { kind: "image"; image: ImageRecord; paragraph?: never };

type CEFRSummary = {
  status: string;
  ready_parts: number;
  total_parts: number;
};

type CEFRPartRecord = {
  part_index: number;
  start_paragraph_index: number;
  end_paragraph_index: number;
  status: string;
};

type ChapterPartRecord = {
  part_index: number;
  title: string;
  start_paragraph_index: number;
  end_paragraph_index: number;
};

type ChapterRecord = {
  chapter_index: number;
  title: string;
  start_paragraph_index: number;
  end_paragraph_index: number;
  parts: ChapterPartRecord[];
};

type ReaderPayload = {
  id: number;
  title: string;
  author: string;
  cefr_status: string;
  cefr: CEFRSummary;
  chapters: ChapterRecord[];
  cefr_parts: CEFRPartRecord[];
  progress: {
    last_read_at: string | null;
    last_paragraph_index: number;
    last_token_index: number | null;
    percent: number;
  };
  total_paragraphs: number;
};

type ChapterPayload = {
  book_id: number;
  chapter_index: number;
  title: string;
  blocks: ChapterBlock[];
};

type CEFRPartLoadSummary = {
  book_id: number;
  part_index: number;
  status: string;
  paragraphs: ParagraphRecord[];
  cefr: CEFRSummary;
};

type ScanSummary = {
  imported: number;
  updated: number;
  skipped: number;
  books: BookSummary[];
};

type CEFRJobSummary = {
  id: number | null;
  status: string;
  total_parts: number;
  completed_parts: number;
  ready_parts: number;
  current_label: string | null;
  error_message: string | null;
};

type ViewState = { kind: "library" } | { kind: "reader"; bookId: number };

const LEVEL_LABELS = ["A1", "A2", "B1", "B2", "C1"] as const;

function App() {
  const [view, setView] = useState<ViewState>(readLocation());

  useEffect(() => {
    migrateHashRoute();
    const onPopState = () => setView(readLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return (
    <div className="shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />
      {view.kind === "library" ? (
        <LibraryPage onOpenBook={(bookId) => navigateToBook(bookId)} />
      ) : (
        <ReaderPage bookId={view.bookId} onBack={() => navigateToLibrary()} />
      )}
    </div>
  );
}

function LibraryPage({ onOpenBook }: { onOpenBook: (bookId: number) => void }) {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [job, setJob] = useState<CEFRJobSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"scan" | "upload" | "initialize" | null>(null);
  const [lastScan, setLastScan] = useState<ScanSummary | null>(null);

  const loadBooks = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/books");
      if (!response.ok) {
        throw new Error(`Failed to load books (${response.status})`);
      }
      setBooks((await response.json()) as BookSummary[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load books.");
    } finally {
      setLoading(false);
    }
  };

  const loadJob = async () => {
    try {
      const response = await fetch("/api/cefr/initialize");
      if (!response.ok) {
        throw new Error(`Failed to load initialize status (${response.status})`);
      }
      setJob((await response.json()) as CEFRJobSummary);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load initialize status.");
    }
  };

  useEffect(() => {
    void loadBooks();
    void loadJob();
  }, []);

  useEffect(() => {
    if (job?.status !== "running") {
      return;
    }
    const interval = window.setInterval(() => {
      void loadJob();
      void loadBooks();
    }, 1500);
    return () => window.clearInterval(interval);
  }, [job?.status]);

  const handleScan = async () => {
    setBusyAction("scan");
    setError(null);
    try {
      const response = await fetch("/api/books/scan", { method: "POST" });
      if (!response.ok) {
        throw new Error(`Scan failed (${response.status})`);
      }
      const summary = (await response.json()) as ScanSummary;
      setLastScan(summary);
      setBooks(summary.books);
      await loadJob();
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "Scan failed.");
    } finally {
      setBusyAction(null);
    }
  };

  const handleInitialize = async () => {
    setBusyAction("initialize");
    setError(null);
    try {
      const response = await fetch("/api/cefr/initialize", { method: "POST" });
      if (!response.ok) {
        throw new Error(`Initialize failed (${response.status})`);
      }
      setJob((await response.json()) as CEFRJobSummary);
      await loadBooks();
    } catch (initializeError) {
      setError(initializeError instanceof Error ? initializeError.message : "Initialize failed.");
    } finally {
      setBusyAction(null);
    }
  };

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const formData = new FormData();
    formData.append("file", file);
    setBusyAction("upload");
    setError(null);
    try {
      const response = await fetch("/api/books/upload", { method: "POST", body: formData });
      if (!response.ok) {
        throw new Error(`Upload failed (${response.status})`);
      }
      await response.json();
      await loadBooks();
      await loadJob();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed.");
    } finally {
      setBusyAction(null);
      event.target.value = "";
    }
  };

  const ringTotal = job?.total_parts ?? 0;
  const ringReady = job?.ready_parts ?? 0;
  const ringPercent = ringTotal ? (ringReady / ringTotal) * 100 : 0;

  return (
    <main className="page">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Phase 1 Reader</p>
          <h1>Read first, paint CEFR later.</h1>
          <p className="lede">
            The reader opens with plain text immediately, then fills in Oxford CEFR by the current
            section or with a full-library initialize pass.
          </p>
        </div>
        <div className="hero-panel">
          <div className="hero-actions">
            <button className="primary-button" onClick={() => void handleScan()} disabled={busyAction !== null}>
              {busyAction === "scan" ? "Refreshing..." : "Refresh Library"}
            </button>
            <label className="upload-button">
              <input type="file" accept=".epub,application/epub+zip" onChange={handleUpload} disabled={busyAction !== null} />
              {busyAction === "upload" ? "Uploading..." : "Upload EPUB"}
            </label>
          </div>
          <div className="initialize-card">
            <ProgressRing percent={ringPercent} label={`${ringReady}/${ringTotal || 0}`} />
            <div className="initialize-copy">
              <strong>Initialize CEFR</strong>
              <span>{job?.current_label || "Batch process the full library in the background."}</span>
              <span>{renderJobStatus(job)}</span>
            </div>
            <button
              className="secondary-button"
              onClick={() => void handleInitialize()}
              disabled={busyAction !== null || job?.status === "running"}
            >
              {job?.status === "running" ? "Initializing..." : "Initialize"}
            </button>
          </div>
          <div className="status-card">
            <span>{books.length} books indexed</span>
            <span>{books.reduce((sum, book) => sum + book.cefr_ready_parts, 0)} ready parts</span>
            <span>{books.reduce((sum, book) => sum + book.cefr_total_parts, 0)} total parts</span>
          </div>
          {lastScan ? (
            <p className="scan-note">
              Last refresh: {lastScan.imported} imported, {lastScan.updated} updated, {lastScan.skipped} unchanged.
            </p>
          ) : null}
        </div>
      </section>

      <section className="legend-strip" aria-label="CEFR legend">
        {LEVEL_LABELS.map((level) => (
          <span key={level} className={`legend-pill level-${level.toLowerCase()}`}>
            {level}
          </span>
        ))}
      </section>

      {error ? <p className="error-banner">{error}</p> : null}

      <section className="library-section">
        <div className="section-header">
          <h2>Recent books</h2>
          <span>{loading ? "Loading..." : `${books.length} ready to read`}</span>
        </div>
        <div className="book-grid">
          {books.map((book) => (
            <article key={book.id} className="book-card">
              <div className="book-meta">
                <p className="book-author">{book.author || "Unknown author"}</p>
                <button className="book-link" onClick={() => onOpenBook(book.id)}>
                  {book.title}
                </button>
              </div>
              <p className="progress-label">{book.progress_label}</p>
              <div className="progress-bar" aria-hidden="true">
                <span style={{ width: `${Math.max(book.progress_percent, 4)}%` }} />
              </div>
              <div className="card-footer">
                <span className={`cefr-badge ${book.has_cefr ? "ready" : "missing"}`}>
                  {book.cefr_ready_parts}/{book.cefr_total_parts || 0} CEFR parts
                </span>
                <span>{formatTimestamp(book.last_read_at)}</span>
              </div>
            </article>
          ))}
          {!loading && books.length === 0 ? (
            <article className="empty-state">
              <h3>No books yet</h3>
              <p>Drop an EPUB into the local books folder or upload one here, then refresh the library.</p>
            </article>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function ReaderPage({ bookId, onBack }: { bookId: number; onBack: () => void }) {
  const [book, setBook] = useState<ReaderPayload | null>(null);
  const [chapterCache, setChapterCache] = useState<Record<number, ChapterBlock[]>>({});
  const [selectedChapterIndex, setSelectedChapterIndex] = useState<number>(0);
  const [selectedPartIndex, setSelectedPartIndex] = useState<number | null>(null);
  const [dialogImage, setDialogImage] = useState<ImageRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingChapter, setLoadingChapter] = useState(false);
  const [loadingPartIndex, setLoadingPartIndex] = useState<number | null>(null);
  const chapterParagraphsRef = useRef<ParagraphRecord[]>([]);
  const paragraphRefs = useRef<Array<HTMLElement | null>>([]);
  const saveTimeoutRef = useRef<number | null>(null);
  const lastSavedRef = useRef<number>(-1);
  const lastScrollTargetRef = useRef<string>("");
  const requestedPartsRef = useRef<Set<number>>(new Set());
  const shouldRestoreScrollRef = useRef<boolean>(false);

  const currentChapter = book?.chapters[selectedChapterIndex] ?? null;
  const currentBlocks = chapterCache[selectedChapterIndex] ?? [];
  const visibleBlocks =
    selectedPartIndex !== null && currentChapter?.parts[selectedPartIndex]
      ? filterBlocksForPart(currentBlocks, currentChapter.parts[selectedPartIndex])
      : currentBlocks;
  const currentParagraphs = visibleBlocks.flatMap((block) => (block.kind === "paragraph" ? [block.paragraph] : []));
  const currentChapterWordCounts = currentChapter && chapterCache[selectedChapterIndex] ? countWordsByPart(currentBlocks, currentChapter.parts) : null;
  const currentPartWordCount =
    currentChapterWordCounts && selectedPartIndex !== null ? currentChapterWordCounts[selectedPartIndex] ?? 0 : null;
  const isImageOnlyView = visibleBlocks.length > 0 && visibleBlocks.every((block) => block.kind === "image");
  const scrollTargetKey = `${selectedChapterIndex}:${selectedPartIndex ?? "all"}`;

  useEffect(() => {
    chapterParagraphsRef.current = currentParagraphs;
  }, [currentParagraphs]);

  useEffect(() => {
    if (!dialogImage) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDialogImage(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialogImage]);

  useEffect(() => {
    let active = true;
    const loadBook = async () => {
      setLoading(true);
      setError(null);
      requestedPartsRef.current.clear();
      setChapterCache({});
      try {
        const response = await fetch(`/api/books/${bookId}`);
        if (!response.ok) {
          throw new Error(`Failed to load book (${response.status})`);
        }
        const nextBook = (await response.json()) as ReaderPayload;
        if (!active) {
          return;
        }
        const initialChapterIndex = findChapterIndex(nextBook.chapters, nextBook.progress.last_paragraph_index);
        const initialChapter = nextBook.chapters[initialChapterIndex] ?? null;
        shouldRestoreScrollRef.current = true;
        lastSavedRef.current = nextBook.progress.last_paragraph_index;
        setSelectedChapterIndex(initialChapterIndex);
        setSelectedPartIndex(initialChapter ? findPartIndex(initialChapter.parts, nextBook.progress.last_paragraph_index) : null);
        setBook(nextBook);
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load book.");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };
    void loadBook();
    return () => {
      active = false;
    };
  }, [bookId]);

  useEffect(() => {
    if (!book || chapterCache[selectedChapterIndex]) {
      return;
    }
    let active = true;
    const loadChapter = async () => {
      setLoadingChapter(true);
      try {
        const response = await fetch(`/api/books/${book.id}/chapters/${selectedChapterIndex}`);
        if (!response.ok) {
          throw new Error(`Failed to load chapter (${response.status})`);
        }
        const payload = (await response.json()) as ChapterPayload;
        if (active) {
          setChapterCache((current) => ({ ...current, [payload.chapter_index]: payload.blocks }));
        }
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load chapter.");
        }
      } finally {
        if (active) {
          setLoadingChapter(false);
        }
      }
    };
    void loadChapter();
    return () => {
      active = false;
    };
  }, [book, selectedChapterIndex, chapterCache]);

  const ensurePartLoaded = async (currentBook: ReaderPayload, paragraphIndex: number) => {
    const part = currentBook.cefr_parts.find(
      (item) => paragraphIndex >= item.start_paragraph_index && paragraphIndex <= item.end_paragraph_index,
    );
    if (!part || part.status === "ready" || part.status === "error" || part.status === "loading" || requestedPartsRef.current.has(part.part_index)) {
      return;
    }
    requestedPartsRef.current.add(part.part_index);
    setLoadingPartIndex(part.part_index);
    setBook((current) =>
      current
        ? {
            ...current,
            cefr_parts: current.cefr_parts.map((item) =>
              item.part_index === part.part_index ? { ...item, status: "loading" } : item,
            ),
          }
        : current,
    );
    await loadPart(currentBook.id, part.part_index);
  };

  const loadPart = async (currentBookId: number, partIndex: number) => {
    try {
      const response = await fetch(`/api/books/${currentBookId}/cefr-parts/${partIndex}/load`, { method: "POST" });
      if (!response.ok) {
        throw new Error(`Failed to load CEFR part (${response.status})`);
      }
      const payload = (await response.json()) as CEFRPartLoadSummary;
      setBook((current) => mergePartSummary(current, payload));
      setChapterCache((current) => mergePartIntoChapters(current, payload));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load CEFR part.");
    } finally {
      requestedPartsRef.current.delete(partIndex);
      setLoadingPartIndex((current) => (current === partIndex ? null : current));
    }
  };

  useEffect(() => {
    if (!book || !currentChapter) {
      return;
    }
    if (lastScrollTargetRef.current === scrollTargetKey) {
      return;
    }
    if (!currentParagraphs.length) {
      if (!currentBlocks.length) {
        return;
      }
      window.scrollTo({ top: 0, behavior: "auto" });
      lastScrollTargetRef.current = scrollTargetKey;
      shouldRestoreScrollRef.current = false;
      return;
    }
    lastScrollTargetRef.current = scrollTargetKey;
    if (shouldRestoreScrollRef.current) {
      const targetIndex = currentParagraphs.findIndex(
        (paragraph) => paragraph.paragraph_index === book.progress.last_paragraph_index,
      );
      const target = targetIndex >= 0 ? paragraphRefs.current[targetIndex] : null;
      if (target) {
        window.scrollTo({ top: Math.max(target.offsetTop - 120, 0), behavior: "auto" });
      } else {
        window.scrollTo({ top: 0, behavior: "auto" });
      }
      shouldRestoreScrollRef.current = false;
    } else {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
    void ensurePartLoaded(book, currentChapter.start_paragraph_index);
  }, [book, currentChapter, currentParagraphs, scrollTargetKey]);

  useEffect(() => {
    if (!book || !currentParagraphs.length) {
      return;
    }

    const detectParagraph = () => {
      const firstVisible = paragraphRefs.current.findIndex((paragraph) => {
        if (!paragraph) {
          return false;
        }
        const bounds = paragraph.getBoundingClientRect();
        return bounds.top <= 220 && bounds.bottom >= 120;
      });
      if (firstVisible === -1) {
        return;
      }
      const absoluteParagraphIndex = chapterParagraphsRef.current[firstVisible]?.paragraph_index;
      if (absoluteParagraphIndex === undefined) {
        return;
      }
      void ensurePartLoaded(book, absoluteParagraphIndex);
      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current);
      }
      saveTimeoutRef.current = window.setTimeout(() => {
        if (lastSavedRef.current === absoluteParagraphIndex) {
          return;
        }
        void postProgress(book.id, absoluteParagraphIndex, null).then(() => {
          lastSavedRef.current = absoluteParagraphIndex;
          setBook((current) =>
            current
              ? {
                  ...current,
                  progress: {
                    ...current.progress,
                    last_paragraph_index: absoluteParagraphIndex,
                    percent: current.total_paragraphs
                      ? Number(((absoluteParagraphIndex / current.total_paragraphs) * 100).toFixed(1))
                      : 0,
                  },
                }
              : current,
          );
        });
      }, 250);
    };

    window.addEventListener("scroll", detectParagraph, { passive: true });
    detectParagraph();
    return () => {
      window.removeEventListener("scroll", detectParagraph);
      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [book, currentParagraphs]);

  useEffect(() => {
    if (!book || dialogImage) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) {
        return;
      }
      const key = event.key.toLowerCase();
      if (!["w", "a", "s", "d"].includes(key)) {
        return;
      }

      event.preventDefault();

      if (key === "w" || key === "s") {
        const direction = key === "w" ? -1 : 1;
        window.scrollBy({ top: direction * 160, behavior: "smooth" });
        return;
      }

      if (key === "a" && !isNearTop()) {
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }

      const nextPartTarget = findAdjacentPart(book.chapters, selectedChapterIndex, selectedPartIndex, key === "a" ? -1 : 1);
      if (!nextPartTarget) {
        return;
      }

      shouldRestoreScrollRef.current = false;
      setSelectedChapterIndex(nextPartTarget.chapterIndex);
      setSelectedPartIndex(nextPartTarget.partIndex);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [book, dialogImage, selectedChapterIndex, selectedPartIndex]);

  const progressLabel = book ? `${book.progress.percent.toFixed(1)}%` : "0.0%";

  return (
    <main className="reader-shell">
      <nav className="reader-header" aria-label="Reader navigation">
        <button className="back-link" onClick={onBack}>
          Home
        </button>
        <div className="reader-title-block">
          <h1>{loading ? "Loading..." : book?.title}</h1>
        </div>
        <div className="reader-progress" aria-label={`Reading progress ${progressLabel}`}>
          <ProgressRing percent={book?.progress.percent ?? 0} label={progressLabel} />
          <span>{progressLabel}</span>
        </div>
      </nav>

      {error ? <p className="error-banner">{error}</p> : null}

      {!loading && book ? (
        <div className="reader-frame">
          <aside className="chapter-sidebar">
            <nav className="chapter-list" aria-label="Book chapters">
              {book.chapters.map((chapter) => (
                <div key={chapter.chapter_index} className="chapter-item">
                  <button
                    className={`chapter-link ${chapter.chapter_index === selectedChapterIndex ? "active" : ""}`}
                    onClick={() => {
                      shouldRestoreScrollRef.current = false;
                      setSelectedChapterIndex(chapter.chapter_index);
                      setSelectedPartIndex(chapter.parts.length ? chapter.parts[0].part_index : null);
                    }}
                  >
                    {chapter.title}
                  </button>
                  {chapter.chapter_index === selectedChapterIndex && chapter.parts.length > 1 ? (
                    <div className="chapter-part-list">
                      {chapter.parts.map((part) => (
                        <button
                          key={`${chapter.chapter_index}-${part.part_index}`}
                          className={`chapter-part-link ${
                            chapter.chapter_index === selectedChapterIndex && part.part_index === selectedPartIndex ? "active" : ""
                          }`}
                          onClick={() => {
                            shouldRestoreScrollRef.current = false;
                            setSelectedChapterIndex(chapter.chapter_index);
                            setSelectedPartIndex(part.part_index);
                          }}
                        >
                          {part.title}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </nav>
          </aside>

          <div className="reader-layout">
            <article className={`reader-paper ${isImageOnlyView ? "reader-paper-image-only" : ""}`}>
              <div className="reader-legend">
                {LEVEL_LABELS.map((level) => (
                  <span key={level} className={`legend-pill level-${level.toLowerCase()}`}>
                    {level}
                  </span>
                ))}
                <span className="legend-pill neutral">
                  {book.cefr.ready_parts}/{book.cefr.total_parts || 0} CEFR parts ready
                </span>
                {currentPartWordCount !== null ? <span className="legend-pill neutral">{currentPartWordCount} words</span> : null}
                {loadingChapter ? <span className="legend-pill neutral">Loading chapter...</span> : null}
                {loadingPartIndex !== null ? <span className="legend-pill neutral">Loading current section...</span> : null}
              </div>

              <div className={`chapter-heading ${isImageOnlyView ? "chapter-heading-image-only" : ""}`}>
                <h2>{currentChapter?.title || "Loading..."}</h2>
                {selectedPartIndex !== null && currentChapter?.parts[selectedPartIndex] ? (
                  <p className="chapter-part-label">{currentChapter.parts[selectedPartIndex].title}</p>
                ) : null}
              </div>

              {visibleBlocks.map((block) =>
                block.kind === "image" ? (
                  <figure key={block.image.src} className={`reader-figure ${isImageOnlyView ? "reader-figure-contained" : ""}`}>
                    <img
                      className={`reader-image ${isImageOnlyView ? "reader-image-contained" : ""}`}
                      src={block.image.src}
                      alt={block.image.alt || currentChapter?.title || ""}
                      onClick={() => setDialogImage(block.image)}
                    />
                  </figure>
                ) : (
                  <p
                    key={block.paragraph.paragraph_index}
                    ref={(node) => {
                      const paragraphIndex = currentParagraphs.findIndex(
                        (paragraph) => paragraph.paragraph_index === block.paragraph.paragraph_index,
                      );
                      paragraphRefs.current[paragraphIndex] = node;
                    }}
                    className="reader-paragraph"
                    data-paragraph-index={block.paragraph.paragraph_index}
                  >
                    {block.paragraph.tokens.map((token) => (
                      <span
                        key={token.token_index}
                        className={token.cefr_level ? `reader-token level-${token.cefr_level.toLowerCase()}` : "reader-token"}
                        title={token.oxford_tip || ""}
                      >
                        {token.text}
                      </span>
                    ))}
                  </p>
                ),
              )}
            </article>
          </div>
        </div>
      ) : null}

      {dialogImage ? (
        <div className="image-dialog-backdrop" onClick={() => setDialogImage(null)} role="presentation">
          <dialog className="image-dialog" open onClick={(event) => event.stopPropagation()}>
            <button className="image-dialog-close" onClick={() => setDialogImage(null)} aria-label="Close image view">
              ×
            </button>
            <img className="image-dialog-image" src={dialogImage.src} alt={dialogImage.alt || currentChapter?.title || ""} />
          </dialog>
        </div>
      ) : null}
    </main>
  );
}

function ProgressRing({ percent, label }: { percent: number; label: string }) {
  const radius = 32;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - percent / 100);
  return (
    <svg className="progress-ring" viewBox="0 0 80 80" aria-hidden="true">
      <circle className="progress-ring-track" cx="40" cy="40" r={radius} />
      <circle className="progress-ring-fill" cx="40" cy="40" r={radius} style={{ strokeDasharray: circumference, strokeDashoffset: offset }} />
      <text x="40" y="45" textAnchor="middle">
        {label}
      </text>
    </svg>
  );
}

function mergePartSummary(current: ReaderPayload | null, payload: CEFRPartLoadSummary): ReaderPayload | null {
  if (!current || current.id !== payload.book_id) {
    return current;
  }
  return {
    ...current,
    cefr_status: payload.cefr.status,
    cefr: payload.cefr,
    cefr_parts: current.cefr_parts.map((part) =>
      part.part_index === payload.part_index ? { ...part, status: payload.status } : part,
    ),
  };
}

function mergePartIntoChapters(
  current: Record<number, ChapterBlock[]>,
  payload: CEFRPartLoadSummary,
): Record<number, ChapterBlock[]> {
  const paragraphMap = new Map(payload.paragraphs.map((paragraph) => [paragraph.paragraph_index, paragraph]));
  const next = { ...current };
  for (const [chapterIndex, blocks] of Object.entries(current)) {
    next[Number(chapterIndex)] = blocks.map((block) =>
      block.kind === "paragraph"
        ? { ...block, paragraph: paragraphMap.get(block.paragraph.paragraph_index) ?? block.paragraph }
        : block,
    );
  }
  return next;
}

function renderJobStatus(job: CEFRJobSummary | null): string {
  if (!job) {
    return "Ready when you want it.";
  }
  if (job.status === "running") {
    return `${job.completed_parts}/${job.total_parts} queued parts processed`;
  }
  if (job.status === "complete") {
    return "Initialize complete.";
  }
  if (job.status === "error" && job.error_message) {
    return job.error_message;
  }
  return "Ready when you want it.";
}

function findChapterIndex(chapters: ChapterRecord[], paragraphIndex: number): number {
  const chapter = chapters.find(
    (item) => paragraphIndex >= item.start_paragraph_index && paragraphIndex <= item.end_paragraph_index,
  );
  return chapter?.chapter_index ?? 0;
}

function findPartIndex(parts: ChapterPartRecord[], paragraphIndex: number): number | null {
  const part = parts.find((item) => paragraphIndex >= item.start_paragraph_index && paragraphIndex <= item.end_paragraph_index);
  return part ? part.part_index : null;
}

function filterBlocksForPart(blocks: ChapterBlock[], part: ChapterPartRecord): ChapterBlock[] {
  const visible: ChapterBlock[] = [];
  const pendingImages: ChapterBlock[] = [];
  for (const block of blocks) {
    if (block.kind === "image") {
      pendingImages.push(block);
      continue;
    }
    const inPart =
      block.paragraph.paragraph_index >= part.start_paragraph_index &&
      block.paragraph.paragraph_index <= part.end_paragraph_index;
    if (inPart) {
      visible.push(...pendingImages, block);
    }
    pendingImages.length = 0;
  }
  return visible;
}

function countWordsByPart(blocks: ChapterBlock[], parts: ChapterPartRecord[]): Record<number, number> {
  const counts = Object.fromEntries(parts.map((part) => [part.part_index, 0]));
  for (const block of blocks) {
    if (block.kind !== "paragraph") {
      continue;
    }
    const part = parts.find(
      (item) =>
        block.paragraph.paragraph_index >= item.start_paragraph_index &&
        block.paragraph.paragraph_index <= item.end_paragraph_index,
    );
    if (!part) {
      continue;
    }
    counts[part.part_index] += countWords(block.paragraph.text);
  }
  return counts;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function findAdjacentPart(
  chapters: ChapterRecord[],
  selectedChapterIndex: number,
  selectedPartIndex: number | null,
  offset: -1 | 1,
): { chapterIndex: number; partIndex: number } | null {
  const parts = chapters.flatMap((chapter) =>
    chapter.parts.map((part) => ({ chapterIndex: chapter.chapter_index, partIndex: part.part_index })),
  );
  if (!parts.length) {
    return null;
  }

  const currentIndex = parts.findIndex(
    (part) => part.chapterIndex === selectedChapterIndex && part.partIndex === (selectedPartIndex ?? 0),
  );
  const anchorIndex = currentIndex >= 0 ? currentIndex : offset > 0 ? -1 : parts.length;
  const nextIndex = anchorIndex + offset;
  return nextIndex >= 0 && nextIndex < parts.length ? parts[nextIndex] : null;
}

function isNearTop(): boolean {
  return window.scrollY <= 24;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function migrateHashRoute() {
  const hashMatch = window.location.hash.match(/^#\/books\/(\d+)$/);
  if (hashMatch) {
    window.history.replaceState({}, "", `/books/${hashMatch[1]}${window.location.search}`);
  } else if (window.location.hash === "#/") {
    window.history.replaceState({}, "", `/${window.location.search}`);
  }
}

function readLocation(): ViewState {
  const pathname = window.location.pathname;
  const match = pathname.match(/^\/books\/(\d+)\/?$/);
  if (match) {
    return { kind: "reader", bookId: Number(match[1]) };
  }
  const hashMatch = window.location.hash.match(/^#\/books\/(\d+)$/);
  return hashMatch ? { kind: "reader", bookId: Number(hashMatch[1]) } : { kind: "library" };
}

function navigateToBook(bookId: number) {
  window.history.pushState({}, "", `/books/${bookId}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function navigateToLibrary() {
  window.history.pushState({}, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) {
    return "Not opened yet";
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "Recent activity" : date.toLocaleString();
}

async function postProgress(bookId: number, paragraphIndex: number, tokenIndex: number | null) {
  await fetch(`/api/books/${bookId}/progress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paragraph_index: paragraphIndex, token_index: tokenIndex }),
  });
}

export default App;
