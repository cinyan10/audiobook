import { useEffect, useRef, useState, type ChangeEvent, type ReactElement } from "react";

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
  root_text: string;
  cefr_level: string | null;
  oxford_tip: string | null;
};

type TimedTokenRecord = {
  token_index: number;
  paragraph_index: number;
  text: string;
  start_time: number;
  end_time: number;
};

type AlignmentPayload = {
  book_id: number;
  chapter_index: number;
  part_index: number;
  audio_path: string;
  duration_seconds: number;
  tokens: TimedTokenRecord[];
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
  audio_available: boolean;
  alignment_available: boolean;
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
    last_audio_chapter_index: number | null;
    last_audio_part_index: number | null;
    last_audio_time_seconds: number;
    percent: number;
  };
  total_paragraphs: number;
};

type ProgressRecord = ReaderPayload["progress"];

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

type DictionaryDefinition = {
  number: number;
  definition: string;
  examples: string[];
};

type DictionaryChoice = {
  definition_number: number | null;
  definition: string;
  examples: string[];
  ai_explanation: string;
  matched: boolean;
};

type DictionaryLookup = {
  word: string;
  word_type: string;
  cefr_level: string;
  phonetics: string[];
  audio_url: string;
  source_url: string;
  definitions: DictionaryDefinition[];
  context_definition: DictionaryChoice;
};

type LookupDialogState = {
  word: string;
  context: string;
  cefrLevel: string;
  x: number;
  y: number;
  loading: boolean;
  error: string | null;
  result: DictionaryLookup | null;
};

type ContextMenuState = {
  word: string;
  rootWord: string;
  context: string;
  cefrLevel: string;
  paragraphIndex: number;
  tokenIndex: number;
  target: HTMLElement;
  x: number;
  y: number;
};

type WordlistEntry = {
  id: number;
  book_id: number;
  book_title: string;
  root_word: string;
  original_word: string;
  word_type: string;
  cefr_level: string;
  definition_number: number | null;
  definition: string;
  definition_examples: string[];
  definition_phonetics: string[];
  definition_audio_url: string;
  definition_source_url: string;
  definition_lookup_error: string;
  context: string;
  paragraph_index: number;
  token_index: number;
  created_at: string;
};

type ViewState =
  | { kind: "library" }
  | { kind: "wordlist" }
  | { kind: "reader"; bookId: number; chapterIndex: number | null; partIndex: number | null };
type NavbarAudioState = {
  playing: boolean;
  currentTime: number;
  duration: number;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  onSkip: (deltaSeconds: number) => void;
};

type NavbarState = {
  title: string | null;
  progressLabel: string | null;
  progressPercent: number;
  audio: NavbarAudioState | null;
  showSidebarToggle: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: (() => void) | null;
};

const LEVEL_LABELS = ["A1", "A2", "B1", "B2", "C1"] as const;
const SIDEBAR_FLOAT_BREAKPOINT = 1480;
const AUDIO_PROGRESS_SAVE_MS = 15000;

function App() {
  const [view, setView] = useState<ViewState>(readLocation());
  const [cefrJobRunning, setCefrJobRunning] = useState(false);
  const [libraryRefreshSignal, setLibraryRefreshSignal] = useState(0);
  const [navbar, setNavbar] = useState<NavbarState>({
    title: null,
    progressLabel: null,
    progressPercent: 0,
    audio: null,
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
    if (view.kind !== "reader") {
      setNavbar({
        title: null,
        progressLabel: null,
        progressPercent: 0,
        audio: null,
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
        audio={navbar.audio}
        showDetails={view.kind === "reader"}
        showSidebarToggle={navbar.showSidebarToggle}
        sidebarOpen={navbar.sidebarOpen}
        onToggleSidebar={navbar.onToggleSidebar}
        showInitializeCefr={view.kind === "library"}
        initializingCefr={cefrJobRunning}
        onInitializeCefr={handleInitializeAllCefr}
        onWordlist={() => navigateToWordlist()}
      />
      {view.kind === "library" ? (
        <LibraryPage
          onOpenBook={(bookId) => navigateToBook(bookId)}
          refreshSignal={libraryRefreshSignal}
        />
      ) : view.kind === "wordlist" ? (
        <WordlistPage onOpenBook={(bookId) => navigateToBook(bookId)} />
      ) : (
        <ReaderPage
          bookId={view.bookId}
          routeChapterIndex={view.chapterIndex}
          routePartIndex={view.partIndex}
          onNavbarChange={setNavbar}
        />
      )}
    </div>
  );
}

function GlobalNavbar({
  onHome,
  title,
  progressLabel,
  progressPercent,
  audio,
  showDetails,
  showSidebarToggle,
  sidebarOpen,
  onToggleSidebar,
  showInitializeCefr,
  initializingCefr,
  onInitializeCefr,
  onWordlist,
}: {
  onHome: () => void;
  title: string | null;
  progressLabel: string | null;
  progressPercent: number;
  audio: NavbarAudioState | null;
  showDetails: boolean;
  showSidebarToggle: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: (() => void) | null;
  showInitializeCefr: boolean;
  initializingCefr: boolean;
  onInitializeCefr: () => void;
  onWordlist: () => void;
}) {
  return (
    <>
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
            <button className="back-link" onClick={onWordlist}>
              Wordlist
            </button>
          </div>
          <div className="reader-title-block">
            {showDetails ? <h1>{title || "Loading..."}</h1> : null}
          </div>
          <div className="reader-header-end">
            <div className="reader-progress" aria-label={showDetails && progressLabel ? `Reading progress ${progressLabel}` : undefined}>
              {showDetails ? (
                <>
                  <ProgressRing percent={progressPercent} label={progressLabel || "0.0%"} />
                  <span>{progressLabel}</span>
                </>
              ) : null}
            </div>
            {showInitializeCefr ? (
              <button className="navbar-action-button" onClick={() => void onInitializeCefr()} disabled={initializingCefr} type="button">
                {initializingCefr ? "Checking..." : "Initialize CEFR"}
              </button>
            ) : null}
          </div>
        </div>
      </nav>
      {audio ? (
        <div className="reader-audio" aria-label="Audio playback controls">
          <button className="audio-button" onClick={audio.onTogglePlay} type="button" aria-label={audio.playing ? "Pause" : "Play"}>
            {audio.playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <div className="audio-timeline">
            <span>{formatClock(audio.currentTime)}</span>
            <input
              className="audio-slider"
              type="range"
              min={0}
              max={Math.max(audio.duration, 0)}
              step={0.1}
              value={Math.min(audio.currentTime, Math.max(audio.duration, 0))}
              onChange={(event) => audio.onSeek(Number(event.target.value))}
            />
            <span>{formatClock(audio.duration)}</span>
          </div>
        </div>
      ) : null}
    </>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5h3v14H8zM13 5h3v14h-3z" />
    </svg>
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

function WordlistPage({ onOpenBook }: { onOpenBook: (bookId: number) => void }) {
  const [entries, setEntries] = useState<WordlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetch("/api/wordlist")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load wordlist (${response.status})`);
        }
        return (await response.json()) as WordlistEntry[];
      })
      .then((payload) => {
        if (!cancelled) {
          setEntries(payload);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load wordlist.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="page wordlist-page">
      {error ? <p className="error-banner">{error}</p> : null}
      <section className="wordlist-panel" aria-label="Wordlist">
        <div className="wordlist-head">
          <h2>Wordlist</h2>
          <span>{entries.length} words</span>
        </div>
        {loading ? <p className="library-empty">Loading wordlist...</p> : null}
        {!loading && entries.length === 0 ? <p className="library-empty">Add words from the reader context menu.</p> : null}
        <div className="wordlist-list">
          {entries.map((entry) => (
            <article key={entry.id} className="wordlist-entry">
              <button className={`wordlist-word ${cefrLevelClass(entry.cefr_level)}`} onClick={() => onOpenBook(entry.book_id)} type="button">
                {entry.root_word}
              </button>
              {entry.word_type || entry.cefr_level ? (
                <span className="wordlist-meta">{[entry.word_type, entry.cefr_level, entry.definition_phonetics.join("  ")].filter(Boolean).join(" · ")}</span>
              ) : null}
              <p>{highlightContextWord(entry)}</p>
              {entry.definition ? (
                <div className="wordlist-definition">
                  <p>
                    {entry.definition_number ? <b>Definition {entry.definition_number}. </b> : null}
                    {entry.definition}
                  </p>
                  {entry.definition_examples.map((example) => (
                    <blockquote key={example}>{example}</blockquote>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

function ReaderPage({
  bookId,
  routeChapterIndex,
  routePartIndex,
  onNavbarChange,
}: {
  bookId: number;
  routeChapterIndex: number | null;
  routePartIndex: number | null;
  onNavbarChange: (state: NavbarState) => void;
}) {
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
  const [generatingAudio, setGeneratingAudio] = useState(false);
  const [audioState, setAudioState] = useState({ currentTime: 0, duration: 0, playing: false });
  const [alignmentTokens, setAlignmentTokens] = useState<TimedTokenRecord[]>([]);
  const [activeTokenIndex, setActiveTokenIndex] = useState<number | null>(null);
  const [lookupDialog, setLookupDialog] = useState<LookupDialogState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [wordlistEntries, setWordlistEntries] = useState<WordlistEntry[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pronunciationAudioRef = useRef<HTMLAudioElement | null>(null);
  const dictionaryAudioRef = useRef<HTMLAudioElement | null>(null);
  const chapterParagraphsRef = useRef<ParagraphRecord[]>([]);
  const paragraphRefs = useRef<Array<HTMLElement | null>>([]);
  const tokenRefs = useRef<Record<number, HTMLElement | null>>({});
  const saveTimeoutRef = useRef<number | null>(null);
  const audioSaveIntervalRef = useRef<number | null>(null);
  const lastSavedRef = useRef<number>(-1);
  const lastAudioSaveKeyRef = useRef<string>("");
  const lastLoadedAudioKeyRef = useRef<string>("");
  const lastScrollTargetRef = useRef<string>("");
  const lastAutoScrollTokenRef = useRef<number | null>(null);
  const lastSelectionSeekKeyRef = useRef<string>("");
  const pronunciationEndTimeRef = useRef<number | null>(null);
  const suppressScrollProgressUntilRef = useRef<number>(0);
  const requestedCefrRef = useRef<Set<string>>(new Set());
  const completedCefrRef = useRef<Set<string>>(new Set());
  const activeCefrKeyRef = useRef<string>("");
  const cefrAbortRef = useRef<AbortController | null>(null);
  const shouldRestoreScrollRef = useRef<boolean>(false);
  const sidebarFloatingRef = useRef(isSidebarFloating);
  const pendingAudioRestoreRef = useRef<number>(0);
  const audioContextRef = useRef<{
    bookId: number;
    chapterIndex: number;
    partIndex: number;
    paragraphIndex: number;
  } | null>(null);

  const currentChapter = book?.chapters[selectedChapterIndex] ?? null;
  const currentPart =
    selectedPartIndex !== null && currentChapter
      ? currentChapter.parts.find((part) => part.part_index === selectedPartIndex) ?? null
      : null;
  const currentBlocks = chapterCache[selectedChapterIndex] ?? [];
  const visibleBlocks =
    currentPart
      ? filterBlocksForPart(currentBlocks, currentPart)
      : currentBlocks;
  const currentParagraphs = visibleBlocks.flatMap((block) => (block.kind === "paragraph" ? [block.paragraph] : []));
  const currentChapterWordCounts = currentChapter && chapterCache[selectedChapterIndex] ? countWordsByPart(currentBlocks, currentChapter.parts) : null;
  const currentPartWordCount =
    currentChapterWordCounts && selectedPartIndex !== null ? currentChapterWordCounts[selectedPartIndex] ?? 0 : null;
  const isImageOnlyView = visibleBlocks.length > 0 && visibleBlocks.every((block) => block.kind === "image");
  const scrollTargetKey = `${selectedChapterIndex}:${selectedPartIndex ?? "all"}`;
  const currentAudioSrc = book && currentPart?.audio_available ? `/api/books/${book.id}/audio/${selectedChapterIndex}/${currentPart.part_index}` : null;
  const currentAlignmentSrc =
    book && currentPart?.audio_available && currentPart.alignment_available
      ? `/api/books/${book.id}/alignment/${selectedChapterIndex}/${currentPart.part_index}`
      : null;
  const currentAudioKey = book && currentPart ? `${book.id}:${selectedChapterIndex}:${currentPart.part_index}` : "";
  const wordlistRoots = new Set(wordlistEntries.map((entry) => entry.root_word));
  const wordlistTokenKeys = new Set(wordlistEntries.map((entry) => `${entry.paragraph_index}:${entry.token_index}`));
  const contextMenuWordIsSaved = Boolean(contextMenu?.rootWord && wordlistRoots.has(contextMenu.rootWord));

  useEffect(() => {
    chapterParagraphsRef.current = currentParagraphs;
  }, [currentParagraphs]);

  useEffect(() => {
    tokenRefs.current = {};
    lastSelectionSeekKeyRef.current = "";
  }, [scrollTargetKey]);

  useEffect(() => {
    if (!book) {
      setWordlistEntries([]);
      return;
    }
    let cancelled = false;
    void fetch(`/api/books/${book.id}/wordlist`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load wordlist (${response.status})`);
        }
        return (await response.json()) as WordlistEntry[];
      })
      .then((entries) => {
        if (!cancelled) {
          setWordlistEntries(entries);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWordlistEntries([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [book?.id]);

  useEffect(() => {
    audioContextRef.current =
      book && currentPart
        ? {
            bookId: book.id,
            chapterIndex: selectedChapterIndex,
            partIndex: currentPart.part_index,
            paragraphIndex: resolveProgressParagraphIndex(book.progress.last_paragraph_index, currentPart),
          }
        : null;
  }, [book, currentPart, selectedChapterIndex]);

  const persistAudioProgress = async (force = false) => {
    const audio = audioRef.current;
    const context = audioContextRef.current;
    if (!audio || !context) {
      return;
    }
    const roundedTime = Number(audio.currentTime.toFixed(2));
    const saveKey = `${context.bookId}:${context.chapterIndex}:${context.partIndex}:${roundedTime.toFixed(2)}`;
    if (!force && lastAudioSaveKeyRef.current === saveKey) {
      return;
    }
    lastAudioSaveKeyRef.current = saveKey;
    const progress = await postProgress(context.bookId, context.paragraphIndex, null, {
      audioChapterIndex: context.chapterIndex,
      audioPartIndex: context.partIndex,
      audioTimeSeconds: roundedTime,
    });
    setBook((current) => (current && current.id === context.bookId ? { ...current, progress } : current));
  };

  const seekToToken = (token: TokenRecord) => {
    const audio = audioRef.current;
    if (!audio || !currentAudioSrc) {
      return;
    }
    const window = estimateTokenWindow(token.token_index, currentParagraphs, alignmentTokens, audio);
    if (!window) {
      return;
    }
    if (audio.paused) {
      playPronunciation(currentAudioSrc, window);
    }
    audio.currentTime = window.start;
    setAudioState((current) => ({ ...current, currentTime: window.start }));
    setActiveTokenIndex(token.token_index);
  };

  const playPronunciation = (src: string, window: { start: number; end: number }) => {
    const audio = pronunciationAudioRef.current;
    if (!audio) {
      return;
    }
    audio.pause();
    audio.src = src;
    pronunciationEndTimeRef.current = window.end;
    audio.currentTime = window.start;
    void audio.play();
  };

  const openLookup = (word: string, context: string, target: HTMLElement, cefrLevel = "", rootWord = "") => {
    const bounds = target.getBoundingClientRect();
    const x = Math.min(bounds.left + bounds.width / 2, window.innerWidth - 24);
    const y = Math.min(bounds.bottom + 8, window.innerHeight - 24);
    const savedEntry = wordlistEntries.find(
      (entry) => entry.definition && (entry.root_word === rootWord || entry.root_word === word.toLowerCase() || entry.original_word.toLowerCase() === word.toLowerCase()),
    );
    if (savedEntry) {
      setLookupDialog({
        word,
        context,
        cefrLevel,
        x,
        y,
        loading: false,
        error: null,
        result: dictionaryLookupFromWordlistEntry(savedEntry, word),
      });
      if (savedEntry.definition_audio_url && dictionaryAudioRef.current) {
        dictionaryAudioRef.current.src = savedEntry.definition_audio_url;
        void dictionaryAudioRef.current.play();
      }
      setContextMenu(null);
      return;
    }
    setLookupDialog({ word, context, cefrLevel, x, y, loading: true, error: null, result: null });
    setContextMenu(null);
    void fetch("/api/dictionary/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ word, context: `${word}\n\n${context}`, cefr_level: cefrLevel }),
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error((await response.json()).detail || `Lookup failed (${response.status})`);
        }
        return (await response.json()) as DictionaryLookup;
      })
      .then((result) => {
        setLookupDialog((current) => (current?.word === word ? { ...current, loading: false, result } : current));
        if (result.audio_url && dictionaryAudioRef.current) {
          dictionaryAudioRef.current.src = result.audio_url;
          void dictionaryAudioRef.current.play();
        }
      })
      .catch((lookupError) => {
        setLookupDialog((current) =>
          current?.word === word
            ? { ...current, loading: false, error: lookupError instanceof Error ? lookupError.message : "Lookup failed." }
            : current,
        );
      });
  };

  const lookupSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
      return;
    }
    const word = selectedWord(selection.toString());
    if (!word) {
      return;
    }
    const range = selection.getRangeAt(0);
    const target = closestReaderToken(range.commonAncestorContainer);
    const paragraph = target?.closest<HTMLElement>(".reader-paragraph");
    if (target && paragraph) {
      openLookup(word, lookupContext(paragraph.textContent || "", word), target, target.dataset.cefrLevel || "", target.dataset.rootText || "");
    }
  };

  const addContextMenuWordToWordlist = async () => {
    if (!book || !contextMenu) {
      return;
    }
    const menu = contextMenu;
    const optimisticEntry: WordlistEntry = {
      id: -Date.now(),
      book_id: book.id,
      book_title: book.title,
      root_word: menu.rootWord,
      original_word: menu.word,
      word_type: "",
      cefr_level: menu.cefrLevel,
      definition_number: null,
      definition: "",
      definition_examples: [],
      definition_phonetics: [],
      definition_audio_url: "",
      definition_source_url: "",
      definition_lookup_error: "",
      context: menu.context,
      paragraph_index: menu.paragraphIndex,
      token_index: menu.tokenIndex,
      created_at: new Date().toISOString(),
    };
    setContextMenu(null);
    setWordlistEntries((current) => [optimisticEntry, ...current.filter((item) => item.root_word !== menu.rootWord)]);
    try {
      const entry = await postWordlistEntry(book.id, {
        word: menu.word,
        context: menu.context,
        paragraphIndex: menu.paragraphIndex,
        tokenIndex: menu.tokenIndex,
      });
      setWordlistEntries((current) => [entry, ...current.filter((item) => item.id !== entry.id && item.id !== optimisticEntry.id)]);
      void pollWordlistEntry(book.id, entry.id).then((refreshed) => {
        if (refreshed?.definition) {
          setWordlistEntries((current) => current.map((item) => (item.id === refreshed.id ? refreshed : item)));
        }
      });
    } catch (saveError) {
      setWordlistEntries((current) => current.filter((item) => item.id !== optimisticEntry.id));
      setError(saveError instanceof Error ? saveError.message : "Failed to add word.");
    }
  };

  const removeContextMenuWordFromWordlist = async () => {
    if (!book || !contextMenu) {
      return;
    }
    try {
      await deleteWordlistEntry(book.id, contextMenu.paragraphIndex, contextMenu.tokenIndex);
      setWordlistEntries((current) => current.filter((entry) => entry.root_word !== contextMenu.rootWord));
      setContextMenu(null);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Failed to remove word.");
    }
  };

  const generateCurrentPartAudio = async () => {
    if (!book || !currentPart || generatingAudio) {
      return;
    }
    setGeneratingAudio(true);
    setError(null);
    try {
      const response = await fetch(`/api/books/${book.id}/audio/${selectedChapterIndex}/${currentPart.part_index}/generate`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error((await response.json()).detail || `Audio generation failed (${response.status})`);
      }
      const nextBook = (await response.json()) as ReaderPayload;
      setBook(nextBook);
      lastLoadedAudioKeyRef.current = "";
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : "Audio generation failed.");
    } finally {
      setGeneratingAudio(false);
    }
  };

  const toggleAudioPlayback = () => {
    const audio = audioRef.current;
    if (!audio || !currentAudioSrc) {
      return;
    }
    if (audio.paused) {
      stopPronunciation();
      void audio.play();
    } else {
      audio.pause();
    }
  };

  const stopPronunciation = () => {
    const audio = pronunciationAudioRef.current;
    pronunciationEndTimeRef.current = null;
    audio?.pause();
  };

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
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    const syncAudioState = () => {
      setAudioState({
        currentTime: audio.currentTime,
        duration: Number.isFinite(audio.duration) ? audio.duration : 0,
        playing: !audio.paused,
      });
    };

    const onLoadedMetadata = () => {
      if (pendingAudioRestoreRef.current > 0) {
        audio.currentTime = Math.min(pendingAudioRestoreRef.current, Number.isFinite(audio.duration) ? audio.duration : pendingAudioRestoreRef.current);
      }
      pendingAudioRestoreRef.current = 0;
      syncAudioState();
    };

    const onPause = () => {
      syncAudioState();
      void persistAudioProgress(true);
    };
    const onEnded = () => {
      syncAudioState();
      void persistAudioProgress(true);
    };
    const onSeeked = () => {
      syncAudioState();
    };

    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("timeupdate", syncAudioState);
    audio.addEventListener("play", syncAudioState);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("seeked", onSeeked);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("timeupdate", syncAudioState);
      audio.removeEventListener("play", syncAudioState);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("seeked", onSeeked);
      audio.removeEventListener("ended", onEnded);
    };
  }, []);

  useEffect(() => {
    const audio = pronunciationAudioRef.current;
    if (!audio) {
      return;
    }
    const stopAtEnd = () => {
      if (pronunciationEndTimeRef.current !== null && audio.currentTime >= pronunciationEndTimeRef.current) {
        stopPronunciation();
      }
    };
    audio.addEventListener("timeupdate", stopAtEnd);
    audio.addEventListener("ended", stopPronunciation);
    return () => {
      audio.removeEventListener("timeupdate", stopAtEnd);
      audio.removeEventListener("ended", stopPronunciation);
    };
  }, []);

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
      lastAudioSaveKeyRef.current = "";
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
        const routeTarget = findRoutePart(nextBook.chapters, routeChapterIndex, routePartIndex);
        const initialChapterIndex = routeTarget?.chapterIndex ?? findChapterIndex(nextBook.chapters, nextBook.progress.last_paragraph_index);
        const initialChapter = nextBook.chapters[initialChapterIndex] ?? null;
        shouldRestoreScrollRef.current = !routeTarget;
        lastSavedRef.current = nextBook.progress.last_paragraph_index;
        setSelectedChapterIndex(initialChapterIndex);
        setSelectedPartIndex(routeTarget?.partIndex ?? (initialChapter ? findPartIndex(initialChapter.parts, nextBook.progress.last_paragraph_index) : null));
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
    if (!book) {
      return;
    }
    const routeTarget = findRoutePart(book.chapters, routeChapterIndex, routePartIndex);
    if (!routeTarget && (routeChapterIndex === null || routePartIndex === null)) {
      return;
    }
    const progressChapterIndex = findChapterIndex(book.chapters, book.progress.last_paragraph_index);
    const progressChapter = book.chapters[progressChapterIndex] ?? null;
    const target = routeTarget ?? {
      chapterIndex: progressChapterIndex,
      partIndex: progressChapter ? findPartIndex(progressChapter.parts, book.progress.last_paragraph_index) : null,
    };
    if (target.chapterIndex === selectedChapterIndex && target.partIndex === selectedPartIndex) {
      return;
    }
    shouldRestoreScrollRef.current = !routeTarget;
    void persistAudioProgress(true);
    setSelectedChapterIndex(target.chapterIndex);
    setSelectedPartIndex(target.partIndex);
  }, [book, routeChapterIndex, routePartIndex, selectedChapterIndex, selectedPartIndex]);

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

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    if (!currentAudioSrc || !book || !currentPart) {
      stopPronunciation();
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      pendingAudioRestoreRef.current = 0;
      lastLoadedAudioKeyRef.current = "";
      setAudioState({ currentTime: 0, duration: 0, playing: false });
      return;
    }
    if (lastLoadedAudioKeyRef.current === currentAudioKey && audio.src.endsWith(currentAudioSrc)) {
      return;
    }
    lastLoadedAudioKeyRef.current = currentAudioKey;
    pendingAudioRestoreRef.current =
      book.progress.last_audio_chapter_index === selectedChapterIndex && book.progress.last_audio_part_index === currentPart.part_index
        ? book.progress.last_audio_time_seconds
        : 0;
    audio.pause();
    audio.src = currentAudioSrc;
    audio.load();
    setAudioState({ currentTime: pendingAudioRestoreRef.current, duration: 0, playing: false });
  }, [
    book?.id,
    book?.progress.last_audio_chapter_index,
    book?.progress.last_audio_part_index,
    book?.progress.last_audio_time_seconds,
    currentAudioKey,
    currentAudioSrc,
    currentPart,
    selectedChapterIndex,
  ]);

  useEffect(() => {
    if (!audioState.playing || !currentAudioSrc) {
      if (audioSaveIntervalRef.current !== null) {
        window.clearInterval(audioSaveIntervalRef.current);
        audioSaveIntervalRef.current = null;
      }
      return;
    }
    audioSaveIntervalRef.current = window.setInterval(() => {
      void persistAudioProgress();
    }, AUDIO_PROGRESS_SAVE_MS);
    return () => {
      if (audioSaveIntervalRef.current !== null) {
        window.clearInterval(audioSaveIntervalRef.current);
        audioSaveIntervalRef.current = null;
      }
    };
  }, [audioState.playing, currentAudioSrc]);

  useEffect(() => {
    let active = true;
    setAlignmentTokens([]);
    setActiveTokenIndex(null);
    lastAutoScrollTokenRef.current = null;
    if (!currentAlignmentSrc) {
      return;
    }
    const loadAlignment = async () => {
      try {
        const response = await fetch(currentAlignmentSrc);
        if (!active || response.status === 404) {
          return;
        }
        if (!response.ok) {
          throw new Error(`Failed to load alignment (${response.status})`);
        }
        const payload = (await response.json()) as AlignmentPayload;
        if (active) {
          setAlignmentTokens(payload.tokens);
        }
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load alignment.");
        }
      }
    };
    void loadAlignment();
    return () => {
      active = false;
    };
  }, [currentAlignmentSrc]);

  useEffect(() => {
    if (!alignmentTokens.length) {
      setActiveTokenIndex(null);
      return;
    }
    const activeToken =
      alignmentTokens.find((token) => audioState.currentTime >= token.start_time && audioState.currentTime < token.end_time) ??
      [...alignmentTokens].reverse().find((token) => token.start_time <= audioState.currentTime);
    setActiveTokenIndex((current) => (current === (activeToken?.token_index ?? null) ? current : activeToken?.token_index ?? null));
    if (!activeToken || lastAutoScrollTokenRef.current === activeToken.token_index) {
      return;
    }
    const element = tokenRefs.current[activeToken.token_index];
    if (!element) {
      return;
    }
    const bounds = element.getBoundingClientRect();
    const player = document.querySelector<HTMLElement>(".reader-audio");
    const bottomInset = (player?.offsetHeight ?? 0) + 48;
    const visibleBottom = window.innerHeight - bottomInset;
    if (bounds.bottom > visibleBottom) {
      lastAutoScrollTokenRef.current = activeToken.token_index;
      suppressScrollProgressUntilRef.current = Date.now() + 10000;
      window.scrollBy({ top: Math.max(visibleBottom * 0.82, bounds.bottom - visibleBottom), behavior: "smooth" });
    }
  }, [alignmentTokens, audioState.currentTime]);

  useEffect(
    () => () => {
      void persistAudioProgress(true);
    },
    [],
  );

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

    const seekSelectedWord = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
        lastSelectionSeekKeyRef.current = "";
        return;
      }
      const text = selection.toString().trim();
      if (!text || /\s/.test(text)) {
        lastSelectionSeekKeyRef.current = "";
        return;
      }
      const range = selection.getRangeAt(0);
      const token = currentParagraphs.flatMap((paragraph) => paragraph.tokens).find((candidate) => {
        const element = tokenRefs.current[candidate.token_index];
        return element ? range.intersectsNode(element) && element.textContent?.trim() === text : false;
      });
      if (token) {
        const seekKey = `${token.token_index}:${text}`;
        if (lastSelectionSeekKeyRef.current === seekKey) {
          return;
        }
        lastSelectionSeekKeyRef.current = seekKey;
        seekToToken(token);
      }
    };

    document.addEventListener("mouseup", seekSelectedWord);
    document.addEventListener("keyup", seekSelectedWord);
    return () => {
      document.removeEventListener("mouseup", seekSelectedWord);
      document.removeEventListener("keyup", seekSelectedWord);
    };
  }, [alignmentTokens, book, currentAudioSrc, currentParagraphs]);

  useEffect(() => {
    if (!book || !currentParagraphs.length) {
      return;
    }

    const detectParagraph = () => {
      const audio = audioRef.current;
      if (currentAlignmentSrc && activeTokenIndex !== null && audio && audio.currentTime > 0) {
        return;
      }
      if (Date.now() < suppressScrollProgressUntilRef.current) {
        return;
      }
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
        void postProgress(book.id, absoluteParagraphIndex, null).then((progress) => {
          lastSavedRef.current = absoluteParagraphIndex;
          setBook((current) =>
            current
              ? {
                  ...current,
                  progress,
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
  }, [activeTokenIndex, book, currentAlignmentSrc, currentParagraphs]);

  useEffect(() => {
    if (!book || dialogImage) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) {
        return;
      }
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && key === "l") {
        event.preventDefault();
        lookupSelection();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && key === "b") {
        event.preventDefault();
        setSidebarOpen((current) => !current);
        return;
      }
      if (key === " " && currentAudioSrc) {
        event.preventDefault();
        toggleAudioPlayback();
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
      void persistAudioProgress(true);
      navigateToBookPart(book.id, nextPartTarget.chapterIndex, nextPartTarget.partIndex);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [book, currentAudioSrc, dialogImage, selectedChapterIndex, selectedPartIndex]);

  useEffect(() => {
    const closeMenus = () => setContextMenu(null);
    window.addEventListener("click", closeMenus);
    window.addEventListener("scroll", closeMenus, { passive: true });
    return () => {
      window.removeEventListener("click", closeMenus);
      window.removeEventListener("scroll", closeMenus);
    };
  }, []);

  const progressLabel = book ? `${book.progress.percent.toFixed(1)}%` : "0.0%";

  useEffect(() => {
    onNavbarChange({
      title: loading ? null : book?.title ?? null,
      progressLabel: loading ? "0.0%" : progressLabel,
      progressPercent: book?.progress.percent ?? 0,
      audio:
        currentAudioSrc && audioRef.current
          ? {
              playing: audioState.playing,
              currentTime: audioState.currentTime,
              duration: audioState.duration,
              onTogglePlay: () => {
                toggleAudioPlayback();
              },
              onSeek: (time) => {
                const audio = audioRef.current;
                if (!audio) {
                  return;
                }
                stopPronunciation();
                audio.currentTime = Math.max(0, Math.min(time, Number.isFinite(audio.duration) ? audio.duration : time));
                setAudioState((current) => ({ ...current, currentTime: audio.currentTime }));
              },
              onSkip: (deltaSeconds) => {
                const audio = audioRef.current;
                if (!audio) {
                  return;
                }
                const nextTime = Math.max(
                  0,
                  Math.min(audio.currentTime + deltaSeconds, Number.isFinite(audio.duration) ? audio.duration : audio.currentTime + deltaSeconds),
                );
                stopPronunciation();
                audio.currentTime = nextTime;
                setAudioState((current) => ({ ...current, currentTime: nextTime }));
              },
            }
          : null,
      showSidebarToggle: true,
      sidebarOpen,
      onToggleSidebar: () => setSidebarOpen((current) => !current),
    });
    return () =>
      onNavbarChange({
        title: null,
        progressLabel: null,
        progressPercent: 0,
        audio: null,
        showSidebarToggle: false,
        sidebarOpen: false,
        onToggleSidebar: null,
      });
  }, [audioState.currentTime, audioState.duration, audioState.playing, book, currentAudioSrc, loading, onNavbarChange, progressLabel, sidebarOpen]);

  return (
    <main className="reader-shell">
      <audio ref={audioRef} preload="metadata" className="visually-hidden" />
      <audio ref={pronunciationAudioRef} preload="metadata" className="visually-hidden" />
      <audio ref={dictionaryAudioRef} preload="none" className="visually-hidden" />
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
                      void persistAudioProgress(true);
                      if (chapter.parts.length) {
                        navigateToBookPart(book.id, chapter.chapter_index, chapter.parts[0].part_index);
                      } else {
                        navigateToBookPart(book.id, chapter.chapter_index, 0);
                      }
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
                            void persistAudioProgress(true);
                            navigateToBookPart(book.id, chapter.chapter_index, part.part_index);
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
                {currentPart ? (
                  <button
                    className="part-audio-button"
                    onClick={() => void generateCurrentPartAudio()}
                    disabled={generatingAudio}
                    type="button"
                  >
                    {generatingAudio ? "Generating audio..." : currentPart.audio_available ? "Regenerate audio" : "Generate audio"}
                  </button>
                ) : null}
              </div>

              <div className={`chapter-heading ${isImageOnlyView ? "chapter-heading-image-only" : ""}`}>
                <h2>{currentChapter?.title || "Loading..."}</h2>
                {currentPart && (currentChapter?.parts.length ?? 0) > 1 ? <p className="chapter-part-label">{currentPart.title}</p> : null}
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
                    {block.paragraph.tokens.map((token) => {
                      const tokenKey = `${block.paragraph.paragraph_index}:${token.token_index}`;
                      const isWordlistExact = wordlistTokenKeys.has(tokenKey);
                      const isWordlistRoot = Boolean(token.root_text && wordlistRoots.has(token.root_text));
                      return (
                        <span
                          key={token.token_index}
                          ref={(node) => {
                            tokenRefs.current[token.token_index] = node;
                          }}
                          className={readerTokenClassName(token, token.token_index === activeTokenIndex, isWordlistExact, isWordlistRoot)}
                          title={token.oxford_tip || ""}
                          data-cefr-level={token.cefr_level || ""}
                          data-root-text={token.root_text || ""}
                          onClick={() => seekToToken(token)}
                          onContextMenu={(event) => {
                            const word = selectedWord(token.text);
                            if (!word) {
                              return;
                            }
                            event.preventDefault();
                            setContextMenu({
                              word,
                              rootWord: token.root_text || word.toLowerCase(),
                              context: lookupContext(block.paragraph.text, word),
                              cefrLevel: token.cefr_level || "",
                              paragraphIndex: block.paragraph.paragraph_index,
                              tokenIndex: token.token_index,
                              target: event.currentTarget,
                              x: event.clientX,
                              y: event.clientY,
                            });
                          }}
                        >
                          {token.text}
                        </span>
                      );
                    })}
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
        {contextMenu ? (
          <div className="reader-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
            <button onClick={() => openLookup(contextMenu.word, contextMenu.context, contextMenu.target, contextMenu.cefrLevel, contextMenu.rootWord)} type="button">
              Look up word
            </button>
            {contextMenuWordIsSaved ? (
              <button onClick={() => void removeContextMenuWordFromWordlist()} type="button">
                Remove from Wordlist
              </button>
            ) : (
              <button onClick={() => void addContextMenuWordToWordlist()} type="button">
                Add to Wordlist
              </button>
            )}
          </div>
        ) : null}
        {lookupDialog ? <LookupDialog lookup={lookupDialog} onClose={() => setLookupDialog(null)} /> : null}
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

function LookupDialog({ lookup, onClose }: { lookup: LookupDialogState; onClose: () => void }) {
  const result = lookup.result;
  const choice = result?.context_definition;
  return (
    <dialog className="lookup-dialog" style={{ left: lookup.x, top: lookup.y }} open>
      <button className="lookup-close" onClick={onClose} aria-label="Close lookup" type="button">
        ×
      </button>
      <div className="lookup-head">
        <strong>{result?.word || lookup.word}</strong>
        {result?.word_type ? <span>{result.word_type}</span> : null}
        {result?.cefr_level ? <span>{result.cefr_level}</span> : null}
      </div>
      {result?.phonetics.length ? <p className="lookup-phonetic">{result.phonetics.join("  ")}</p> : null}
      {lookup.loading ? <p className="lookup-muted">Looking up...</p> : null}
      {lookup.error ? <p className="lookup-error">{lookup.error}</p> : null}
      {choice ? (
        <div className="lookup-definition">
          <p>
            {choice.definition_number ? <b>Definition {choice.definition_number}. </b> : null}
            {choice.definition}
          </p>
          {choice.examples.map((example) => (
            <blockquote key={example}>{example}</blockquote>
          ))}
        </div>
      ) : null}
    </dialog>
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

function findRoutePart(
  chapters: ChapterRecord[],
  chapterIndex: number | null,
  partIndex: number | null,
): { chapterIndex: number; partIndex: number | null } | null {
  if (chapterIndex === null || partIndex === null) {
    return null;
  }
  const chapter = chapters.find((item) => item.chapter_index === chapterIndex);
  if (chapter && !chapter.parts.length && partIndex === 0) {
    return { chapterIndex, partIndex: null };
  }
  const part = chapter?.parts.find((item) => item.part_index === partIndex);
  return chapter && part ? { chapterIndex, partIndex } : null;
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

function readerTokenClassName(token: TokenRecord, active: boolean, wordlistExact = false, wordlistRoot = false): string {
  return [
    "reader-token",
    token.cefr_level ? `level-${token.cefr_level.toLowerCase()}` : "",
    wordlistRoot ? "reader-token-wordlist-root" : "",
    wordlistExact ? "reader-token-wordlist-exact" : "",
    active ? "reader-token-active" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function estimateTokenWindow(
  tokenIndex: number,
  paragraphs: ParagraphRecord[],
  alignmentTokens: TimedTokenRecord[],
  audio: HTMLAudioElement,
): { start: number; end: number } | null {
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  const timed = alignmentTokens.find((token) => token.token_index === tokenIndex);
  if (timed) {
    return {
      start: clampAudioTime(timed.start_time, duration),
      end: clampAudioTime(timed.end_time, duration),
    };
  }

  const sorted = [...alignmentTokens].sort((left, right) => left.token_index - right.token_index);
  let previous: TimedTokenRecord | null = null;
  for (const token of sorted) {
    if (token.token_index >= tokenIndex) {
      break;
    }
    previous = token;
  }
  const next = sorted.find((token) => token.token_index > tokenIndex) ?? null;
  let start: number | null = null;
  if (previous && next) {
    const ratio = (tokenIndex - previous.token_index) / (next.token_index - previous.token_index);
    start = previous.start_time + ratio * (next.start_time - previous.start_time);
  }

  const visibleTokenIndexes = paragraphs.flatMap((paragraph) => paragraph.tokens.map((token) => token.token_index));
  const firstTokenIndex = visibleTokenIndexes[0] ?? 0;
  const lastTokenIndex = visibleTokenIndexes[visibleTokenIndexes.length - 1] ?? firstTokenIndex;
  const secondsPerToken = duration > 0 && lastTokenIndex > firstTokenIndex ? duration / (lastTokenIndex - firstTokenIndex) : 0;
  if (start === null && previous && secondsPerToken) {
    start = previous.start_time + (tokenIndex - previous.token_index) * secondsPerToken;
  }
  if (start === null && next && secondsPerToken) {
    start = next.start_time - (next.token_index - tokenIndex) * secondsPerToken;
  }

  const visibleIndex = visibleTokenIndexes.indexOf(tokenIndex);
  if (start === null && duration > 0 && visibleIndex >= 0 && visibleTokenIndexes.length > 1) {
    start = (visibleIndex / (visibleTokenIndexes.length - 1)) * duration;
  }
  if (start === null) {
    return null;
  }
  const clampedStart = clampAudioTime(start, duration);
  return {
    start: clampedStart,
    end: clampAudioTime(clampedStart + Math.min(Math.max(secondsPerToken || 0.45, 0.25), 0.9), duration),
  };
}

function clampAudioTime(time: number, duration: number): number {
  return Math.max(0, Math.min(time, duration > 0 ? duration : time));
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

function selectedWord(text: string): string {
  return text.trim().match(/[A-Za-z]+(?:['-][A-Za-z]+)*/)?.[0] ?? "";
}

const LOOKUP_CONTEXT_MAX_CHARS = 700;

function lookupContext(text: string, word: string): string {
  const context = text.split(/\s+/).join(" ").trim();
  if (!context || context.length <= LOOKUP_CONTEXT_MAX_CHARS) {
    return context || text;
  }

  const sentence = sentenceContext(context, word);
  if (sentence.length <= LOOKUP_CONTEXT_MAX_CHARS) {
    return sentence;
  }

  const index = context.toLowerCase().indexOf(word.toLowerCase());
  if (index < 0) {
    return context.slice(0, LOOKUP_CONTEXT_MAX_CHARS).trim();
  }

  const half = Math.floor((LOOKUP_CONTEXT_MAX_CHARS - word.length) / 2);
  const start = Math.max(0, Math.min(index - half, context.length - LOOKUP_CONTEXT_MAX_CHARS));
  return context.slice(start, start + LOOKUP_CONTEXT_MAX_CHARS).trim();
}

function sentenceContext(text: string, word: string): string {
  const index = text.toLowerCase().indexOf(word.toLowerCase());
  if (index < 0) {
    return text;
  }
  const start = Math.max(text.lastIndexOf(".", index), text.lastIndexOf("!", index), text.lastIndexOf("?", index)) + 1;
  const ends = [text.indexOf(".", index), text.indexOf("!", index), text.indexOf("?", index)].filter((item) => item >= 0);
  const end = ends.length ? Math.min(...ends) + 1 : text.length;
  return text.slice(start, end).trim() || text;
}

function highlightContextWord(entry: WordlistEntry): Array<string | ReactElement> {
  const word = entry.original_word || entry.root_word;
  const pattern = new RegExp(`\\b(${escapeRegExp(word)})\\b`, "i");
  const match = entry.context.match(pattern);
  if (!match || match.index === undefined) {
    return [entry.context];
  }
  const before = entry.context.slice(0, match.index);
  const marked = entry.context.slice(match.index, match.index + match[0].length);
  const after = entry.context.slice(match.index + match[0].length);
  return [
    before,
    <mark key={`${entry.id}-word`} className={`wordlist-context-word ${cefrLevelClass(entry.cefr_level)}`.trim()}>
      {marked}
    </mark>,
    after,
  ];
}

function dictionaryLookupFromWordlistEntry(entry: WordlistEntry, word: string): DictionaryLookup {
  return {
    word: entry.root_word || word,
    word_type: entry.word_type,
    cefr_level: entry.cefr_level,
    phonetics: entry.definition_phonetics,
    audio_url: entry.definition_audio_url,
    source_url: entry.definition_source_url,
    definitions: entry.definition
      ? [
          {
            number: entry.definition_number ?? 1,
            definition: entry.definition,
            examples: entry.definition_examples,
          },
        ]
      : [],
    context_definition: {
      definition_number: entry.definition_number,
      definition: entry.definition,
      examples: entry.definition_examples,
      ai_explanation: "",
      matched: Boolean(entry.definition),
    },
  };
}

function cefrLevelClass(level: string | null | undefined): string {
  return level ? `level-${level.toLowerCase()}` : "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function closestReaderToken(node: Node): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  return element?.closest<HTMLElement>(".reader-token") ?? null;
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
  if (pathname.match(/^\/wordlist\/?$/)) {
    return { kind: "wordlist" };
  }
  const partMatch = pathname.match(/^\/books\/(\d+)\/chapters\/(\d+)\/parts\/(\d+)\/?$/);
  if (partMatch) {
    return {
      kind: "reader",
      bookId: Number(partMatch[1]),
      chapterIndex: Number(partMatch[2]),
      partIndex: Number(partMatch[3]),
    };
  }
  const match = pathname.match(/^\/books\/(\d+)\/?$/);
  if (match) {
    return { kind: "reader", bookId: Number(match[1]), chapterIndex: null, partIndex: null };
  }
  const hashMatch = window.location.hash.match(/^#\/books\/(\d+)$/);
  return hashMatch ? { kind: "reader", bookId: Number(hashMatch[1]), chapterIndex: null, partIndex: null } : { kind: "library" };
}

function navigateToBook(bookId: number) {
  window.history.pushState({}, "", `/books/${bookId}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function navigateToLibrary() {
  window.history.pushState({}, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function navigateToWordlist() {
  window.history.pushState({}, "", "/wordlist");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function navigateToBookPart(bookId: number, chapterIndex: number, partIndex: number, replace = false) {
  window.history[replace ? "replaceState" : "pushState"]({}, "", `/books/${bookId}/chapters/${chapterIndex}/parts/${partIndex}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function resolveProgressParagraphIndex(lastParagraphIndex: number, part: ChapterPartRecord): number {
  if (lastParagraphIndex >= part.start_paragraph_index && lastParagraphIndex <= part.end_paragraph_index) {
    return lastParagraphIndex;
  }
  return part.start_paragraph_index;
}

function formatClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return "0:00";
  }
  const rounded = Math.floor(totalSeconds);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

async function postProgress(
  bookId: number,
  paragraphIndex: number,
  tokenIndex: number | null,
  audio: {
    audioChapterIndex: number;
    audioPartIndex: number;
    audioTimeSeconds: number;
  } | null = null,
): Promise<ProgressRecord> {
  const response = await fetch(`/api/books/${bookId}/progress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paragraph_index: paragraphIndex,
      token_index: tokenIndex,
      audio_chapter_index: audio?.audioChapterIndex ?? null,
      audio_part_index: audio?.audioPartIndex ?? null,
      audio_time_seconds: audio?.audioTimeSeconds ?? null,
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to save progress (${response.status})`);
  }
  return (await response.json()) as ProgressRecord;
}

async function postWordlistEntry(
  bookId: number,
  payload: { word: string; context: string; paragraphIndex: number; tokenIndex: number },
): Promise<WordlistEntry> {
  const response = await fetch(`/api/books/${bookId}/wordlist`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      word: payload.word,
      context: payload.context,
      paragraph_index: payload.paragraphIndex,
      token_index: payload.tokenIndex,
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to add word (${response.status})`);
  }
  return (await response.json()) as WordlistEntry;
}

async function pollWordlistEntry(bookId: number, entryId: number): Promise<WordlistEntry | null> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await delay(700);
    const response = await fetch(`/api/books/${bookId}/wordlist`);
    if (!response.ok) {
      return null;
    }
    const entries = (await response.json()) as WordlistEntry[];
    const entry = entries.find((item) => item.id === entryId);
    if (!entry || entry.definition || entry.definition_lookup_error) {
      return entry ?? null;
    }
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function deleteWordlistEntry(bookId: number, paragraphIndex: number, tokenIndex: number): Promise<void> {
  const response = await fetch(`/api/books/${bookId}/wordlist`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paragraph_index: paragraphIndex,
      token_index: tokenIndex,
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to remove word (${response.status})`);
  }
}

export default App;
