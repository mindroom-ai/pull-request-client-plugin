// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/files/FileExplorerPane.tsx, hooks/useResizableWidth.ts, components/preview/RightPanelResizeHandle.tsx and lib/observeResize.ts at 943de8fe), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The Code tab's Files column. Beside the diffs it has a handle on its inline-end edge that drags
// or steps its width, which every Code tab keeps in the Code prefs; above the diffs, in a narrow
// panel, the handle is hidden and the width unused (styles.css). A drag shows each frame's width
// without a render and stores it when the pointer lets go.
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { useCodePrefs } from './codePrefs';
import { TREE_MIN_WIDTH, clampTreeWidth, steppedTreeWidth, treeMaxWidth } from './treeWidth.logic';
import { useResizeDrag } from './useResizeDrag';

/** The column sizes itself from this custom property. */
const WIDTH_PROPERTY = '--mrpr-tree-width';

const isRightToLeft = (element: Element) => getComputedStyle(element).direction === 'rtl';

export function FileTreeColumn({ children }: { children: ReactNode }) {
  const t = usePluginTranslation('pull-requests');
  const prefs = useCodePrefs();
  const hostRef = useRef<HTMLDivElement>(null);
  // Unbounded by the body until it is measured, before the first paint.
  const [maxWidth, setMaxWidth] = useState(() => treeMaxWidth(Number.POSITIVE_INFINITY));
  const width = clampTreeWidth(prefs.treeWidth, maxWidth);
  // A press that does not drag puts back the width shown when it lets go.
  const shownWidth = useRef(width);
  useLayoutEffect(() => {
    shownWidth.current = width;
  });

  // The column's bounds follow the Code body's width.
  useLayoutEffect(() => {
    const body = hostRef.current?.parentElement;
    if (!body) return;
    const measure = () => setMaxWidth(treeMaxWidth(body.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    // Rendered before the paint, as T3 Code's observeResize does; an ordinary update would paint
    // a frame with the old bounds.
    const observer = new ResizeObserver(() => flushSync(measure));
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  const drag = useResizeDrag<HTMLDivElement>((event) => {
    const host = hostRef.current;
    if (!host) return null;
    const startWidth = width;
    return {
      width: startWidth,
      edge: isRightToLeft(event.currentTarget) ? 'left' : 'right',
      bounds: { min: TREE_MIN_WIDTH, max: maxWidth },
      resize(nextWidth) {
        host.style.setProperty(WIDTH_PROPERTY, `${nextWidth}px`);
        return nextWidth;
      },
      finish(finalWidth, moved) {
        if (moved) prefs.update({ treeWidth: finalWidth });
        else host.style.setProperty(WIDTH_PROPERTY, `${shownWidth.current}px`);
      },
      cleanup(committed) {
        if (!committed) host.style.setProperty(WIDTH_PROPERTY, `${startWidth}px`);
      },
    };
  });
  const { cancel, refresh } = drag;
  // Bounds can change mid-drag (the panel narrows), and the render that carries them rewrites the
  // shown width, so re-apply the live pointer position.
  useLayoutEffect(() => refresh({ min: TREE_MIN_WIDTH, max: maxWidth }), [refresh, maxWidth]);
  // Closing the column mid-drag abandons the drag.
  useLayoutEffect(() => cancel, [cancel]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = steppedTreeWidth(event.key, width, maxWidth, isRightToLeft(event.currentTarget));
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    prefs.update({ treeWidth: next });
  };

  return (
    <div
      ref={hostRef}
      className="mrpr-code-tree"
      style={{ [WIDTH_PROPERTY]: `${width}px` } as CSSProperties}
    >
      {children}
      <div
        role="separator"
        aria-label={t('code.resizeFiles')}
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={TREE_MIN_WIDTH}
        aria-valuemax={maxWidth}
        tabIndex={0}
        className="mrpr-tree-resize"
        onKeyDown={onKeyDown}
        onPointerDown={drag.onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        onPointerCancel={drag.onPointerCancel}
        onLostPointerCapture={drag.onLostPointerCapture}
      >
        <span aria-hidden className="mrpr-tree-resize-line" />
      </div>
    </div>
  );
}
