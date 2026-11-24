// Interactive Line Distribution card inside the Code tab's diff scroller header: kind breakdown
// chips, directory drill-down breadcrumbs, Bars view, and dynamic-depth SVG Icicle flamegraph.
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useLanguage } from '../presentation';
import type { ChangedFileKind } from './changedFileKind';
import {
  COMPACT_ROW_LIMIT,
  ICICLE_DEFAULT_WIDTH,
  ICICLE_MAX_DEPTH,
  ICICLE_ROW_HEIGHT,
  buildBreadcrumbs,
  buildDirectoryRows,
  buildIcicleTree,
  canHideKind,
  computeBarWidths,
  formatShare,
  layoutIcicle,
  metricValue,
  sortFilesByMetric,
  statusBadge,
  summarizeByKind,
  type DistributionFile,
  type DistributionMetric,
  type DistributionView,
  type KindSummary,
} from './lineDistribution.logic';

export type LineDistributionProps = {
  /** All files in the current PR or commit view, anchoring the kind breakdown totals. */
  files: readonly DistributionFile[];
  activeKinds: ReadonlySet<ChangedFileKind>;
  dirPrefix: string;
  view: DistributionView;
  metric: DistributionMetric;
  onToggleKind: (kind: ChangedFileKind) => void;
  onDirPrefixChange: (dirPrefix: string) => void;
  onViewChange: (view: DistributionView) => void;
  onMetricChange: (metric: DistributionMetric) => void;
  onSelectFile: (path: string) => void;
};

type ViewProps = {
  scopedFiles: readonly DistributionFile[];
  dirPrefix: string;
  metric: DistributionMetric;
  scopeTotal: number;
  fmt: Intl.NumberFormat;
  onDirPrefixChange: (prefix: string) => void;
  onSelectFile: (path: string) => void;
};

const truncateLabel = (text: string, width: number): string => {
  const maxChars = Math.max(3, Math.floor((width - 10) / 6.4));
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
};

function SegmentedToggle<T extends string>(props: {
  label: string;
  value: T;
  options: readonly { id: T; text: string; title?: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="mrpr-dist-segmented" role="group" aria-label={props.label}>
      {props.options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          className={props.value === opt.id ? 'mrpr-dist-seg-btn is-active' : 'mrpr-dist-seg-btn'}
          aria-pressed={props.value === opt.id}
          title={opt.title}
          onClick={() => props.onChange(opt.id)}
        >
          {opt.text}
        </button>
      ))}
    </div>
  );
}

function BarRow(props: {
  counts: { additions: number; deletions: number };
  maxValue: number;
  scopeTotal: number;
  metric: DistributionMetric;
  fmt: Intl.NumberFormat;
  onClick: () => void;
  children: ReactNode;
}) {
  const { counts, maxValue, scopeTotal, metric, fmt, onClick, children } = props;
  const { addPct, delPct } = computeBarWidths(counts, maxValue, metric);
  const share = formatShare(metricValue(counts, metric), scopeTotal);
  const showAdd = counts.additions > 0 || metric === 'additions' || counts.deletions === 0;
  const showDel = metric === 'total' && counts.deletions > 0;
  return (
    <button type="button" className="mrpr-dist-bar-row" onClick={onClick}>
      <span className="mrpr-dist-bar-name-col">{children}</span>
      <span className="mrpr-dist-bar-stats mrpr-tabular">
        {showAdd ? <span className="mrpr-added">+{fmt.format(counts.additions)}</span> : null}
        {showDel ? <span className="mrpr-removed">-{fmt.format(counts.deletions)}</span> : null}
        <span className="mrpr-dist-bar-pct">{share}</span>
      </span>
      <span aria-hidden className="mrpr-dist-bar-track">
        {addPct > 0 ? (
          <span className="mrpr-dist-bar-add" style={{ inlineSize: `${addPct.toFixed(2)}%` }} />
        ) : null}
        {delPct > 0 ? (
          <span className="mrpr-dist-bar-del" style={{ inlineSize: `${delPct.toFixed(2)}%` }} />
        ) : null}
      </span>
    </button>
  );
}

function DistributionBars(props: ViewProps) {
  const { scopedFiles, dirPrefix, metric, scopeTotal, fmt, onDirPrefixChange, onSelectFile } =
    props;
  const t = usePluginTranslation('pull-requests');
  const [expandedPrefix, setExpandedPrefix] = useState<string | null>(null);
  const expanded = expandedPrefix === dirPrefix;

  const dirRows = useMemo(
    () => buildDirectoryRows(scopedFiles, dirPrefix, metric),
    [scopedFiles, dirPrefix, metric]
  );
  const sortedFiles = useMemo(() => sortFilesByMetric(scopedFiles, metric), [scopedFiles, metric]);
  const hasSubdirs = dirRows.some((row) => row.file === null);
  const maxDir = Math.max(0, ...dirRows.map((row) => row.value));
  const maxFile = Math.max(0, ...sortedFiles.map((file) => metricValue(file, metric)));
  const limit = expanded ? sortedFiles.length : COMPACT_ROW_LIMIT;

  const topTotal = sortedFiles
    .slice(0, COMPACT_ROW_LIMIT)
    .reduce((sum, file) => sum + metricValue(file, metric), 0);
  const concentrationText =
    sortedFiles.length > COMPACT_ROW_LIMIT
      ? t(dirPrefix ? 'code.distribution.topFilesFolder' : 'code.distribution.topFiles', {
          count: COMPACT_ROW_LIMIT,
          share: formatShare(topTotal, scopeTotal),
        })
      : sortedFiles.length > 1
        ? t(dirPrefix ? 'code.distribution.largestFileFolder' : 'code.distribution.largestFile', {
            share: formatShare(metricValue(sortedFiles[0], metric), scopeTotal),
          })
        : t('code.distribution.lineCount', {
            count: scopeTotal,
            formatted: fmt.format(scopeTotal),
          });

  return (
    <>
      <div
        className={hasSubdirs ? 'mrpr-dist-bars-grid mrpr-dist-bars-split' : 'mrpr-dist-bars-grid'}
      >
        {hasSubdirs ? (
          <div className="mrpr-dist-column">
            <div className="mrpr-dist-sec-head">
              <span className="mrpr-dist-sec-title">
                {dirPrefix
                  ? t('code.distribution.foldersIn', { prefix: dirPrefix })
                  : t('code.distribution.byDirectory')}
              </span>
              <span className="mrpr-dist-sec-meta">{t('code.distribution.clickToDrill')}</span>
            </div>
            <div className="mrpr-dist-bar-list">
              {dirRows.slice(0, limit).map((row) => (
                <BarRow
                  key={row.dirPrefix || row.name}
                  counts={row}
                  maxValue={maxDir}
                  scopeTotal={scopeTotal}
                  metric={metric}
                  fmt={fmt}
                  onClick={() =>
                    row.file ? onSelectFile(row.file.path) : onDirPrefixChange(row.dirPrefix)
                  }
                >
                  <span className="mrpr-dist-bar-name" title={row.dirPrefix || row.file?.path}>
                    {row.name}
                  </span>
                  {row.file === null ? (
                    <span className="mrpr-dist-bar-sub">
                      {t('code.fileCount', { count: row.files })}
                    </span>
                  ) : null}
                </BarRow>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mrpr-dist-column">
          <div className="mrpr-dist-sec-head">
            <span className="mrpr-dist-sec-title">{t('code.distribution.largestFiles')}</span>
            <span className="mrpr-dist-sec-meta">{t('code.distribution.clickToJump')}</span>
          </div>
          <div className="mrpr-dist-bar-list">
            {sortedFiles.slice(0, limit).map((file) => {
              const badge = statusBadge(file.status);
              const slash = file.path.lastIndexOf('/');
              const base = slash === -1 ? file.path : file.path.slice(slash + 1);
              const dir = slash === -1 ? '' : file.path.slice(0, slash);
              return (
                <BarRow
                  key={file.path}
                  counts={file}
                  maxValue={maxFile}
                  scopeTotal={scopeTotal}
                  metric={metric}
                  fmt={fmt}
                  onClick={() => onSelectFile(file.path)}
                >
                  <span aria-hidden className="mrpr-dist-dot" data-kind={file.kind} />
                  <span
                    className="mrpr-dist-status"
                    data-status={badge.tone}
                    aria-label={file.status}
                  >
                    {badge.letter}
                  </span>
                  <span className="mrpr-dist-bar-name" title={file.path}>
                    {base}
                  </span>
                  {dir ? (
                    <span className="mrpr-dist-bar-sub" title={dir}>
                      {dir}
                    </span>
                  ) : null}
                </BarRow>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mrpr-dist-foot">
        <span className="mrpr-tabular">{concentrationText}</span>
        {sortedFiles.length > COMPACT_ROW_LIMIT ? (
          <button
            type="button"
            className="mrpr-link-button"
            onClick={() => setExpandedPrefix(expanded ? null : dirPrefix)}
          >
            {expanded
              ? t('code.distribution.showTop', { count: COMPACT_ROW_LIMIT })
              : t('code.distribution.showAll', { count: sortedFiles.length })}
          </button>
        ) : null}
      </div>
    </>
  );
}

function DistributionIcicle(props: ViewProps) {
  const { scopedFiles, dirPrefix, metric, scopeTotal, fmt, onDirPrefixChange, onSelectFile } =
    props;
  const t = usePluginTranslation('pull-requests');
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(ICICLE_DEFAULT_WIDTH);
  const [inspectedState, setInspectedState] = useState<{ scope: string; path: string } | null>(
    null
  );

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const apply = (measured: number) => {
      if (measured > 0) setWidth(Math.max(240, Math.round(measured)));
    };
    apply(el.getBoundingClientRect().width || el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries?.[entries.length - 1];
      apply(entry?.contentRect.width ?? (el.getBoundingClientRect().width || el.clientWidth));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const tree = useMemo(
    () => buildIcicleTree(scopedFiles, dirPrefix, metric),
    [scopedFiles, dirPrefix, metric]
  );
  const { rects, height } = useMemo(
    () => layoutIcicle(tree, width, ICICLE_MAX_DEPTH, ICICLE_ROW_HEIGHT),
    [tree, width]
  );
  const inspectedPath = inspectedState?.scope === dirPrefix ? inspectedState.path : null;
  const inspected =
    inspectedPath === null
      ? null
      : (rects.find((r) => r.node.path === inspectedPath)?.node ?? null);

  return (
    <>
      <div ref={boxRef} className="mrpr-dist-icicle-box" style={{ blockSize: `${height}px` }}>
        <svg
          className="mrpr-dist-icicle-svg"
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          height={height}
          role="img"
          aria-label={t('code.distribution.regionLabel')}
        >
          {rects.map(({ node, depth, x, y, width: w, height: h }) => {
            const isRoot = depth === 0;
            const interactive = node.file !== null || !isRoot;
            const displayPath = node.path || t('code.distribution.allFiles');
            const displayName = node.name || t('code.distribution.allFiles');
            const share = formatShare(node.value, scopeTotal);
            const label = t('code.distribution.icicleNodeLabel', {
              path: displayPath,
              additions: fmt.format(node.additions),
              deletions: fmt.format(node.deletions),
              share,
              files: t('code.fileCount', { count: node.files }),
            });
            const activate = () => {
              if (node.file) onSelectFile(node.file.path);
              else if (!isRoot) onDirPrefixChange(node.path);
            };
            const clearInspect = () =>
              setInspectedState((cur) => (cur?.path === node.path ? null : cur));
            const labelClass = isRoot
              ? 'mrpr-dist-icicle-root-label'
              : node.file
                ? 'mrpr-dist-icicle-label is-file'
                : 'mrpr-dist-icicle-label';
            const subStat =
              metric === 'total' && node.additions === 0 && node.deletions > 0
                ? `${share} · -${fmt.format(node.deletions)}`
                : `${share} · +${fmt.format(node.additions)}`;
            const interactiveProps = interactive
              ? {
                  role: 'button' as const,
                  tabIndex: 0,
                  'aria-label': label,
                  onFocus: () => setInspectedState({ scope: dirPrefix, path: node.path }),
                  onBlur: clearInspect,
                  onClick: activate,
                  onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      activate();
                    }
                  },
                }
              : {};
            return (
              <g
                key={`${depth}:${node.path}`}
                className={
                  interactive ? 'mrpr-dist-icicle-node is-interactive' : 'mrpr-dist-icicle-node'
                }
                onMouseEnter={() => setInspectedState({ scope: dirPrefix, path: node.path })}
                onMouseLeave={clearInspect}
                {...interactiveProps}
              >
                <title>{label}</title>
                <rect
                  className={isRoot ? 'mrpr-dist-icicle-root-rect' : 'mrpr-dist-icicle-rect'}
                  data-kind={isRoot ? undefined : node.dominantKind}
                  x={(x + 0.5).toFixed(1)}
                  y={(y + 0.5).toFixed(1)}
                  width={Math.max(1, w - 1).toFixed(1)}
                  height={(h - 1).toFixed(1)}
                  rx="2"
                  fillOpacity={
                    isRoot ? undefined : node.file ? 0.96 : Math.max(0.8, 0.92 - (depth - 1) * 0.04)
                  }
                />
                {w > 34 ? (
                  <text
                    className={labelClass}
                    x={(x + 5).toFixed(1)}
                    y={(y + 17).toFixed(1)}
                    textAnchor="start"
                  >
                    {truncateLabel(displayName, w)}
                  </text>
                ) : null}
                {w > 66 ? (
                  <text
                    className={isRoot ? 'mrpr-dist-icicle-root-sub' : 'mrpr-dist-icicle-sub'}
                    x={(x + 5).toFixed(1)}
                    y={(y + 32).toFixed(1)}
                    textAnchor="start"
                  >
                    {subStat}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="mrpr-dist-foot" aria-live="polite">
        {inspected ? (
          <span className="mrpr-dist-icicle-inspect mrpr-tabular">
            <span className="mrpr-dist-icicle-inspect-path">
              {inspected.path || t('code.distribution.allFiles')}
            </span>
            <span className="mrpr-added">+{fmt.format(inspected.additions)}</span>
            {metric === 'total' && inspected.deletions > 0 ? (
              <span className="mrpr-removed">-{fmt.format(inspected.deletions)}</span>
            ) : null}
            <span>{formatShare(inspected.value, scopeTotal)}</span>
            <span>{t('code.fileCount', { count: inspected.files })}</span>
          </span>
        ) : (
          <>
            <span>{t('code.distribution.icicleHint')}</span>
            <span className="mrpr-shrink-0">{t('code.distribution.colorByKind')}</span>
          </>
        )}
      </div>
    </>
  );
}

export function LineDistribution(props: LineDistributionProps) {
  const { files, activeKinds, dirPrefix, view, metric, onToggleKind, onDirPrefixChange } = props;
  const t = usePluginTranslation('pull-requests');
  const language = useLanguage();
  const fmt = useMemo(() => new Intl.NumberFormat(language), [language]);

  const kindSummaries = useMemo(() => summarizeByKind(files, metric), [files, metric]);
  const allTotal = useMemo(
    () => kindSummaries.reduce((sum, e) => sum + e.value, 0),
    [kindSummaries]
  );
  const activeFiles = useMemo(
    () => files.filter((f) => activeKinds.has(f.kind)),
    [files, activeKinds]
  );
  const scopedFiles = useMemo(
    () => (dirPrefix ? activeFiles.filter((f) => f.path.startsWith(dirPrefix)) : activeFiles),
    [activeFiles, dirPrefix]
  );
  const activeTotal = useMemo(
    () => activeFiles.reduce((sum, f) => sum + metricValue(f, metric), 0),
    [activeFiles, metric]
  );
  const scopeTotal = useMemo(
    () => scopedFiles.reduce((sum, f) => sum + metricValue(f, metric), 0),
    [scopedFiles, metric]
  );
  const crumbs = useMemo(() => buildBreadcrumbs(dirPrefix), [dirPrefix]);

  const handleToggleKind = (kind: ChangedFileKind) => {
    if (activeKinds.has(kind) && !canHideKind(kind, activeKinds)) return;
    onToggleKind(kind);
  };
  const kindMeta = (summary: KindSummary) => {
    const kindName = t(`breakdown.${summary.kind}`);
    const share = formatShare(summary.value, allTotal);
    const title = t('code.distribution.kindChipTitle', {
      kind: kindName,
      files: t('code.fileCount', { count: summary.files }),
      additions: fmt.format(summary.additions),
      deletions: fmt.format(summary.deletions),
      share,
    });
    return { kindName, share, title };
  };

  const filesText = t('code.fileCount', { count: scopedFiles.length });
  const linesText = t('code.distribution.lineCount', {
    count: scopeTotal,
    formatted: fmt.format(scopeTotal),
  });
  const scopeMeta = dirPrefix
    ? t('code.distribution.scopeSummaryWithShare', {
        files: filesText,
        lines: linesText,
        share: formatShare(scopeTotal, activeTotal),
      })
    : t('code.distribution.scopeSummary', { files: filesText, lines: linesText });
  const viewProps: ViewProps = {
    scopedFiles,
    dirPrefix,
    metric,
    scopeTotal,
    fmt,
    onDirPrefixChange,
    onSelectFile: props.onSelectFile,
  };

  return (
    <section className="mrpr-dist" aria-label={t('code.distribution.regionLabel')}>
      <div className="mrpr-dist-card">
        <div className="mrpr-dist-top">
          <div className="mrpr-dist-kind-bar">
            {kindSummaries.map((summary) => {
              const weight = allTotal > 0 ? summary.value : summary.files;
              if (weight <= 0) return null;
              const on = activeKinds.has(summary.kind);
              return (
                <div
                  key={summary.kind}
                  className={on ? 'mrpr-dist-kind-seg' : 'mrpr-dist-kind-seg is-off'}
                  data-kind={summary.kind}
                  style={{ flexGrow: weight }}
                  title={kindMeta(summary).title}
                  onClick={() => handleToggleKind(summary.kind)}
                />
              );
            })}
          </div>

          <div className="mrpr-dist-top-row">
            <div
              className="mrpr-dist-chips"
              role="group"
              aria-label={t('code.distribution.kindsLabel')}
            >
              {kindSummaries.map((summary) => {
                const on = activeKinds.has(summary.kind);
                const { kindName, share, title } = kindMeta(summary);
                return (
                  <button
                    key={summary.kind}
                    type="button"
                    className={on ? 'mrpr-dist-chip' : 'mrpr-dist-chip is-off'}
                    aria-pressed={on}
                    title={title}
                    onClick={() => handleToggleKind(summary.kind)}
                  >
                    <span aria-hidden className="mrpr-dist-dot" data-kind={summary.kind} />
                    <span>{kindName}</span>
                    <span className="mrpr-dist-chip-pct mrpr-tabular">{share}</span>
                  </button>
                );
              })}
            </div>

            <div className="mrpr-dist-controls">
              <SegmentedToggle
                label={t('code.distribution.viewLabel')}
                value={view}
                onChange={props.onViewChange}
                options={[
                  { id: 'bars', text: t('code.distribution.bars') },
                  { id: 'icicle', text: t('code.distribution.icicle') },
                ]}
              />
              <SegmentedToggle
                label={t('code.distribution.metricLabel')}
                value={metric}
                onChange={props.onMetricChange}
                options={[
                  {
                    id: 'total',
                    text: t('code.distribution.metricTotal'),
                    title: t('code.distribution.metricTotalHint'),
                  },
                  {
                    id: 'additions',
                    text: t('code.distribution.metricAdditions'),
                    title: t('code.distribution.metricAdditionsHint'),
                  },
                ]}
              />
            </div>
          </div>
        </div>

        <div className="mrpr-dist-crumb-row">
          <nav className="mrpr-dist-crumbs" aria-label={t('code.distribution.breadcrumbLabel')}>
            <button
              type="button"
              className={crumbs.length === 0 ? 'mrpr-dist-crumb is-current' : 'mrpr-dist-crumb'}
              aria-current={crumbs.length === 0 ? 'location' : undefined}
              onClick={() => crumbs.length > 0 && onDirPrefixChange('')}
            >
              {t('code.distribution.allFiles')}
            </button>
            {crumbs.map((crumb, index) => {
              const isLast = index === crumbs.length - 1;
              return (
                <span key={crumb.prefix} className="mrpr-dist-crumb-part">
                  <span aria-hidden className="mrpr-dist-crumb-sep">
                    /
                  </span>
                  <button
                    type="button"
                    className={isLast ? 'mrpr-dist-crumb is-current' : 'mrpr-dist-crumb'}
                    aria-current={isLast ? 'location' : undefined}
                    onClick={() => !isLast && onDirPrefixChange(crumb.prefix)}
                  >
                    {crumb.label}
                  </button>
                </span>
              );
            })}
          </nav>
          <span className="mrpr-dist-crumb-meta mrpr-tabular">{scopeMeta}</span>
        </div>

        <div className="mrpr-dist-body">
          {view === 'bars' ? (
            <DistributionBars {...viewProps} />
          ) : (
            <DistributionIcicle {...viewProps} />
          )}
        </div>
      </div>
    </section>
  );
}
