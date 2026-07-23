import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AudioLinesIcon,
  BookMarkedIcon,
  BookOpenTextIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronUpIcon,
  ImportIcon,
  LibraryIcon,
  MenuIcon,
  PauseIcon,
  PlayIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { toast } from "sonner";

import {
  addWordlistEntry,
  deleteWordlistEntry,
  generatePartAudio,
  getChapter,
  getPartAlignment,
  getPartAudio,
  getReader,
  importBooks,
  listWordlistEntries,
  listBooks,
  lookupWord,
  saveProgress,
  searchBook,
  syncPartAlignment,
  type SaveProgressInput,
} from "@/lib/api";
import type {
  BookSearchResult,
  BookSummary,
  ChapterPayload,
  DictionaryLookup,
  PartAlignmentPayload,
  PartAudioPayload,
  ReaderPayload,
  ReadingProgress,
  TimedToken,
  WordlistEntry,
} from "@/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type ViewState =
  | { kind: "library" }
  | { kind: "wordlist" }
  | { kind: "reader"; bookId: number; chapterIndex?: number };

type AudioGenerationProgress = {
  book_id: number;
  chapter_index: number;
  part_index: number;
  completed: number;
  total: number;
  percent: number;
  stage: string;
};

type ReaderImage = {
  src: string;
  alt: string;
};

type PendingResume = {
  progress: ReadingProgress;
};

type ColorMode = "frequency" | "cefr";

type SaveProgressOptions = {
  immediate?: boolean;
  blockIndex?: number;
  audioTimeSeconds?: number | null;
  audioDurationSeconds?: number | null;
  lastPlayingToken?: TimedToken | null;
};

type ActiveSearchResult = {
  blockIndex: number;
  query: string;
};

type ChapterFindMatch = {
  blockIndex: number;
  start: number;
  end: number;
};

type ChapterFindRange = {
  start: number;
  end: number;
  active: boolean;
};

type WordContextMenuState = {
  word: string;
  rootWord: string;
  context: string;
  cefrLevel: string;
  chapterIndex: number;
  blockIndex: number;
  tokenIndex: number;
  lookupX: number;
  lookupY: number;
  x: number;
  y: number;
};

type LookupDialogState = {
  word: string;
  x: number;
  y: number;
  loading: boolean;
  error: string | null;
  result: DictionaryLookup | null;
};

function App() {
  const [view, setView] = useState<ViewState>({ kind: "library" });
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [loadingBooks, setLoadingBooks] = useState(true);
  const [importing, setImporting] = useState(false);

  const refreshLibrary = useCallback(async () => {
    setLoadingBooks(true);
    try {
      setBooks(await listBooks());
    } catch (error) {
      toast.error(errorMessage(error, "Failed to load library."));
    } finally {
      setLoadingBooks(false);
    }
  }, []);

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  const handleImport = async () => {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: "EPUB books", extensions: ["epub"] }],
    });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (!paths.length) {
      return;
    }

    setImporting(true);
    try {
      const summary = await importBooks(paths);
      setBooks(summary.books);
      if (summary.failed.length) {
        toast.error(`${summary.failed.length} import failed`, {
          description: summary.failed[0]?.message,
        });
      } else if (summary.imported) {
        toast.success(`Imported ${summary.imported} book${summary.imported === 1 ? "" : "s"}.`);
      } else {
        toast.info("Those books are already in your library.");
      }
    } catch (error) {
      toast.error(errorMessage(error, "Import failed."));
    } finally {
      setImporting(false);
    }
  };

  if (view.kind === "reader") {
    return (
      <ReaderView
        bookId={view.bookId}
        initialChapterIndex={view.chapterIndex}
        onBack={async () => {
          setView({ kind: "library" });
          await refreshLibrary();
        }}
      />
    );
  }

  if (view.kind === "wordlist") {
    return (
      <TooltipProvider>
        <WordlistView
          onBack={() => setView({ kind: "library" })}
          onOpenEntry={(entry) =>
            setView({
              kind: "reader",
              bookId: entry.book_id,
              chapterIndex: entry.chapter_index,
            })
          }
        />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <LibraryView
        books={books}
        loading={loadingBooks}
        importing={importing}
        onImport={() => void handleImport()}
        onOpenWordlist={() => setView({ kind: "wordlist" })}
        onOpenBook={(book) =>
          setView({
            kind: "reader",
            bookId: book.id,
          })
        }
      />
    </TooltipProvider>
  );
}

function LibraryView({
  books,
  loading,
  importing,
  onImport,
  onOpenWordlist,
  onOpenBook,
}: {
  books: BookSummary[];
  loading: boolean;
  importing: boolean;
  onImport: () => void;
  onOpenWordlist: () => void;
  onOpenBook: (book: BookSummary) => void;
}) {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <BookOpenTextIcon aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-base font-semibold">Readalong</h1>
              <p className="text-xs text-muted-foreground">{books.length ? `${books.length} books` : "Local reader"}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onOpenWordlist}>
              <BookMarkedIcon data-icon="inline-start" />
              Word list
            </Button>
            <Button onClick={onImport} disabled={importing}>
              <ImportIcon data-icon="inline-start" />
              {importing ? "Importing" : "Import"}
            </Button>
          </div>
        </div>
      </header>

      <section className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 py-8">
        {loading ? (
          <LibrarySkeleton />
        ) : books.length ? (
          <div className="library-grid">
            {books.map((book) => (
              <BookTile key={book.id} book={book} onOpen={() => onOpenBook(book)} />
            ))}
          </div>
        ) : (
          <Empty className="rounded-md border border-dashed bg-muted/20">
            <EmptyHeader>
              <EmptyTitle>Your shelf is empty</EmptyTitle>
              <EmptyDescription>Import an EPUB and start reading locally without audio setup.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={onImport} disabled={importing}>
                <ImportIcon data-icon="inline-start" />
                {importing ? "Importing" : "Import EPUB"}
              </Button>
            </EmptyContent>
          </Empty>
        )}
      </section>
    </main>
  );
}

function WordlistView({
  onBack,
  onOpenEntry,
}: {
  onBack: () => void;
  onOpenEntry: (entry: WordlistEntry) => void;
}) {
  const [entries, setEntries] = useState<WordlistEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refreshEntries = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await listWordlistEntries());
    } catch (error) {
      toast.error(errorMessage(error, "Failed to load word list."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshEntries();
  }, [refreshEntries]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listen<WordlistEntry>("wordlist_entry_enriched", (event) => {
      setEntries((current) => upsertWordlistEntry(current, event.payload));
    }).then((unsubscribe) => {
      if (cancelled) {
        unsubscribe();
      } else {
        unlisten = unsubscribe;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const removeEntry = (entry: WordlistEntry) => {
    void deleteWordlistEntry(entry.root_word)
      .then(() => {
        setEntries((current) => current.filter((item) => item.root_word !== entry.root_word));
        toast.success("Removed from word list.");
      })
      .catch((error) => toast.error(errorMessage(error, "Failed to remove word.")));
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto grid h-16 w-full max-w-7xl grid-cols-[auto_1fr] items-center gap-3 px-6">
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to library">
            <ChevronLeftIcon />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">Word list</h1>
            <p className="truncate text-xs text-muted-foreground">
              {entries.length ? `${entries.length} saved word${entries.length === 1 ? "" : "s"}` : "Saved vocabulary"}
            </p>
          </div>
        </div>
      </header>

      <section className="wordlist-page mx-auto w-full max-w-5xl px-6 py-8">
        {loading ? (
          <div className="wordlist-list">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-32 rounded-md" />
            ))}
          </div>
        ) : entries.length ? (
          <div className="wordlist-list">
            {entries.map((entry) => (
              <article key={entry.id} className="wordlist-entry">
                <button className="wordlist-entry-main" type="button" onClick={() => onOpenEntry(entry)}>
                  <span className="wordlist-word-row">
                    <strong>{entry.root_word}</strong>
                    <span>{entry.original_word}</span>
                  </span>
                  <span className="wordlist-meta-row">
                    {entry.word_type ? <Badge variant="secondary">{entry.word_type}</Badge> : null}
                    {entry.cefr_level ? <Badge variant="outline">{entry.cefr_level}</Badge> : null}
                    <span>{entry.book_title}</span>
                    <span>{formatSavedAt(entry.created_at)}</span>
                  </span>
                  <span className="wordlist-context">{highlightContextWord(entry.context, entry.original_word)}</span>
                  {entry.definition ? (
                    <span className="wordlist-definition">
                      <span>{entry.simple_meaning || entry.definition}</span>
                      {entry.in_context_meaning ? <span>{entry.in_context_meaning}</span> : null}
                      {entry.definition_examples[0] ? <em>{entry.definition_examples[0]}</em> : null}
                    </span>
                  ) : entry.definition_lookup_error ? (
                    <span className="wordlist-error">{entry.definition_lookup_error}</span>
                  ) : (
                    <span className="wordlist-muted">Looking up definition...</span>
                  )}
                </button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" onClick={() => removeEntry(entry)} aria-label={`Remove ${entry.root_word}`}>
                      <Trash2Icon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Remove</TooltipContent>
                </Tooltip>
              </article>
            ))}
          </div>
        ) : (
          <Empty className="rounded-md border border-dashed bg-muted/20">
            <EmptyHeader>
              <EmptyTitle>No saved words yet</EmptyTitle>
              <EmptyDescription>Add words from the reader context menu.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </section>
    </main>
  );
}

function BookTile({ book, onOpen }: { book: BookSummary; onOpen: () => void }) {
  const coverSrc = book.cover_asset_path ? convertFileSrc(book.cover_asset_path) : null;
  const progress = Math.round(book.progress_percent);
  return (
    <article className="book-tile">
      <button className="book-open" type="button" onClick={onOpen} aria-label={`Open ${book.title}`}>
        <div className="cover-frame">
          {coverSrc ? (
            <img src={coverSrc} alt="" className="cover-image" />
          ) : (
            <div className="cover-fallback">
              <LibraryIcon aria-hidden="true" />
              <span>{initials(book.title)}</span>
            </div>
          )}
        </div>
        <span className="cover-title" aria-hidden="true">
          {book.title}
        </span>
      </button>
      <div className="book-progress" aria-label={`${progress}% read`}>
        <ProgressRing percent={book.progress_percent} />
        <span>{progress}%</span>
      </div>
    </article>
  );
}

function ProgressRing({ percent }: { percent: number }) {
  const radius = 18;
  const circumference = 2 * Math.PI * radius;
  const clampedPercent = Math.max(0, Math.min(100, percent));
  const offset = circumference * (1 - clampedPercent / 100);

  return (
    <svg className="progress-ring" viewBox="0 0 48 48" aria-hidden="true">
      <circle className="progress-ring-track" cx="24" cy="24" r={radius} />
      <circle
        className="progress-ring-fill"
        cx="24"
        cy="24"
        r={radius}
        style={{ strokeDasharray: circumference, strokeDashoffset: offset }}
      />
    </svg>
  );
}

function AudioGenerationRing({ percent }: { percent: number }) {
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  const clampedPercent = Math.max(0, Math.min(100, percent));
  const offset = circumference * (1 - clampedPercent / 100);

  return (
    <svg className="audio-progress-ring" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="audio-progress-ring-track" cx="12" cy="12" r={radius} />
      <circle
        className="audio-progress-ring-fill"
        cx="12"
        cy="12"
        r={radius}
        style={{ strokeDasharray: circumference, strokeDashoffset: offset }}
      />
    </svg>
  );
}

function ReaderView({
  bookId,
  initialChapterIndex,
  onBack,
}: {
  bookId: number;
  initialChapterIndex?: number;
  onBack: () => void;
}) {
  const [reader, setReader] = useState<ReaderPayload | null>(null);
  const [chapter, setChapter] = useState<ChapterPayload | null>(null);
  const [chapterIndex, setChapterIndex] = useState(initialChapterIndex ?? 0);
  const [partIndex, setPartIndex] = useState(0);
  const [tocOpen, setTocOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [partAudio, setPartAudio] = useState<PartAudioPayload | null>(null);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [generatingAudio, setGeneratingAudio] = useState(false);
  const [partAlignment, setPartAlignment] = useState<PartAlignmentPayload | null>(null);
  const [loadingAlignment, setLoadingAlignment] = useState(false);
  const [syncingAlignment, setSyncingAlignment] = useState(false);
  const [activeTokenKey, setActiveTokenKey] = useState<string | null>(null);
  const [audioProgress, setAudioProgress] = useState<AudioGenerationProgress | null>(null);
  const [audioState, setAudioState] = useState({ currentTime: 0, duration: 0, playing: false });
  const [wordlistEntries, setWordlistEntries] = useState<WordlistEntry[]>([]);
  const [colorMode, setColorMode] = useState<ColorMode>(() => storedColorMode());
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<BookSearchResult[]>([]);
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [activeSearchResult, setActiveSearchResult] = useState<ActiveSearchResult | null>(null);
  const [chapterFindOpen, setChapterFindOpen] = useState(false);
  const [chapterFindQuery, setChapterFindQuery] = useState("");
  const [activeChapterFindIndex, setActiveChapterFindIndex] = useState(0);
  const [chapterFindScrollRequest, setChapterFindScrollRequest] = useState(0);
  const [dialogImage, setDialogImage] = useState<ReaderImage | null>(null);
  const [wordContextMenu, setWordContextMenu] = useState<WordContextMenuState | null>(null);
  const [lookupDialog, setLookupDialog] = useState<LookupDialogState | null>(null);
  const [imageZoom, setImageZoom] = useState(1);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const wordPreviewAudioRef = useRef<HTMLAudioElement | null>(null);
  const dictionaryAudioRef = useRef<HTMLAudioElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const chapterFindInputRef = useRef<HTMLInputElement | null>(null);
  const visibleBlockRef = useRef<number | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const saveQueuedPayloadRef = useRef<SaveProgressInput | null>(null);
  const saveFlushScheduledRef = useRef(false);
  const saveInFlightRef = useRef(false);
  const audioSaveTimerRef = useRef<number | null>(null);
  const lastAudioSaveAtRef = useRef(0);
  const pendingResumeRef = useRef<PendingResume | null>(null);
  const pendingAudioResumeTimeRef = useRef<number | null>(null);
  const audioLookupPendingRef = useRef(false);
  const alignmentLookupPendingRef = useRef(false);
  const pendingPartBlockRef = useRef<number | null>(null);
  const tokenRefs = useRef<Record<string, HTMLElement | null>>({});
  const activeTimedTokenRef = useRef<TimedToken | null>(null);
  const wordPreviewEndTimeRef = useRef<number | null>(null);
  const lastAutoScrollTokenRef = useRef<string | null>(null);
  const lastSelectionSeekKeyRef = useRef("");
  const lastContextMenuAtRef = useRef(0);
  const lastChapterFindRevealKeyRef = useRef("");
  const searchRequestRef = useRef(0);
  const lookupRequestRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void getReader(bookId)
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setReader(payload);
        const shouldResume = initialChapterIndex === undefined;
        pendingResumeRef.current = shouldResume ? { progress: payload.progress } : null;
        const savedChapterIndex = shouldResume ? payload.progress.last_chapter_index : initialChapterIndex;
        const nextChapterIndex = payload.chapters.some((item) => item.chapter_index === savedChapterIndex) ? savedChapterIndex : 0;
        const nextChapter = payload.chapters.find((item) => item.chapter_index === nextChapterIndex);
        const savedPart = shouldResume ? nextChapter?.parts.find((part) => part.part_index === payload.progress.last_part_index) : null;
        const blockPart = shouldResume
          ? nextChapter?.parts.find(
              (part) =>
                payload.progress.last_block_index >= part.start_block_index &&
                payload.progress.last_block_index <= part.end_block_index,
            )
          : null;
        const nextPartIndex = savedPart?.part_index ?? blockPart?.part_index ?? 0;
        setChapterIndex(nextChapterIndex);
        setPartIndex(nextPartIndex);
      })
      .catch((error) => toast.error(errorMessage(error, "Failed to open book.")))
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [bookId, initialChapterIndex]);

  useEffect(() => {
    if (!reader) {
      setChapter(null);
      return;
    }
    let cancelled = false;
    setChapter(null);
    void getChapter(bookId, chapterIndex)
      .then((payload) => {
        if (!cancelled) {
          setChapter(payload);
        }
      })
      .catch((error) => toast.error(errorMessage(error, "Failed to load chapter.")));
    return () => {
      cancelled = true;
    };
  }, [bookId, chapterIndex, reader]);

  useEffect(() => {
    let cancelled = false;
    void listWordlistEntries()
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
  }, [bookId]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listen<WordlistEntry>("wordlist_entry_enriched", (event) => {
      setWordlistEntries((current) => upsertWordlistEntry(current, event.payload));
    }).then((unsubscribe) => {
      if (cancelled) {
        unsubscribe();
      } else {
        unlisten = unsubscribe;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(colorModeStorageKey(), colorMode);
  }, [colorMode]);

  const activeChapter = useMemo(
    () => reader?.chapters.find((item) => item.chapter_index === chapterIndex),
    [chapterIndex, reader],
  );
  const activePart = useMemo(
    () => activeChapter?.parts.find((item) => item.part_index === partIndex),
    [activeChapter, partIndex],
  );
  const wordlistRoots = useMemo(
    () => new Set(wordlistEntries.map((entry) => entry.root_word)),
    [wordlistEntries],
  );
  const wordlistExactKeys = useMemo(
    () => new Set(wordlistEntries.map((entry) => wordlistExactKey(entry))),
    [wordlistEntries],
  );
  const visibleBlocks = useMemo(() => {
    if (!chapter) {
      return [];
    }
    if (!activePart || !activeChapter || activeChapter.parts.length <= 1) {
      return chapter.blocks;
    }
    return chapter.blocks.filter(
      (block) => block.block_index >= activePart.start_block_index && block.block_index <= activePart.end_block_index,
    );
  }, [activeChapter, activePart, chapter]);
  const partWordCount = useMemo(
    () => visibleBlocks.reduce((total, block) => total + countWords(block.text), 0),
    [visibleBlocks],
  );
  const partParagraphCount = useMemo(
    () => visibleBlocks.filter((block) => block.kind === "paragraph").length,
    [visibleBlocks],
  );
  const timedTokensByKey = useMemo(() => {
    const tokens = new Map<string, TimedToken>();
    for (const token of partAlignment?.tokens ?? []) {
      tokens.set(timedTokenKey(token.block_index, token.token_index), token);
    }
    return tokens;
  }, [partAlignment]);
  const chapterFindMatches = useMemo(
    () => findChapterMatches(chapter, chapterFindQuery),
    [chapter, chapterFindQuery],
  );
  const activeChapterFindMatch = chapterFindOpen ? chapterFindMatches[activeChapterFindIndex] ?? null : null;
  const chapterFindRangesByBlock = useMemo(() => {
    if (!chapterFindOpen) {
      return new Map<number, ChapterFindRange[]>();
    }
    const ranges = new Map<number, ChapterFindRange[]>();
    chapterFindMatches.forEach((match, index) => {
      const blockRanges = ranges.get(match.blockIndex) ?? [];
      blockRanges.push({
        start: match.start,
        end: match.end,
        active: index === activeChapterFindIndex,
      });
      ranges.set(match.blockIndex, blockRanges);
    });
    return ranges;
  }, [activeChapterFindIndex, chapterFindMatches, chapterFindOpen]);
  const trimmedSearchQuery = searchQuery.trim();

  useEffect(() => {
    if (!searchOpen) {
      return;
    }
    window.requestAnimationFrame(() => searchInputRef.current?.focus({ preventScroll: true }));
  }, [searchOpen]);

  useEffect(() => {
    if (!chapterFindOpen) {
      return;
    }
    window.requestAnimationFrame(() => {
      chapterFindInputRef.current?.focus({ preventScroll: true });
      chapterFindInputRef.current?.select();
    });
  }, [chapterFindOpen]);

  useEffect(() => {
    if (!chapterFindMatches.length) {
      if (activeChapterFindIndex !== 0) {
        setActiveChapterFindIndex(0);
      }
      return;
    }
    if (activeChapterFindIndex >= chapterFindMatches.length) {
      setActiveChapterFindIndex(0);
    }
  }, [activeChapterFindIndex, chapterFindMatches.length]);

  useEffect(() => {
    lastChapterFindRevealKeyRef.current = "";
  }, [chapter?.chapter_index, chapterFindQuery]);

  useEffect(() => {
    if (!chapterFindOpen || !chapterFindMatches.length) {
      return;
    }
    const closestIndex = closestChapterFindMatchIndex(chapterFindMatches, visibleBlockRef.current);
    setActiveChapterFindIndex((current) => (current === closestIndex ? current : closestIndex));
  }, [chapter?.chapter_index, chapterFindMatches, chapterFindOpen]);

  const flushQueuedProgress = useCallback(() => {
    if (saveInFlightRef.current) {
      return;
    }
    const payload = saveQueuedPayloadRef.current;
    if (!payload) {
      return;
    }

    saveQueuedPayloadRef.current = null;
    saveInFlightRef.current = true;
    void saveProgress(payload)
      .catch((error) => {
        toast.error(errorMessage(error, "Failed to save progress."));
      })
      .finally(() => {
        saveInFlightRef.current = false;
        if (saveQueuedPayloadRef.current && !saveFlushScheduledRef.current) {
          saveFlushScheduledRef.current = true;
          window.setTimeout(() => {
            saveFlushScheduledRef.current = false;
            flushQueuedProgress();
          }, 0);
        }
      });
  }, []);

  const queueProgressSave = useCallback(
    (payload: SaveProgressInput) => {
      saveQueuedPayloadRef.current = payload;
      if (saveInFlightRef.current || saveFlushScheduledRef.current) {
        return;
      }
      saveFlushScheduledRef.current = true;
      window.setTimeout(() => {
        saveFlushScheduledRef.current = false;
        flushQueuedProgress();
      }, 0);
    },
    [flushQueuedProgress],
  );

  useEffect(() => {
    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;
    if (!searchOpen || !reader || trimmedSearchQuery.length < 2) {
      setSearchResults([]);
      setLoadingSearch(false);
      return;
    }

    setLoadingSearch(true);
    const timeout = window.setTimeout(() => {
      void searchBook(bookId, trimmedSearchQuery)
        .then((results) => {
          if (searchRequestRef.current === requestId) {
            setSearchResults(results);
          }
        })
        .catch((error) => {
          if (searchRequestRef.current === requestId) {
            toast.error(errorMessage(error, "Search failed."));
            setSearchResults([]);
          }
        })
        .finally(() => {
          if (searchRequestRef.current === requestId) {
            setLoadingSearch(false);
          }
        });
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [bookId, reader, searchOpen, trimmedSearchQuery]);

  const saveCurrentProgress = useCallback(
    (options: SaveProgressOptions = {}) => {
      if (!reader || !activePart || pendingResumeRef.current || pendingAudioResumeTimeRef.current !== null) {
        return;
      }
      const audio = audioRef.current;
      const blockIndex = options.blockIndex ?? visibleBlockRef.current ?? activePart.start_block_index;
      const progressChapter = reader.chapters.find(
        (chapter) => blockIndex >= chapter.start_block_index && blockIndex <= chapter.end_block_index,
      );
      const progressPart = progressChapter?.parts.find(
        (part) => blockIndex >= part.start_block_index && blockIndex <= part.end_block_index,
      );
      const progressPercent = readingProgressPercent(reader, chapter, blockIndex);
      const audioDuration =
        options.audioDurationSeconds ??
        (partAudio && audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
      const audioTime =
        options.audioTimeSeconds ??
        (partAudio && audio && Number.isFinite(audio.currentTime) ? audio.currentTime : null);
      const lastPlayingToken = partAlignment?.tokens.length
        ? options.lastPlayingToken === undefined
          ? activeTimedTokenRef.current
          : options.lastPlayingToken
        : null;
      const payload = {
        bookId,
        chapterIndex: progressChapter?.chapter_index ?? chapterIndex,
        partIndex: progressPart?.part_index ?? activePart.part_index,
        blockIndex,
        scrollRatio: currentScrollRatio(),
        progressPercent,
        audioTimeSeconds: audioTime,
        audioDurationSeconds: audioDuration,
        lastPlayingBlockIndex: lastPlayingToken?.block_index ?? null,
        lastPlayingTokenIndex: lastPlayingToken?.token_index ?? null,
      };

      if (options.immediate) {
        if (saveTimerRef.current) {
          window.clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        queueProgressSave(payload);
        return;
      }

      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        queueProgressSave(payload);
      }, 900);
    },
    [activePart, bookId, chapter, chapterIndex, partAlignment, partAudio, queueProgressSave, reader],
  );

  useEffect(() => {
    tokenRefs.current = {};
    lastAutoScrollTokenRef.current = null;
    lastSelectionSeekKeyRef.current = "";
    activeTimedTokenRef.current = null;
    setActiveTokenKey(null);
    setWordContextMenu(null);
    setLookupDialog(null);
  }, [chapterIndex, partIndex]);

  useEffect(() => {
    if (!reader || !chapter) {
      return;
    }
    const blocks = Array.from(document.querySelectorAll<HTMLElement>("[data-reader-block]"));
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) {
          return;
        }
        const blockIndex = Number((visible.target as HTMLElement).dataset.blockIndex);
        if (!Number.isFinite(blockIndex) || blockIndex === visibleBlockRef.current) {
          return;
        }
        visibleBlockRef.current = blockIndex;
        saveCurrentProgress({ blockIndex });
      },
      { rootMargin: "-35% 0px -50% 0px", threshold: [0.2, 0.6, 1] },
    );
    blocks.forEach((block) => observer.observe(block));
    return () => observer.disconnect();
  }, [chapter, reader, saveCurrentProgress]);

  useEffect(() => {
    const handleScroll = () => saveCurrentProgress();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [saveCurrentProgress]);

  useEffect(() => {
    if (!activePart) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<AudioGenerationProgress>("part-audio-progress", (event) => {
      const progress = event.payload;
      if (
        progress.book_id !== bookId ||
        progress.chapter_index !== chapterIndex ||
        progress.part_index !== activePart.part_index
      ) {
        return;
      }
      setAudioProgress(progress);
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
      } else {
        unlisten = cleanup;
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [activePart, bookId, chapterIndex]);

  useEffect(() => {
    const audio = audioRef.current;
    audio?.pause();
    audio?.removeAttribute("src");
    audio?.load();
    setPartAudio(null);
    setAudioProgress(null);
    setAudioState({ currentTime: 0, duration: 0, playing: false });
    audioLookupPendingRef.current = false;

    if (!reader || !chapter || !activePart) {
      return;
    }

    let cancelled = false;
    audioLookupPendingRef.current = true;
    setLoadingAudio(true);
    void getPartAudio(bookId, chapterIndex, activePart.part_index)
      .then((payload) => {
        if (!cancelled) {
          setPartAudio(payload);
        }
      })
      .catch((error) => toast.error(errorMessage(error, "Failed to check part audio.")))
      .finally(() => {
        if (!cancelled) {
          audioLookupPendingRef.current = false;
          setLoadingAudio(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activePart, bookId, chapter, chapterIndex, reader]);

  useEffect(() => {
    const audio = audioRef.current;
    wordPreviewAudioRef.current?.pause();
    wordPreviewEndTimeRef.current = null;
    if (!audio) {
      return;
    }
    if (!partAudio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      setAudioState({ currentTime: 0, duration: 0, playing: false });
      return;
    }

    audio.pause();
    audio.src = convertFileSrc(partAudio.audio_path);
    audio.load();
    setAudioState({ currentTime: 0, duration: 0, playing: false });
  }, [partAudio]);

  useEffect(() => {
    setPartAlignment(null);
    setActiveTokenKey(null);
    lastAutoScrollTokenRef.current = null;
    alignmentLookupPendingRef.current = false;
    if (!partAudio?.alignment_available || !activePart) {
      return;
    }

    let cancelled = false;
    alignmentLookupPendingRef.current = true;
    setLoadingAlignment(true);
    void getPartAlignment(bookId, chapterIndex, activePart.part_index)
      .then((payload) => {
        if (!cancelled) {
          setPartAlignment(payload);
        }
      })
      .catch((error) => toast.error(errorMessage(error, "Failed to load word sync.")))
      .finally(() => {
        if (!cancelled) {
          alignmentLookupPendingRef.current = false;
          setLoadingAlignment(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activePart, bookId, chapterIndex, partAudio]);

  useEffect(() => {
    const pending = pendingResumeRef.current;
    if (!pending || !reader || !chapter || !activePart) {
      return;
    }

    const finishRestore = () => {
      pendingResumeRef.current = null;
    };
    const progress = pending.progress;

    if (partAudio) {
      const audio = audioRef.current;
      const hasSavedAudioTime = progress.last_audio_time_seconds !== null;
      if (hasSavedAudioTime) {
        if (!audio || (audio.readyState < 1 && audioState.duration <= 0)) {
          return;
        }
        const duration =
          audioState.duration ||
          (Number.isFinite(audio.duration) ? audio.duration : 0) ||
          progress.last_audio_duration_seconds ||
          progress.last_audio_time_seconds ||
          0;
        const resumeTime = clampNumber(progress.last_audio_time_seconds ?? 0, 0, duration);
        pendingAudioResumeTimeRef.current = resumeTime;
        audio.pause();
        audio.currentTime = resumeTime;
        setAudioState({
          currentTime: resumeTime,
          duration,
          playing: false,
        });
        window.setTimeout(() => {
          if (pendingAudioResumeTimeRef.current !== resumeTime) {
            return;
          }
          if (Math.abs(audio.currentTime - resumeTime) > 0.25) {
            audio.pause();
            audio.currentTime = resumeTime;
            setAudioState({
              currentTime: resumeTime,
              duration,
              playing: false,
            });
          }
          pendingAudioResumeTimeRef.current = null;
        }, 500);
      }

      if (partAudio.alignment_available && (loadingAlignment || alignmentLookupPendingRef.current)) {
        return;
      }

      if (partAlignment?.tokens.length) {
        const savedToken = findSavedPlayingToken(partAlignment.tokens, progress);
        const timeToken =
          progress.last_audio_time_seconds === null ? null : timedTokenAtTime(partAlignment.tokens, progress.last_audio_time_seconds);
        const targetToken = savedToken ?? timeToken;
        if (targetToken) {
          const key = timedTokenKey(targetToken.block_index, targetToken.token_index);
          activeTimedTokenRef.current = targetToken;
          visibleBlockRef.current = targetToken.block_index;
          setActiveTokenKey(key);
          scheduleScrollRestore(() => {
            tokenRefs.current[key]?.scrollIntoView({ block: "center" });
          });
          finishRestore();
          return;
        }
      }

      restoreScrollPosition(progress, chapter);
      finishRestore();
      return;
    }

    if (loadingAudio || audioLookupPendingRef.current) {
      return;
    }

    restoreScrollPosition(progress, chapter);
    finishRestore();
  }, [activePart, audioState.duration, chapter, loadingAlignment, loadingAudio, partAlignment, partAudio, reader]);

  useEffect(() => {
    if (!chapter || pendingResumeRef.current) {
      return;
    }
    const pendingPartBlock = pendingPartBlockRef.current;
    pendingPartBlockRef.current = null;
    if (pendingPartBlock === null) {
      return;
    }
    const target = chapter.blocks.find((block) => block.block_index >= pendingPartBlock);
    if (!target) {
      window.scrollTo({ top: 0 });
      return;
    }
    visibleBlockRef.current = target.block_index;
    scheduleScrollRestore(() => {
      document.getElementById(blockDomId(target.block_index))?.scrollIntoView({ block: "center" });
    });
  }, [chapter]);

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
    audio.addEventListener("loadedmetadata", syncAudioState);
    audio.addEventListener("timeupdate", syncAudioState);
    audio.addEventListener("play", syncAudioState);
    audio.addEventListener("pause", syncAudioState);
    audio.addEventListener("ended", syncAudioState);
    return () => {
      audio.removeEventListener("loadedmetadata", syncAudioState);
      audio.removeEventListener("timeupdate", syncAudioState);
      audio.removeEventListener("play", syncAudioState);
      audio.removeEventListener("pause", syncAudioState);
      audio.removeEventListener("ended", syncAudioState);
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !partAudio) {
      return;
    }

    const savePlaybackPosition = (immediate: boolean) => {
      saveCurrentProgress({
        immediate,
        audioTimeSeconds: audio.currentTime,
        audioDurationSeconds: Number.isFinite(audio.duration) ? audio.duration : null,
        lastPlayingToken: activeTimedTokenRef.current,
      });
    };
    const scheduleImmediatePlaybackPosition = () => {
      if (audioSaveTimerRef.current) {
        window.clearTimeout(audioSaveTimerRef.current);
      }
      audioSaveTimerRef.current = window.setTimeout(() => {
        audioSaveTimerRef.current = null;
        savePlaybackPosition(true);
      }, 150);
    };
    const saveThrottledPlaybackPosition = () => {
      const now = Date.now();
      if (now - lastAudioSaveAtRef.current < 2000) {
        return;
      }
      lastAudioSaveAtRef.current = now;
      savePlaybackPosition(false);
    };
    audio.addEventListener("timeupdate", saveThrottledPlaybackPosition);
    audio.addEventListener("pause", scheduleImmediatePlaybackPosition);
    audio.addEventListener("seeked", scheduleImmediatePlaybackPosition);
    return () => {
      if (audioSaveTimerRef.current) {
        window.clearTimeout(audioSaveTimerRef.current);
        audioSaveTimerRef.current = null;
      }
      savePlaybackPosition(true);
      audio.removeEventListener("timeupdate", saveThrottledPlaybackPosition);
      audio.removeEventListener("pause", scheduleImmediatePlaybackPosition);
      audio.removeEventListener("seeked", scheduleImmediatePlaybackPosition);
    };
  }, [partAudio, saveCurrentProgress]);

  useEffect(() => {
    const audio = wordPreviewAudioRef.current;
    if (!audio) {
      return;
    }
    const stopAtEnd = () => {
      if (wordPreviewEndTimeRef.current !== null && audio.currentTime >= wordPreviewEndTimeRef.current) {
        wordPreviewEndTimeRef.current = null;
        audio.pause();
      }
    };
    const clearEnd = () => {
      wordPreviewEndTimeRef.current = null;
    };
    audio.addEventListener("timeupdate", stopAtEnd);
    audio.addEventListener("ended", clearEnd);
    return () => {
      audio.removeEventListener("timeupdate", stopAtEnd);
      audio.removeEventListener("ended", clearEnd);
    };
  }, []);

  useEffect(() => {
    const saveBeforeUnload = () => saveCurrentProgress({ immediate: true });
    window.addEventListener("beforeunload", saveBeforeUnload);
    return () => {
      saveBeforeUnload();
      window.removeEventListener("beforeunload", saveBeforeUnload);
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [saveCurrentProgress]);

  const selectChapter = useCallback((nextChapterIndex: number, nextPartIndex = 0, startBlockIndex?: number) => {
    pendingPartBlockRef.current = startBlockIndex ?? null;
    setPartIndex(nextPartIndex);
    setChapterIndex(nextChapterIndex);
    if (nextChapterIndex === chapterIndex && startBlockIndex !== undefined) {
      window.requestAnimationFrame(() => {
        document.getElementById(blockDomId(startBlockIndex))?.scrollIntoView({ block: "center" });
      });
    }
  }, [chapterIndex]);

  const toggleSearch = useCallback(() => {
    const nextOpen = !searchOpen;
    setSearchOpen(nextOpen);
    if (nextOpen) {
      setTocOpen(true);
    }
  }, [searchOpen]);

  const selectSearchResult = useCallback(
    (result: BookSearchResult) => {
      const resultChapter = reader?.chapters.find((item) => item.chapter_index === result.chapter_index);
      const resultPart = resultChapter?.parts.find(
        (part) => result.block_index >= part.start_block_index && result.block_index <= part.end_block_index,
      );
      setActiveSearchResult({ blockIndex: result.block_index, query: trimmedSearchQuery });
      selectChapter(result.chapter_index, resultPart?.part_index ?? 0, result.block_index);
    },
    [reader, selectChapter, trimmedSearchQuery],
  );

  useEffect(() => {
    if (!activeSearchResult || !chapter) {
      return;
    }
    if (!visibleBlocks.some((block) => block.block_index === activeSearchResult.blockIndex)) {
      return;
    }
    visibleBlockRef.current = activeSearchResult.blockIndex;
    scheduleScrollRestore(() => {
      document.getElementById(blockDomId(activeSearchResult.blockIndex))?.scrollIntoView({ block: "center" });
    });
  }, [activeSearchResult, chapter, visibleBlocks]);

  const openChapterFind = useCallback(() => {
    setChapterFindOpen(true);
    setActiveSearchResult(null);
    window.requestAnimationFrame(() => {
      chapterFindInputRef.current?.focus({ preventScroll: true });
      chapterFindInputRef.current?.select();
    });
  }, []);

  const closeChapterFind = useCallback(() => {
    setChapterFindOpen(false);
  }, []);

  const requestChapterFindScroll = useCallback(() => {
    setChapterFindScrollRequest((current) => current + 1);
  }, []);

  const moveChapterFind = useCallback(
    (direction: 1 | -1) => {
      if (!chapterFindMatches.length) {
        return;
      }
      setActiveChapterFindIndex((current) => (current + direction + chapterFindMatches.length) % chapterFindMatches.length);
      requestChapterFindScroll();
    },
    [chapterFindMatches.length, requestChapterFindScroll],
  );

  const confirmChapterFind = useCallback(() => {
    if (!chapterFindMatches.length) {
      return;
    }
    const revealKey = `${chapter?.chapter_index ?? ""}:${chapterFindQuery}:${activeChapterFindIndex}`;
    if (lastChapterFindRevealKeyRef.current === revealKey) {
      const nextIndex = (activeChapterFindIndex + 1) % chapterFindMatches.length;
      lastChapterFindRevealKeyRef.current = `${chapter?.chapter_index ?? ""}:${chapterFindQuery}:${nextIndex}`;
      setActiveChapterFindIndex(nextIndex);
      requestChapterFindScroll();
      return;
    }
    lastChapterFindRevealKeyRef.current = revealKey;
    requestChapterFindScroll();
  }, [activeChapterFindIndex, chapter?.chapter_index, chapterFindMatches.length, chapterFindQuery, requestChapterFindScroll]);

  useEffect(() => {
    if (!chapterFindScrollRequest || !chapterFindOpen || !activeChapterFindMatch || !chapter || !activeChapter) {
      return;
    }
    const targetPart = activeChapter.parts.find(
      (part) =>
        activeChapterFindMatch.blockIndex >= part.start_block_index &&
        activeChapterFindMatch.blockIndex <= part.end_block_index,
    );
    if (targetPart && targetPart.part_index !== partIndex) {
      setPartIndex(targetPart.part_index);
      return;
    }
    if (!visibleBlocks.some((block) => block.block_index === activeChapterFindMatch.blockIndex)) {
      return;
    }
    visibleBlockRef.current = activeChapterFindMatch.blockIndex;
    scheduleScrollRestore(() => {
      document.getElementById(blockDomId(activeChapterFindMatch.blockIndex))?.scrollIntoView({ block: "center" });
    });
  }, [activeChapter, activeChapterFindMatch, chapter, chapterFindOpen, chapterFindScrollRequest, partIndex, visibleBlocks]);

  const generateCurrentPartAudio = useCallback(
    async (regenerate: boolean) => {
      if (!activePart) {
        return;
      }
      setAudioProgress({
        book_id: bookId,
        chapter_index: chapterIndex,
        part_index: activePart.part_index,
        completed: 0,
        total: partParagraphCount,
        percent: 0,
        stage: "queued",
      });
      setGeneratingAudio(true);
      try {
        const payload = await generatePartAudio(bookId, chapterIndex, activePart.part_index, regenerate);
        setPartAudio(payload);
        if (payload.alignment_error) {
          toast.warning(regenerate ? "Audio regenerated, word sync failed." : "Audio generated, word sync failed.", {
            description: payload.alignment_error,
          });
        } else {
          toast.success(payload.alignment_available ? "Audio and word sync ready." : regenerate ? "Audio regenerated." : "Audio generated.");
        }
      } catch (error) {
        toast.error(errorMessage(error, "Audio generation failed."));
      } finally {
        setGeneratingAudio(false);
        setAudioProgress(null);
      }
    },
    [activePart, bookId, chapterIndex, partParagraphCount],
  );

  const stopWordPreview = useCallback(() => {
    wordPreviewEndTimeRef.current = null;
    wordPreviewAudioRef.current?.pause();
  }, []);

  const syncCurrentPartAlignment = useCallback(
    async (regenerate: boolean) => {
      if (!activePart || !partAudio) {
        return;
      }
      setSyncingAlignment(true);
      try {
        const payload = await syncPartAlignment(bookId, chapterIndex, activePart.part_index, regenerate);
        setPartAlignment(payload);
        setPartAudio((current) =>
          current &&
          current.book_id === bookId &&
          current.chapter_index === chapterIndex &&
          current.part_index === activePart.part_index
            ? { ...current, alignment_available: true, alignment_error: null }
            : current,
        );
        toast.success(regenerate ? "Word sync refreshed." : "Word sync ready.");
      } catch (error) {
        const message = errorMessage(error, "Word sync failed.");
        setPartAudio((current) =>
          current &&
          current.book_id === bookId &&
          current.chapter_index === chapterIndex &&
          current.part_index === activePart.part_index
            ? { ...current, alignment_available: false, alignment_error: message }
            : current,
        );
        toast.error(message);
      } finally {
        setSyncingAlignment(false);
      }
    },
    [activePart, bookId, chapterIndex, partAudio],
  );

  const toggleAudioPlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !partAudio) {
      return;
    }
    if (audio.paused) {
      stopWordPreview();
      void audio.play().catch((error) => toast.error(errorMessage(error, "Failed to play audio.")));
    } else {
      audio.pause();
    }
  }, [partAudio, stopWordPreview]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        if (chapterFindOpen) {
          closeChapterFind();
        } else {
          openChapterFind();
        }
        return;
      }
      if (event.code !== "Space" || event.repeat || shouldIgnorePlaybackShortcut(event.target)) {
        return;
      }
      event.preventDefault();
      toggleAudioPlay();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [chapterFindOpen, closeChapterFind, openChapterFind, toggleAudioPlay]);

  useEffect(() => {
    if (!partAlignment?.tokens.length) {
      activeTimedTokenRef.current = null;
      setActiveTokenKey(null);
      return;
    }
    const activeTokenIndex = partAlignment.tokens.findIndex(
      (token) => audioState.currentTime >= token.start_time && audioState.currentTime < token.end_time,
    );
    const activeToken =
      activeTokenIndex >= 0
        ? partAlignment.tokens[activeTokenIndex]
        : [...partAlignment.tokens].reverse().find((token) => token.start_time <= audioState.currentTime);
    activeTimedTokenRef.current = activeToken ?? null;
    const key = activeToken ? timedTokenKey(activeToken.block_index, activeToken.token_index) : null;
    setActiveTokenKey((current) => (current === key ? current : key));
    if (audioState.playing && activeToken) {
      saveCurrentProgress({
        audioTimeSeconds: audioState.currentTime,
        audioDurationSeconds: audioState.duration,
        blockIndex: activeToken.block_index,
        lastPlayingToken: activeToken,
      });
    }

    if (!audioState.playing || !key || lastAutoScrollTokenRef.current === key) {
      return;
    }

    const element = tokenRefs.current[key];
    if (!element) {
      return;
    }
    const bounds = element.getBoundingClientRect();
    const player = document.querySelector<HTMLElement>(".reader-audio");
    const headerInset = 88;
    const bottomInset = (player?.offsetHeight ?? 0) + 48;
    const visibleBottom = window.innerHeight - bottomInset;
    if (bounds.bottom > visibleBottom || bounds.top < headerInset) {
      lastAutoScrollTokenRef.current = key;
      element.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [audioState.currentTime, audioState.duration, audioState.playing, partAlignment, saveCurrentProgress]);

  const toggleContextMenuWordlist = useCallback(() => {
    if (!wordContextMenu) {
      return;
    }
    const menu = wordContextMenu;
    setWordContextMenu(null);
    if (wordlistRoots.has(menu.rootWord)) {
      void deleteWordlistEntry(menu.rootWord)
        .then(() => {
          setWordlistEntries((current) => current.filter((entry) => entry.root_word !== menu.rootWord));
          toast.success("Removed from word list.");
        })
        .catch((error) => toast.error(errorMessage(error, "Failed to remove word.")));
      return;
    }
    void addWordlistEntry({
      bookId,
      chapterIndex: menu.chapterIndex,
      blockIndex: menu.blockIndex,
      tokenIndex: menu.tokenIndex,
      word: menu.word,
      rootWord: menu.rootWord,
      context: menu.context,
      cefrLevel: menu.cefrLevel,
    })
      .then((entry) => {
        setWordlistEntries((current) => upsertWordlistEntry(current, entry));
        toast.success("Added to word list.", {
          description: entry.definition ? undefined : "Looking up the definition in the background.",
        });
      })
      .catch((error) => toast.error(errorMessage(error, "Failed to add word.")));
  }, [bookId, wordContextMenu, wordlistRoots]);

  useEffect(() => {
    if (!wordContextMenu) {
      return;
    }
    const close = () => setWordContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    document.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("click", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [wordContextMenu]);

  useEffect(() => {
    if (!lookupDialog) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLookupDialog(null);
      }
    };
    const closeOnOutsidePointer = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".lookup-dialog")) {
        return;
      }
      setLookupDialog(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    document.addEventListener("mousedown", closeOnOutsidePointer);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("mousedown", closeOnOutsidePointer);
    };
  }, [lookupDialog]);

  const openWordContextMenu = useCallback(
    (
      token: ChapterPayload["blocks"][number]["tokens"][number],
      blockText: string,
      blockIndex: number,
      tokenIndex: number,
      target: HTMLElement,
      clientX: number,
      clientY: number,
    ) => {
      if (!token.normalized_text) {
        return;
      }
      lastContextMenuAtRef.current = Date.now();
      const bounds = target.getBoundingClientRect();
      const menuWidth = 176;
      const menuHeight = 92;
      const dialogWidth = 380;
      setWordContextMenu({
        word: token.text,
        rootWord: token.root_text || token.normalized_text,
        context: blockText,
        cefrLevel: token.cefr_level || "",
        chapterIndex,
        blockIndex,
        tokenIndex,
        x: clampNumber(clientX, 12, Math.max(12, window.innerWidth - menuWidth - 12)),
        y: clampNumber(clientY, 72, Math.max(72, window.innerHeight - menuHeight - 12)),
        lookupX: clampNumber(bounds.left + bounds.width / 2, 12, Math.max(12, window.innerWidth - dialogWidth - 12)),
        lookupY: clampNumber(bounds.bottom + 8, 72, Math.max(72, window.innerHeight - 120)),
      });
    },
    [chapterIndex],
  );

  const lookupContextMenuWord = useCallback(() => {
    if (!wordContextMenu) {
      return;
    }
    const requestId = lookupRequestRef.current + 1;
    lookupRequestRef.current = requestId;
    const menu = wordContextMenu;
    const cachedEntry = wordlistEntries.find(
      (entry) =>
        entry.definition &&
        hasWordlistAiEnrichment(entry) &&
        (entry.root_word === menu.rootWord ||
          entry.root_word === menu.word.toLowerCase() ||
          entry.original_word.toLowerCase() === menu.word.toLowerCase()),
    );
    setWordContextMenu(null);
    if (cachedEntry) {
      setLookupDialog({
        word: menu.word,
        x: menu.lookupX,
        y: menu.lookupY,
        loading: false,
        error: null,
        result: dictionaryLookupFromWordlistEntry(cachedEntry, menu.word),
      });
      return;
    }
    setLookupDialog({
      word: menu.word,
      x: menu.lookupX,
      y: menu.lookupY,
      loading: true,
      error: null,
      result: null,
    });
    dictionaryAudioRef.current?.pause();
    void lookupWord(menu.word, `${menu.word}\n\n${menu.context}`, menu.cefrLevel, menu.rootWord)
      .then((result) => {
        if (lookupRequestRef.current !== requestId) {
          return;
        }
        setLookupDialog({
          word: menu.word,
          x: menu.lookupX,
          y: menu.lookupY,
          loading: false,
          error: null,
          result,
        });
      })
      .catch((error) => {
        if (lookupRequestRef.current !== requestId) {
          return;
        }
        setLookupDialog({
          word: menu.word,
          x: menu.lookupX,
          y: menu.lookupY,
          loading: false,
          error: errorMessage(error, "Lookup failed."),
          result: null,
        });
      });
  }, [wordContextMenu, wordlistEntries]);

  const openImage = useCallback((image: ReaderImage) => {
    setImageZoom(1);
    setDialogImage(image);
  }, []);

  const closeImage = useCallback(() => {
    setDialogImage(null);
    setImageZoom(1);
  }, []);

  useEffect(() => {
    if (!dialogImage) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeImage();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeImage, dialogImage]);

  const seekAudio = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    stopWordPreview();
    audio.currentTime = Math.max(0, Math.min(time, Number.isFinite(audio.duration) ? audio.duration : time));
    setAudioState((current) => ({ ...current, currentTime: audio.currentTime }));
  }, [stopWordPreview]);

  const seekToTimedToken = useCallback(
    (blockIndex: number, tokenIndex: number) => {
      const audio = audioRef.current;
      if (!audio || !partAudio) {
        return;
      }
      const key = timedTokenKey(blockIndex, tokenIndex);
      const token = timedTokensByKey.get(key);
      if (!token) {
        return;
      }
      stopWordPreview();
      audio.currentTime = Math.max(0, token.start_time);
      setAudioState((current) => ({ ...current, currentTime: audio.currentTime }));
      setActiveTokenKey(key);

      if (audio.paused) {
        const preview = wordPreviewAudioRef.current;
        if (!preview) {
          return;
        }
        preview.pause();
        preview.src = audio.src || convertFileSrc(partAudio.audio_path);
        wordPreviewEndTimeRef.current = Math.max(token.end_time, token.start_time + 0.15);
        preview.currentTime = token.start_time;
        void preview.play().catch((error) => toast.error(errorMessage(error, "Failed to play word preview.")));
      }
    },
    [partAudio, stopWordPreview, timedTokensByKey],
  );

  const seekToRelativeToken = useCallback(
    (blockIndex: number, tokenIndex: number) => {
      const audio = audioRef.current;
      if (!audio || !partAudio) {
        return;
      }
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : partAudio.duration_seconds;
      if (!Number.isFinite(duration) || duration <= 0) {
        return;
      }

      let wordCount = 0;
      let targetWordIndex: number | null = null;
      let previousTimedWord: { wordIndex: number; token: TimedToken } | null = null;
      let nextTimedWord: { wordIndex: number; token: TimedToken } | null = null;
      for (const block of visibleBlocks) {
        if (block.kind !== "paragraph") {
          continue;
        }
        for (let index = 0; index < block.tokens.length; index += 1) {
          const token = block.tokens[index];
          if (!token.normalized_text) {
            continue;
          }
          const timedToken = timedTokensByKey.get(timedTokenKey(block.block_index, index));
          if (block.block_index === blockIndex && index === tokenIndex) {
            targetWordIndex = wordCount;
          } else if (timedToken && targetWordIndex === null) {
            previousTimedWord = { wordIndex: wordCount, token: timedToken };
          } else if (timedToken && targetWordIndex !== null && nextTimedWord === null) {
            nextTimedWord = { wordIndex: wordCount, token: timedToken };
          }
          wordCount += 1;
        }
      }
      if (targetWordIndex === null || wordCount === 0) {
        return;
      }

      let targetTime: number;
      if (previousTimedWord && nextTimedWord && nextTimedWord.token.start_time >= previousTimedWord.token.end_time) {
        const gapWords = nextTimedWord.wordIndex - previousTimedWord.wordIndex;
        const gapRatio = gapWords <= 0 ? 0 : (targetWordIndex - previousTimedWord.wordIndex) / gapWords;
        targetTime = previousTimedWord.token.end_time + (nextTimedWord.token.start_time - previousTimedWord.token.end_time) * gapRatio;
      } else {
        const ratio = wordCount === 1 ? 0 : targetWordIndex / (wordCount - 1);
        targetTime = duration * ratio;
      }

      stopWordPreview();
      audio.currentTime = clampNumber(targetTime, 0, duration);
      setAudioState((current) => ({ ...current, currentTime: audio.currentTime }));
      setActiveTokenKey(timedTokenKey(blockIndex, tokenIndex));
    },
    [partAudio, stopWordPreview, timedTokensByKey, visibleBlocks],
  );

  useEffect(() => {
    if (!partAlignment?.tokens.length) {
      return;
    }

    const seekSelectedWord = (event: KeyboardEvent | MouseEvent) => {
      if (event instanceof MouseEvent && event.button !== 0) {
        return;
      }
      if (Date.now() - lastContextMenuAtRef.current < 500) {
        return;
      }
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
      const selectedNode = selection.anchorNode;
      const selectedElement =
        selectedNode instanceof HTMLElement ? selectedNode : selectedNode?.parentElement ?? null;
      const tokenElement = selectedElement?.closest<HTMLElement>("[data-timed-token-key]");
      if (!tokenElement || tokenElement.textContent?.trim() !== text) {
        return;
      }
      const blockIndex = Number(tokenElement.dataset.blockIndex);
      const tokenIndex = Number(tokenElement.dataset.tokenIndex);
      const key = tokenElement.dataset.timedTokenKey ?? "";
      if (!Number.isFinite(blockIndex) || !Number.isFinite(tokenIndex) || !timedTokensByKey.has(key)) {
        return;
      }
      const seekKey = `${key}:${text}`;
      if (lastSelectionSeekKeyRef.current === seekKey) {
        return;
      }
      lastSelectionSeekKeyRef.current = seekKey;
      seekToTimedToken(blockIndex, tokenIndex);
    };

    document.addEventListener("mouseup", seekSelectedWord);
    document.addEventListener("keyup", seekSelectedWord);
    return () => {
      document.removeEventListener("mouseup", seekSelectedWord);
      document.removeEventListener("keyup", seekSelectedWord);
    };
  }, [partAlignment, seekToTimedToken, timedTokensByKey]);

  const audioGenerationPercent = Math.round(audioProgress?.percent ?? 0);
  const audioGenerationStatus =
    audioProgress && audioProgress.total > 0
      ? `Generating audio, ${audioGenerationPercent}%, ${audioProgress.completed} of ${audioProgress.total} paragraphs complete`
      : "Generating audio";

  return (
    <TooltipProvider>
      <main className="min-h-screen bg-reader text-foreground">
        <header className="sticky top-0 z-20 border-b bg-reader/95 backdrop-blur">
          <div className="grid h-16 grid-cols-[auto_1fr_auto] items-center gap-3 px-4">
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to library">
                    <ChevronLeftIcon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Library</TooltipContent>
              </Tooltip>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  const nextOpen = !tocOpen;
                  setTocOpen(nextOpen);
                  if (!nextOpen) {
                    setSearchOpen(false);
                  }
                }}
                aria-label="Toggle chapters"
              >
                <MenuIcon />
              </Button>
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold">{reader?.title || "Opening book"}</h1>
              <p className="truncate text-xs text-muted-foreground">{activeChapter?.title || chapter?.title || "Chapter"}</p>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant={searchOpen ? "secondary" : "ghost"} size="icon" onClick={toggleSearch} aria-label="Search book">
                    <SearchIcon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Search</TooltipContent>
              </Tooltip>
              <Badge variant="secondary">{reader ? `${Math.round(reader.progress.progress_percent)}%` : "..."}</Badge>
            </div>
          </div>
        </header>

        <div className={cn("reader-shell", tocOpen && "has-toc")}>
          {tocOpen ? (
            <aside className="toc-panel">
              <ScrollArea className="h-[calc(100vh-4rem)]">
                <div className="flex flex-col gap-2 p-4">
                  {searchOpen ? (
                    <SearchPanel
                      inputRef={searchInputRef}
                      query={searchQuery}
                      results={searchResults}
                      loading={loadingSearch}
                      activeBlockIndex={activeSearchResult?.blockIndex ?? null}
                      onQueryChange={(query) => {
                        setSearchQuery(query);
                        setActiveSearchResult(null);
                      }}
                      onSelect={selectSearchResult}
                      onClose={() => {
                        setSearchOpen(false);
                        setActiveSearchResult(null);
                      }}
                    />
                  ) : null}
                  <p className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Chapters</p>
                  {reader?.chapters.map((item) => (
                    <div key={item.chapter_index} className="toc-group">
                      <button
                        className={cn("toc-item", item.chapter_index === chapterIndex && "active")}
                        type="button"
                        onClick={() => selectChapter(item.chapter_index, 0, item.start_block_index)}
                      >
                        <span className="toc-title">{formatChapterTitle(item.title)}</span>
                        {item.parts.length > 1 ? <span className="toc-count">{item.parts.length}</span> : null}
                      </button>
                      {item.chapter_index === chapterIndex && item.parts.length > 1 ? (
                        <div className="toc-parts" aria-label={`${item.title} parts`}>
                          {item.parts.map((part) => (
                            <button
                              key={part.part_index}
                              className={cn("toc-part", part.part_index === partIndex && "active")}
                              type="button"
                              onClick={() => selectChapter(item.chapter_index, part.part_index, part.start_block_index)}
                            >
                              {part.title}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </aside>
          ) : null}

          <article className="reader-page">
            {loading || !reader || !chapter ? (
              <ReaderSkeleton />
            ) : (
              <>
                <div className="reader-heading">
                  <h2>{chapter.title}</h2>
                  <div className="part-stats" aria-label="Part statistics">
                    {activePart && activeChapter && activeChapter.parts.length > 1 ? <span className="part-label">{activePart.title}</span> : null}
                    <span>{partWordCount.toLocaleString()} words</span>
                    <div className="color-mode-toggle" aria-label="Word color mode">
                      {(["frequency", "cefr"] as const).map((mode) => (
                        <button
                          key={mode}
                          className={cn(colorMode === mode && "active")}
                          type="button"
                          onClick={() => setColorMode(mode)}
                          aria-pressed={colorMode === mode}
                        >
                          {mode === "frequency" ? "Frequency" : "CEFR"}
                        </button>
                      ))}
                    </div>
                    {partAudio ? (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button size="sm" disabled={generatingAudio || loadingAudio || syncingAlignment} aria-label={generatingAudio ? audioGenerationStatus : undefined}>
                            {generatingAudio ? <AudioGenerationRing percent={audioProgress?.percent ?? 0} /> : <AudioLinesIcon data-icon="inline-start" />}
                            {generatingAudio ? `Generating ${audioGenerationPercent}%` : "Regenerate audio"}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Regenerate audio?</AlertDialogTitle>
                            <AlertDialogDescription>
                              The current generated audio for this part will be replaced.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => void generateCurrentPartAudio(true)}>
                              Regenerate
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    ) : (
                      <Button
                        size="sm"
                        disabled={generatingAudio || loadingAudio || !activePart}
                        onClick={() => void generateCurrentPartAudio(false)}
                        aria-label={generatingAudio ? audioGenerationStatus : undefined}
                      >
                        {generatingAudio ? <AudioGenerationRing percent={audioProgress?.percent ?? 0} /> : <AudioLinesIcon data-icon="inline-start" />}
                        {generatingAudio ? `Generating ${audioGenerationPercent}%` : "Generate audio"}
                      </Button>
                    )}
                    {partAudio ? (
                      <Button
                        size="sm"
                        variant={partAlignment ? "secondary" : "default"}
                        disabled={syncingAlignment || generatingAudio || loadingAlignment}
                        onClick={() => void syncCurrentPartAlignment(Boolean(partAlignment))}
                      >
                        <AudioLinesIcon data-icon="inline-start" />
                        {syncingAlignment ? "Syncing words" : partAlignment ? "Resync words" : "Sync words"}
                      </Button>
                    ) : null}
                    {loadingAlignment ? <span>Loading word sync</span> : null}
                    {!loadingAlignment && !partAlignment && partAudio?.alignment_error ? <span>Word sync unavailable</span> : null}
                  </div>
                </div>
                {chapterFindOpen ? (
                  <ChapterFindBar
                    inputRef={chapterFindInputRef}
                    query={chapterFindQuery}
                    activeIndex={chapterFindMatches.length ? activeChapterFindIndex : -1}
                    matchCount={chapterFindMatches.length}
                    onQueryChange={setChapterFindQuery}
                    onPrevious={() => moveChapterFind(-1)}
                    onNext={() => moveChapterFind(1)}
                    onConfirm={confirmChapterFind}
                    onClose={closeChapterFind}
                  />
                ) : null}
                <Separator />
                <div className="reader-text">
                  {visibleBlocks.map((block) =>
                    block.kind === "paragraph" ? (
                      <p
                        key={block.block_index}
                        id={blockDomId(block.block_index)}
                        data-reader-block
                        data-block-index={block.block_index}
                      >
                        <ReaderTokens
                          bookId={bookId}
                          block={block}
                          chapterIndex={chapterIndex}
                          colorMode={colorMode}
                          activeTokenKey={activeTokenKey}
                          activeSearchResult={activeSearchResult}
                          chapterFindRanges={chapterFindRangesByBlock.get(block.block_index) ?? []}
                          wordlistRoots={wordlistRoots}
                          wordlistExactKeys={wordlistExactKeys}
                          timedTokensByKey={timedTokensByKey}
                          onSeekToken={seekToTimedToken}
                          onSeekRelativeToken={seekToRelativeToken}
                          onOpenWordContextMenu={openWordContextMenu}
                          onTokenRef={(tokenKey, node) => {
                            tokenRefs.current[tokenKey] = node;
                          }}
                        />
                      </p>
                    ) : (
                      <ReaderFigure
                        key={block.block_index}
                        block={block}
                        fallbackAlt={chapter.title}
                        onOpen={openImage}
                      />
                    ),
                  )}
                </div>
              </>
            )}
          </article>
        </div>
        <audio ref={audioRef} preload="metadata" className="hidden" />
        <audio ref={wordPreviewAudioRef} preload="metadata" className="hidden" />
        <audio ref={dictionaryAudioRef} preload="metadata" className="hidden" />
        {wordContextMenu ? (
          <WordContextMenu
            menu={wordContextMenu}
            saved={wordlistRoots.has(wordContextMenu.rootWord)}
            onLookup={lookupContextMenuWord}
            onToggleWordlist={toggleContextMenuWordlist}
          />
        ) : null}
        {lookupDialog ? (
          <LookupDialog
            lookup={lookupDialog}
            onClose={() => setLookupDialog(null)}
            onMove={(x, y) => setLookupDialog((current) => (current ? { ...current, x, y } : current))}
            onPlayPronunciation={(audioUrl) => {
              const audio = dictionaryAudioRef.current;
              if (!audio) {
                return;
              }
              audio.pause();
              audio.src = audioUrl;
              void audio.play().catch(() => undefined);
            }}
          />
        ) : null}
        {dialogImage ? (
          <ImageDialog
            image={dialogImage}
            zoom={imageZoom}
            onZoomChange={setImageZoom}
            onClose={closeImage}
          />
        ) : null}
        {partAudio ? (
          <PartAudioPlayer
            playing={audioState.playing}
            currentTime={audioState.currentTime}
            duration={audioState.duration}
            onTogglePlay={toggleAudioPlay}
            onSeek={seekAudio}
          />
        ) : null}
      </main>
    </TooltipProvider>
  );
}

function ReaderFigure({
  block,
  fallbackAlt,
  onOpen,
}: {
  block: ChapterPayload["blocks"][number];
  fallbackAlt: string;
  onOpen: (image: ReaderImage) => void;
}) {
  if (!block.asset_path) {
    return null;
  }
  const image = {
    src: convertFileSrc(block.asset_path),
    alt: block.alt || fallbackAlt,
  };
  return (
    <figure
      id={blockDomId(block.block_index)}
      className="reader-figure"
      data-reader-block
      data-block-index={block.block_index}
    >
      <button
        className="reader-image-button"
        type="button"
        onClick={() => onOpen(image)}
        aria-label="Open image"
      >
        <img className="reader-image" src={image.src} alt={image.alt} />
      </button>
    </figure>
  );
}

function WordContextMenu({
  menu,
  saved,
  onLookup,
  onToggleWordlist,
}: {
  menu: WordContextMenuState;
  saved: boolean;
  onLookup: () => void;
  onToggleWordlist: () => void;
}) {
  return (
    <div
      className="reader-context-menu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button type="button" onClick={onLookup}>
        Look up word
      </button>
      <button type="button" onClick={onToggleWordlist}>
        {saved ? "Remove from word list" : "Add to word list"}
      </button>
    </div>
  );
}

function LookupDialog({
  lookup,
  onClose,
  onMove,
  onPlayPronunciation,
}: {
  lookup: LookupDialogState;
  onClose: () => void;
  onMove: (x: number, y: number) => void;
  onPlayPronunciation: (audioUrl: string) => void;
}) {
  const result = lookup.result;
  const choice = result?.context_definition;
  const examples = choice?.examples ?? [];
  const displayWord = result?.selected_word || lookup.word;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const startDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest("button")) {
      return;
    }
    event.preventDefault();
    const dialog = dialogRef.current;
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = lookup.x;
    const startTop = lookup.y;
    const width = dialog?.offsetWidth ?? 380;
    const height = dialog?.offsetHeight ?? 260;
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const maxTop = Math.max(72, window.innerHeight - height - 8);

    const move = (moveEvent: MouseEvent) => {
      onMove(
        clampNumber(startLeft + moveEvent.clientX - startX, 8, maxLeft),
        clampNumber(startTop + moveEvent.clientY - startY, 72, maxTop),
      );
    };
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };

    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  };

  return (
    <div
      ref={dialogRef}
      className="lookup-dialog"
      style={{ left: lookup.x, top: lookup.y }}
      role="dialog"
      aria-label={`${displayWord} lookup`}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="lookup-toolbar" onMouseDown={startDrag}>
        <div className="lookup-title">
          <strong>{displayWord}</strong>
          <div className="lookup-badges">
            {result?.cefr_level ? <Badge variant="secondary">{result.cefr_level}</Badge> : null}
            {result?.word_type ? <Badge variant="outline">{result.word_type}</Badge> : null}
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close lookup">
          <XIcon />
        </Button>
      </div>

      {lookup.loading ? (
        <div className="lookup-loading">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : null}

      {lookup.error ? <p className="lookup-error">{lookup.error}</p> : null}

      {result ? (
        <div className="lookup-content">
          {result.phonetics.length ? (
            <div className="lookup-pronunciation">
              {result.audio_url ? (
                <button type="button" className="lookup-phonetic-button" onClick={() => onPlayPronunciation(result.audio_url)}>
                  {result.phonetics.join("  ")}
                </button>
              ) : (
                <span>{result.phonetics.join("  ")}</span>
              )}
            </div>
          ) : null}

          <LookupSection title="Simple meaning" body={result.simple_meaning} />
          <LookupSection title="In context" body={result.in_context_meaning} />

          {choice?.matched && choice.definition ? (
            <section className="lookup-section">
              <h3>Oxford definition</h3>
              <p>
                {choice.definition_number ? <b>Definition {choice.definition_number}. </b> : null}
                {choice.definition}
              </p>
              {result.source_url ? (
                <a href={result.source_url} target="_blank" rel="noreferrer">
                  Oxford Learner's Dictionary
                </a>
              ) : null}
            </section>
          ) : null}

          <LookupSection title="Original meaning" body={result.original_meaning} />

          {examples.length ? (
            <section className="lookup-section">
              <h3>Examples</h3>
              <div className="lookup-examples">
                {examples.slice(0, 3).map((example) => (
                  <blockquote key={example}>{example}</blockquote>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function LookupSection({ title, body }: { title: string; body: string }) {
  if (!body.trim()) {
    return null;
  }
  return (
    <section className="lookup-section">
      <h3>{title}</h3>
      <p>{body}</p>
    </section>
  );
}

function ImageDialog({
  image,
  zoom,
  onZoomChange,
  onClose,
}: {
  image: ReaderImage;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  onClose: () => void;
}) {
  const setZoom = (value: number) => onZoomChange(Math.max(0.5, Math.min(3, value)));
  return (
    <div className="image-dialog-backdrop" onClick={onClose} role="presentation">
      <dialog className="image-dialog" open onClick={(event) => event.stopPropagation()}>
        <div className="image-dialog-toolbar" aria-label="Image controls">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="secondary" size="icon" onClick={() => setZoom(zoom - 0.25)} aria-label="Zoom out">
                <ZoomOutIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Zoom out</TooltipContent>
          </Tooltip>
          <input
            className="image-zoom-slider"
            type="range"
            min={0.5}
            max={3}
            step={0.05}
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
            aria-label="Image zoom"
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="secondary" size="icon" onClick={() => setZoom(zoom + 0.25)} aria-label="Zoom in">
                <ZoomInIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Zoom in</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="secondary" size="icon" onClick={onClose} aria-label="Close image">
                <XIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Close</TooltipContent>
          </Tooltip>
        </div>
        <div className="image-dialog-viewport">
          <img
            className="image-dialog-image"
            src={image.src}
            alt={image.alt}
            style={{ transform: `scale(${zoom})` }}
          />
        </div>
      </dialog>
    </div>
  );
}

function LibrarySkeleton() {
  return (
    <div className="library-grid">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="book-tile">
          <Skeleton className="shelf-skeleton-cover" />
          <Skeleton className="shelf-skeleton-progress" />
        </div>
      ))}
    </div>
  );
}

function PartAudioPlayer({
  playing,
  currentTime,
  duration,
  onTogglePlay,
  onSeek,
}: {
  playing: boolean;
  currentTime: number;
  duration: number;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
}) {
  const safeDuration = Math.max(duration, 0);
  const remainingTime = safeDuration > 0 ? Math.max(safeDuration - currentTime, 0) : 0;
  return (
    <div className="reader-audio" aria-label="Audio playback controls">
      <Button className="audio-button" size="icon" onClick={onTogglePlay} aria-label={playing ? "Pause" : "Play"}>
        {playing ? <PauseIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
      </Button>
      <div className="audio-timeline">
        <span className="audio-time audio-time-current" aria-label={`${formatClock(currentTime)} elapsed`}>
          {formatClock(currentTime)}
        </span>
        <input
          className="audio-slider"
          type="range"
          min={0}
          max={safeDuration}
          step={0.1}
          value={Math.min(currentTime, safeDuration)}
          onChange={(event) => onSeek(Number(event.target.value))}
          aria-label="Audio position"
        />
        <span className="audio-time audio-time-total" aria-label={`${formatClock(duration)} total`}>
          {formatClock(duration)}
        </span>
        <span className="audio-time audio-time-left" aria-label={`${formatClock(remainingTime)} remaining`}>
          ({formatClock(remainingTime)})
        </span>
      </div>
    </div>
  );
}

function SearchPanel({
  inputRef,
  query,
  results,
  loading,
  activeBlockIndex,
  onQueryChange,
  onSelect,
  onClose,
}: {
  inputRef: RefObject<HTMLInputElement>;
  query: string;
  results: BookSearchResult[];
  loading: boolean;
  activeBlockIndex: number | null;
  onQueryChange: (query: string) => void;
  onSelect: (result: BookSearchResult) => void;
  onClose: () => void;
}) {
  const trimmedQuery = query.trim();
  const status = loading
    ? "Searching"
    : trimmedQuery.length < 2
      ? "Type at least 2 characters"
      : `${results.length} result${results.length === 1 ? "" : "s"}`;
  return (
    <section className="search-panel" aria-label="Book search" onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    }}>
      <div className="search-field">
        <SearchIcon aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search book"
          aria-label="Search book"
        />
        {query ? (
          <Button variant="ghost" size="icon" onClick={() => onQueryChange("")} aria-label="Clear search">
            <XIcon />
          </Button>
        ) : null}
      </div>
      <div className="search-status">{status}</div>
      {trimmedQuery.length >= 2 && !loading ? (
        <div className="search-results">
          {results.length ? (
            results.map((result) => (
              <button
                key={`${result.chapter_index}-${result.block_index}`}
                className={cn("search-result", activeBlockIndex === result.block_index && "active")}
                type="button"
                onClick={() => onSelect(result)}
              >
                <span className="search-result-title">{formatChapterTitle(result.chapter_title)}</span>
                <span className="search-result-snippet">
                  <HighlightedSnippet result={result} />
                </span>
                {result.match_count > 1 ? <span className="search-result-count">{result.match_count} matches</span> : null}
              </button>
            ))
          ) : (
            <div className="search-empty">No matches</div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function ChapterFindBar({
  inputRef,
  query,
  activeIndex,
  matchCount,
  onQueryChange,
  onPrevious,
  onNext,
  onConfirm,
  onClose,
}: {
  inputRef: RefObject<HTMLInputElement>;
  query: string;
  activeIndex: number;
  matchCount: number;
  onQueryChange: (query: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const counter = query.trim() ? `${activeIndex >= 0 ? activeIndex + 1 : 0}/${matchCount}` : "0/0";
  return (
    <section
      className="chapter-find-bar"
      aria-label="Find in current chapter"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          if (event.shiftKey) {
            onPrevious();
          } else {
            onConfirm();
          }
        }
      }}
    >
      <SearchIcon aria-hidden="true" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Find in chapter"
        aria-label="Find in current chapter"
      />
      <span className="chapter-find-count" aria-label={`${matchCount} matches`}>
        {counter}
      </span>
      <Button variant="ghost" size="icon" onClick={onPrevious} disabled={!matchCount} aria-label="Previous match">
        <ChevronUpIcon />
      </Button>
      <Button variant="ghost" size="icon" onClick={onNext} disabled={!matchCount} aria-label="Next match">
        <ChevronDownIcon />
      </Button>
      <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close find">
        <XIcon />
      </Button>
    </section>
  );
}

function HighlightedSnippet({ result }: { result: BookSearchResult }) {
  const before = result.snippet.slice(0, result.match_start);
  const match = result.snippet.slice(result.match_start, result.match_end);
  const after = result.snippet.slice(result.match_end);
  return (
    <>
      {before}
      <mark>{match}</mark>
      {after}
    </>
  );
}

function ReaderSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-4 w-1/4" />
      {Array.from({ length: 8 }).map((_, index) => (
        <Skeleton key={index} className="h-20 w-full" />
      ))}
    </div>
  );
}

function initials(title: string) {
  return title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");
}

function blockDomId(blockIndex: number) {
  return `reader-block-${blockIndex}`;
}

function formatChapterTitle(title: string) {
  return title.replace(/^(\d+)\s+/, "$1 ");
}

function countWords(text: string) {
  return text.match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function formatClock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0:00";
  }
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const remainingSeconds = whole % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function currentScrollRatio() {
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  if (maxScroll <= 0) {
    return 0;
  }
  return clampNumber(window.scrollY / maxScroll, 0, 1);
}

function scheduleScrollRestore(callback: () => void) {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(callback);
  });
}

function restoreScrollPosition(progress: ReadingProgress, chapter: ChapterPayload) {
  scheduleScrollRestore(() => {
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    if (maxScroll > 0 && progress.last_read_at) {
      window.scrollTo({ top: clampNumber(progress.last_scroll_ratio, 0, 1) * maxScroll });
      return;
    }

    const target = chapter.blocks.find((block) => block.block_index >= progress.last_block_index);
    if (target) {
      document.getElementById(blockDomId(target.block_index))?.scrollIntoView({ block: "center" });
    } else {
      window.scrollTo({ top: 0 });
    }
  });
}

function readingProgressPercent(reader: ReaderPayload, chapter: ChapterPayload | null, blockIndex: number) {
  if (reader.total_progress_units <= 0) {
    return reader.progress.progress_percent;
  }

  const progressChapter = reader.chapters.find(
    (item) => blockIndex >= item.start_block_index && blockIndex <= item.end_block_index,
  );
  if (!progressChapter) {
    return reader.progress.progress_percent;
  }

  let currentUnits = progressChapter.progress_start_unit;
  if (progressChapter.contributes_to_progress && chapter?.chapter_index === progressChapter.chapter_index) {
    currentUnits += chapter.blocks
      .filter((block) => block.kind === "paragraph" && block.block_index < blockIndex)
      .reduce((total, block) => total + block.text.length, 0);
  }

  const percent = (currentUnits / reader.total_progress_units) * 100;
  return Math.min(100, Math.max(0, Math.round(percent * 10) / 10));
}

function findSavedPlayingToken(tokens: TimedToken[], progress: ReadingProgress) {
  if (progress.last_playing_block_index === null || progress.last_playing_token_index === null) {
    return null;
  }
  return (
    tokens.find(
      (token) =>
        token.block_index === progress.last_playing_block_index &&
        token.token_index === progress.last_playing_token_index,
    ) ?? null
  );
}

function timedTokenAtTime(tokens: TimedToken[], time: number) {
  return (
    tokens.find((token) => time >= token.start_time && time < token.end_time) ??
    [...tokens].reverse().find((token) => token.start_time <= time) ??
    null
  );
}

function caseInsensitiveTextRange(text: string, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length < 2) {
    return null;
  }
  const start = text.toLocaleLowerCase().indexOf(needle);
  return start === -1 ? null : { start, end: start + needle.length };
}

function findChapterMatches(chapter: ChapterPayload | null, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!chapter || !needle) {
    return [];
  }
  const matches: ChapterFindMatch[] = [];
  for (const block of chapter.blocks) {
    if (block.kind !== "paragraph") {
      continue;
    }
    const haystack = block.text.toLocaleLowerCase();
    let start = haystack.indexOf(needle);
    while (start !== -1) {
      matches.push({
        blockIndex: block.block_index,
        start,
        end: start + needle.length,
      });
      start = haystack.indexOf(needle, start + needle.length);
    }
  }
  return matches;
}

function closestChapterFindMatchIndex(matches: ChapterFindMatch[], fallbackBlockIndex: number | null) {
  if (!matches.length) {
    return 0;
  }
  const viewportTop = 0;
  const viewportBottom = window.innerHeight;
  const viewportCenter = viewportBottom / 2;
  let bestDomIndex = -1;
  let bestDomDistance = Number.POSITIVE_INFINITY;
  let bestFallbackIndex = 0;
  let bestFallbackDistance = Number.POSITIVE_INFINITY;

  matches.forEach((match, index) => {
    const element = document.getElementById(blockDomId(match.blockIndex));
    if (element) {
      const bounds = element.getBoundingClientRect();
      const distance =
        bounds.bottom < viewportTop
          ? viewportTop - bounds.bottom
          : bounds.top > viewportBottom
            ? bounds.top - viewportBottom
            : Math.abs((bounds.top + bounds.bottom) / 2 - viewportCenter);
      if (distance < bestDomDistance) {
        bestDomDistance = distance;
        bestDomIndex = index;
      }
      return;
    }

    if (fallbackBlockIndex !== null) {
      const distance = Math.abs(match.blockIndex - fallbackBlockIndex);
      if (distance < bestFallbackDistance) {
        bestFallbackDistance = distance;
        bestFallbackIndex = index;
      }
    }
  });

  return bestDomIndex === -1 ? bestFallbackIndex : bestDomIndex;
}

function ReaderTokens({
  bookId,
  block,
  chapterIndex,
  colorMode,
  activeTokenKey,
  activeSearchResult,
  chapterFindRanges,
  wordlistRoots,
  wordlistExactKeys,
  timedTokensByKey,
  onSeekToken,
  onSeekRelativeToken,
  onOpenWordContextMenu,
  onTokenRef,
}: {
  bookId: number;
  block: ChapterPayload["blocks"][number];
  chapterIndex: number;
  colorMode: ColorMode;
  activeTokenKey: string | null;
  activeSearchResult: ActiveSearchResult | null;
  chapterFindRanges: ChapterFindRange[];
  wordlistRoots: Set<string>;
  wordlistExactKeys: Set<string>;
  timedTokensByKey: Map<string, TimedToken>;
  onSeekToken: (blockIndex: number, tokenIndex: number) => void;
  onSeekRelativeToken: (blockIndex: number, tokenIndex: number) => void;
  onOpenWordContextMenu: (
    token: ChapterPayload["blocks"][number]["tokens"][number],
    blockText: string,
    blockIndex: number,
    tokenIndex: number,
    target: HTMLElement,
    clientX: number,
    clientY: number,
  ) => void;
  onTokenRef: (tokenKey: string, node: HTMLElement | null) => void;
}) {
  if (!block.tokens.length) {
    return <>{block.text}</>;
  }
  const searchRange =
    activeSearchResult && activeSearchResult.blockIndex === block.block_index
      ? caseInsensitiveTextRange(block.text, activeSearchResult.query)
      : null;
  let tokenOffset = 0;
  return (
    <>
      {block.tokens.map((token, index) => {
        const exactKey = wordlistTokenKey(bookId, chapterIndex, block.block_index, index);
        const syncKey = timedTokenKey(block.block_index, index);
        const hasTiming = timedTokensByKey.has(syncKey);
        const colorLevel = colorMode === "frequency" ? token.frequency_level : token.cefr_level;
        const rootWord = token.root_text || token.normalized_text;
        const isWordlistExact = wordlistExactKeys.has(exactKey);
        const isWordlistRoot = Boolean(rootWord && wordlistRoots.has(rootWord) && !isWordlistExact);
        const tokenStart = tokenOffset;
        const tokenEnd = tokenStart + token.text.length;
        const isBookSearchHit = Boolean(searchRange && tokenEnd > searchRange.start && tokenStart < searchRange.end);
        const isChapterFindHit = chapterFindRanges.some((range) => tokenEnd > range.start && tokenStart < range.end);
        const isActiveChapterFindHit = chapterFindRanges.some(
          (range) => range.active && tokenEnd > range.start && tokenStart < range.end,
        );
        tokenOffset = tokenEnd;
        return (
          <span
            key={`${block.block_index}-${index}`}
            ref={(node) => onTokenRef(syncKey, node)}
            className={cn(
              "reader-token",
              colorLevel && `level-${colorLevel.toLowerCase()}`,
              token.normalized_text && "clickable",
              isWordlistRoot && "wordlisted-root",
              isWordlistExact && "marked",
              hasTiming && "synced",
              activeTokenKey === syncKey && "active",
              (isBookSearchHit || isChapterFindHit) && "search-hit",
              isActiveChapterFindHit && "find-hit-active",
            )}
            data-cefr-level={token.cefr_level || undefined}
            data-frequency-level={token.frequency_level || undefined}
            data-frequency-count={token.frequency_count || undefined}
            data-root-text={token.root_text || undefined}
            data-block-index={block.block_index}
            data-token-index={index}
            data-timed-token-key={syncKey}
            onClick={() => {
              if (hasTiming) {
                onSeekToken(block.block_index, index);
              } else if (token.normalized_text) {
                onSeekRelativeToken(block.block_index, index);
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (token.normalized_text) {
                onOpenWordContextMenu(token, block.text, block.block_index, index, event.currentTarget, event.clientX, event.clientY);
              }
            }}
          >
            {token.text}
          </span>
        );
      })}
    </>
  );
}

function wordlistExactKey(entry: WordlistEntry) {
  return wordlistTokenKey(entry.book_id, entry.chapter_index, entry.block_index, entry.token_index);
}

function wordlistTokenKey(bookId: number, chapterIndex: number, blockIndex: number, tokenIndex: number) {
  return `${bookId}:${chapterIndex}:${blockIndex}:${tokenIndex}`;
}

function timedTokenKey(blockIndex: number, tokenIndex: number) {
  return `${blockIndex}:${tokenIndex}`;
}

function upsertWordlistEntry(entries: WordlistEntry[], entry: WordlistEntry) {
  const index = entries.findIndex((item) => item.id === entry.id || item.root_word === entry.root_word);
  if (index === -1) {
    return [entry, ...entries];
  }
  const next = [...entries];
  next[index] = entry;
  return next;
}

function dictionaryLookupFromWordlistEntry(entry: WordlistEntry, selectedWord: string): DictionaryLookup {
  const definitionNumber = entry.definition_number ?? 1;
  const definition = entry.definition;
  return {
    word: entry.root_word,
    selected_word: selectedWord,
    word_type: entry.word_type,
    cefr_level: entry.cefr_level,
    phonetics: entry.definition_phonetics,
    audio_url: entry.definition_audio_url,
    source_url: entry.definition_source_url,
    definitions: definition
      ? [
          {
            entry_id: entry.root_word,
            word_type: entry.word_type,
            number: definitionNumber,
            definition,
            examples: entry.definition_examples,
            source_url: entry.definition_source_url,
          },
        ]
      : [],
    context_definition: {
      entry_id: definition ? entry.root_word : null,
      definition_number: definition ? definitionNumber : null,
      definition,
      examples: entry.definition_examples,
      ai_explanation: entry.ai_explanation,
      matched: Boolean(definition),
    },
    simple_meaning: entry.simple_meaning || definition,
    in_context_meaning: entry.in_context_meaning,
    original_meaning: entry.original_meaning,
  };
}

function hasWordlistAiEnrichment(entry: WordlistEntry) {
  return Boolean(entry.simple_meaning.trim() || entry.in_context_meaning.trim());
}

function highlightContextWord(context: string, word: string) {
  const trimmedWord = word.trim();
  if (!context || !trimmedWord) {
    return context;
  }
  const start = context.toLocaleLowerCase().indexOf(trimmedWord.toLocaleLowerCase());
  if (start === -1) {
    return context;
  }
  const end = start + trimmedWord.length;
  return (
    <>
      {context.slice(0, start)}
      <mark>{context.slice(start, end)}</mark>
      {context.slice(end)}
    </>
  );
}

function formatSavedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function colorModeStorageKey() {
  return "readalong:color-mode";
}

function storedColorMode(): ColorMode {
  const stored = window.localStorage.getItem(colorModeStorageKey());
  return stored === "cefr" ? "cefr" : "frequency";
}

function shouldIgnorePlaybackShortcut(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function errorMessage(error: unknown, fallback: string) {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return fallback;
}

export default App;
