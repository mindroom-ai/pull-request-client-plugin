// Pure transforms for Line Distribution: kind breakdown, directory drill-down normalization,
// Bars rankings, and dynamic-depth Icicle layout.
import type { PullRequestFile } from '../github';
import { changedFileKind, type ChangedFileKind } from './changedFileKind';

export type DistributionView = 'bars' | 'icicle';
export type DistributionMetric = 'total' | 'additions' | 'net';
export type DistributionViewProps = {
  scopedFiles: readonly DistributionFile[];
  dirPrefix: string;
  metric: DistributionMetric;
  scopeTotal: number;
  fmt: Intl.NumberFormat;
  onDirPrefixChange: (prefix: string) => void;
  onSelectFile: (path: string) => void;
};

export const DISTRIBUTION_KINDS: readonly ChangedFileKind[] = ['code', 'test', 'docs', 'generated'];
export const COMPACT_ROW_LIMIT = 5;
export const ICICLE_MAX_DEPTH = 5;
export const ICICLE_ROW_HEIGHT = 42;
export const ICICLE_DEFAULT_WIDTH = 620;
const ICICLE_MIN_RECT_WIDTH = 1.5;

type Totals = {
  files: number;
  additions: number;
  deletions: number;
  value: number;
  netAdded: number;
  netRemoved: number;
};
const emptyTotals = (): Totals => ({
  files: 0,
  additions: 0,
  deletions: 0,
  value: 0,
  netAdded: 0,
  netRemoved: 0,
});
const addTotals = (target: Totals, file: DistributionFile, value: number) => {
  const delta = file.additions - file.deletions;
  target.files += 1;
  target.additions += file.additions;
  target.deletions += file.deletions;
  target.value += value;
  if (delta > 0) target.netAdded += delta;
  else target.netRemoved -= delta;
};
export type DistributionFile = Pick<
  PullRequestFile,
  'path' | 'status' | 'additions' | 'deletions'
> & {
  kind: ChangedFileKind;
};
export type KindSummary = Totals & { kind: ChangedFileKind };
export type DirectoryRow = Totals & {
  name: string;
  dirPrefix: string;
  file: DistributionFile | null;
};
export type IcicleNode = Totals & {
  name: string;
  path: string;
  file: DistributionFile | null;
  dominantKind: ChangedFileKind;
  children: IcicleNode[];
};
export type IcicleRect = {
  node: IcicleNode;
  depth: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export const metricValue = (
  counts: { additions: number; deletions: number },
  metric: DistributionMetric
) =>
  metric === 'additions'
    ? counts.additions
    : metric === 'net'
      ? Math.abs(counts.additions - counts.deletions)
      : counts.additions + counts.deletions;

export const formatSigned = (delta: number, fmt: Intl.NumberFormat): string =>
  delta > 0 ? `+${fmt.format(delta)}` : delta < 0 ? `-${fmt.format(-delta)}` : fmt.format(0);

export const toDistributionFiles = (files: readonly PullRequestFile[]): DistributionFile[] =>
  files.map(({ path, status, additions, deletions }) => ({
    path,
    status,
    additions,
    deletions,
    kind: changedFileKind(path),
  }));

/** Formats `part / total` as a compact percentage, returning `'0%'` when `total <= 0`. */
export function formatShare(part: number, total: number): string {
  if (total <= 0 || part <= 0) return '0%';
  if (part >= total) return '100%';
  const pct = (part / total) * 100;
  return pct >= 10 ? `${Math.round(pct)}%` : pct < 0.1 ? '<0.1%' : `${pct.toFixed(1)}%`;
}

/** Per-kind totals in canonical order, keeping only kinds present in `files`. */
export function summarizeByKind(
  files: readonly DistributionFile[],
  metric: DistributionMetric
): KindSummary[] {
  const byKind = new Map<ChangedFileKind, KindSummary>();
  for (const file of files) {
    const entry = byKind.get(file.kind) ?? { kind: file.kind, ...emptyTotals() };
    addTotals(entry, file, metricValue(file, metric));
    byKind.set(file.kind, entry);
  }
  return DISTRIBUTION_KINDS.flatMap((kind) => (byKind.has(kind) ? [byKind.get(kind)!] : []));
}

export const activeKindsFrom = (
  presentKinds: readonly ChangedFileKind[],
  hideTests: boolean,
  hiddenNonTestKinds: ReadonlySet<ChangedFileKind>
) =>
  new Set(
    presentKinds.filter((kind) => (kind === 'test' ? !hideTests : !hiddenNonTestKinds.has(kind)))
  );

/** True when hiding `kind` still leaves at least one active kind in the view. */
export const canHideKind = (kind: ChangedFileKind, activeKinds: ReadonlySet<ChangedFileKind>) =>
  activeKinds.has(kind) && activeKinds.size > 1;

/** Walks `dirPrefix` up to the nearest non-empty ancestor in `files`, or `''`. */
export function normalizeDirPrefix(dirPrefix: string, files: readonly { path: string }[]): string {
  const stripped = dirPrefix.replace(/^\/+/, '');
  if (!stripped) return '';
  let prefix = stripped.endsWith('/') ? stripped : `${stripped}/`;
  while (prefix !== '') {
    if (files.some((file) => file.path.startsWith(prefix))) return prefix;
    const parentSlash = prefix.slice(0, -1).lastIndexOf('/');
    prefix = parentSlash === -1 ? '' : prefix.slice(0, parentSlash + 1);
  }
  return '';
}

export function buildBreadcrumbs(dirPrefix: string): { label: string; prefix: string }[] {
  const trimmed = dirPrefix.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return [];
  let acc = '';
  return trimmed.split('/').map((label) => ({ label, prefix: (acc += `${label}/`) }));
}

const byLargest = (a: Totals & { name: string }, b: Totals & { name: string }) =>
  b.value - a.value ||
  b.additions + b.deletions - (a.additions + a.deletions) ||
  b.files - a.files ||
  a.name.localeCompare(b.name);

/** Immediate children (subdirectories and direct files) under `dirPrefix`, largest first. */
export function buildDirectoryRows(
  files: readonly DistributionFile[],
  dirPrefix: string,
  metric: DistributionMetric
): DirectoryRow[] {
  const map = new Map<string, DirectoryRow>();
  for (const file of files) {
    if (dirPrefix && !file.path.startsWith(dirPrefix)) continue;
    const rel = file.path.slice(dirPrefix.length);
    const slash = rel.indexOf('/');
    const isFile = slash === -1;
    const name = isFile ? rel : rel.slice(0, slash + 1);
    const row = map.get(name) ?? {
      name,
      dirPrefix: isFile ? '' : `${dirPrefix}${name}`,
      file: isFile ? file : null,
      ...emptyTotals(),
    };
    addTotals(row, file, metricValue(file, metric));
    map.set(name, row);
  }
  return [...map.values()].sort(byLargest);
}

export const sortFilesByMetric = (files: readonly DistributionFile[], metric: DistributionMetric) =>
  [...files].sort(
    (a, b) =>
      metricValue(b, metric) - metricValue(a, metric) ||
      b.additions + b.deletions - (a.additions + a.deletions) ||
      a.path.localeCompare(b.path)
  );

/** Proportional green/red bar widths as percentages of the widest item (0..100). */
export function computeBarWidths(
  counts: { additions: number; deletions: number; netAdded?: number; netRemoved?: number },
  maxValue: number,
  metric: DistributionMetric
): { addPct: number; delPct: number } {
  const [pos, neg] =
    metric === 'additions'
      ? [counts.additions, 0]
      : metric === 'net'
        ? [
            counts.netAdded ?? Math.max(0, counts.additions - counts.deletions),
            counts.netRemoved ?? Math.max(0, counts.deletions - counts.additions),
          ]
        : [counts.additions, counts.deletions];
  const value = pos + neg;
  if (maxValue <= 0 || value <= 0) return { addPct: 0, delPct: 0 };
  const totalPct = Math.min(100, Math.max(1.5, (value / maxValue) * 100));
  if (neg === 0) return { addPct: totalPct, delPct: 0 };
  if (pos === 0) return { addPct: 0, delPct: totalPct };
  let addPct = (pos / value) * totalPct;
  let delPct = totalPct - addPct;
  if (totalPct >= 1.6 && addPct < 0.8) [addPct, delPct] = [0.8, totalPct - 0.8];
  else if (totalPct >= 1.6 && delPct < 0.8) [delPct, addPct] = [0.8, totalPct - 0.8];
  return { addPct, delPct };
}

export type DistributionStatusKey = 'added' | 'modified' | 'removed' | 'renamed' | 'copied';

export function statusBadge(status: PullRequestFile['status']): {
  letter: 'A' | 'M' | 'D' | 'R';
  tone: 'added' | 'modified' | 'removed' | 'renamed';
  key: DistributionStatusKey;
} {
  if (status === 'added') return { letter: 'A', tone: 'added', key: 'added' };
  if (status === 'removed') return { letter: 'D', tone: 'removed', key: 'removed' };
  if (status === 'copied') return { letter: 'R', tone: 'renamed', key: 'copied' };
  if (status === 'renamed') return { letter: 'R', tone: 'renamed', key: 'renamed' };
  return { letter: 'M', tone: 'modified', key: 'modified' };
}

/** Builds a directory/file hierarchy rooted at `dirPrefix` with rolled-up counts and dominant kind. */
export function buildIcicleTree(
  files: readonly DistributionFile[],
  dirPrefix: string,
  metric: DistributionMetric
): IcicleNode {
  type Draft = Omit<IcicleNode, 'dominantKind' | 'children'> & {
    kindValues: Record<ChangedFileKind, number>;
    kindFiles: Record<ChangedFileKind, number>;
    children: Map<string, Draft>;
  };
  const make = (name: string, path: string, file: DistributionFile | null): Draft => ({
    name,
    path,
    file,
    ...emptyTotals(),
    kindValues: { code: 0, test: 0, docs: 0, generated: 0 },
    kindFiles: { code: 0, test: 0, docs: 0, generated: 0 },
    children: new Map(),
  });
  const add = (node: Draft, file: DistributionFile, value: number) => {
    addTotals(node, file, value);
    node.kindValues[file.kind] += value;
    node.kindFiles[file.kind] += 1;
  };
  const root = make(dirPrefix, dirPrefix, null);
  for (const file of files) {
    if (dirPrefix && !file.path.startsWith(dirPrefix)) continue;
    const rel = file.path.slice(dirPrefix.length);
    if (!rel) continue;
    const value = metricValue(file, metric);
    let cur = root;
    let acc = dirPrefix;
    add(cur, file, value);
    const segments = rel.split('/');
    for (let i = 0; i < segments.length; i += 1) {
      const isLast = i === segments.length - 1;
      const name = isLast ? segments[i] : `${segments[i]}/`;
      acc += name;
      let child = cur.children.get(name);
      if (!child) {
        child = make(name, acc, isLast ? file : null);
        cur.children.set(name, child);
      }
      cur = child;
      add(cur, file, value);
    }
  }
  const finalize = ({ kindValues, kindFiles, children, ...base }: Draft): IcicleNode => {
    const weights = base.value > 0 ? kindValues : kindFiles;
    const dominantKind = DISTRIBUTION_KINDS.reduce((best, k) =>
      weights[k] > weights[best] ? k : best
    );
    return {
      ...base,
      dominantKind,
      children: [...children.values()].map(finalize).sort(byLargest),
    };
  };
  return finalize(root);
}

/** Lays out a top-down icicle flamegraph sized tightly to rendered depth (`depth * rowHeight`). */
export function layoutIcicle(
  root: IcicleNode,
  width: number,
  maxDepth = ICICLE_MAX_DEPTH,
  rowHeight = ICICLE_ROW_HEIGHT,
  fallbackToFiles = true
): { rects: IcicleRect[]; depth: number; height: number } {
  const safeWidth = Math.max(1, width);
  if (root.files === 0 || (root.value <= 0 && !fallbackToFiles)) {
    return { rects: [], depth: 1, height: rowHeight };
  }
  const weightOf = root.value > 0 ? (n: IcicleNode) => n.value : (n: IcicleNode) => n.files;
  const rects: IcicleRect[] = [];
  const walk = (node: IcicleNode, depth: number, x: number, w: number) => {
    if (depth >= maxDepth || w < ICICLE_MIN_RECT_WIDTH) return;
    rects.push({ node, depth, x, y: depth * rowHeight, width: w, height: rowHeight });
    const nodeWeight = weightOf(node);
    if (nodeWeight <= 0 || node.children.length === 0) return;
    let cursor = x;
    for (const child of node.children) {
      const cw = weightOf(child);
      if (cw <= 0) continue;
      const childWidth = (cw / nodeWeight) * w;
      walk(child, depth + 1, cursor, childWidth);
      cursor += childWidth;
    }
  };
  walk(root, 0, 0, safeWidth);
  const depth = Math.max(1, ...rects.map((rect) => rect.depth + 1));
  return { rects, depth, height: depth * rowHeight };
}
