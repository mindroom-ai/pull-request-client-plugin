// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestCodeTab.tsx at 8ab427c6 (and 1f698f01d9)), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The Code tab of the panel, laid out as T3 Code's pull request Code tab: the changed files as a
// tree beside their diffs, or above them in a narrow panel, both in T3 Code's file order. Choosing
// a file in the tree scrolls its diff to the top. Review threads show at their lines in the diffs,
// and the ones no rendered line holds in a bar above them; the commit selector shows one commit's
// diff in place of the pull request's. Each file's header folds it, shows GitHub's line counts and
// a viewed mark; the toolbar counts the viewed files and holds the display controls.
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { IconButton, IconTooltip, useThemeKind } from '@mindroom/client-sdk/ui';
import type { CodeViewDiffItem, CodeViewItem, PostRenderPhase } from '@pierre/diffs';
import type { CodeViewAnnotationArgs, CodeViewHandle } from '@pierre/diffs/react';
import type { GitStatus } from '@pierre/trees';
import {
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
} from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
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
import { isTestFile } from './diff/changedFileKind';
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
  resolveFileDiffPath,
} from './diff/diffRendering';
import { orderDiffFiles } from './diff/fileOrder.logic';
import { StyledDiffCodeView } from './diff/StyledDiffCodeView';
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
import { useCommitFiles, useDiffBlobs } from './queries';
import type { ReviewThread } from './reviewThreads';
import { pluginRootStyle } from './theme';

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
};

const FileHeaderContext = createContext<FileHeaderState | null>(null);

function FoldToggle({ path }: { path: string }) {
  const t = usePluginTranslation('pull-requests');
  const header = useContext(FileHeaderContext);
  if (!header) return null;
  const folded = header.foldedOf(path);
  return (
    <button
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
  onClick,
  children,
}: {
  label: string;
  /** Whether a toggle is on; undefined for a button that acts. */
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <IconTooltip label={label} align="End">
      {(triggerRef) => (
        <IconButton
          ref={triggerRef}
          size="300"
          radii="300"
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
        >
          {children}
        </IconButton>
      )}
    </IconTooltip>
  );
}

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
  // Start with the Files tree closed when stacked above the diffs (< 640px).
  const [wide, setWide] = useState<boolean | null>(() =>
    typeof ResizeObserver === 'undefined' ? true : null
  );
  const [treeChoice, setTreeChoice] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const width = root.clientWidth;
      setWide((previous) => (width === 0 ? previous ?? true : width >= WIDE_TREE_MIN_WIDTH));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  const treeOpen = treeChoice ?? wide ?? false;
  const [nearViewport, setNearViewport] = useState<ReadonlySet<string>>(() => new Set());
  // Pierre only mounts items in its virtualized window (visible rows plus overscan).
  const onDiffRender = useCallback(
    (
      _node: HTMLElement,
      _instance: unknown,
      phase: PostRenderPhase,
      { item }: { item: { id: string } }
    ) => {
      if (phase === 'update') return;
      setNearViewport((previous) => {
        if (previous.has(item.id) === (phase === 'mount')) return previous;
        const next = new Set(previous);
        if (phase === 'mount') next.add(item.id);
        else next.delete(item.id);
        return next;
      });
    },
    []
  );
  const viewerRef = useRef<CodeViewHandle<ThreadGroup, undefined>>(null);
  const rowsRef = useRef(new Map<string, HTMLElement>());

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

  // The highlighted lines depend on the theme, so the parse cache key carries it.
  const scope = `pull-request:${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}:${themeKind}`;
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

  const testPaths = useMemo(
    () => new Set((viewFiles ?? []).map((file) => file.path).filter(isTestFile)),
    [viewFiles]
  );
  const shownPartialDiffs = useMemo(
    () =>
      hideTests
        ? parsedFiles.filter((fileDiff) => !testPaths.has(resolveFileDiffPath(fileDiff)))
        : parsedFiles,
    [parsedFiles, hideTests, testPaths]
  );
  const sourceByPath = useMemo(
    () => new Map(viewFiles?.map((file) => [file.path, file])),
    [viewFiles]
  );
  const targets = useMemo(
    () =>
      shownPartialDiffs.filter(canHydrateDiff).flatMap((diff) => {
        const path = resolveFileDiffPath(diff);
        const sha = sourceByPath.get(path)?.sha;
        return sha ? [{ path, sha }] : [];
      }),
    [shownPartialDiffs, sourceByPath]
  );
  const shas = useMemo(() => [...new Set(targets.map(({ sha }) => sha))], [targets]);
  const enabledShas = useMemo(
    () =>
      new Set(
        targets.flatMap(({ path, sha }) =>
          nearViewport.has(path) && !collapsedOf(path) ? [sha] : []
        )
      ),
    [targets, nearViewport, collapsedOf]
  );
  const blobs = useDiffBlobs(pullRequest, shas, enabledShas);
  const shownDiffs = useMemo(
    () =>
      shownPartialDiffs.map((file) => {
        const source = sourceByPath.get(resolveFileDiffPath(file));
        return prepareFileDiff(file, {
          source,
          blob: source?.sha ? blobs.get(source.sha) : undefined,
          ignoreWhitespace,
        });
      }),
    [shownPartialDiffs, sourceByPath, blobs, ignoreWhitespace]
  );
  const hiddenTests = hideTests ? testPaths.size : 0;
  // A file without a diff to show, as GitHub sends none for a binary or a very large file.
  const withoutDiff = useMemo(() => {
    const parsed = new Set(parsedFiles.map(resolveFileDiffPath));
    return (viewFiles ?? []).filter(
      (file) => !parsed.has(file.path) && !(hideTests && testPaths.has(file.path))
    );
  }, [viewFiles, parsedFiles, hideTests, testPaths]);
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

  const marked = listed
    .filter((path) => markTexts.has(path))
    .map((path) => ({ fileKey: path, path, patch: markTexts.get(path) ?? '' }));
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

  const updateFolds = (change: (current: Folds) => Partial<Folds>) =>
    setFolds((stored) => {
      const current = stored.view === view ? stored : folds;
      return { ...current, ...change(current) };
    });
  const toggleFolded = (path: string) =>
    updateFolds((current) => ({
      choices: withFileDiffFold(
        current.choices,
        foldKeyOf(path),
        !isFileDiffCollapsed(foldKeyOf(path), current.override, current.choices, isViewedNow(path))
      ),
    }));
  // Marking a file viewed folds it and unmarking it unfolds it; Shift-click does so from the
  // file last marked to this one, as the list shows them. Before the toolbar's collapse or expand
  // all is used, a mark drops the reader's fold, so the fold follows the mark; after it, the mark
  // sets the reader's fold.
  const setViewed = (path: string, extendRange: boolean) => {
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
  };
  const header: FileHeaderState = {
    statOf: (path) => stats.get(path),
    viewedOf: (path) => {
      const patch = markTexts.get(path);
      return patch === undefined ? undefined : viewed.stateOf(path, patch);
    },
    setViewed,
    foldedOf: collapsedOf,
    toggleFolded,
  };
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

  const reveal = (path: string) => {
    if (items.some((item) => item.id === path)) {
      // A folded file opens as it is revealed, and stays open as its mark changes.
      updateFolds((current) => ({
        choices: withFileDiffFold(current.choices, foldKeyOf(path), false),
      }));
      viewerRef.current?.scrollTo({ type: 'item', id: path, align: 'start' });
    } else {
      rowsRef.current.get(path)?.scrollIntoView({ block: 'nearest' });
    }
  };

  const renderWithoutDiff = () =>
    withoutDiff.length === 0 ? null : (
      <ul className="mrpr-no-diff-list">
        {withoutDiff.map((file) => (
          <li
            key={file.path}
            className="mrpr-no-diff"
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
    );

  // Nothing to show: the view has no file, every one is a hidden test, or only whitespace changed
  // while whitespace changes are hidden.
  const emptyNote = !viewFiles
    ? undefined
    : viewFiles.length === 0
    ? t(shownCommit === undefined ? 'code.noChanges' : 'code.noCommitChanges')
    : listed.length === 0
    ? t('code.onlyTests')
    : ignoreWhitespace &&
      withoutDiff.length === 0 &&
      shownDiffs.every(
        (fileDiff) =>
          fileDiff.hunks.length > 0 &&
          fileDiff.hunks.every((hunk) => hunk.additionLines === 0 && hunk.deletionLines === 0)
      )
    ? t('code.onlyWhitespace')
    : undefined;

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
          <ToolbarButton
            label={t('code.files')}
            pressed={treeOpen}
            onClick={() => setTreeChoice(!treeOpen)}
          >
            <FolderTree aria-hidden className="mrpr-button-icon" />
          </ToolbarButton>
        </div>
      </div>
      {/* A list that did not load leaves the diffs whole; it says so, with a retry, above them. */}
      {commits.status === 'error' ||
      threads.status === 'error' ||
      truncatedReviewComments !== undefined ||
      truncatedCommits !== undefined ? (
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
        </div>
      ) : null}
      {/* Another view starts with the bar closed. */}
      <OffDiffThreads key={view} threads={placed.offDiff} />
      {viewFiles && emptyNote ? (
        <div className="mrpr-panel-note">
          <p className="mrpr-status">{emptyNote}</p>
        </div>
      ) : viewFiles ? (
        <div className="mrpr-code-body">
          {treeOpen ? (
            <FileTreeColumn>
              <DiffFileTree
                ariaLabel={t('code.treeLabel', pullRequest)}
                entries={entries}
                onSelectFile={reveal}
              />
            </FileTreeColumn>
          ) : null}
          <div className="mrpr-code-diffs" onClickCapture={onDiffsClickCapture}>
            <FileHeaderContext.Provider value={header}>
              {/* The viewer must own its scroll element to position virtual rows within it. */}
              <StyledDiffCodeView<ThreadGroup>
                viewerRef={viewerRef}
                items={items}
                options={{
                  theme: DIFF_THEME_NAMES[themeKind],
                  themeType: themeKind,
                  diffStyle: prefs.diffStyle,
                  overflow: prefs.wrap ? 'wrap' : 'scroll',
                  lineDiffType: 'none',
                  stickyHeaders: true,
                  onPostRender: onDiffRender,
                }}
                renderCodeViewFooter={renderWithoutDiff}
                renderHeaderPrefix={renderHeaderPrefix}
                renderHeaderMetadata={renderHeaderMetadata}
                renderAnnotation={renderAnnotation}
                unsafeCSSExtra={REPLACE_FILE_COUNTS_CSS}
              />
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
