// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestCodeTab.tsx at 8ab427c6 (and 1f698f01d9)), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The Code tab of the panel, laid out as T3 Code's pull request Code tab: the changed files as a
// tree beside their diffs, or above them in a narrow panel, both in T3 Code's file order. Choosing
// a file in the tree scrolls its diff to the top. Review threads show at their lines in the diffs,
// and the ones no rendered line holds in a bar above them; the commit selector shows one commit's
// diff in place of the pull request's. Each file's header folds it, shows GitHub's line counts and
// a viewed mark; the toolbar counts the viewed files and holds the display controls.
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { IconButton, IconTooltip, useThemeKind } from '@mindroom/client-sdk/ui';
import type {
  CodeViewDiffItem,
  CodeViewItem,
  FileDiffLoadedFiles,
  FileDiffMetadata,
} from '@pierre/diffs';
import {
  WorkerPoolContextProvider,
  type CodeViewAnnotationArgs,
  type CodeViewHandle,
  type WorkerInitializationRenderOptions,
  type WorkerPoolOptions,
} from '@pierre/diffs/react';
import diffWorkerSource from '@pierre/diffs/worker/worker-portable.js?raw';
import type { GitStatus } from '@pierre/trees';
import {
  ChartBar,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  FlaskConicalOff,
  FolderTree,
  Pilcrow,
  Rows3,
  TextWrap,
  X,
} from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { CommitSelector } from './detail/CommitSelector';
import { DiffOptionsMenu } from './detail/DiffOptionsMenu';
import { OffDiffThreads } from './detail/OffDiffThreads';
import { ReviewThreadCard } from './detail/ReviewThreadCard';
import { TruncatedNote } from './detail/TruncatedNote';
import { isTestFile, type ChangedFileKind } from './diff/changedFileKind';
import { useCodePrefs } from './diff/codePrefs';
import {
  areAllDiffFilesCollapsed,
  getFileViewedRange,
  isFileDiffCollapsed,
  withFileDiffFold,
  type DiffFoldOverride,
  type FileDiffFoldChoices,
} from './diff/diffFold.logic';
import { DiffFileTree, type DiffFileTreeEntry } from './diff/DiffFileTree';
import { orderDiffFilesLikeTree } from './diff/diffFileTree.logic';
import { FileTreeColumn } from './diff/FileTreeColumn';
import {
  DIFF_THEME_NAMES,
  canHydrateDiff,
  fnv1a32,
  getRenderablePatch,
  prepareFileDiff,
  reconstructOldFile,
  resolveFileDiffPath,
} from './diff/diffRendering';
import { orderDiffFiles } from './diff/fileOrder.logic';
import { LineDistribution } from './diff/LineDistribution';
import {
  activeKindsFrom,
  canHideKind,
  normalizeDirPrefix,
  summarizeByKind,
  toDistributionFiles,
} from './diff/lineDistribution.logic';
import { StyledDiffCodeView, type StyledDiffCodeViewOptions } from './diff/StyledDiffCodeView';
import { annotationsKey, placeThreads, type ThreadGroup } from './diff/threadAnnotations';
import { useViewedFiles, type ViewedState } from './diff/viewedFiles';
import {
  filePatch,
  pullRequestUrl,
  type Commit,
  type PullRequestFile,
  type PullRequestRef,
} from './github';
import { GitHubErrorState } from './GitHubErrorState';
import { PullRequestDiffStat, PullRequestMetaLine } from './presentation';
import { loadDiffBlob, useCommitFiles } from './queries';
import type { ReviewThread } from './reviewThreads';
import { pluginRootStyle } from './theme';
import { useGitHubAccess } from './token';

/** A list the panel loads for the tab: its items once they have loaded, else why they did not. */
export type ListState<T> =
  | { status: 'pending' }
  | { status: 'error'; error: unknown; retry: () => void }
  | { status: 'success'; items: T[] };

// The headers show GitHub's counts, which files without hunks have too; Pierre's, counted from
// the hunks, give way to them.
const REPLACE_FILE_COUNTS_CSS = `
[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  display: none !important;
}`;

const NO_THREADS: ReviewThread[] = [];
const NO_FOLDS: FileDiffFoldChoices = new Map();
// Matches `@container (min-inline-size: 640px)` in styles.css where the Files tree sits beside diffs.
const WIDE_TREE_MIN_WIDTH = 640;

// Keep Shiki highlighting off the main thread in a single scoped worker whose heap is freed on
// unmount via WorkerPoolContextProvider -> terminateWorkerPoolSingleton(). Reuse one module-level
// Blob URL instead of Vite's ?worker&inline factory, which leaks a new 1.3 MB Blob URL per open.
let diffWorkerBlobUrl: string | undefined;

function createDiffWorker(): Worker {
  diffWorkerBlobUrl ??= URL.createObjectURL(
    new Blob([diffWorkerSource], { type: 'text/javascript;charset=utf-8' })
  );
  return new Worker(diffWorkerBlobUrl);
}

const DIFF_WORKER_POOL_OPTIONS: WorkerPoolOptions = {
  workerFactory: createDiffWorker,
  poolSize: 1,
  totalASTLRUCacheSize: 50,
};
const DIFF_WORKER_HIGHLIGHTER_OPTIONS: WorkerInitializationRenderOptions = {
  theme: DIFF_THEME_NAMES,
  lineDiffType: 'none',
  langs: [],
};

function ScopedDiffWorkerPool({ children }: { children: ReactNode }) {
  if (typeof Worker === 'undefined') return children;
  return (
    <WorkerPoolContextProvider
      poolOptions={DIFF_WORKER_POOL_OPTIONS}
      highlighterOptions={DIFF_WORKER_HIGHLIGHTER_OPTIONS}
    >
      {children}
    </WorkerPoolContextProvider>
  );
}

/** What a file's viewed mark and fold are against: its patch, or its blob without one. */
const markText = (file: PullRequestFile) =>
  file.patch ?? (file.sha === null ? '' : `blob:${file.sha}`);

function treeStatus(status: PullRequestFile['status']): GitStatus {
  if (status === 'removed') return 'deleted';
  if (status === 'renamed' || status === 'copied') return 'renamed';
  if (status === 'added') return 'added';
  return 'modified';
}

/**
 * What the files' headers show and do. Pierre keeps the portals it draws headers into while their
 * items stay the same; the headers read this instead, so a mark or a fold shows at once.
 */
type FileHeaderState = {
  statOf(path: string): { additions: number; deletions: number } | undefined;
  /** Undefined for a file the pull request does not change, which has no mark. */
  viewedOf(path: string): ViewedState | undefined;
  setViewed(path: string, extendRange: boolean): void;
  foldedOf(path: string): boolean;
  toggleFolded(path: string): void;
  foldButtons: Map<string, HTMLButtonElement>;
};

const FileHeaderContext = createContext<FileHeaderState | null>(null);

function FoldToggle({ path }: { path: string }) {
  const t = usePluginTranslation('pull-requests');
  const header = useContext(FileHeaderContext);
  const foldButtons = header?.foldButtons;
  const buttonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      if (!foldButtons || !node) return undefined;
      foldButtons.set(path, node);
      return () => {
        if (foldButtons.get(path) === node) foldButtons.delete(path);
      };
    },
    [foldButtons, path]
  );
  if (!header) return null;
  const folded = header.foldedOf(path);
  return (
    <button
      ref={buttonRef}
      type="button"
      className="mrpr-fold-toggle"
      aria-expanded={!folded}
      aria-label={t(folded ? 'code.expandDiff' : 'code.collapseDiff')}
      onClick={(event) => {
        event.stopPropagation();
        header.toggleFolded(path);
      }}
    >
      {folded ? (
        <ChevronRight aria-hidden className="mrpr-button-icon mrpr-arrow-back" />
      ) : (
        <ChevronDown aria-hidden className="mrpr-button-icon" />
      )}
    </button>
  );
}

// The file's line counts, then its viewed mark: "Changed" in the warning color for a file pushed
// to since it was marked.
function FileMeta({ path }: { path: string }) {
  const t = usePluginTranslation('pull-requests');
  const header = useContext(FileHeaderContext);
  const stat = header?.statOf(path);
  const viewed = header?.viewedOf(path);
  const changed = viewed === 'changed';
  return (
    <span className="mrpr-file-meta">
      {stat ? <PullRequestDiffStat additions={stat.additions} deletions={stat.deletions} /> : null}
      {header && viewed !== undefined ? (
        <label
          data-viewed-toggle=""
          className="mrpr-viewed"
          onClick={(event) => event.stopPropagation()}
        >
          <input
            type="checkbox"
            aria-label={t(changed ? 'code.changed' : 'code.viewed')}
            checked={viewed === 'viewed'}
            onChange={(event) =>
              header.setViewed(
                path,
                event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey
              )
            }
          />
          {changed ? (
            <IconTooltip label={t('code.changedHint')}>
              {(triggerRef) => (
                <span ref={triggerRef} className="mrpr-tone-warning">
                  {t('code.changed')}
                </span>
              )}
            </IconTooltip>
          ) : (
            <span>{t('code.viewed')}</span>
          )}
        </label>
      ) : null}
    </span>
  );
}

// Module level, so the view keeps the portals it drew them into; they read the rest from context.
const renderHeaderPrefix = (item: CodeViewItem<ThreadGroup>) => <FoldToggle path={item.id} />;
const renderHeaderMetadata = (item: CodeViewItem<ThreadGroup>) => <FileMeta path={item.id} />;

// The threads on one line of a diff, one card each.
const renderAnnotation = (...[annotation]: CodeViewAnnotationArgs<ThreadGroup>) => (
  <div className="mrpr-annotation">
    {annotation.metadata.threads.map((thread) => (
      <ReviewThreadCard key={thread.id} thread={thread} />
    ))}
  </div>
);

function ToolbarButton({
  label,
  pressed,
  disabled,
  buttonRef,
  onClick,
  children,
}: {
  label: string;
  /** Whether a toggle is on; undefined for a button that acts. */
  pressed?: boolean;
  disabled?: boolean;
  buttonRef?: { current: HTMLButtonElement | null };
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <IconTooltip label={label} align="End">
      {(triggerRef) => (
        <IconButton
          ref={(node: HTMLButtonElement | null) => {
            triggerRef(node);
            if (buttonRef) buttonRef.current = node;
          }}
          size="300"
          radii="300"
          aria-label={label}
          aria-pressed={pressed}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </IconButton>
      )}
    </IconTooltip>
  );
}

/** Moves focus into the file tree without triggering a competing native scroll. */
const focusTree = (tree: HTMLElement | null) => {
  const root = tree?.querySelector('file-tree-container')?.shadowRoot ?? tree;
  const target =
    root?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ??
    root?.querySelector<HTMLElement>('[role="treeitem"]') ??
    root?.querySelector<HTMLElement>('[role="tree"]') ??
    tree?.querySelector<HTMLElement>('.mrpr-tree-header button');
  target?.focus({ preventScroll: true });
};

/** The folds of one view: the pull request as a whole, or one commit. */
type Folds = {
  view: string;
  override: DiffFoldOverride;
  choices: FileDiffFoldChoices;
  /** The file last marked or unmarked, where a Shift-click's range starts. */
  anchor: string | null;
};

export function CodeTab({
  pullRequest,
  files,
  threads,
  commits,
  commit,
  onCommitChange,
  truncatedReviewComments,
  truncatedCommits,
}: {
  pullRequest: PullRequestRef;
  /** The files of the pull request as a whole. */
  files: PullRequestFile[];
  threads: ListState<ReviewThread>;
  commits: ListState<Commit>;
  /** The SHA of the commit whose diff shows; undefined is All commits. */
  commit: string | undefined;
  onCommitChange: (sha: string | undefined) => void;
  /** How many review comments loaded, when GitHub's list of them was cut short. */
  truncatedReviewComments?: number;
  /** How many commits loaded, when the selector has only some of the pull request's. */
  truncatedCommits?: number;
}) {
  const t = usePluginTranslation('pull-requests');
  const themeKind = useThemeKind();
  const prefs = useCodePrefs();
  const viewed = useViewedFiles(pullRequest);
  const rootRef = useRef<HTMLDivElement>(null);
  const diffsRef = useRef<HTMLDivElement>(null);
  const filesButtonRef = useRef<HTMLButtonElement | null>(null);
  const refocusFiles = useRef(false);
  // Wide (>= 640px): resizable Files sidebar starting open with all folders expanded.
  // Stacked (< 640px): Files tree renders inside CodeView's header with all folders collapsed.
  const [wide, setWide] = useState<boolean | null>(() =>
    typeof ResizeObserver === 'undefined' ? true : null
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const wideRef = useRef(wide);
  wideRef.current = wide;
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return undefined;
    const apply = (width: number, fromResize: boolean) => {
      if (width === 0) {
        setWide((previous) => previous ?? true);
        return;
      }
      const nextWide = width >= WIDE_TREE_MIN_WIDTH;
      if (
        fromResize &&
        wideRef.current !== null &&
        wideRef.current !== nextWide &&
        (root.querySelector('.mrpr-tree')?.contains(document.activeElement) ?? false)
      ) {
        refocusFiles.current = true;
      }
      setWide(nextWide);
    };
    apply(root.getBoundingClientRect().width || root.clientWidth, false);
    const observer = new ResizeObserver((entries) => {
      const entry = entries?.[entries.length - 1];
      const width =
        entry?.contentRect.width ?? (root.getBoundingClientRect().width || root.clientWidth);
      apply(width, true);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!refocusFiles.current) return;
    refocusFiles.current = false;
    filesButtonRef.current?.focus({ preventScroll: true });
  }, [wide]);
  const stacked = wide === false;
  const showSidebar = wide === true && sidebarOpen;
  const access = useGitHubAccess();
  const canLoadDiffFiles = access.via !== undefined && !access.pending;
  const viewerRef = useRef<CodeViewHandle<ThreadGroup, undefined>>(null);
  const rowsRef = useRef(new Map<string, HTMLElement>());
  const foldButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  const revealFocusFrameRef = useRef<number | null>(null);
  const cancelRevealFocus = useCallback(() => {
    if (revealFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(revealFocusFrameRef.current);
      revealFocusFrameRef.current = null;
    }
  }, []);
  useEffect(() => cancelRevealFocus, [cancelRevealFocus, stacked]);

  // A commit opened from the Timeline or left chosen across a force-push may no longer be part of
  // the pull request; it reads as All commits then, and its files are not asked for.
  const shownCommit =
    commit !== undefined &&
    commits.status === 'success' &&
    commits.items.some((entry) => entry.sha === commit)
      ? commit
      : undefined;
  const commitFiles = useCommitFiles(pullRequest, shownCommit ?? '', shownCommit !== undefined);
  const viewFiles = shownCommit === undefined ? files : commitFiles.data;

  // Viewed marks belong to the pull request as a whole: a file keeps its mark, against its patch
  // in the pull request, in a commit's view, and a file only a commit changes has none. A file
  // GitHub sends no patch for is marked against its blob, which changes with its content.
  const markTexts = useMemo(
    () => new Map(files.map((file) => [file.path, markText(file)])),
    [files]
  );

  // A file is folded while it is viewed, as GitHub folds it: a mark from another tab folds it, and
  // a push that changes it opens it. Another commit, or All commits again, drops the reader's
  // folds. A fold is kept against the file as it is shown, so a push that changes the file drops
  // the fold too, as T3 Code keys it by the file's diff.
  const view = shownCommit ?? '';
  const startFolds = (): Folds => ({ view, override: null, choices: NO_FOLDS, anchor: null });
  const [storedFolds, setFolds] = useState(startFolds);
  if (storedFolds.view !== view) setFolds(startFolds());
  const folds = storedFolds.view === view ? storedFolds : startFolds();
  const foldKeys = useMemo(
    () =>
      new Map(
        (viewFiles ?? []).map((file) => [file.path, `${file.path}#${fnv1a32(markText(file))}`])
      ),
    [viewFiles]
  );
  const foldKeyOf = useCallback((path: string) => foldKeys.get(path) ?? path, [foldKeys]);
  const isViewedNow = useCallback(
    (path: string) => {
      const text = markTexts.get(path);
      return text !== undefined && viewed.stateOf(path, text) === 'viewed';
    },
    [markTexts, viewed]
  );

  const collapsedOf = useCallback(
    (path: string) =>
      isFileDiffCollapsed(foldKeyOf(path), folds.override, folds.choices, isViewedNow(path)),
    [foldKeyOf, folds.override, folds.choices, isViewedNow]
  );

  // Scope cache keys to PR, commit view, credentials, and theme so Pierre never reuses a diff
  // mutated in place by `loadDiffFiles` across views or accounts.
  const scope = `pull-request:${pullRequest.owner}/${pullRequest.repo}#${
    pullRequest.number
  }:${view}:${String(access.key)}:${themeKind}`;
  const { ignoreWhitespace, hideTests } = prefs;
  const parsedFiles = useMemo(() => {
    const patch = (viewFiles ?? [])
      .map(filePatch)
      .filter((part): part is string => part !== null)
      .join('');
    const parsed = getRenderablePatch(patch, scope);
    // T3 Code's order, then the tree's, so the list and the tree agree.
    return parsed?.kind === 'files' ? orderDiffFilesLikeTree(orderDiffFiles(parsed.files)) : [];
  }, [viewFiles, scope]);

  const parsedByPath = useMemo(
    () => new Map(parsedFiles.map((file) => [resolveFileDiffPath(file), file])),
    [parsedFiles]
  );
  const testPaths = useMemo(
    () => new Set((viewFiles ?? []).map((file) => file.path).filter(isTestFile)),
    [viewFiles]
  );
  const sourceByPath = useMemo(
    () => new Map(viewFiles?.map((file) => [file.path, file])),
    [viewFiles]
  );
  // Prepare before filtering tests so toggling `hideTests` keeps the same `fileDiff` identity for
  // unchanged source files (including folded ones whose instance Pierre retains).
  const preparedFiles = useMemo(
    () =>
      parsedFiles.map((parsed) =>
        prepareFileDiff(parsed, {
          ignoreWhitespace,
          sha: sourceByPath.get(resolveFileDiffPath(parsed))?.sha,
        })
      ),
    [parsedFiles, sourceByPath, ignoreWhitespace]
  );
  const cacheKeyByPath = useMemo(
    () => new Map(preparedFiles.map((file) => [resolveFileDiffPath(file), file.cacheKey])),
    [preparedFiles]
  );
  const distributionFiles = useMemo(() => toDistributionFiles(viewFiles ?? []), [viewFiles]);
  const presentKinds = useMemo(
    () => summarizeByKind(distributionFiles, 'total').map((entry) => entry.kind),
    [distributionFiles]
  );
  // Directory drill-down resets when switching commits; non-test kind toggles stay in tab state.
  const [storedDirFilter, setStoredDirFilter] = useState({ view, prefix: '' });
  if (storedDirFilter.view !== view) setStoredDirFilter({ view, prefix: '' });
  const rawDirPrefix = storedDirFilter.view === view ? storedDirFilter.prefix : '';
  const setDirPrefix = useCallback(
    (prefix: string) => setStoredDirFilter({ view, prefix }),
    [view]
  );
  const [hiddenNonTestKinds, setHiddenNonTestKinds] = useState<ReadonlySet<ChangedFileKind>>(
    () => new Set()
  );
  const activeKinds = useMemo(
    () => activeKindsFrom(presentKinds, hideTests, hiddenNonTestKinds),
    [presentKinds, hideTests, hiddenNonTestKinds]
  );
  const kindFilteredFiles = useMemo(
    () => distributionFiles.filter((file) => activeKinds.has(file.kind)),
    [distributionFiles, activeKinds]
  );
  const dirPrefix = useMemo(
    () => normalizeDirPrefix(rawDirPrefix, kindFilteredFiles),
    [rawDirPrefix, kindFilteredFiles]
  );
  const hiddenPresentNonTestCount = presentKinds.filter(
    (kind) => kind !== 'test' && hiddenNonTestKinds.has(kind)
  ).length;
  const hasDistributionFilter = dirPrefix !== '' || hiddenPresentNonTestCount > 0;
  const clearDistributionFilters = () => {
    setDirPrefix('');
    setHiddenNonTestKinds(new Set());
  };
  const toggleKind = useCallback(
    (kind: ChangedFileKind) => {
      if (activeKinds.has(kind)) {
        if (!canHideKind(kind, activeKinds)) return;
        if (kind === 'test') prefs.update({ hideTests: true });
        else setHiddenNonTestKinds((prev) => new Set([...prev, kind]));
      } else if (kind === 'test') {
        prefs.update({ hideTests: false });
      } else {
        setHiddenNonTestKinds((prev) => {
          const next = new Set(prev);
          next.delete(kind);
          return next;
        });
      }
    },
    [activeKinds, prefs]
  );
  const scopedDistributionFiles = useMemo(
    () =>
      dirPrefix
        ? kindFilteredFiles.filter((file) => file.path.startsWith(dirPrefix))
        : kindFilteredFiles,
    [kindFilteredFiles, dirPrefix]
  );
  const includedPaths = useMemo(
    () =>
      hideTests || hasDistributionFilter
        ? new Set(scopedDistributionFiles.map((file) => file.path))
        : null,
    [hideTests, hasDistributionFilter, scopedDistributionFiles]
  );
  const shownDiffs = useMemo(
    () =>
      includedPaths
        ? preparedFiles.filter((fileDiff) => includedPaths.has(resolveFileDiffPath(fileDiff)))
        : preparedFiles,
    [preparedFiles, includedPaths]
  );

  const [expandNotice, setExpandNotice] = useState<{ scope: string; path: string } | null>(null);
  const expandFailurePath = expandNotice?.scope === scope ? expandNotice.path : null;

  // Abort in-flight blob reads on unmount or when the diff view, credentials, theme, or
  // whitespace mode changes — not on unrelated file-list refreshes that retain existing items.
  const sessionRef = useRef<{
    scope: string;
    controller: AbortController;
    inFlight: Map<string, Promise<string | null>>;
    unavailableShas: Set<string>;
  } | null>(null);
  useLayoutEffect(() => {
    const controller = new AbortController();
    const session = {
      scope,
      controller,
      inFlight: new Map<string, Promise<string | null>>(),
      unavailableShas: new Set<string>(),
    };
    sessionRef.current = session;
    return () => {
      controller.abort();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [scope, ignoreWhitespace]);

  const loaderRef = useRef({ pullRequest, access, sourceByPath, parsedByPath, cacheKeyByPath });
  useLayoutEffect(() => {
    loaderRef.current = { pullRequest, access, sourceByPath, parsedByPath, cacheKeyByPath };
  });
  const loadDiffFiles = useCallback(
    async (fileDiff: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
      const session = sessionRef.current;
      const signal = session?.controller.signal;
      if (!session || !signal || signal.aborted) throw new Error('Diff expansion cancelled');
      const {
        pullRequest: ref,
        access: currentAccess,
        sourceByPath: sources,
        parsedByPath: parsedFilesByPath,
        cacheKeyByPath: cacheKeys,
      } = loaderRef.current;
      const path = resolveFileDiffPath(fileDiff);
      const parsed = parsedFilesByPath.get(path);
      const source = sources.get(path);
      const expectedKey = cacheKeys.get(path);
      if (expectedKey === undefined || fileDiff.cacheKey !== expectedKey) {
        throw new Error('Diff expansion cancelled');
      }
      const fail = (error: unknown) => {
        if (!signal.aborted && path && loaderRef.current.cacheKeyByPath.get(path) === expectedKey) {
          setExpandNotice({ scope: session.scope, path });
        }
        return error;
      };
      if (
        !parsed ||
        !canHydrateDiff(parsed) ||
        !source?.sha ||
        currentAccess.via === undefined ||
        currentAccess.pending
      ) {
        throw fail(new Error('Diff cannot be expanded'));
      }
      const { sha } = source;
      if (session.unavailableShas.has(sha)) throw fail(new Error('Diff blob unavailable'));
      const pending =
        session.inFlight.get(sha) ??
        loadDiffBlob(ref, sha, currentAccess, signal).finally(() => {
          session.inFlight.delete(sha);
        });
      session.inFlight.set(sha, pending);
      let blob: string | null;
      try {
        blob = await pending;
      } catch (error) {
        throw fail(error);
      }
      signal.throwIfAborted();
      if (loaderRef.current.cacheKeyByPath.get(path) !== expectedKey) {
        throw new Error('Diff expansion cancelled');
      }
      if (blob === null) {
        session.unavailableShas.add(sha);
        throw fail(new Error('Diff blob unavailable'));
      }
      const old = reconstructOldFile(parsed, source, blob);
      if (old === null) throw fail(new Error('Diff blob mismatch'));
      setExpandNotice(null);
      return {
        oldFile: { name: parsed.prevName ?? parsed.name, contents: old },
        newFile: { name: parsed.name, contents: blob },
      };
    },
    []
  );
  const hiddenTests = hideTests ? testPaths.size : 0;
  // A file without a diff to show, as GitHub sends none for a binary or a very large file.
  const withoutDiff = useMemo(() => {
    const parsed = new Set(parsedFiles.map(resolveFileDiffPath));
    return (viewFiles ?? []).filter(
      (file) => !parsed.has(file.path) && (!includedPaths || includedPaths.has(file.path))
    );
  }, [viewFiles, parsedFiles, includedPaths]);
  // The files shown, in the order shown: the diffs, then the files without one.
  const listed = useMemo(
    () => [...shownDiffs.map(resolveFileDiffPath), ...withoutDiff.map((file) => file.path)],
    [shownDiffs, withoutDiff]
  );

  const threadList = threads.status === 'success' ? threads.items : NO_THREADS;
  const placed = useMemo(
    () => placeThreads(shownDiffs, threadList, shownCommit !== undefined),
    [shownDiffs, threadList, shownCommit]
  );
  const items = useMemo(
    (): CodeViewDiffItem<ThreadGroup>[] =>
      shownDiffs.map((fileDiff) => {
        const path = resolveFileDiffPath(fileDiff);
        const annotations = placed.annotations.get(path) ?? [];
        const collapsed = collapsedOf(path);
        return {
          id: path,
          type: 'diff',
          fileDiff,
          annotations,
          collapsed,
          // Pierre's view redraws an item it has drawn only when the item's version changes, so
          // the version follows the diff (a commit's diff of a path is another), its threads and
          // its fold.
          version: fnv1a32(
            `${fileDiff.cacheKey ?? ''}|${annotationsKey(annotations)}|${collapsed ? 1 : 0}`
          ),
        };
      }),
    [shownDiffs, placed, collapsedOf]
  );
  const statusByPath = useMemo(
    () => new Map((viewFiles ?? []).map((file) => [file.path, treeStatus(file.status)])),
    [viewFiles]
  );

  const marked = useMemo(
    () =>
      listed
        .filter((path) => markTexts.has(path))
        .map((path) => ({ fileKey: path, path, patch: markTexts.get(path) ?? '' })),
    [listed, markTexts]
  );
  const stats = useMemo(
    () =>
      new Map(
        (viewFiles ?? []).map((file) => [
          file.path,
          { additions: file.additions, deletions: file.deletions },
        ])
      ),
    [viewFiles]
  );
  // Only listed files, so a folder's lines leave out hidden test files.
  const entries = useMemo(
    (): DiffFileTreeEntry[] =>
      listed.map((path) => ({
        path,
        status: statusByPath.get(path) ?? 'modified',
        additions: stats.get(path)?.additions ?? 0,
        deletions: stats.get(path)?.deletions ?? 0,
      })),
    [listed, statusByPath, stats]
  );

  const updateFolds = useCallback(
    (change: (current: Folds) => Partial<Folds>) =>
      setFolds((stored) => {
        const current =
          stored.view === view ? stored : { view, override: null, choices: NO_FOLDS, anchor: null };
        return { ...current, ...change(current) };
      }),
    [view]
  );
  const toggleFolded = useCallback(
    (path: string) =>
      updateFolds((current) => ({
        choices: withFileDiffFold(
          current.choices,
          foldKeyOf(path),
          !isFileDiffCollapsed(
            foldKeyOf(path),
            current.override,
            current.choices,
            isViewedNow(path)
          )
        ),
      })),
    [updateFolds, foldKeyOf, isViewedNow]
  );
  // Marking a file viewed folds it and unmarking it unfolds it; Shift-click does so from the
  // file last marked to this one, as the list shows them. Before the toolbar's collapse or expand
  // all is used, a mark drops the reader's fold, so the fold follows the mark; after it, the mark
  // sets the reader's fold.
  const setViewed = useCallback(
    (path: string, extendRange: boolean) => {
      const patch = markTexts.get(path) ?? '';
      const mark = viewed.stateOf(path, patch) !== 'viewed';
      const range = getFileViewedRange(marked, path, extendRange ? folds.anchor : null);
      if (extendRange) {
        viewed.markRange(
          range.map((file) => file.path),
          range.map((file) => file.patch),
          mark
        );
      } else {
        viewed.toggle(path, patch);
      }
      updateFolds((current) => ({
        anchor: path,
        choices: range.reduce(
          (next, file) =>
            withFileDiffFold(
              next,
              foldKeyOf(file.path),
              current.override === null ? undefined : mark
            ),
          current.choices
        ),
      }));
    },
    [markTexts, viewed, marked, folds.anchor, updateFolds, foldKeyOf]
  );
  const header = useMemo<FileHeaderState>(
    () => ({
      statOf: (path) => stats.get(path),
      viewedOf: (path) => {
        const patch = markTexts.get(path);
        return patch === undefined ? undefined : viewed.stateOf(path, patch);
      },
      setViewed,
      foldedOf: collapsedOf,
      toggleFolded,
      foldButtons: foldButtonsRef.current,
    }),
    [stats, markTexts, viewed, setViewed, collapsedOf, toggleFolded]
  );
  const allFolded = areAllDiffFilesCollapsed(
    items.map((item) => item.id),
    new Set(items.filter((item) => item.collapsed).map((item) => item.id))
  );

  // Pierre draws the headers in its own tree; a click on one, but not on its controls, folds it.
  const onDiffsClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    for (const node of event.nativeEvent.composedPath()) {
      if (!(node instanceof HTMLElement)) continue;
      if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) return;
      if (node.hasAttribute('data-viewed-toggle')) return;
      if (node.hasAttribute('data-diffs-header')) {
        const path = node.querySelector('[data-title]')?.textContent?.trim();
        if (path && items.some((item) => item.id === path)) toggleFolded(path);
        return;
      }
    }
  };

  const focusRevealedTarget = useCallback((path: string, isDiffItem: boolean): boolean => {
    const target = isDiffItem ? foldButtonsRef.current.get(path) : rowsRef.current.get(path);
    if (target?.isConnected) {
      target.focus({ preventScroll: true });
      return true;
    }
    return false;
  }, []);

  const reveal = useCallback(
    (path: string, moveFocus = false) => {
      cancelRevealFocus();
      const isDiffItem = items.some((item) => item.id === path);
      if (isDiffItem) {
        // A folded file opens as it is revealed, and stays open as its mark changes.
        updateFolds((current) => ({
          choices: withFileDiffFold(current.choices, foldKeyOf(path), false),
        }));
        viewerRef.current?.scrollTo({ type: 'item', id: path, align: 'start' });
      } else {
        rowsRef.current.get(path)?.scrollIntoView({ block: 'nearest' });
      }
      if (!moveFocus) return;
      // Move focus out of the off-screen scroll-away header (stacked tree or Line Distribution) to
      // the revealed diff control (or the diffs container if the row is still virtualized). Also
      // re-check on the next frame because Pierre's tree reclaims focus after onSelectionChange
      // during the same click handler, and virtualized diff headers may not mount synchronously
      // before CodeView finishes scrolling.
      const moved = focusRevealedTarget(path, isDiffItem);
      revealFocusFrameRef.current = window.requestAnimationFrame(() => {
        revealFocusFrameRef.current = null;
        const active = document.activeElement;
        const inScrollAwayHeader = [
          ...(diffsRef.current?.querySelectorAll('.mrpr-code-tree-stacked, .mrpr-dist') ?? []),
        ].some((headerEl) => headerEl.contains(active));
        if (
          moved
            ? !inScrollAwayHeader
            : !inScrollAwayHeader && active !== null && active !== document.body
        ) {
          return;
        }
        if (!focusRevealedTarget(path, isDiffItem)) {
          diffsRef.current?.focus({ preventScroll: true });
        }
      });
    },
    [cancelRevealFocus, items, updateFolds, foldKeyOf, focusRevealedTarget]
  );

  const renderWithoutDiff = useCallback(
    () =>
      withoutDiff.length === 0 ? null : (
        <ul className="mrpr-no-diff-list">
          {withoutDiff.map((file) => (
            <li
              key={file.path}
              className="mrpr-no-diff"
              tabIndex={-1}
              ref={(row) => {
                if (row) rowsRef.current.set(file.path, row);
                else rowsRef.current.delete(file.path);
              }}
            >
              <span className="mrpr-no-diff-head">
                <span className="mrpr-no-diff-path">{file.path}</span>
                <FileMeta path={file.path} />
              </span>
              <span className="mrpr-meta">
                <span>{t('noDiff')}</span>
                <a href={file.url} target="_blank" rel="noopener noreferrer" className="mrpr-link">
                  {t('openOnGitHub')}
                </a>
              </span>
            </li>
          ))}
        </ul>
      ),
    [withoutDiff, t]
  );

  // Nothing to show: the view has no file, every one is a hidden test, or only whitespace changed
  // while whitespace changes are hidden.
  const emptyNote = !viewFiles
    ? undefined
    : viewFiles.length === 0
      ? t(shownCommit === undefined ? 'code.noChanges' : 'code.noCommitChanges')
      : listed.length === 0
        ? hiddenPresentNonTestCount > 0
          ? t('code.distribution.noMatchingFiles')
          : t('code.onlyTests')
        : ignoreWhitespace &&
            withoutDiff.length === 0 &&
            shownDiffs.every(
              (fileDiff) =>
                fileDiff.hunks.length > 0 &&
                fileDiff.hunks.every((hunk) => hunk.additionLines === 0 && hunk.deletionLines === 0)
            )
          ? t('code.onlyWhitespace')
          : undefined;
  const hasDiffs = Boolean(viewFiles && !emptyNote);

  // Give the stacked tree inside CodeView's auto-height header a concrete max-block-size derived
  // from the diffs viewport height (percentage max-block-size resolves to none there).
  useLayoutEffect(() => {
    const diffs = diffsRef.current;
    if (!diffs) return undefined;
    if (!stacked) {
      diffs.style.removeProperty('--mrpr-stacked-tree-max-height');
      return undefined;
    }
    const apply = (height: number) => {
      if (height > 0) {
        diffs.style.setProperty('--mrpr-stacked-tree-max-height', `${Math.round(height * 0.45)}px`);
      }
    };
    apply(diffs.getBoundingClientRect().height || diffs.clientHeight);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries?.[entries.length - 1];
      const height =
        entry?.contentRect.height ?? (diffs.getBoundingClientRect().height || diffs.clientHeight);
      apply(height);
    });
    observer.observe(diffs);
    return () => observer.disconnect();
  }, [hasDiffs, stacked]);

  const goToFiles = () => {
    if (!hasDiffs) return;
    cancelRevealFocus();
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    viewerRef.current?.scrollTo({
      type: 'position',
      position: 0,
      behavior: still ? 'instant' : 'smooth',
    });
    focusTree(
      diffsRef.current?.querySelector<HTMLElement>('.mrpr-code-tree-stacked .mrpr-tree') ?? null
    );
  };

  const hasFiles = Boolean(viewFiles && viewFiles.length > 0);
  const showDistribution = Boolean(prefs.showDistribution && hasDiffs);
  const toggleDistribution = () => {
    if (!hasDiffs) return;
    const next = !prefs.showDistribution;
    prefs.update({ showDistribution: next });
    if (next) {
      cancelRevealFocus();
      const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      viewerRef.current?.scrollTo({
        type: 'position',
        position: 0,
        behavior: still ? 'instant' : 'smooth',
      });
    }
  };
  const filterChipText = dirPrefix
    ? hiddenPresentNonTestCount > 0
      ? t('code.distribution.dirFilterWithKinds', {
          prefix: dirPrefix,
          count: hiddenPresentNonTestCount,
        })
      : dirPrefix
    : t('code.distribution.clearFilter');
  const filterChipLabel = dirPrefix
    ? t('code.distribution.clearDirFilter', { prefix: filterChipText })
    : filterChipText;

  const renderCodeViewHeader = useMemo(
    () =>
      stacked || showDistribution
        ? () => (
            <>
              {stacked ? (
                <div className="mrpr-code-tree-stacked">
                  <DiffFileTree
                    ariaLabel={t('code.treeLabel', pullRequest)}
                    entries={entries}
                    initialExpansion="closed"
                    onSelectFile={(path) => reveal(path, true)}
                  />
                </div>
              ) : null}
              {showDistribution ? (
                <LineDistribution
                  files={distributionFiles}
                  scopedFiles={scopedDistributionFiles}
                  activeKinds={activeKinds}
                  dirPrefix={dirPrefix}
                  view={prefs.distributionView}
                  metric={prefs.distributionMetric}
                  onToggleKind={toggleKind}
                  onDirPrefixChange={setDirPrefix}
                  onViewChange={(distributionView) => prefs.update({ distributionView })}
                  onMetricChange={(distributionMetric) => prefs.update({ distributionMetric })}
                  onSelectFile={(path) => reveal(path, true)}
                />
              ) : null}
            </>
          )
        : undefined,
    [
      stacked,
      showDistribution,
      t,
      pullRequest,
      entries,
      reveal,
      distributionFiles,
      scopedDistributionFiles,
      activeKinds,
      dirPrefix,
      prefs,
      toggleKind,
    ]
  );

  const diffViewOptions = useMemo<StyledDiffCodeViewOptions<ThreadGroup>>(
    () => ({
      theme: DIFF_THEME_NAMES[themeKind],
      themeType: themeKind,
      diffStyle: prefs.diffStyle,
      overflow: prefs.wrap ? 'wrap' : 'scroll',
      lineDiffType: 'none',
      stickyHeaders: true,
      loadDiffFiles: canLoadDiffFiles ? loadDiffFiles : undefined,
    }),
    [themeKind, prefs.diffStyle, prefs.wrap, canLoadDiffFiles, loadDiffFiles]
  );

  return (
    <div ref={rootRef} className="mrpr-root mrpr-code" style={pluginRootStyle()}>
      <div className="mrpr-code-toolbar">
        <div className="mrpr-code-toolbar-start">
          {commits.status === 'success' && commits.items.length > 0 ? (
            <CommitSelector
              commits={commits.items}
              commit={shownCommit}
              onCommitChange={onCommitChange}
            />
          ) : null}
          {viewFiles ? (
            <PullRequestMetaLine>
              <span className="mrpr-shrink-0">{t('code.fileCount', { count: listed.length })}</span>
              {hiddenTests > 0 ? (
                <button
                  type="button"
                  className="mrpr-link-button"
                  onClick={() => prefs.update({ hideTests: false })}
                >
                  {t('code.testsHidden', { count: hiddenTests })}
                </button>
              ) : null}
              {hasDistributionFilter ? (
                <button
                  type="button"
                  className="mrpr-filter-chip"
                  aria-label={filterChipLabel}
                  title={filterChipLabel}
                  onClick={clearDistributionFilters}
                >
                  <span className="mrpr-truncate">{filterChipText}</span>
                  <X aria-hidden className="mrpr-filter-chip-icon" />
                </button>
              ) : null}
              {marked.length > 0 ? (
                <span className="mrpr-tabular mrpr-truncate">
                  {t('code.viewedCount', {
                    viewed: viewed.viewedCount(marked),
                    total: marked.length,
                  })}
                </span>
              ) : null}
            </PullRequestMetaLine>
          ) : null}
        </div>
        <div className="mrpr-code-toolbar-end">
          {/* A narrow toolbar keeps the diff options in a menu; a wide one shows them. */}
          <span className="mrpr-code-options-menu">
            <DiffOptionsMenu prefs={prefs} onChange={prefs.update} />
          </span>
          <span className="mrpr-code-options">
            <ToolbarButton
              label={t('code.hideWhitespace')}
              pressed={ignoreWhitespace}
              onClick={() => prefs.update({ ignoreWhitespace: !ignoreWhitespace })}
            >
              <Pilcrow aria-hidden className="mrpr-button-icon" />
            </ToolbarButton>
            <span role="group" aria-label={t('code.diffLayout')} className="mrpr-segmented">
              <ToolbarButton
                label={t('code.stackedView')}
                pressed={prefs.diffStyle === 'unified'}
                onClick={() => prefs.update({ diffStyle: 'unified' })}
              >
                <Rows3 aria-hidden className="mrpr-button-icon" />
              </ToolbarButton>
              <ToolbarButton
                label={t('code.splitView')}
                pressed={prefs.diffStyle === 'split'}
                onClick={() => prefs.update({ diffStyle: 'split' })}
              >
                <Columns2 aria-hidden className="mrpr-button-icon" />
              </ToolbarButton>
            </span>
            <ToolbarButton
              label={t('code.wrapLines')}
              pressed={prefs.wrap}
              onClick={() => prefs.update({ wrap: !prefs.wrap })}
            >
              <TextWrap aria-hidden className="mrpr-button-icon" />
            </ToolbarButton>
          </span>
          {items.length > 0 && !emptyNote ? (
            <ToolbarButton
              label={t(allFolded ? 'code.expandAll' : 'code.collapseAll')}
              onClick={() =>
                updateFolds(() => ({
                  override: allFolded ? 'expanded' : 'folded',
                  choices: NO_FOLDS,
                }))
              }
            >
              {allFolded ? (
                <ChevronsUpDown aria-hidden className="mrpr-button-icon" />
              ) : (
                <ChevronsDownUp aria-hidden className="mrpr-button-icon" />
              )}
            </ToolbarButton>
          ) : null}
          {testPaths.size > 0 ? (
            <ToolbarButton
              label={t('code.hideTests')}
              pressed={hideTests}
              onClick={() => prefs.update({ hideTests: !hideTests })}
            >
              <FlaskConicalOff aria-hidden className="mrpr-button-icon" />
            </ToolbarButton>
          ) : null}
          {hasFiles ? (
            <ToolbarButton
              label={t('code.distribution.toggle')}
              pressed={hasDiffs && prefs.showDistribution}
              disabled={!hasDiffs}
              onClick={toggleDistribution}
            >
              <ChartBar aria-hidden className="mrpr-button-icon" />
            </ToolbarButton>
          ) : null}
          {stacked ? (
            <ToolbarButton
              label={t('code.goToFiles')}
              disabled={!hasDiffs}
              buttonRef={filesButtonRef}
              onClick={goToFiles}
            >
              <FolderTree aria-hidden className="mrpr-button-icon" />
            </ToolbarButton>
          ) : (
            <ToolbarButton
              label={t('code.files')}
              pressed={sidebarOpen}
              buttonRef={filesButtonRef}
              onClick={() => {
                refocusFiles.current = false;
                setSidebarOpen((open) => !open);
              }}
            >
              <FolderTree aria-hidden className="mrpr-button-icon" />
            </ToolbarButton>
          )}
        </div>
      </div>
      {/* A list that did not load leaves the diffs whole; it says so, with a retry, above them. */}
      {commits.status === 'error' ||
      threads.status === 'error' ||
      truncatedReviewComments !== undefined ||
      truncatedCommits !== undefined ||
      expandFailurePath !== null ? (
        <div className="mrpr-code-notices">
          {commits.status === 'error' ? (
            <GitHubErrorState compact error={commits.error} onRetry={commits.retry} />
          ) : null}
          {threads.status === 'error' ? (
            <GitHubErrorState compact error={threads.error} onRetry={threads.retry} />
          ) : null}
          {truncatedReviewComments !== undefined ? (
            <TruncatedNote
              label={t('truncated.reviewComments', { count: truncatedReviewComments })}
              href={pullRequestUrl(pullRequest)}
            />
          ) : null}
          {truncatedCommits !== undefined ? (
            <TruncatedNote
              label={t('truncated.commits', { count: truncatedCommits })}
              href={`${pullRequestUrl(pullRequest)}/commits`}
            />
          ) : null}
          {expandFailurePath !== null ? (
            <p role="status" className="mrpr-status mrpr-note">
              {t('code.contextUnavailable', { path: expandFailurePath })}
            </p>
          ) : null}
        </div>
      ) : null}
      {/* Another view starts with the bar closed. */}
      <OffDiffThreads key={view} threads={placed.offDiff} />
      {viewFiles && emptyNote ? (
        <div className="mrpr-panel-note">
          <p className="mrpr-status">{emptyNote}</p>
          {listed.length === 0 && hiddenPresentNonTestCount > 0 ? (
            <button type="button" className="mrpr-link-button" onClick={clearDistributionFilters}>
              {t('code.distribution.clearFilter')}
            </button>
          ) : null}
        </div>
      ) : viewFiles ? (
        <div className="mrpr-code-body">
          {showSidebar ? (
            <FileTreeColumn>
              <DiffFileTree
                ariaLabel={t('code.treeLabel', pullRequest)}
                entries={entries}
                initialExpansion="open"
                onSelectFile={reveal}
              />
            </FileTreeColumn>
          ) : null}
          <div
            ref={diffsRef}
            className="mrpr-code-diffs"
            tabIndex={-1}
            onClickCapture={onDiffsClickCapture}
          >
            <FileHeaderContext.Provider value={header}>
              <ScopedDiffWorkerPool>
                {/* The viewer must own its scroll element to position virtual rows within it. */}
                <StyledDiffCodeView<ThreadGroup>
                  viewerRef={viewerRef}
                  items={items}
                  options={diffViewOptions}
                  renderCodeViewHeader={renderCodeViewHeader}
                  renderCodeViewFooter={renderWithoutDiff}
                  renderHeaderPrefix={renderHeaderPrefix}
                  renderHeaderMetadata={renderHeaderMetadata}
                  renderAnnotation={renderAnnotation}
                  unsafeCSSExtra={REPLACE_FILE_COUNTS_CSS}
                />
              </ScopedDiffWorkerPool>
            </FileHeaderContext.Provider>
          </div>
        </div>
      ) : (
        <div className="mrpr-panel-note">
          {commitFiles.isError ? (
            <GitHubErrorState
              compact
              error={commitFiles.error}
              onRetry={() => void commitFiles.refetch()}
            />
          ) : (
            <p className="mrpr-status">{t('loadingFiles')}</p>
          )}
        </div>
      )}
    </div>
  );
}
