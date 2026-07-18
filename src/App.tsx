import { convertFileSrc } from "@tauri-apps/api/core";
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
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { generatePartAudio, getChapter, getPartAudio, getReader, importBooks, listBooks, saveProgress } from "@/lib/api";
import type { BookSummary, ChapterPayload, PartAudioPayload, ReaderPayload } from "@/types";
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
            chapterIndex: 0,
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
  const [audioState, setAudioState] = useState({ currentTime: 0, duration: 0, playing: false });
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const visibleBlockRef = useRef<number | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const pendingPartBlockRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void getReader(bookId)
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setReader(payload);
        const savedChapterIndex = initialChapterIndex ?? payload.progress.last_chapter_index ?? 0;
        const nextChapterIndex = payload.chapters.some((item) => item.chapter_index === savedChapterIndex) ? savedChapterIndex : 0;
        const nextChapter = payload.chapters.find((item) => item.chapter_index === nextChapterIndex);
        const nextPartIndex =
          nextChapter?.parts.find(
            (part) =>
              payload.progress.last_block_index >= part.start_block_index &&
              payload.progress.last_block_index <= part.end_block_index,
          )?.part_index ?? 0;
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
  }, [bookId, chapterIndex]);

  useEffect(() => {
    if (!reader || !chapter) {
      return;
    }
    const pendingPartBlock = pendingPartBlockRef.current;
    pendingPartBlockRef.current = null;
    const partTarget = pendingPartBlock === null ? null : chapter.blocks.find((block) => block.block_index >= pendingPartBlock);
    const target = partTarget ?? chapter.blocks.find((block) => block.block_index >= reader.progress.last_block_index);
    if (target && (partTarget || chapterIndex === reader.progress.last_chapter_index)) {
      window.requestAnimationFrame(() => {
        document.getElementById(blockDomId(target.block_index))?.scrollIntoView({ block: "center" });
      });
    } else {
      window.scrollTo({ top: 0 });
    }
  }, [chapter, chapterIndex, reader]);

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
        if (saveTimerRef.current) {
          window.clearTimeout(saveTimerRef.current);
        }
        saveTimerRef.current = window.setTimeout(() => {
          const percent = reader.total_blocks ? Math.min(100, Math.round((blockIndex / reader.total_blocks) * 1000) / 10) : 0;
          void saveProgress(bookId, chapterIndex, blockIndex, percent).catch((error) => {
            toast.error(errorMessage(error, "Failed to save progress."));
          });
        }, 900);
      },
      { rootMargin: "-35% 0px -50% 0px", threshold: [0.2, 0.6, 1] },
    );
    blocks.forEach((block) => observer.observe(block));
    return () => {
      observer.disconnect();
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [bookId, chapter, chapterIndex, partIndex, reader]);

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

  useEffect(() => {
    const audio = audioRef.current;
    audio?.pause();
    audio?.removeAttribute("src");
    audio?.load();
    setPartAudio(null);
    setAudioState({ currentTime: 0, duration: 0, playing: false });

    if (!reader || !chapter || !activePart) {
      return;
    }

    let cancelled = false;
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
          setLoadingAudio(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activePart, bookId, chapter, chapterIndex, reader]);

  useEffect(() => {
    const audio = audioRef.current;
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
      setGeneratingAudio(true);
      try {
        const payload = await generatePartAudio(bookId, chapterIndex, activePart.part_index, regenerate);
        setPartAudio(payload);
        toast.success(regenerate ? "Audio regenerated." : "Audio generated.");
      } catch (error) {
        toast.error(errorMessage(error, "Audio generation failed."));
      } finally {
        setGeneratingAudio(false);
      }
    },
    [activePart, bookId, chapterIndex],
  );

  const toggleAudioPlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !partAudio) {
      return;
    }
    if (audio.paused) {
      void audio.play().catch((error) => toast.error(errorMessage(error, "Failed to play audio.")));
    } else {
      audio.pause();
    }
  }, [partAudio]);

  const seekAudio = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    audio.currentTime = Math.max(0, Math.min(time, Number.isFinite(audio.duration) ? audio.duration : time));
    setAudioState((current) => ({ ...current, currentTime: audio.currentTime }));
  }, []);

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
                  {activePart && activeChapter && activeChapter.parts.length > 1 ? <span>{activePart.title}</span> : null}
                  <div className="part-stats" aria-label="Part statistics">
                    <span>{partWordCount.toLocaleString()} words</span>
                    {partAudio ? (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button size="sm" disabled={generatingAudio || loadingAudio}>
                            <AudioLinesIcon data-icon="inline-start" />
                            {generatingAudio ? "Generating audio..." : "Regenerate audio"}
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
                      >
                        <AudioLinesIcon data-icon="inline-start" />
                        {generatingAudio ? "Generating audio..." : "Generate audio"}
                      </Button>
                    )}
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
                        <ReaderTokens block={block} />
                      </p>
                    ) : null,
                  )}
                </div>
              </>
            )}
          </article>
        </div>
        <audio ref={audioRef} preload="metadata" className="hidden" />
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

function ReaderTokens({ block }: { block: ChapterPayload["blocks"][number] }) {
  if (!block.tokens.length) {
    return <>{block.text}</>;
  }
  return (
    <>
      {block.tokens.map((token, index) => (
        <span
          key={`${block.block_index}-${index}`}
          className={cn("reader-token", token.cefr_level && `level-${token.cefr_level.toLowerCase()}`)}
          data-cefr-level={token.cefr_level || undefined}
          data-root-text={token.root_text || undefined}
        >
          {token.text}
        </span>
      ))}
    </>
  );
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
