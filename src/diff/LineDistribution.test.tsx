// @vitest-environment jsdom
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullRequestFile } from '../github';
import plugin from '../index';
import { act } from '../testing/act';
import type { ChangedFileKind } from './changedFileKind';
import { LineDistribution, type LineDistributionProps } from './LineDistribution';
import { ICICLE_ROW_HEIGHT, toDistributionFiles } from './lineDistribution.logic';

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

const SAMPLE_FILES = toDistributionFiles([
  prFile('src/workers/pool.ts', 160, 40, 'modified'),
  prFile('src/workers/queue.ts', 90, 10, 'added'),
  prFile('src/workers/pool.test.ts', 80, 20, 'added'),
  prFile('src/api/client.ts', 70, 30, 'modified'),
  prFile('src/api/routes.ts', 50, 10, 'modified'),
  prFile('src/index.ts', 30, 5, 'modified'),
  prFile('docs/guide.md', 45, 5, 'added'),
]);

const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

const keyDown = (el: Element, key: string) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });

const mount = (over: Partial<LineDistributionProps> = {}) => {
  const files = over.files ?? SAMPLE_FILES;
  const activeKinds = over.activeKinds ?? new Set<ChangedFileKind>(['code', 'test', 'docs']);
  const dirPrefix = over.dirPrefix ?? '';
  const scopedFiles =
    over.scopedFiles ??
    files.filter((f) => activeKinds.has(f.kind) && (!dirPrefix || f.path.startsWith(dirPrefix)));
  const props: LineDistributionProps = {
    files,
    scopedFiles,
    activeKinds,
    dirPrefix,
    view: 'bars',
    metric: 'total',
    onToggleKind: vi.fn(),
    onDirPrefixChange: vi.fn(),
    onViewChange: vi.fn(),
    onMetricChange: vi.fn(),
    onSelectFile: vi.fn(),
    ...over,
  };
  return renderPluginComponent(<LineDistribution {...props} />, {
    id: 'pull-requests',
    plugin,
  }).then((rendered) => ({ ...rendered, props }));
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.documentElement.style.fontSize = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LineDistribution', () => {
  it('shows only present kind chips, keeps the kind bar decorative, toggles kinds, and refuses to hide the last active kind', async () => {
    const first = await mount();
    const { container, getByRole, queryByRole, props } = first;
    const kindBar = container.querySelector('.mrpr-dist-kind-bar')!;
    expect(kindBar.getAttribute('aria-hidden')).toBe('true');
    await click(kindBar.querySelector('.mrpr-dist-kind-seg')!);
    expect(props.onToggleKind).not.toHaveBeenCalled();

    expect(getByRole('button', { name: /Code/ }).getAttribute('aria-pressed')).toBe('true');
    expect(getByRole('button', { name: /Tests/ }).getAttribute('aria-pressed')).toBe('true');
    expect(getByRole('button', { name: /Docs/ }).getAttribute('aria-pressed')).toBe('true');
    expect(queryByRole('button', { name: /Generated/ })).toBeNull();

    await click(getByRole('button', { name: /Tests/ }));
    expect(props.onToggleKind).toHaveBeenCalledWith('test');

    first.unmount();
    // Only one kind active: clicking it must not call onToggleKind.
    const single = await mount({ activeKinds: new Set<ChangedFileKind>(['code']) });
    await click(single.getByRole('button', { name: /Code/ }));
    expect(single.props.onToggleKind).not.toHaveBeenCalled();
    // Clicking an inactive kind re-enables it.
    await click(single.getByRole('button', { name: /Tests/ }));
    expect(single.props.onToggleKind).toHaveBeenCalledWith('test');
  });

  it('renders 2-column Bars with translated status badges, top-5 compact toggle, folder drill-down, and 1-column leaf view', async () => {
    const first = await mount();
    const { container, getByRole, getByText, queryByText, props } = first;
    expect(container.querySelector('.mrpr-dist-bars-split')).not.toBeNull();
    expect(getByText(/Top 5 files =/)).toBeTruthy();

    // Status badges use translated sr-only text + title rather than raw English aria-label.
    const poolRow = getByRole('button', { name: /Modified.*pool\.ts/ });
    const statusBadgeEl = poolRow.querySelector('.mrpr-dist-status')!;
    expect(statusBadgeEl.getAttribute('aria-label')).toBeNull();
    expect(statusBadgeEl.getAttribute('title')).toBe('Modified');
    expect(statusBadgeEl.querySelector('.mrpr-sr-only')?.textContent).toBe('Modified');

    // Compact default shows 5 file rows under Largest files; Show all expands to all 7.
    const fileList = getByText('Largest files').closest('.mrpr-dist-column')!;
    expect(fileList.querySelectorAll('.mrpr-dist-bar-row')).toHaveLength(5);
    await click(getByRole('button', { name: 'Show all 7' }));
    expect(fileList.querySelectorAll('.mrpr-dist-bar-row')).toHaveLength(7);
    await click(getByRole('button', { name: 'Show top 5' }));
    expect(fileList.querySelectorAll('.mrpr-dist-bar-row')).toHaveLength(5);

    // Click directory row to drill in; click file row to select file.
    await click(getByRole('button', { name: /^src\// }));
    expect(props.onDirPrefixChange).toHaveBeenCalledWith('src/');
    await click(poolRow);
    expect(props.onSelectFile).toHaveBeenCalledWith('src/workers/pool.ts');

    first.unmount();
    // Leaf directory (`src/workers/`): collapses to 1 column and renders clickable ancestor breadcrumbs.
    const leaf = await mount({ dirPrefix: 'src/workers/' });
    expect(leaf.container.querySelector('.mrpr-dist-bars-split')).toBeNull();
    expect(leaf.queryByText(/Folders in/)).toBeNull();
    expect(leaf.getByRole('button', { name: 'workers' }).getAttribute('aria-current')).toBe(
      'location'
    );
    await click(leaf.getByRole('button', { name: 'src' }));
    expect(leaf.props.onDirPrefixChange).toHaveBeenCalledWith('src/');
    await click(leaf.getByRole('button', { name: 'All files' }));
    expect(leaf.props.onDirPrefixChange).toHaveBeenCalledWith('');
    expect(queryByText('NaN%')).toBeNull();
  });

  it('switches view and metric controls via callbacks', async () => {
    const { getByRole, props } = await mount();
    await click(getByRole('button', { name: 'Icicle' }));
    expect(props.onViewChange).toHaveBeenCalledWith('icicle');
    await click(getByRole('button', { name: '+Add' }));
    expect(props.onMetricChange).toHaveBeenCalledWith('additions');
    await click(getByRole('button', { name: 'Net' }));
    expect(props.onMetricChange).toHaveBeenCalledWith('net');
  });

  it('renders Icicle with group role, opaque fills, page-zoom scaling, keyboard-accessible nodes, resize viewBox, and inspect footer', async () => {
    let observedWidth = 540;
    const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.classList.contains('mrpr-dist-icicle-box') ? observedWidth : 0;
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly entry = {
          callback: null as unknown as ResizeObserverCallback,
          targets: new Set<Element>(),
        };
        constructor(callback: ResizeObserverCallback) {
          this.entry.callback = callback;
          observers.push(this.entry);
        }
        observe(target: Element) {
          this.entry.targets.add(target);
        }
        unobserve() {}
        disconnect() {}
      }
    );

    document.documentElement.style.fontSize = '16px';
    const first = await mount({ view: 'icicle' });
    const { container, getByRole, getByText, props } = first;
    const svg = container.querySelector('svg.mrpr-dist-icicle-svg')!;
    expect(svg.getAttribute('role')).toBe('group');
    expect(container.querySelector('.mrpr-dist-foot')?.getAttribute('aria-live')).toBeNull();
    // Root (0) -> src/ (1) -> workers/ (2) -> pool.ts (3) => 4 rows * 42 = 168px.
    expect(svg.getAttribute('viewBox')).toBe(`0 0 540 ${4 * ICICLE_ROW_HEIGHT}`);
    expect(svg.getAttribute('preserveAspectRatio')).toBeNull();
    // Every rendered node has a <title> tooltip and opaque fillOpacity (1).
    const nodes = container.querySelectorAll('g.mrpr-dist-icicle-node');
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) expect(node.querySelector('title')?.textContent).toBeTruthy();
    for (const rect of container.querySelectorAll('rect.mrpr-dist-icicle-rect')) {
      expect(rect.getAttribute('fill-opacity')).toBe('1');
    }

    // Resize updates viewBox width cleanly.
    await act(async () => {
      observedWidth = 480;
      const box = container.querySelector('.mrpr-dist-icicle-box')!;
      for (const { callback, targets } of observers) {
        if (targets.has(box)) {
          callback(
            [{ target: box, contentRect: { width: 480 } } as unknown as ResizeObserverEntry],
            {} as ResizeObserver
          );
        }
      }
    });
    expect(svg.getAttribute('viewBox')).toBe(`0 0 480 ${4 * ICICLE_ROW_HEIGHT}`);

    // Page Zoom (150% -> 24px root font size) scales rowHeight, SVG height, padding, and baselines.
    await act(async () => {
      document.documentElement.style.fontSize = '24px';
      await Promise.resolve();
    });
    const zoomedRowHeight = Math.round(ICICLE_ROW_HEIGHT * 1.5);
    expect(svg.getAttribute('viewBox')).toBe(`0 0 480 ${4 * zoomedRowHeight}`);
    expect((container.querySelector('.mrpr-dist-icicle-box') as HTMLElement).style.blockSize).toBe(
      `${4 * zoomedRowHeight}px`
    );
    expect(container.querySelector('text.mrpr-dist-icicle-root-label')?.getAttribute('x')).toBe(
      '7.5'
    );
    expect(container.querySelector('text.mrpr-dist-icicle-root-label')?.getAttribute('y')).toBe(
      '25.5'
    );
    expect(container.querySelector('text.mrpr-dist-icicle-root-sub')?.getAttribute('y')).toBe(
      '48.0'
    );
    await act(async () => {
      document.documentElement.style.fontSize = '16px';
      await Promise.resolve();
    });
    expect(svg.getAttribute('viewBox')).toBe(`0 0 480 ${4 * ICICLE_ROW_HEIGHT}`);

    // Keyboard activation (Enter on folder, Space on file) and focus summary in footer.
    const folderBtn = getByRole('button', { name: /^src\/workers\/:/ });
    await act(async () => {
      folderBtn.focus();
    });
    expect(container.querySelector('.mrpr-dist-icicle-inspect')?.textContent).toContain(
      'src/workers/'
    );
    await keyDown(folderBtn, 'Enter');
    expect(props.onDirPrefixChange).toHaveBeenCalledWith('src/workers/');

    const fileBtn = getByRole('button', { name: /^src\/workers\/pool\.ts:/ });
    await keyDown(fileBtn, ' ');
    expect(props.onSelectFile).toHaveBeenCalledWith('src/workers/pool.ts');

    await act(async () => {
      folderBtn.blur();
    });
    expect(getByText(/Click a folder to zoom/)).toBeTruthy();
    first.unmount();

    // Narrow interactive nodes (< 28px wide) remain keyboard-accessible buttons; root is not.
    const skewed = toDistributionFiles([
      prFile('src/huge.ts', 490, 0, 'modified'),
      prFile('tiny-dir/tiny.ts', 5, 0, 'added'),
    ]);
    const narrow = await mount({
      files: skewed,
      activeKinds: new Set<ChangedFileKind>(['code']),
      view: 'icicle',
    });
    const rootNode = [...narrow.container.querySelectorAll('g.mrpr-dist-icicle-node')].find((el) =>
      el.querySelector('title')?.textContent?.startsWith('All files:')
    )!;
    expect(rootNode).toBeTruthy();
    expect(rootNode.getAttribute('role')).toBeNull();
    expect(rootNode.getAttribute('tabindex')).toBeNull();

    const tinyDirBtn = narrow.getByRole('button', { name: /^tiny-dir\/:/ });
    expect(tinyDirBtn.getAttribute('tabindex')).toBe('0');
    expect(Number(tinyDirBtn.querySelector('rect')?.getAttribute('width'))).toBeLessThan(28);
    await keyDown(tinyDirBtn, 'Enter');
    expect(narrow.props.onDirPrefixChange).toHaveBeenCalledWith('tiny-dir/');

    const tinyFileBtn = narrow.getByRole('button', { name: /^tiny-dir\/tiny\.ts:/ });
    expect(tinyFileBtn.getAttribute('tabindex')).toBe('0');
    await keyDown(tinyFileBtn, ' ');
    expect(narrow.props.onSelectFile).toHaveBeenCalledWith('tiny-dir/tiny.ts');
    narrow.unmount();

    // Zoomed into shallow leaf folder: height shrinks to 2 * 42 = 84px with zero dead space.
    const zoomed = await mount({ view: 'icicle', dirPrefix: 'src/workers/' });
    expect(
      zoomed.container.querySelector('svg.mrpr-dist-icicle-svg')?.getAttribute('viewBox')
    ).toBe(`0 0 480 ${2 * ICICLE_ROW_HEIGHT}`);
  });

  it('handles zero total line changes gracefully in both Bars and Icicle views', async () => {
    const zeroFiles = toDistributionFiles([
      prFile('assets/logo.png', 0, 0, 'added'),
      prFile('assets/icon.png', 0, 0, 'renamed'),
    ]);
    const bars = await mount({ files: zeroFiles, activeKinds: new Set<ChangedFileKind>(['code']) });
    expect(bars.container.textContent).not.toContain('NaN');
    expect(bars.container.textContent).toContain('0%');

    bars.unmount();
    const icicle = await mount({
      files: zeroFiles,
      activeKinds: new Set<ChangedFileKind>(['code']),
      view: 'icicle',
    });
    expect(icicle.container.textContent).not.toContain('NaN');
    expect(icicle.container.querySelectorAll('g.mrpr-dist-icicle-node').length).toBeGreaterThan(0);
  });

  it('renders Net Bars and Icicle with cancellation, signed labels, neutral dirs, zero-net empty state, and churn total captions', async () => {
    const mixed = toDistributionFiles([
      prFile('src/grow.ts', 120, 20),
      prFile('src/shrink.ts', 10, 110),
      prFile('src/even.ts', 30, 30),
      prFile('docs/note.md', 40, 0, 'added'),
    ]);
    const kinds = new Set<ChangedFileKind>(['code', 'docs']);

    // Net Bars: signed aggregate in crumb meta, sum(|net|) kind shares, split dir bar, signed file stats.
    const bars = await mount({ files: mixed, activeKinds: kinds, metric: 'net' });
    expect(bars.container.querySelector('.mrpr-dist-crumb-meta')?.textContent).toBe(
      '4 files · +40 net'
    );
    expect(bars.getByRole('button', { name: /Code\s*83%/ }).getAttribute('title')).toContain(
      '0 net'
    );
    const srcRow = bars.getByRole('button', { name: /^src\// });
    expect(srcRow.querySelector('.mrpr-dist-bar-stats')?.textContent).toBe('083%');
    expect(srcRow.querySelector('.mrpr-dist-bar-add')).not.toBeNull();
    expect(srcRow.querySelector('.mrpr-dist-bar-del')).not.toBeNull();
    const shrinkRow = bars.getByRole('button', { name: /shrink\.ts/ });
    expect(shrinkRow.querySelector('.mrpr-removed')?.textContent).toBe('-100');
    expect(shrinkRow.querySelector('.mrpr-dist-bar-add')).toBeNull();
    bars.unmount();

    // Drilled into canceling directory: shows 0 net (83%), never unsigned 200 lines.
    const drilled = await mount({
      files: mixed,
      activeKinds: kinds,
      dirPrefix: 'src/',
      metric: 'net',
    });
    expect(drilled.container.querySelector('.mrpr-dist-crumb-meta')?.textContent).toBe(
      '3 files · 0 net (83%)'
    );
    drilled.unmount();

    // Net Icicle: neutral dirs with net captions, green/red file tiles with signs, inspect & legend.
    const icicle = await mount({ files: mixed, activeKinds: kinds, view: 'icicle', metric: 'net' });
    const srcDir = icicle.getByRole('button', { name: /^src\/: 0 net/ });
    expect(srcDir.getAttribute('data-net')).toBeNull();
    expect(srcDir.querySelector('rect.mrpr-dist-icicle-root-rect')).not.toBeNull();
    expect(srcDir.querySelector('text.mrpr-dist-icicle-root-sub')?.textContent).toBe('0 net');
    const growTile = icicle.getByRole('button', { name: /^src\/grow\.ts: \+100 net/ });
    expect(growTile.getAttribute('data-net')).toBe('added');
    expect(growTile.querySelector('text.mrpr-dist-icicle-sub')?.textContent).toBe('+100');
    const shrinkTile = icicle.getByRole('button', { name: /^src\/shrink\.ts: -100 net/ });
    expect(shrinkTile.getAttribute('data-net')).toBe('removed');
    expect(shrinkTile.querySelector('text.mrpr-dist-icicle-sub')?.textContent).toBe('-100');
    expect(icicle.queryByRole('button', { name: /^src\/even\.ts:/ })).toBeNull();
    expect(icicle.container.querySelector('.mrpr-dist-foot')?.textContent).toMatch(
      /\+ grows.*- shrinks/
    );
    await act(async () => srcDir.focus());
    expect(icicle.container.querySelector('.mrpr-dist-icicle-inspect')?.textContent).toMatch(
      /0 net.*-160.*83%/
    );
    icicle.unmount();

    // Phone width: narrow Net dir drops optional "net" suffix; leaf keeps signed single number.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.classList.contains('mrpr-dist-icicle-box') ? 260 : 0;
    });
    const phone = await mount({ files: mixed, activeKinds: kinds, view: 'icicle', metric: 'net' });
    expect(
      phone
        .getByRole('button', { name: /^docs\/note\.md: \+40 net/ })
        .querySelector('text.mrpr-dist-icicle-sub')?.textContent
    ).toBe('+40');
    expect(
      phone
        .getByRole('button', { name: /^docs\/: \+40 net/ })
        .querySelector('text.mrpr-dist-icicle-root-sub')?.textContent
    ).toBe('+40');
    phone.unmount();

    // All net=0: no file-count fallback in kind bar or icicle; clean empty state in both views.
    const allZero = toDistributionFiles([
      prFile('src/swap.ts', 45, 45),
      prFile('docs/swap.md', 10, 10),
    ]);
    const zeroBars = await mount({ files: allZero, activeKinds: kinds, metric: 'net' });
    expect(zeroBars.container.querySelectorAll('.mrpr-dist-kind-seg')).toHaveLength(0);
    expect(zeroBars.getByText('No net line change')).toBeTruthy();
    zeroBars.unmount();

    const zeroIcicle = await mount({
      files: allZero,
      activeKinds: kinds,
      view: 'icicle',
      metric: 'net',
    });
    expect(zeroIcicle.container.querySelectorAll('g.mrpr-dist-icicle-node')).toHaveLength(0);
    expect(zeroIcicle.getByText('No net line change')).toBeTruthy();
    zeroIcicle.unmount();

    // Total icicle explains churn width; +Add stays additions-only; single shrinking Net bar uses signed footer.
    const churn = toDistributionFiles([prFile('src/trim.ts', 10, 190)]);
    const codeOnly = new Set<ChangedFileKind>(['code']);
    const totalIcicle = await mount({
      files: churn,
      activeKinds: codeOnly,
      view: 'icicle',
      metric: 'total',
    });
    expect(
      totalIcicle
        .getByRole('button', { name: /^src\/trim\.ts:/ })
        .querySelector('text.mrpr-dist-icicle-sub')?.textContent
    ).toBe('100% · 200');
    totalIcicle.unmount();

    const addIcicle = await mount({
      files: churn,
      activeKinds: codeOnly,
      view: 'icicle',
      metric: 'additions',
    });
    expect(
      addIcicle
        .getByRole('button', { name: /^src\/trim\.ts:/ })
        .querySelector('text.mrpr-dist-icicle-sub')?.textContent
    ).toBe('100% · +10');
    expect(addIcicle.container.querySelector('.mrpr-dist-foot')?.textContent).toContain(
      'Color = kind'
    );
    addIcicle.unmount();

    const singleNet = await mount({ files: churn, activeKinds: codeOnly, metric: 'net' });
    expect(singleNet.container.querySelector('.mrpr-dist-foot')?.textContent).toBe('-180 net');
  });
});
