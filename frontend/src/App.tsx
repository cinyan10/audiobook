import { useEffect, useRef, useState, type ChangeEvent } from "react";

type BookSummary = {
  id: number;
  title: string;
  author: string;
  cover_url: string | null;
  has_cefr: boolean;
  cefr_status: string;
  cefr_ready_parts: number;
  cefr_total_parts: number;
  cefr_percent: number;
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
type NavbarState = {
  title: string | null;
  progressLabel: string | null;
  progressPercent: number;
  showSidebarToggle: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: (() => void) | null;
};

const LEVEL_LABELS = ["A1", "A2", "B1", "B2", "C1"] as const;
const SIDEBAR_FLOAT_BREAKPOINT = 1480;

function App() {
  const [view, setView] = useState<ViewState>(readLocation());
  const [cefrJobRunning, setCefrJobRunning] = useState(false);
  const [libraryRefreshSignal, setLibraryRefreshSignal] = useState(0);
  const [navbar, setNavbar] = useState<NavbarState>({
    title: null,
    progressLabel: null,
    progressPercent: 0,
    showSidebarToggle: false,
    sidebarOpen: false,
    onToggleSidebar: null,
  });

  useEffect(() => {
    migrateHashRoute();
    const onPopState = () => setView(readLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (view.kind === "library") {
      setNavbar({
        title: null,
        progressLabel: null,
        progressPercent: 0,
        showSidebarToggle: false,
        sidebarOpen: false,
        onToggleSidebar: null,
      });
    }
  }, [view]);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/cefr/events`);
    socket.onmessage = (event) => {
      const job = JSON.parse(event.data) as CEFRJobSummary;
      setCefrJobRunning(job.status === "running");
      setLibraryRefreshSignal((current) => current + 1);
    };
    return () => socket.close();
  }, []);

  const handleInitializeAllCefr = async () => {
    setCefrJobRunning(true);
    const response = await fetch("/api/cefr/initialize", { method: "POST" });
    if (!response.ok) {
      setCefrJobRunning(false);
      return;
    }
    const job = (await response.json()) as CEFRJobSummary;
    setCefrJobRunning(job.status === "running");
    setLibraryRefreshSignal((current) => current + 1);
  };

  return (
    <div className="shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />
      <GlobalNavbar
        onHome={() => navigateToLibrary()}
        title={navbar.title}
        progressLabel={navbar.progressLabel}
        progressPercent={navbar.progressPercent}
        showDetails={view.kind === "reader"}
        showSidebarToggle={navbar.showSidebarToggle}
        sidebarOpen={navbar.sidebarOpen}
        onToggleSidebar={navbar.onToggleSidebar}
        showInitializeCefr={view.kind === "library"}
        initializingCefr={cefrJobRunning}
        onInitializeCefr={handleInitializeAllCefr}
      />
      {view.kind === "library" ? (
        <LibraryPage
          onOpenBook={(bookId) => navigateToBook(bookId)}
          refreshSignal={libraryRefreshSignal}
        />
      ) : (
        <ReaderPage bookId={view.bookId} onNavbarChange={setNavbar} />
      )}
    </div>
  );
}

function GlobalNavbar({
  onHome,
  title,
  progressLabel,
  progressPercent,
  showDetails,
  showSidebarToggle,
  sidebarOpen,
  onToggleSidebar,
  showInitializeCefr,
  initializingCefr,
  onInitializeCefr,
}: {
  onHome: () => void;
  title: string | null;
  progressLabel: string | null;
  progressPercent: number;
  showDetails: boolean;
  showSidebarToggle: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: (() => void) | null;
  showInitializeCefr: boolean;
  initializingCefr: boolean;
  onInitializeCefr: () => void;
}) {
  return (
    <nav className="reader-navbar" aria-label="Reader navigation">
      <div className={`reader-header ${showDetails ? "" : "reader-header-compact"}`.trim()}>
        <div className="reader-nav-start">
          {showSidebarToggle ? (
            <button
              className="nav-icon-button"
              onClick={onToggleSidebar ?? undefined}
              aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
              aria-pressed={sidebarOpen}
              type="button"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3.5" y="5" width="17" height="14" rx="2" />
                <path d="M9 5v14" />
              </svg>
            </button>
          ) : null}
          <button className="back-link" onClick={onHome}>
            Home
          </button>
        </div>
        <div className="reader-title-block">
          {showDetails ? <h1>{title || "Loading..."}</h1> : null}
        </div>
        <div className="reader-progress" aria-label={showDetails && progressLabel ? `Reading progress ${progressLabel}` : undefined}>
          {showDetails ? (
            <>
              <ProgressRing percent={progressPercent} label={progressLabel || "0.0%"} />
              <span>{progressLabel}</span>
            </>
          ) : null}
          {showInitializeCefr ? (
            <button className="navbar-action-button" onClick={() => void onInitializeCefr()} disabled={initializingCefr} type="button">
              {initializingCefr ? "Checking..." : "Initialize CEFR"}
            </button>
          ) : null}
        </div>
      </div>
    </nav>
  );
}

function LibraryPage({
  onOpenBook,
  refreshSignal,
}: {
  onOpenBook: (bookId: number) => void;
  refreshSignal: number;
}) {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [openMenuBookId, setOpenMenuBookId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadBooks = async ({ refresh = false }: { refresh?: boolean } = {}) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(refresh ? "/api/books/scan" : "/api/books", {
        method: refresh ? "POST" : "GET",
      });
      if (!response.ok) {
        throw new Error(`Failed to load books (${response.status})`);
      }
      const payload = (await response.json()) as BookSummary[] | { books: BookSummary[] };
      setBooks(Array.isArray(payload) ? payload : payload.books);
    } catch (loadError) {
      if (refresh) {
        await loadBooks();
        return;
      }
      setError(loadError instanceof Error ? loadError.message : "Failed to load books.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadBooks({ refresh: true });
  }, []);

  useEffect(() => {
    if (!refreshSignal) {
      return;
    }
    void loadBooks();
  }, [refreshSignal]);

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const formData = new FormData();
    formData.append("file", file);
    setUploading(true);
    setError(null);
    try {
      const response = await fetch("/api/books/upload", { method: "POST", body: formData });
      if (!response.ok) {
        throw new Error(`Upload failed (${response.status})`);
      }
      await response.json();
      await loadBooks({ refresh: true });
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed.");
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  };

  const handleInitializeBookCefr = async (bookId: number) => {
    setOpenMenuBookId(null);
    try {
      const response = await fetch(`/api/books/${bookId}/cefr/initialize`, { method: "POST" });
      if (!response.ok) {
        throw new Error(`Initialize failed (${response.status})`);
      }
      await loadBooks();
    } catch (initializeError) {
      setError(initializeError instanceof Error ? initializeError.message : "Initialize failed.");
    }
  };

  return (
    <main className="page library-page">
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept=".epub,application/epub+zip"
        onChange={handleUpload}
        disabled={uploading}
      />
      {error ? <p className="error-banner">{error}</p> : null}
      <section className="library-grid" aria-label="Library">
        {books.map((book, index) => (
          <article
            key={book.id}
            className={`library-book ${coverToneClass(index)}`}
          >
            <button className="library-book-open" onClick={() => onOpenBook(book.id)} type="button">
              <div className="library-cover">
                {book.cover_url ? (
                  <img src={book.cover_url} alt={book.title} className="library-cover-image" />
                ) : (
                  <div className="library-cover-placeholder">
                    <p>{book.title}</p>
                    <span>{book.author || "Unknown author"}</span>
                  </div>
                )}
              </div>
            </button>
            <div className="library-book-meta">
              <span className="library-progress-group">
                <span className={`library-badge ${book.last_read_at ? "progress" : "new"}`}>
                  {book.last_read_at ? `${Math.round(book.progress_percent)}%` : "NEW"}
                </span>
                <ProgressRing
                  percent={book.cefr_percent}
                  label={`${Math.round(book.cefr_percent)}%`}
                  className="library-cefr-ring"
                />
              </span>
              <span className="library-book-actions">
                <button
                  className="library-book-menu"
                  aria-label={`Actions for ${book.title}`}
                  aria-expanded={openMenuBookId === book.id}
                  onClick={() => setOpenMenuBookId((current) => (current === book.id ? null : book.id))}
                  type="button"
                >
                  •••
                </button>
                {openMenuBookId === book.id ? (
                  <span className="library-action-menu">
                    <button onClick={() => void handleInitializeBookCefr(book.id)} type="button">
                      Initialize CEFR
                    </button>
                  </span>
                ) : null}
              </span>
            </div>
          </article>
        ))}
        <button
          className={`library-book library-book-add ${uploading ? "is-uploading" : ""}`}
          onClick={() => fileInputRef.current?.click()}
          type="button"
        >
          <div className="library-cover library-cover-add" aria-hidden="true">
            <span>+</span>
          </div>
          <div className="library-book-meta">
            <span className="library-badge add">{uploading ? "ADDING" : "ADD"}</span>
          </div>
        </button>
      </section>
      {!loading && books.length === 0 ? <p className="library-empty">Add your first EPUB to start the shelf.</p> : null}
    </main>
  );
}

function ReaderPage({ bookId, onNavbarChange }: { bookId: number; onNavbarChange: (state: NavbarState) => void }) {
  const [book, setBook] = useState<ReaderPayload | null>(null);
  const [chapterCache, setChapterCache] = useState<Record<number, ChapterBlock[]>>({});
  const [selectedChapterIndex, setSelectedChapterIndex] = useState<number>(0);
  const [selectedPartIndex, setSelectedPartIndex] = useState<number | null>(null);
  const [dialogImage, setDialogImage] = useState<ImageRecord | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= SIDEBAR_FLOAT_BREAKPOINT);
  const [isSidebarFloating, setIsSidebarFloating] = useState(() => window.innerWidth < SIDEBAR_FLOAT_BREAKPOINT);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingChapter, setLoadingChapter] = useState(false);
  const [loadingCefr, setLoadingCefr] = useState(false);
  const chapterParagraphsRef = useRef<ParagraphRecord[]>([]);
  const paragraphRefs = useRef<Array<HTMLElement | null>>([]);
  const saveTimeoutRef = useRef<number | null>(null);
  const lastSavedRef = useRef<number>(-1);
  const lastScrollTargetRef = useRef<string>("");
  const requestedCefrRef = useRef<Set<string>>(new Set());
  const completedCefrRef = useRef<Set<string>>(new Set());
  const activeCefrKeyRef = useRef<string>("");
  const cefrAbortRef = useRef<AbortController | null>(null);
  const shouldRestoreScrollRef = useRef<boolean>(false);
  const sidebarFloatingRef = useRef(isSidebarFloating);

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
    const syncSidebarLayout = () => {
      const floating = window.innerWidth < SIDEBAR_FLOAT_BREAKPOINT;
      setIsSidebarFloating(floating);
      if (sidebarFloatingRef.current !== floating) {
        setSidebarOpen(!floating);
        sidebarFloatingRef.current = floating;
      }
    };

    syncSidebarLayout();
    window.addEventListener("resize", syncSidebarLayout);
    return () => window.removeEventListener("resize", syncSidebarLayout);
  }, []);

  useEffect(() => {
    let active = true;
    const loadBook = async () => {
      setLoading(true);
      setError(null);
      cefrAbortRef.current?.abort();
      activeCefrKeyRef.current = "";
      requestedCefrRef.current.clear();
      completedCefrRef.current.clear();
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

  const abortCurrentCefrLoad = () => {
    if (activeCefrKeyRef.current) {
      requestedCefrRef.current.delete(activeCefrKeyRef.current);
    }
    cefrAbortRef.current?.abort();
    cefrAbortRef.current = null;
    activeCefrKeyRef.current = "";
    setLoadingCefr(false);
  };

  const ensureVisibleCefrLoaded = async (currentBookId: number, paragraphs: ParagraphRecord[]) => {
    if (!book || !paragraphs.length) {
      return;
    }
    const parts = findOverlappingCefrParts(book.cefr_parts, paragraphs).filter((part) => part.status !== "ready");
    if (!parts.length) {
      return;
    }
    const cacheKey = `${currentBookId}:${parts.map((part) => part.part_index).join(",")}`;
    if (completedCefrRef.current.has(cacheKey) || requestedCefrRef.current.has(cacheKey)) {
      return;
    }

    if (activeCefrKeyRef.current && activeCefrKeyRef.current !== cacheKey) {
      requestedCefrRef.current.delete(activeCefrKeyRef.current);
      cefrAbortRef.current?.abort();
    }
    const controller = new AbortController();
    cefrAbortRef.current = controller;
    activeCefrKeyRef.current = cacheKey;
    requestedCefrRef.current.add(cacheKey);
    setLoadingCefr(true);
    try {
      const enriched: ParagraphRecord[] = [];
      const statuses = new Map<number, string>();
      let cefrSummary: CEFRSummary | null = null;
      for (const part of parts) {
        const response = await fetch(`/api/books/${currentBookId}/cefr-parts/${part.part_index}/load`, {
          method: "POST",
          signal: controller.signal,
        });
        if (controller.signal.aborted || activeCefrKeyRef.current !== cacheKey) {
          return;
        }
        if (!response.ok) {
          throw new Error(`Failed to load CEFR from Oxford (${response.status})`);
        }
        const payload = (await response.json()) as CEFRPartLoadSummary;
        if (controller.signal.aborted || activeCefrKeyRef.current !== cacheKey) {
          return;
        }
        enriched.push(...payload.paragraphs);
        statuses.set(payload.part_index, payload.status);
        cefrSummary = payload.cefr;
      }
      if (controller.signal.aborted || activeCefrKeyRef.current !== cacheKey) {
        return;
      }
      completedCefrRef.current.add(cacheKey);
      setChapterCache((current) => mergeParagraphsIntoChapters(current, enriched));
      setBook((current) =>
        current && current.id === currentBookId
          ? {
              ...current,
              cefr_status: cefrSummary?.status ?? current.cefr_status,
              cefr: cefrSummary ?? current.cefr,
              cefr_parts: current.cefr_parts.map((part) =>
                statuses.has(part.part_index) ? { ...part, status: statuses.get(part.part_index) ?? part.status } : part,
              ),
            }
          : current,
      );
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") {
        return;
      }
      setError(loadError instanceof Error ? loadError.message : "Failed to load CEFR from Oxford.");
    } finally {
      requestedCefrRef.current.delete(cacheKey);
      if (activeCefrKeyRef.current === cacheKey) {
        cefrAbortRef.current = null;
        activeCefrKeyRef.current = "";
        setLoadingCefr(false);
      }
    }
  };

  useEffect(() => {
    abortCurrentCefrLoad();
  }, [scrollTargetKey]);

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
    void ensureVisibleCefrLoaded(book.id, currentParagraphs);
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
      if ((event.metaKey || event.ctrlKey) && key === "b") {
        event.preventDefault();
        setSidebarOpen((current) => !current);
        return;
      }
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

  useEffect(() => {
    onNavbarChange({
      title: loading ? null : book?.title ?? null,
      progressLabel: loading ? "0.0%" : progressLabel,
      progressPercent: book?.progress.percent ?? 0,
      showSidebarToggle: true,
      sidebarOpen,
      onToggleSidebar: () => setSidebarOpen((current) => !current),
    });
    return () =>
      onNavbarChange({
        title: null,
        progressLabel: null,
        progressPercent: 0,
        showSidebarToggle: false,
        sidebarOpen: false,
        onToggleSidebar: null,
      });
  }, [book, loading, onNavbarChange, progressLabel, sidebarOpen]);

  return (
    <main className="reader-shell">
      {error ? <p className="error-banner">{error}</p> : null}

      {!loading && book ? (
        <div className="reader-frame">
          {isSidebarFloating && sidebarOpen ? (
            <button
              className="chapter-sidebar-backdrop"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close sidebar"
              type="button"
            />
          ) : null}

          <aside className={`chapter-sidebar ${isSidebarFloating ? "floating" : ""} ${sidebarOpen ? "open" : ""}`.trim()}>
            <nav className="chapter-list" aria-label="Book chapters">
              {book.chapters.map((chapter) => (
                <div key={chapter.chapter_index} className="chapter-item">
                  <button
                    className={`chapter-link ${chapter.chapter_index === selectedChapterIndex ? "active" : ""}`}
                    onClick={() => {
                      shouldRestoreScrollRef.current = false;
                      setSelectedChapterIndex(chapter.chapter_index);
                      setSelectedPartIndex(chapter.parts.length ? chapter.parts[0].part_index : null);
                      if (isSidebarFloating) {
                        setSidebarOpen(false);
                      }
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
                            if (isSidebarFloating) {
                              setSidebarOpen(false);
                            }
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
                {loadingCefr ? <span className="legend-pill neutral">Loading current section...</span> : null}
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

function ProgressRing({ percent, label, className = "" }: { percent: number; label: string; className?: string }) {
  const radius = 32;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - percent / 100);
  return (
    <svg className={`progress-ring ${className}`.trim()} viewBox="0 0 80 80" aria-hidden="true">
      <circle className="progress-ring-track" cx="40" cy="40" r={radius} />
      <circle className="progress-ring-fill" cx="40" cy="40" r={radius} style={{ strokeDasharray: circumference, strokeDashoffset: offset }} />
      <text x="40" y="45" textAnchor="middle">
        {label}
      </text>
    </svg>
  );
}

function mergeParagraphsIntoChapters(current: Record<number, ChapterBlock[]>, paragraphs: ParagraphRecord[]): Record<number, ChapterBlock[]> {
  const paragraphMap = new Map(paragraphs.map((paragraph) => [paragraph.paragraph_index, paragraph]));
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

function coverToneClass(index: number): string {
  const tones = ["tone-sage", "tone-graphite", "tone-umber", "tone-plum"];
  return tones[index % tones.length];
}

function findOverlappingCefrParts(parts: CEFRPartRecord[], paragraphs: ParagraphRecord[]): CEFRPartRecord[] {
  const first = paragraphs[0]?.paragraph_index;
  const last = paragraphs[paragraphs.length - 1]?.paragraph_index;
  if (first === undefined || last === undefined) {
    return [];
  }
  return parts.filter((part) => part.start_paragraph_index <= last && part.end_paragraph_index >= first);
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
