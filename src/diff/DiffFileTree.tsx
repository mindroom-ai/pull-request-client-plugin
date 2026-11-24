// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/diffs/DiffFileTree.tsx, components/files/fileTreeExpansion.ts and hooks/useStableCallback.ts at 8ab427c6 (and 1c86881dd5)), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The changed files as a tree, in Pierre's file tree, with a header that folds every folder.
import { IconButton, IconTooltip, useThemeKind } from '@mindroom/client-sdk/ui';
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import type {
  FileTreeRowDecoration,
  FileTreeRowDecorationContext,
  GitStatusEntry,
} from '@pierre/trees';
import { FileTree, useFileTree, useFileTreeSelector } from '@pierre/trees/react';
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import {
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MutableRefObject,
} from 'react';

import {
  buildDiffFileTreeUpdates,
  compareDiffFileTreeEntries,
  collectDirectoryPaths,
  diffFileTreeDirectoryLines,
  diffFileTreeModel,
  diffFileTreePositions,
  type DiffFileTreeEntry,
} from './diffFileTree.logic';
import { useLanguage } from '../presentation';
import { useRootFontSize } from '../rootFontSize';
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from './pierreTreeTheme';

export type { DiffFileTreeEntry } from './diffFileTree.logic';

type TreeModel = ReturnType<typeof useFileTree>['model'];

function areAllDirectoriesExpanded(model: TreeModel, directoryPaths: readonly string[]): boolean {
  return (
    directoryPaths.length > 0 &&
    directoryPaths.every((path) => {
      const item = model.getItem(path);
      return item !== null && 'isExpanded' in item && item.isExpanded();
    })
  );
}

/**
 * Calls `listener` once per task, however many events the model emitted in it. Expanding every
 * folder emits one event per folder, and a listener that looks at every folder is quadratic
 * otherwise.
 */
function subscribeOncePerTask(
  model: { subscribe(listener: () => void): () => void },
  listener: () => void
): () => void {
  let queued = false;
  let subscribed = true;
  const unsubscribe = model.subscribe(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (subscribed) listener();
    });
  });
  return () => {
    subscribed = false;
    unsubscribe();
  };
}

function setAllDirectoriesExpanded(
  model: TreeModel,
  directoryPaths: readonly string[],
  expanded: boolean
): void {
  for (const path of directoryPaths) {
    const item = model.getItem(path);
    if (item === null || !('isExpanded' in item) || item.isExpanded() === expanded) continue;
    if (expanded) item.expand();
    else item.collapse();
  }
}

/** Call only from handlers and effects; render sees the previous commit's fn. */
function useStableCallback<Args extends ReadonlyArray<unknown>, Result>(
  fn: (...args: Args) => Result
): (...args: Args) => Result {
  const latest = useRef(fn);
  // Insertion effects run before every layout effect in the commit, so a
  // child's layout effect already calls this render's fn.
  useInsertionEffect(() => {
    latest.current = fn;
  });
  const [stable] = useState(
    () =>
      (...args: Args) =>
        latest.current(...args)
  );
  return stable;
}

type TreeInitialExpansion = 'open' | 'closed';

interface DiffFileTreeProps {
  readonly entries: ReadonlyArray<DiffFileTreeEntry>;
  readonly onSelectFile: (path: string) => void;
  readonly ariaLabel: string;
  readonly initialExpansion?: TreeInitialExpansion;
}

/** What the tree shows besides its paths, by the model's paths. */
interface TreeView {
  readonly selectedPaths: readonly string[];
  readonly expandedDirectories: readonly string[];
  readonly collapsedDirectories: readonly string[];
  readonly focusedPath: string | null;
}

/** What a tree made again for another zoom takes over from the one before. */
interface CarriedTree extends TreeView {
  readonly initialExpansion: TreeInitialExpansion;
  /** How far it was scrolled, in rows. */
  readonly scrolledRows: number;
  /** Where the keyboard's focus was in it: on a row or on the header's button. */
  readonly focused: 'row' | 'header' | null;
}

function directoryStatesOf(
  model: TreeModel,
  directoryPaths: readonly string[]
): Pick<TreeView, 'expandedDirectories' | 'collapsedDirectories'> {
  const expandedDirectories: string[] = [];
  const collapsedDirectories: string[] = [];
  for (const path of directoryPaths) {
    const directory = model.getItem(path);
    if (directory === null || !('isExpanded' in directory)) continue;
    if (directory.isExpanded()) expandedDirectories.push(path);
    else collapsedDirectories.push(path);
  }
  return { expandedDirectories, collapsedDirectories };
}

/**
 * Gives `model`, whose paths were just reset, `view`'s expanded/collapsed folders, selection and
 * focus. Restoring folder expansion first ensures focused/selected descendants exist in the
 * projection regardless of `initialExpansion`. The selection it reports meanwhile is its own doing,
 * which the caller ignores while syncing.
 */
function applyTreeView(model: TreeModel, view: TreeView, known: (path: string) => boolean) {
  for (const path of view.expandedDirectories) {
    const directory = model.getItem(path);
    if (directory !== null && 'isExpanded' in directory && !directory.isExpanded()) {
      directory.expand();
    }
  }
  for (const path of view.collapsedDirectories) {
    const directory = model.getItem(path);
    if (directory !== null && 'isExpanded' in directory && directory.isExpanded()) {
      directory.collapse();
    }
  }
  for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect();
  for (const path of view.selectedPaths) model.getItem(path)?.select();
  if (view.focusedPath !== null && known(view.focusedPath)) model.focusPath(view.focusedPath);
}

/** The element the tree scrolls in, inside the shadow root Pierre draws it in. */
const scrollElementOf = (tree: HTMLElement | null) =>
  tree
    ?.querySelector('file-tree-container')
    ?.shadowRoot?.querySelector<HTMLElement>('[data-file-tree-virtualized-scroll="true"]') ?? null;

/** How long the page zoom rests before the tree is made again at its size. */
const ZOOM_SETTLE_MS = 250;

/**
 * Pierre's tree places its rows by a height in px that it takes once, when it is made, so a page
 * zoom makes it again with the rows' 1.5rem in the new size, once the zoom rests (a pinch changes
 * it on each frame), with the selection, folded folders, focus and scroll of the one before.
 */
export function DiffFileTree({ initialExpansion = 'open', ...props }: DiffFileTreeProps) {
  const rem = useRootFontSize();
  const [settledRem, setSettledRem] = useState(rem);
  useEffect(() => {
    if (rem === settledRem) return undefined;
    const timer = setTimeout(() => setSettledRem(rem), ZOOM_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [rem, settledRem]);
  const carried = useRef<CarriedTree | null>(null);
  return (
    <SizedDiffFileTree
      key={`${settledRem}:${initialExpansion}`}
      {...props}
      initialExpansion={initialExpansion}
      itemHeight={1.5 * settledRem}
      carried={carried}
    />
  );
}

function SizedDiffFileTree({
  entries,
  onSelectFile,
  ariaLabel,
  initialExpansion,
  itemHeight,
  carried,
}: Omit<DiffFileTreeProps, 'initialExpansion'> & {
  readonly initialExpansion: TreeInitialExpansion;
  readonly itemHeight: number;
  readonly carried: MutableRefObject<CarriedTree | null>;
}) {
  const t = usePluginTranslation('pull-requests');
  const language = useLanguage();
  const themeKind = useThemeKind();
  const paths = entries.map((entry) => entry.path);
  const presented = diffFileTreeModel(paths);
  const modelPaths = presented.paths;
  const icons = presented.icons;
  const directoryPaths = collectDirectoryPaths(modelPaths);
  const positions = diffFileTreePositions(modelPaths);
  const [ordering] = useState(() => {
    let currentPositions: ReadonlyMap<string, number> = new Map();
    return {
      sort: compareDiffFileTreeEntries(() => currentPositions),
      update: (nextPositions: ReadonlyMap<string, number>) => {
        currentPositions = nextPositions;
      },
    };
  });
  const gitStatus: ReadonlyArray<GitStatusEntry> = entries.map((entry) => ({
    path: presented.modelPath(entry.path),
    status: entry.status,
  }));
  const directoryLines = useMemo(() => diffFileTreeDirectoryLines(entries), [entries]);
  const syncingSelectionRef = useRef(false);
  const treeRef = useRef<HTMLDivElement>(null);
  const mountedPresentationRef = useRef<ReturnType<typeof diffFileTreeModel> | null>(null);

  // The tree model keeps the first selection handler it was given.
  const handleSelectionChange = useStableCallback((selectedPaths: ReadonlyArray<string>) => {
    if (syncingSelectionRef.current) return;
    const modelPath = selectedPaths.at(-1);
    if (modelPath && modelPaths.includes(modelPath)) {
      onSelectFile(presented.selectionPath(modelPath));
    }
  });

  // A folder's changed lines; a file's are in its diff's header. The tree model keeps the first
  // renderer it was given, and draws after this component's commit, so this reads the latest counts.
  const renderDirectoryLines = useStableCallback(
    ({ item }: FileTreeRowDecorationContext): FileTreeRowDecoration | null => {
      if (item.kind !== 'directory') return null;
      const lines = directoryLines.get(item.path);
      if (lines === undefined || (lines.additions === 0 && lines.deletions === 0)) return null;
      // In the app's language, as the pull request's own line counts are.
      const format = new Intl.NumberFormat(language);
      const additions = format.format(lines.additions);
      const deletions = format.format(lines.deletions);
      const added = `+${additions}`;
      const removed = `-${deletions}`;
      return {
        text: `${added} ${removed}`,
        // The plural follows the number; the text shows it formatted, as the row does. The path is
        // the whole folder's, which a narrow tree may cut. Folders are never aliased, only files;
        // selectionPath keeps the path real should that change.
        title: t('code.folderLines', {
          count: lines.additions,
          path: presented.selectionPath(item.path).replace(/\/$/, ''),
          additions,
          deletions,
        }),
        parts: [
          { text: added, color: 'var(--pr-added)' },
          { text: removed, color: 'var(--pr-removed)' },
        ],
      };
    }
  );

  const { model } = useFileTree({
    density: 'compact',
    itemHeight,
    flattenEmptyDirectories: true,
    initialExpansion,
    icons,
    onSelectionChange: handleSelectionChange,
    paths: [],
    renderRowDecoration: renderDirectoryLines,
    search: false,
    sort: ordering.sort,
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });
  // Before Pierre's tree goes, what the next one, made for another zoom, takes over.
  useLayoutEffect(
    () => () => {
      const tree = treeRef.current;
      const paths = mountedPresentationRef.current?.paths ?? [];
      carried.current = {
        initialExpansion,
        selectedPaths: model.getSelectedPaths(),
        ...directoryStatesOf(model, collectDirectoryPaths(paths)),
        focusedPath: model.getFocusedPath(),
        scrolledRows: (scrollElementOf(tree)?.scrollTop ?? 0) / model.getItemHeight(),
        focused: tree?.querySelector('file-tree-container')?.matches(':focus-within')
          ? 'row'
          : tree?.querySelector('.mrpr-tree-header')?.contains(document.activeElement)
            ? 'header'
            : null,
      };
    },
    [carried, initialExpansion, model]
  );
  const allDirectoriesExpanded = useSyncExternalStore(
    (listener) => subscribeOncePerTask(model, listener),
    () => areAllDirectoriesExpanded(model, directoryPaths)
  );
  // The tree takes no height from its rows, so it says how tall they are: above the diffs, its
  // pane is as tall as them until it reaches its cap.
  const visibleRows = useFileTreeSelector(model, (currentModel) => currentModel.getVisibleCount());

  // Pushes the icon set into the imperative Pierre file tree model.
  useEffect(() => {
    model.setIcons(icons);
  }, [icons, model]);

  // Applies path updates, ordering and git status to the imperative Pierre file tree model.
  useEffect(() => {
    ordering.update(positions);
    const mounted = mountedPresentationRef.current;
    if (mounted?.paths === modelPaths) return;
    mountedPresentationRef.current = presented;
    const known = (path: string) => modelPaths.includes(path) || directoryPaths.includes(path);
    if (mounted === null) {
      model.resetPaths(modelPaths);
      const before = carried.current;
      carried.current = null;
      if (before !== null && before.initialExpansion === initialExpansion) {
        syncingSelectionRef.current = true;
        applyTreeView(model, before, known);
        queueMicrotask(() => {
          syncingSelectionRef.current = false;
        });
        if (before.focused === 'header') {
          treeRef.current?.querySelector<HTMLElement>('.mrpr-tree-header button')?.focus();
        }
        // Once Pierre has drawn the rows, at the row it showed first, and with the focus.
        requestAnimationFrame(() => {
          const scroller = scrollElementOf(treeRef.current);
          if (scroller) scroller.scrollTop = before.scrolledRows * itemHeight;
          if (before.focused !== 'row' || before.focusedPath === null) return;
          // Pierre's first layout scrolls to the focused row and the restore then sets the scroll back.
          scroller
            ?.querySelector<HTMLElement>(`[data-item-path="${CSS.escape(before.focusedPath)}"]`)
            ?.focus({ preventScroll: true });
        });
      }
    } else if (mounted.paths.every((path, index) => modelPaths[index] === path)) {
      const updates = buildDiffFileTreeUpdates(mounted.paths, modelPaths);
      if (updates.length > 0) model.batch(updates);
    } else {
      // A reset can turn a file path into a directory. Carry selection and focus
      // through real paths so a refetch keeps the same file without revealing it again.
      const focusedPath = model.getFocusedPath();
      const nextFocusedPath =
        focusedPath === null ? null : presented.modelPath(mounted.selectionPath(focusedPath));
      const selectedPaths = model
        .getSelectedPaths()
        .map((path) => presented.modelPath(mounted.selectionPath(path)))
        .filter((path) => path.endsWith('/') || modelPaths.includes(path));
      const { expandedDirectories, collapsedDirectories } = directoryStatesOf(
        model,
        directoryPaths
      );
      syncingSelectionRef.current = true;
      model.resetPaths(modelPaths);
      applyTreeView(
        model,
        { selectedPaths, expandedDirectories, collapsedDirectories, focusedPath: nextFocusedPath },
        known
      );
      queueMicrotask(() => {
        syncingSelectionRef.current = false;
      });
    }
    model.setGitStatus(gitStatus);
  }, [
    carried,
    directoryPaths,
    gitStatus,
    initialExpansion,
    itemHeight,
    model,
    modelPaths,
    ordering,
    positions,
    presented,
  ]);

  // Pierre draws its rows again on a change of paths or git status, not of counts alone, as when
  // another commit changed the same files. Setting its composition again is its only public call
  // that redraws without changing anything, as it does not skip an unchanged value; re-check this
  // when upgrading @pierre/trees (1.0.0-beta.6).
  useEffect(() => {
    model.setComposition(model.getComposition());
  }, [directoryLines, language, model, t]);

  const foldLabel = allDirectoriesExpanded ? t('code.collapseFolders') : t('code.expandFolders');
  return (
    <div ref={treeRef} className="mrpr-tree">
      <div className="mrpr-tree-header">
        <span className="mrpr-tree-title">{t('code.files')}</span>
        <span className="mrpr-tree-count">{entries.length}</span>
        {directoryPaths.length > 0 ? (
          <IconTooltip label={foldLabel}>
            {(triggerRef) => (
              <IconButton
                ref={triggerRef}
                size="300"
                radii="300"
                aria-label={foldLabel}
                onClick={() =>
                  setAllDirectoriesExpanded(model, directoryPaths, !allDirectoriesExpanded)
                }
              >
                {allDirectoriesExpanded ? (
                  <ChevronsDownUp aria-hidden className="mrpr-button-icon" />
                ) : (
                  <ChevronsUpDown aria-hidden className="mrpr-button-icon" />
                )}
              </IconButton>
            )}
          </IconTooltip>
        ) : null}
      </div>
      <FileTree
        model={model}
        aria-label={ariaLabel}
        onClickCapture={(event) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return;
          }
          // Pierre emits no change for its sole selected row; read before the click to avoid double reveals.
          const selected = model.getSelectedPaths();
          const path = selected.length === 1 ? selected[0] : undefined;
          if (!path || !modelPaths.includes(path)) return;
          const clickedSelectedRow = event.nativeEvent
            .composedPath()
            .some(
              (node) => node instanceof HTMLElement && node.getAttribute('data-item-path') === path
            );
          if (clickedSelectedRow) onSelectFile(presented.selectionPath(path));
        }}
        style={{
          ...pierreTreeStyle(themeKind),
          ['--mrpr-tree-rows-height' as string]: `${visibleRows * model.getItemHeight()}px`,
        }}
      />
    </div>
  );
}
