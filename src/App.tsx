import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AudioLinesIcon,
  BookOpenTextIcon,
  ChevronLeftIcon,
  ImportIcon,
  LibraryIcon,
  MenuIcon,
  PauseIcon,
  PlayIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  generatePartAudio,
  getChapter,
  getPartAlignment,
  getPartAudio,
  getReader,
  importBooks,
  listBooks,
  saveProgress,
  syncPartAlignment,
} from "@/lib/api";
import type { BookSummary, ChapterPayload, PartAlignmentPayload, PartAudioPayload, ReaderPayload, ReadingProgress, TimedToken } from "@/types";
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

type SaveProgressOptions = {
  immediate?: boolean;
  blockIndex?: number;
  audioTimeSeconds?: number | null;
  audioDurationSeconds?: number | null;
  lastPlayingToken?: TimedToken | null;
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

  return (
    <TooltipProvider>
      <LibraryView
        books={books}
        loading={loadingBooks}
        importing={importing}
        onImport={() => void handleImport()}
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
  onOpenBook,
}: {
  books: BookSummary[];
  loading: boolean;
  importing: boolean;
  onImport: () => void;
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
          <Button onClick={onImport} disabled={importing}>
            <ImportIcon data-icon="inline-start" />
            {importing ? "Importing" : "Import"}
          </Button>
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
  const [markedTokens, setMarkedTokens] = useState<Set<string>>(() => new Set());
  const [dialogImage, setDialogImage] = useState<ReaderImage | null>(null);
  const [imageZoom, setImageZoom] = useState(1);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const wordPreviewAudioRef = useRef<HTMLAudioElement | null>(null);
  const visibleBlockRef = useRef<number | null>(null);
  const saveTimerRef = useRef<number | null>(null);
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
    const stored = window.localStorage.getItem(markedTokensStorageKey(bookId));
    if (!stored) {
      setMarkedTokens(new Set());
      return;
    }
    try {
      const parsed = JSON.parse(stored);
      setMarkedTokens(Array.isArray(parsed) ? new Set(parsed.filter((item) => typeof item === "string")) : new Set());
    } catch {
      setMarkedTokens(new Set());
    }
  }, [bookId]);

  const activeChapter = useMemo(
    () => reader?.chapters.find((item) => item.chapter_index === chapterIndex),
    [chapterIndex, reader],
  );
  const activePart = useMemo(
    () => activeChapter?.parts.find((item) => item.part_index === partIndex),
    [activeChapter, partIndex],
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

      const persist = () => {
        void saveProgress(payload).catch((error) => {
          toast.error(errorMessage(error, "Failed to save progress."));
        });
      };

      if (options.immediate) {
        if (saveTimerRef.current) {
          window.clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        persist();
        return;
      }

      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        persist();
      }, 900);
    },
    [activePart, bookId, chapter, chapterIndex, partAlignment, partAudio, reader],
  );

  useEffect(() => {
    tokenRefs.current = {};
    lastAutoScrollTokenRef.current = null;
    lastSelectionSeekKeyRef.current = "";
    activeTimedTokenRef.current = null;
    setActiveTokenKey(null);
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
    const saveThrottledPlaybackPosition = () => {
      const now = Date.now();
      if (now - lastAudioSaveAtRef.current < 2000) {
        return;
      }
      lastAudioSaveAtRef.current = now;
      savePlaybackPosition(false);
    };
    const saveImmediatePlaybackPosition = () => savePlaybackPosition(true);

    audio.addEventListener("timeupdate", saveThrottledPlaybackPosition);
    audio.addEventListener("pause", saveImmediatePlaybackPosition);
    audio.addEventListener("seeked", saveImmediatePlaybackPosition);
    return () => {
      saveImmediatePlaybackPosition();
      audio.removeEventListener("timeupdate", saveThrottledPlaybackPosition);
      audio.removeEventListener("pause", saveImmediatePlaybackPosition);
      audio.removeEventListener("seeked", saveImmediatePlaybackPosition);
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
      if (event.code !== "Space" || event.repeat || shouldIgnorePlaybackShortcut(event.target)) {
        return;
      }
      event.preventDefault();
      toggleAudioPlay();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleAudioPlay]);

  useEffect(() => {
    if (!partAlignment?.tokens.length) {
      activeTimedTokenRef.current = null;
      setActiveTokenKey(null);
      return;
    }
    const activeToken =
      partAlignment.tokens.find((token) => audioState.currentTime >= token.start_time && audioState.currentTime < token.end_time) ??
      [...partAlignment.tokens].reverse().find((token) => token.start_time <= audioState.currentTime);
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
      element.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [audioState.currentTime, audioState.duration, audioState.playing, partAlignment, saveCurrentProgress]);

  const toggleMarkedToken = useCallback(
    (tokenKey: string) => {
      setMarkedTokens((current) => {
        const next = new Set(current);
        if (next.has(tokenKey)) {
          next.delete(tokenKey);
        } else {
          next.add(tokenKey);
        }
        window.localStorage.setItem(markedTokensStorageKey(bookId), JSON.stringify([...next]));
        return next;
      });
    },
    [bookId],
  );

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

  useEffect(() => {
    if (!partAlignment?.tokens.length) {
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
      for (const token of partAlignment.tokens) {
        const key = timedTokenKey(token.block_index, token.token_index);
        const element = tokenRefs.current[key];
        if (!element || !range.intersectsNode(element) || element.textContent?.trim() !== text) {
          continue;
        }
        const seekKey = `${key}:${text}`;
        if (lastSelectionSeekKeyRef.current === seekKey) {
          return;
        }
        lastSelectionSeekKeyRef.current = seekKey;
        seekToTimedToken(token.block_index, token.token_index);
        return;
      }
    };

    document.addEventListener("mouseup", seekSelectedWord);
    document.addEventListener("keyup", seekSelectedWord);
    return () => {
      document.removeEventListener("mouseup", seekSelectedWord);
      document.removeEventListener("keyup", seekSelectedWord);
    };
  }, [partAlignment, seekToTimedToken]);

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
              <Button variant="ghost" size="icon" onClick={() => setTocOpen((value) => !value)} aria-label="Toggle chapters">
                <MenuIcon />
              </Button>
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold">{reader?.title || "Opening book"}</h1>
              <p className="truncate text-xs text-muted-foreground">{activeChapter?.title || chapter?.title || "Chapter"}</p>
            </div>
            <Badge variant="secondary">{reader ? `${Math.round(reader.progress.progress_percent)}%` : "..."}</Badge>
          </div>
        </header>

        <div className={cn("reader-shell", tocOpen && "has-toc")}>
          {tocOpen ? (
            <aside className="toc-panel">
              <ScrollArea className="h-[calc(100vh-4rem)]">
                <div className="flex flex-col gap-2 p-4">
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
                          block={block}
                          chapterIndex={chapterIndex}
                          activeTokenKey={activeTokenKey}
                          markedTokens={markedTokens}
                          timedTokensByKey={timedTokensByKey}
                          onSeekToken={seekToTimedToken}
                          onToggleMarkedToken={toggleMarkedToken}
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
  return (
    <div className="reader-audio" aria-label="Audio playback controls">
      <Button className="audio-button" size="icon" onClick={onTogglePlay} aria-label={playing ? "Pause" : "Play"}>
        {playing ? <PauseIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
      </Button>
      <div className="audio-timeline">
        <span>{formatClock(currentTime)}</span>
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
        <span>{formatClock(duration)}</span>
      </div>
    </div>
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

function ReaderTokens({
  block,
  chapterIndex,
  activeTokenKey,
  markedTokens,
  timedTokensByKey,
  onSeekToken,
  onToggleMarkedToken,
  onTokenRef,
}: {
  block: ChapterPayload["blocks"][number];
  chapterIndex: number;
  activeTokenKey: string | null;
  markedTokens: Set<string>;
  timedTokensByKey: Map<string, TimedToken>;
  onSeekToken: (blockIndex: number, tokenIndex: number) => void;
  onToggleMarkedToken: (tokenKey: string) => void;
  onTokenRef: (tokenKey: string, node: HTMLElement | null) => void;
}) {
  if (!block.tokens.length) {
    return <>{block.text}</>;
  }
  return (
    <>
      {block.tokens.map((token, index) => {
        const tokenKey = markedTokenKey(chapterIndex, block.block_index, index);
        const syncKey = timedTokenKey(block.block_index, index);
        const hasTiming = timedTokensByKey.has(syncKey);
        return (
          <span
            key={`${block.block_index}-${index}`}
            ref={(node) => onTokenRef(syncKey, node)}
            className={cn(
              "reader-token",
              token.cefr_level && `level-${token.cefr_level.toLowerCase()}`,
              markedTokens.has(tokenKey) && "marked",
              hasTiming && "synced",
              activeTokenKey === syncKey && "active",
            )}
            data-cefr-level={token.cefr_level || undefined}
            data-root-text={token.root_text || undefined}
            onClick={() => {
              if (hasTiming) {
                onSeekToken(block.block_index, index);
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              onToggleMarkedToken(tokenKey);
            }}
          >
            {token.text}
          </span>
        );
      })}
    </>
  );
}

function markedTokenKey(chapterIndex: number, blockIndex: number, tokenIndex: number) {
  return `${chapterIndex}:${blockIndex}:${tokenIndex}`;
}

function timedTokenKey(blockIndex: number, tokenIndex: number) {
  return `${blockIndex}:${tokenIndex}`;
}

function markedTokensStorageKey(bookId: number) {
  return `readalong:marked-tokens:${bookId}`;
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
