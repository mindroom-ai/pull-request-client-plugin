// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/diffs/StyledDiffCodeView.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// Pierre's diff view in the app's colors and fonts. Uses a surrounding worker pool when Web
// Workers are available, falling back to main-thread highlighting otherwise.
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewReactOptions,
  type ControlledCodeViewProps,
} from '@pierre/diffs/react';
import { useMemo, type Ref } from 'react';

import { useRootFontSize } from '../rootFontSize';
import { DIFF_SURFACE_THEME_UNSAFE_CSS } from './diffRendering';

export const DIFF_VIEW_UNSAFE_CSS = `${DIFF_SURFACE_THEME_UNSAFE_CSS}
/* Code reads left to right in every app language, as the app's code blocks do. Sizes are in rem,
   so the diffs follow the page zoom; the row heights the view is given in px go with them. */
:host {
  direction: ltr;
  --diffs-font-size: 0.8125rem;
  --diffs-line-height: 1.25rem;
  --diffs-gap-fallback: 0.5rem;
}

/* Pierre's icons are 16px by their attributes. */
svg:is([data-change-icon], [data-rename-icon], [data-icon]) {
  width: 1rem;
  height: 1rem;
}

/* A 1fr track's automatic minimum grows with the currently mounted lines. In split
   wrap mode that shifts width between columns, rewraps rows and makes the virtualizer
   repeatedly correct the scroll position. Keep both code columns at the same width. */
[data-diff-type="split"][data-overflow="wrap"] {
  --diffs-code-grid: var(--diffs-grid-number-column-width) minmax(0, 1fr);
}

:is(
  [data-line],
  [data-line-annotation],
  [data-merge-conflict],
  [data-merge-conflict-actions],
  [data-no-newline]
)[data-selected-line] {
  --diffs-line-bg: light-dark(
    color-mix(
      in lab,
      var(--code-background) 88%,
      color-mix(in srgb, var(--code-background) 50%, var(--diffs-modified-base))
    ),
    color-mix(
      in lab,
      var(--code-background) 80%,
      color-mix(in srgb, var(--code-background) 70%, var(--diffs-modified-base))
    )
  ) !important;
}

:is([data-gutter-buffer], [data-column-number])[data-selected-line] {
  --diffs-line-bg: light-dark(
    color-mix(
      in lab,
      var(--code-background) 91%,
      color-mix(in srgb, var(--code-background) 35%, var(--diffs-modified-base))
    ),
    color-mix(
      in lab,
      var(--code-background) 85%,
      color-mix(in srgb, var(--code-background) 60%, var(--diffs-modified-base))
    )
  ) !important;
}

[data-indicators="bars"]
  :is([data-column-number], [data-gutter-buffer="annotation"])[data-selected-line] {
  position: relative;
}

[data-indicators="bars"]
  :is([data-column-number], [data-gutter-buffer="annotation"])[data-selected-line]::before {
  position: absolute !important;
  inset-block: 0 !important;
  inset-inline-start: 0 !important;
  display: block !important;
  width: 4px !important;
  min-width: 4px !important;
  max-width: 4px !important;
  height: auto !important;
  padding: 0 !important;
  content: "" !important;
  background-color: var(--diffs-modified-base) !important;
  background-image: none !important;
}

[data-file-info] {
  background-color: var(--code-background) !important;
  border-block-color: transparent !important;
  color: var(--code-foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: var(--code-background) !important;
  border-bottom-color: transparent !important;
  align-items: center !important;
  font-family: var(--font-sans) !important;
  font-size: 0.75rem !important;
  line-height: 1 !important;
  /* Collapsed items are never remeasured: the painted header must match diffHeaderHeight.
     Center controls in that height instead of adding padding to their intrinsic height. */
  height: 2rem !important;
  min-height: 2rem !important;
  padding-block: 0 !important;
  padding-inline: 0.5rem 0.75rem !important;
}

[data-diffs-header]:hover {
  /* A native scrollbar gutter cannot be painted by descendants. Use an inset edge cue instead
     of a full-width band that would look accidentally clipped at the gutter. */
  background-color: var(--code-background) !important;
  box-shadow: inset 3px 0 color-mix(in srgb, var(--code-foreground) 24%, transparent);
}

/* Hunk separators are the way to the unchanged lines between hunks. They keep the library's
   layout, with the expand button in its own cell, but sit one step off the code surface so they
   read as quiet controls; hover brings them forward. */
:is([data-separator="line-info"], [data-separator="line-info-basic"]) {
  /* Exact and margin-free: the virtualizer places rows from hunkSeparatorHeight below. */
  height: 1.5rem !important;
  margin-block: 0 !important;
  --diffs-bg-separator: color-mix(in srgb, var(--code-background) 97%, var(--code-foreground));
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]) [data-separator-content] {
  color: color-mix(in srgb, var(--code-foreground) 50%, var(--code-background)) !important;
  font-family: var(--font-sans) !important;
  font-size: 0.6875rem !important;
  text-decoration: none !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]) [data-expand-button] {
  color: color-mix(in srgb, var(--code-foreground) 50%, var(--code-background)) !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])[data-expand-index]
  :is([data-separator-content], [data-expand-button]):hover {
  color: var(--code-foreground) !important;
  background-color: color-mix(
    in srgb,
    var(--code-background) 92%,
    var(--code-foreground)
  ) !important;
}

[data-diffs-header] [data-header-content] {
  align-items: center !important;
  line-height: 1 !important;
}

/* Pierre clips file names with overflow: hidden for its start ellipsis. A 1em line box cuts off
   descenders; give the clipped names room inside the fixed-height header. */
[data-diffs-header] :is([data-title], [data-prev-name]) {
  line-height: 1rem !important;
}

[data-diffs-header] [data-metadata] {
  align-items: center !important;
  line-height: 1 !important;
  font-variant-numeric: tabular-nums;
}

[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  font-family: var(--font-mono) !important;
  font-size: 0.6875rem !important;
  font-variant-numeric: tabular-nums;
  line-height: 1 !important;
}

[data-diffs-header] [data-change-icon],
[data-diffs-header] [data-rename-icon] {
  display: block;
  flex-shrink: 0;
}

[data-title] {
  font-family: var(--font-sans) !important;
}

/* Expanding a file mounts its body all at once; easing it in matches the 200ms the app's
   collapsibles take. Appearance only: the viewer owns geometry, so height cannot animate. */
[data-diff],
[data-file] {
  transition: opacity 200ms ease-out;
}

@starting-style {
  [data-diff],
  [data-file] {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-diff],
  [data-file] {
    transition: none;
  }
}
`;

export type StyledDiffCodeViewOptions<LAnnotation> = Omit<
  CodeViewReactOptions<LAnnotation, undefined>,
  'unsafeCSS' | 'itemMetrics' | 'layout'
>;

type StyledDiffCodeViewProps<LAnnotation> = Omit<
  ControlledCodeViewProps<LAnnotation, undefined>,
  'options' | 'disableWorkerPool'
> & {
  readonly options?: StyledDiffCodeViewOptions<LAnnotation>;
  readonly viewerRef?: Ref<CodeViewHandle<LAnnotation, undefined>>;
  /** Styles of the caller's own, after the view's. */
  readonly unsafeCSSExtra?: string;
};

const DIFF_VIEW_LAYOUT = { paddingTop: 0, paddingBottom: 0, gap: 0 };

export function StyledDiffCodeView<LAnnotation = undefined>({
  options,
  viewerRef,
  className,
  unsafeCSSExtra,
  ...props
}: StyledDiffCodeViewProps<LAnnotation>) {
  const rem = useRootFontSize();
  const itemMetrics = useMemo(
    () => ({
      lineHeight: 1.25 * rem,
      diffHeaderHeight: 2 * rem,
      hunkSeparatorHeight: 1.5 * rem,
      // Zero both spacing and paddingTop; Pierre's expanded-file fallback otherwise adds a header
      // gap.
      spacing: 0,
      paddingTop: 0,
      // Include --diffs-gap-fallback in metrics or each expanded file loses a scrollable row.
      paddingBottom: 0.5 * rem,
    }),
    [rem]
  );
  const mergedOptions = useMemo<CodeViewReactOptions<LAnnotation, undefined>>(
    () => ({
      ...options,
      unsafeCSS: unsafeCSSExtra
        ? `${DIFF_VIEW_UNSAFE_CSS}\n${unsafeCSSExtra}`
        : DIFF_VIEW_UNSAFE_CSS,
      // In px, from the rem sizes of the styles above.
      itemMetrics,
      layout: DIFF_VIEW_LAYOUT,
    }),
    [options, unsafeCSSExtra, itemMetrics]
  );
  return (
    <CodeView<LAnnotation>
      {...props}
      {...(viewerRef ? { ref: viewerRef } : {})}
      disableWorkerPool={typeof Worker === 'undefined'}
      className={className ? `mrpr-diff-view ${className}` : 'mrpr-diff-view'}
      options={mergedOptions}
    />
  );
}
