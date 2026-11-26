import { describe, expect, it } from 'vitest';
import type { PullRequestFile } from '../github';
import {
  ICICLE_ROW_HEIGHT,
  activeKindsFrom,
  buildBreadcrumbs,
  buildDirectoryRows,
  buildIcicleTree,
  canHideKind,
  computeBarWidths,
  formatShare,
  formatSigned,
  layoutIcicle,
  normalizeDirPrefix,
  sortFilesByMetric,
  statusBadge,
  summarizeByKind,
  toDistributionFiles,
} from './lineDistribution.logic';

const prFile = (
  path: string,
  additions: number,
  deletions: number,
  status: PullRequestFile['status'] = 'modified'
): PullRequestFile => ({
  path,
  previousPath: null,
  status,
  additions,
  deletions,
  patch: null,
  sha: null,
  url: `https://example.invalid/${path}`,
});

const SAMPLE = toDistributionFiles([
  prFile('src/workers/pool.ts', 120, 30, 'modified'),
  prFile('src/workers/queue.ts', 40, 10, 'added'),
  prFile('src/workers/pool.test.ts', 90, 10, 'added'),
  prFile('src/app.ts', 20, 5, 'modified'),
  prFile('docs/guide.md', 50, 0, 'added'),
  prFile('package-lock.json', 200, 100, 'modified'),
]);

describe('formatShare', () => {
  it('handles zero totals without NaN and formats small and large shares cleanly', () => {
    expect(formatShare(0, 0)).toBe('0%');
    expect(formatShare(10, 0)).toBe('0%');
    expect(formatShare(0, 100)).toBe('0%');
    expect(formatShare(100, 100)).toBe('100%');
    expect(formatShare(35, 100)).toBe('35%');
    expect(formatShare(42, 1000)).toBe('4.2%');
    expect(formatShare(1, 5000)).toBe('<0.1%');
  });
});

describe('kind summaries and active kind invariants', () => {
  it('summarizes only present kinds in canonical order for each metric', () => {
    const total = summarizeByKind(SAMPLE, 'total');
    expect(total.map((k) => [k.kind, k.files, k.value])).toEqual([
      ['code', 3, 225],
      ['test', 1, 100],
      ['docs', 1, 50],
      ['generated', 1, 300],
    ]);

    const addsOnly = summarizeByKind(
      toDistributionFiles([prFile('src/index.ts', 10, 40), prFile('docs/readme.md', 0, 20)]),
      'additions'
    );
    expect(addsOnly.map((k) => [k.kind, k.value])).toEqual([
      ['code', 10],
      ['docs', 0],
    ]);
  });

  it('syncs test visibility with hideTests and blocks hiding the last active kind', () => {
    const present = ['code', 'test', 'docs'] as const;
    const allActive = activeKindsFrom(present, false, new Set());
    expect([...allActive]).toEqual(['code', 'test', 'docs']);
    expect(canHideKind('test', allActive)).toBe(true);

    const onlyCode = activeKindsFrom(present, true, new Set(['docs']));
    expect([...onlyCode]).toEqual(['code']);
    expect(canHideKind('code', onlyCode)).toBe(false);
    expect(canHideKind('test', onlyCode)).toBe(false);
  });
});

describe('directory drill-down and Bars rankings', () => {
  it('normalizes dirPrefix to the nearest non-empty ancestor with directory-boundary safety', () => {
    const files = [{ path: 'src/app.ts' }, { path: 'src/ab/other.ts' }];
    expect(normalizeDirPrefix('', files)).toBe('');
    expect(normalizeDirPrefix('src/ab', files)).toBe('src/ab/');
    // `src/a/` must not match `src/ab/other.ts`, so it walks up to `src/`.
    expect(normalizeDirPrefix('src/a/', files)).toBe('src/');
    expect(normalizeDirPrefix('src/workers/deep/', files)).toBe('src/');
    expect(normalizeDirPrefix('tests/unit/', files)).toBe('');
  });

  it('builds breadcrumbs and immediate directory rows sorted largest first', () => {
    expect(buildBreadcrumbs('')).toEqual([]);
    expect(buildBreadcrumbs('src/workers/')).toEqual([
      { label: 'src', prefix: 'src/' },
      { label: 'workers', prefix: 'src/workers/' },
    ]);

    const rootRows = buildDirectoryRows(SAMPLE, '', 'total');
    expect(rootRows.map((r) => [r.name, r.dirPrefix, r.value, r.files])).toEqual([
      ['src/', 'src/', 325, 4],
      ['package-lock.json', '', 300, 1],
      ['docs/', 'docs/', 50, 1],
    ]);

    const nested = buildDirectoryRows(SAMPLE, 'src/', 'additions');
    expect(nested.map((r) => [r.name, r.dirPrefix, r.value])).toEqual([
      ['workers/', 'src/workers/', 250],
      ['app.ts', '', 20],
    ]);
  });

  it('sorts files by chosen metric and maps status badges', () => {
    const files = toDistributionFiles([
      prFile('src/deleted.ts', 0, 200, 'removed'),
      prFile('src/new.ts', 80, 0, 'added'),
      prFile('src/moved.ts', 10, 10, 'renamed'),
    ]);
    expect(sortFilesByMetric(files, 'total').map((f) => f.path)).toEqual([
      'src/deleted.ts',
      'src/new.ts',
      'src/moved.ts',
    ]);
    expect(sortFilesByMetric(files, 'additions').map((f) => f.path)).toEqual([
      'src/new.ts',
      'src/moved.ts',
      'src/deleted.ts',
    ]);
    expect(statusBadge('added')).toEqual({ letter: 'A', tone: 'added', key: 'added' });
    expect(statusBadge('removed')).toEqual({ letter: 'D', tone: 'removed', key: 'removed' });
    expect(statusBadge('renamed')).toEqual({ letter: 'R', tone: 'renamed', key: 'renamed' });
    expect(statusBadge('copied')).toEqual({ letter: 'R', tone: 'renamed', key: 'copied' });
    expect(statusBadge('modified')).toEqual({ letter: 'M', tone: 'modified', key: 'modified' });
    expect(statusBadge('changed')).toEqual({ letter: 'M', tone: 'modified', key: 'modified' });
  });

  it('computes proportional green/red bar widths safely including zero totals', () => {
    expect(computeBarWidths({ additions: 0, deletions: 0 }, 0, 'total')).toEqual({
      addPct: 0,
      delPct: 0,
    });
    expect(computeBarWidths({ additions: 50, deletions: 50 }, 100, 'total')).toEqual({
      addPct: 50,
      delPct: 50,
    });
    expect(computeBarWidths({ additions: 0, deletions: 50 }, 100, 'total')).toEqual({
      addPct: 0,
      delPct: 50,
    });
    expect(computeBarWidths({ additions: 50, deletions: 50 }, 100, 'additions')).toEqual({
      addPct: 50,
      delPct: 0,
    });
  });
});

describe('icicle tree and dynamic-depth layout', () => {
  it('sizes height tightly to actual tree depth and shrinks when zoomed into a shallow folder', () => {
    const rootTree = buildIcicleTree(SAMPLE, '', 'total');
    const rootLayout = layoutIcicle(rootTree, 600);
    // Root (0) -> src/ (1) -> workers/ (2) -> pool.ts (3) => 4 rows.
    expect(rootLayout.depth).toBe(4);
    expect(rootLayout.height).toBe(4 * ICICLE_ROW_HEIGHT);

    const workersTree = buildIcicleTree(SAMPLE, 'src/workers/', 'total');
    const workersLayout = layoutIcicle(workersTree, 600);
    // Root src/workers/ (0) -> pool.ts, pool.test.ts, queue.ts (1) => 2 rows, zero dead space.
    expect(workersLayout.depth).toBe(2);
    expect(workersLayout.height).toBe(2 * ICICLE_ROW_HEIGHT);
    expect(workersTree.dominantKind).toBe('code');
  });

  it('caps depth at 5 rows and drops zero-value subtrees in additions mode', () => {
    const deep = toDistributionFiles([
      prFile('a/b/c/d/e/f/deep.ts', 0, 80, 'removed'),
      prFile('src/top.ts', 50, 0, 'added'),
    ]);
    const totalLayout = layoutIcicle(buildIcicleTree(deep, '', 'total'), 600);
    expect(totalLayout.depth).toBe(5);
    expect(totalLayout.height).toBe(5 * ICICLE_ROW_HEIGHT);

    // In additions mode `deep.ts` has 0 additions so it does not inflate height.
    const addLayout = layoutIcicle(buildIcicleTree(deep, '', 'additions'), 600);
    expect(addLayout.depth).toBe(3);
    expect(addLayout.height).toBe(3 * ICICLE_ROW_HEIGHT);
  });

  it('handles zero total line changes gracefully without NaN geometry', () => {
    const zeroFiles = toDistributionFiles([
      prFile('assets/logo.png', 0, 0, 'added'),
      prFile('assets/icon.png', 0, 0, 'added'),
    ]);
    const tree = buildIcicleTree(zeroFiles, '', 'total');
    const layout = layoutIcicle(tree, 600);
    expect(layout.depth).toBe(3);
    expect(layout.rects.length).toBeGreaterThan(0);
    for (const rect of layout.rects) {
      expect(Number.isFinite(rect.x)).toBe(true);
      expect(Number.isFinite(rect.width)).toBe(true);
      expect(rect.width).toBeGreaterThan(0);
    }
  });
});

describe('net metric transforms', () => {
  const MIXED = toDistributionFiles([
    prFile('src/grow.ts', 120, 20),
    prFile('src/shrink.ts', 10, 110),
    prFile('src/even.ts', 30, 30),
    prFile('docs/note.md', 40, 0, 'added'),
  ]);

  it('sums abs per-file nets for groups/kinds, preserves signed deltas, ranks by |net|, and splits bars', () => {
    const fmt = new Intl.NumberFormat('en');
    expect([formatSigned(40, fmt), formatSigned(-80, fmt), formatSigned(-0, fmt)]).toEqual([
      '+40',
      '-80',
      '0',
    ]);
    expect(
      summarizeByKind(MIXED, 'net').map((k) => [k.kind, k.value, k.additions - k.deletions])
    ).toEqual([
      ['code', 200, 0],
      ['docs', 40, 40],
    ]);
    const dirs = buildDirectoryRows(MIXED, '', 'net');
    expect(dirs.map((r) => [r.name, r.value, r.additions - r.deletions])).toEqual([
      ['src/', 200, 0],
      ['docs/', 40, 40],
    ]);
    expect(sortFilesByMetric(MIXED, 'net').map((f) => f.path)).toEqual([
      'src/grow.ts',
      'src/shrink.ts',
      'docs/note.md',
      'src/even.ts',
    ]);
    // Growing, shrinking, zero-net files, and canceling directory (50/50 green/red split).
    expect([
      computeBarWidths(MIXED[0], 100, 'net'),
      computeBarWidths(MIXED[1], 100, 'net'),
      computeBarWidths(MIXED[2], 100, 'net'),
      computeBarWidths(dirs[0], 200, 'net'),
    ]).toEqual([
      { addPct: 100, delPct: 0 },
      { addPct: 0, delPct: 100 },
      { addPct: 0, delPct: 0 },
      { addPct: 50, delPct: 50 },
    ]);
  });

  it('omits zero-net files in icicle and avoids file-count fallback when all net=0', () => {
    const paths = layoutIcicle(
      buildIcicleTree(MIXED, '', 'net'),
      600,
      5,
      ICICLE_ROW_HEIGHT,
      false
    ).rects.map((r) => r.node.path);
    expect(paths).toEqual(['', 'src/', 'src/grow.ts', 'src/shrink.ts', 'docs/', 'docs/note.md']);

    const allZero = toDistributionFiles([prFile('a/one.ts', 40, 40), prFile('b/two.md', 15, 15)]);
    expect(
      layoutIcicle(buildIcicleTree(allZero, '', 'net'), 600, 5, ICICLE_ROW_HEIGHT, false).rects
    ).toEqual([]);
  });
});
