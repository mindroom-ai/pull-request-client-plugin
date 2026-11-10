// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/diffs/DiffFileTree.tsx, components/files/fileTreeExpansion.ts and hooks/useStableCallback.ts at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The changed files as a tree, in Pierre's file tree, with a header that folds every folder.
import { IconButton, IconTooltip, useThemeKind } from '@mindroom/client-sdk/ui';
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import type { GitStatusEntry } from '@pierre/trees';
import { FileTree, useFileTree, useFileTreeSelector } from '@pierre/trees/react';
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { useEffect, useInsertionEffect, useRef, useState } from 'react';

import {
  buildDiffFileTreeUpdates,
  compareDiffFileTreeEntries,
  collectDirectoryPaths,
  diffFileTreeModel,
  diffFileTreePositions,
  type DiffFileTreeEntry,
} from './diffFileTree.logic';
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

interface DiffFileTreeProps {
  readonly entries: ReadonlyArray<DiffFileTreeEntry>;
  readonly onSelectFile: (path: string) => void;
  readonly ariaLabel: string;
}

export function DiffFileTree({ entries, onSelectFile, ariaLabel }: DiffFileTreeProps) {
  const t = usePluginTranslation('pull-requests');
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
  const syncingSelectionRef = useRef(false);
  const mountedPresentationRef = useRef<ReturnType<typeof diffFileTreeModel> | null>(null);

  // The tree model keeps the first selection handler it was given.
  const handleSelectionChange = useStableCallback((selectedPaths: ReadonlyArray<string>) => {
    if (syncingSelectionRef.current) return;
    const modelPath = selectedPaths.at(-1);
    if (modelPath && modelPaths.includes(modelPath)) {
      onSelectFile(presented.selectionPath(modelPath));
    }
  });

  const { model } = useFileTree({
    density: 'compact',
    flattenEmptyDirectories: true,
    initialExpansion: 'open',
    icons,
    onSelectionChange: handleSelectionChange,
    paths: [],
    search: false,
    sort: ordering.sort,
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });
  const allDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, directoryPaths)
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
    if (mounted === null) {
      model.resetPaths(modelPaths);
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
      const collapsedDirectories = directoryPaths.filter((path) => {
        const directory = model.getItem(path);
        return directory !== null && 'isExpanded' in directory && !directory.isExpanded();
      });
      syncingSelectionRef.current = true;
      model.resetPaths(modelPaths);
      for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect();
      for (const path of selectedPaths) model.getItem(path)?.select();
      queueMicrotask(() => {
        syncingSelectionRef.current = false;
      });
      for (const path of collapsedDirectories) {
        const directory = model.getItem(path);
        if (directory !== null && 'collapse' in directory) directory.collapse();
      }
      if (
        nextFocusedPath !== null &&
        (modelPaths.includes(nextFocusedPath) || directoryPaths.includes(nextFocusedPath))
      ) {
        model.focusPath(nextFocusedPath);
      }
    }
    model.setGitStatus(gitStatus);
  }, [directoryPaths, gitStatus, model, modelPaths, ordering, positions, presented]);

  const foldLabel = allDirectoriesExpanded ? t('code.collapseFolders') : t('code.expandFolders');
  return (
    <div className="mrpr-tree">
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
