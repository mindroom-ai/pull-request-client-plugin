// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestCodeTab.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The Code tab of the panel, laid out as T3 Code's pull request Code tab: the changed files as a
// tree beside their diffs, or above them in a narrow panel, both in T3 Code's file order. Choosing
// a file in the tree scrolls its diff to the top. Review threads show at their lines in the diffs,
// and the ones no rendered line holds in a bar above them; the commit selector shows one commit's
// diff in place of the pull request's. Each file's header folds it, shows GitHub's line counts and
// a viewed mark; the toolbar counts the viewed files and holds the display controls.
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { IconButton, IconTooltip, useThemeKind } from '@mindroom/client-sdk/ui';
import type { CodeViewDiffItem, CodeViewItem } from '@pierre/diffs';
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
  useContext,
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
import { isTestFile } from './diff/changedFileKind';
import { useCodePrefs } from './diff/codePrefs';
import {
  areAllDiffFilesCollapsed,
  getFileViewedRange,
  isFileDiffCollapsed,
  toggleFileDiffFoldForViewed,
  type DiffFoldOverride,
} from './diff/diffFold.logic';
import { DiffFileTree, type DiffFileTreeEntry } from './diff/DiffFileTree';
import { orderDiffFilesLikeTree } from './diff/diffFileTree.logic';
import {
  DIFF_THEME_NAMES,
  fnv1a32,
  getRenderablePatch,
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
import { useCommitFiles } from './queries';
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
const NO_PATHS: ReadonlySet<string> = new Set();

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
  toggled: ReadonlySet<string>;
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
}) {
  const t = usePluginTranslation('pull-requests');
  const themeKind = useThemeKind();
  const prefs = useCodePrefs();
  const viewed = useViewedFiles(pullRequest);
  const [treeOpen, setTreeOpen] = useState(true);
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
    () =>
      new Map(
        files.map((file) => [
          file.path,
          file.patch ?? (file.sha === null ? '' : `blob:${file.sha}`),
        ])
      ),
    [files]
  );

  // A view starts, once its files are there, with its viewed files folded, as GitHub shows them;
  // another commit, or All commits again, starts again.
  const view = shownCommit ?? '';
  const startFolds = (): Folds => ({
    view,
    override: null,
    toggled: new Set(
      (viewFiles ?? [])
        .map((file) => file.path)
        .filter((path) => {
          const text = markTexts.get(path);
          return text !== undefined && viewed.stateOf(path, text) === 'viewed';
        })
    ),
    anchor: null,
  });
  const [storedFolds, setFolds] = useState(() => (viewFiles ? startFolds() : undefined));
  if (viewFiles && storedFolds?.view !== view) setFolds(startFolds());
  const folds = storedFolds?.view === view ? storedFolds : startFolds();

  // The highlighted lines depend on the theme, so the parse that caches them carries it in its key.
  const scope = `pull-request:${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}:${themeKind}`;
  const { ignoreWhitespace, hideTests } = prefs;
  const parsedFiles = useMemo(() => {
    const patch = (viewFiles ?? [])
      .map(filePatch)
      .filter((part): part is string => part !== null)
      .join('');
    const parsed = getRenderablePatch(patch, scope, { ignoreWhitespace });
    // T3 Code's order, then the tree's, so the list and the tree agree.
    return parsed?.kind === 'files' ? orderDiffFilesLikeTree(orderDiffFiles(parsed.files)) : [];
  }, [viewFiles, scope, ignoreWhitespace]);

  const testPaths = useMemo(
    () => new Set((viewFiles ?? []).map((file) => file.path).filter(isTestFile)),
    [viewFiles]
  );
  const shownDiffs = useMemo(
    () =>
      hideTests
        ? parsedFiles.filter((fileDiff) => !testPaths.has(resolveFileDiffPath(fileDiff)))
        : parsedFiles,
    [parsedFiles, hideTests, testPaths]
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
        const collapsed = isFileDiffCollapsed(path, folds.override, folds.toggled);
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
    [shownDiffs, placed, folds.override, folds.toggled]
  );
  const statusByPath = useMemo(
    () => new Map((viewFiles ?? []).map((file) => [file.path, treeStatus(file.status)])),
    [viewFiles]
  );
  const entries = useMemo(
    (): DiffFileTreeEntry[] =>
      listed.map((path) => ({ path, status: statusByPath.get(path) ?? 'modified' })),
    [listed, statusByPath]
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

  const updateFolds = (change: (current: Folds) => Partial<Folds>) =>
    setFolds((stored) => {
      const current = stored?.view === view ? stored : folds;
      return { ...current, ...change(current) };
    });
  const toggleFolded = (path: string) =>
    updateFolds((current) => {
      const toggled = new Set(current.toggled);
      if (toggled.has(path)) toggled.delete(path);
      else toggled.add(path);
      return { toggled };
    });
  // Marking a file viewed folds it and unmarking it unfolds it; Shift-click does so from the
  // file last marked to this one, as the list shows them.
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
      toggled: range.reduce(
        (next, file) => toggleFileDiffFoldForViewed(file.path, mark, current.override, next),
        current.toggled
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
    foldedOf: (path) => isFileDiffCollapsed(path, folds.override, folds.toggled),
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
      // A folded file opens as it is revealed.
      updateFolds((current) => ({
        toggled: toggleFileDiffFoldForViewed(path, false, current.override, current.toggled),
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
    <div className="mrpr-root mrpr-code" style={pluginRootStyle()}>
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
                  toggled: NO_PATHS,
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
            onClick={() => setTreeOpen((open) => !open)}
          >
            <FolderTree aria-hidden className="mrpr-button-icon" />
          </ToolbarButton>
        </div>
      </div>
      {/* A list that did not load leaves the diffs whole; it says so, with a retry, above them. */}
      {commits.status === 'error' ||
      threads.status === 'error' ||
      truncatedReviewComments !== undefined ? (
        <div className="mrpr-code-notices">
          {commits.status === 'error' ? (
            <GitHubErrorState compact error={commits.error} onRetry={commits.retry} />
          ) : null}
          {threads.status === 'error' ? (
            <GitHubErrorState compact error={threads.error} onRetry={threads.retry} />
          ) : null}
          {truncatedReviewComments !== undefined ? (
            <p className="mrpr-status mrpr-note">
              <a
                className="mrpr-link"
                href={pullRequestUrl(pullRequest)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('summary.truncated', { count: truncatedReviewComments })}
              </a>
            </p>
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
            <div className="mrpr-code-tree">
              <DiffFileTree
                ariaLabel={t('code.treeLabel', pullRequest)}
                entries={entries}
                onSelectFile={reveal}
              />
            </div>
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
