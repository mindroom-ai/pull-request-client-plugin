// Interactive Line Distribution card inside the Code tab's diff scroller header: kind breakdown
// chips, directory drill-down breadcrumbs, and view switcher (Bars / Icicle).
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { useMemo } from 'react';
import { useLanguage } from '../presentation';
import type { ChangedFileKind } from './changedFileKind';
import { DistributionBars } from './DistributionBars';
import { DistributionIcicle } from './DistributionIcicle';
import {
  buildBreadcrumbs,
  canHideKind,
  formatShare,
  metricValue,
  summarizeByKind,
  type DistributionFile,
  type DistributionMetric,
  type DistributionView,
  type DistributionViewProps,
} from './lineDistribution.logic';

export type LineDistributionProps = {
  /** All files in the current PR or commit view, anchoring the kind breakdown totals. */
  files: readonly DistributionFile[];
  /** Files already filtered by `activeKinds` and `dirPrefix`. */
  scopedFiles: readonly DistributionFile[];
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

export function LineDistribution(props: LineDistributionProps) {
  const {
    files,
    scopedFiles,
    activeKinds,
    dirPrefix,
    view,
    metric,
    onToggleKind,
    onDirPrefixChange,
  } = props;
  const t = usePluginTranslation('pull-requests');
  const language = useLanguage();
  const fmt = useMemo(() => new Intl.NumberFormat(language), [language]);

  const kindSummaries = useMemo(() => summarizeByKind(files, metric), [files, metric]);
  const allTotal = useMemo(
    () => kindSummaries.reduce((sum, entry) => sum + entry.value, 0),
    [kindSummaries]
  );
  const activeTotal = useMemo(
    () =>
      kindSummaries.reduce(
        (sum, entry) => (activeKinds.has(entry.kind) ? sum + entry.value : sum),
        0
      ),
    [kindSummaries, activeKinds]
  );
  const scopeTotal = useMemo(
    () => scopedFiles.reduce((sum, file) => sum + metricValue(file, metric), 0),
    [scopedFiles, metric]
  );
  const crumbs = useMemo(() => buildBreadcrumbs(dirPrefix), [dirPrefix]);

  const handleToggleKind = (kind: ChangedFileKind) => {
    if (activeKinds.has(kind) && !canHideKind(kind, activeKinds)) return;
    onToggleKind(kind);
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
  const viewProps: DistributionViewProps = {
    scopedFiles,
    dirPrefix,
    metric,
    scopeTotal,
    fmt,
    onDirPrefixChange,
    onSelectFile: props.onSelectFile,
  };
  const trail = [{ label: t('code.distribution.allFiles'), prefix: '' }, ...crumbs];

  return (
    <section className="mrpr-dist" aria-label={t('code.distribution.regionLabel')}>
      <div className="mrpr-dist-card">
        <div className="mrpr-dist-top">
          <div className="mrpr-dist-kind-bar" aria-hidden="true">
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
                const kindName = t(`breakdown.${summary.kind}`);
                const share = formatShare(summary.value, allTotal);
                const title = t('code.distribution.kindChipTitle', {
                  kind: kindName,
                  files: t('code.fileCount', { count: summary.files }),
                  additions: fmt.format(summary.additions),
                  deletions: fmt.format(summary.deletions),
                  share,
                });
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
            {trail.map((crumb, index) => {
              const isLast = index === trail.length - 1;
              return (
                <span key={crumb.prefix} className="mrpr-dist-crumb-part">
                  {index > 0 ? (
                    <span aria-hidden className="mrpr-dist-crumb-sep">
                      /
                    </span>
                  ) : null}
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
