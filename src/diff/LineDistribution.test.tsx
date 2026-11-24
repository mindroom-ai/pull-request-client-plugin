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
  const props: LineDistributionProps = {
    files: SAMPLE_FILES,
    activeKinds: new Set<ChangedFileKind>(['code', 'test', 'docs']),
    dirPrefix: '',
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LineDistribution', () => {
  it('shows only present kind chips, toggles kinds, and refuses to hide the last active kind', async () => {
    const first = await mount();
    const { getByRole, queryByRole, props } = first;
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

  it('renders 2-column Bars with top-5 compact toggle, drills into folders, and collapses leaf directories to 1 column', async () => {
    const first = await mount();
    const { container, getByRole, getByText, queryByText, props } = first;
    expect(container.querySelector('.mrpr-dist-bars-split')).not.toBeNull();
    expect(getByText(/Top 5 files =/)).toBeTruthy();

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
    await click(getByRole('button', { name: /pool\.ts/ }));
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
  });

  it('renders Icicle with measured viewBox, dynamic depth height, tooltips, keyboard activation, and live hover/focus summary', async () => {
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

    const first = await mount({ view: 'icicle' });
    const { container, getByRole, getByText, props } = first;
    const svg = container.querySelector('svg.mrpr-dist-icicle-svg')!;
    // Root (0) -> src/ (1) -> workers/ (2) -> pool.ts (3) => 4 rows * 42 = 168px.
    expect(svg.getAttribute('viewBox')).toBe(`0 0 540 ${4 * ICICLE_ROW_HEIGHT}`);
    expect(svg.getAttribute('preserveAspectRatio')).toBeNull();
    // Every rendered node has a <title> tooltip.
    const nodes = container.querySelectorAll('g.mrpr-dist-icicle-node');
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) expect(node.querySelector('title')?.textContent).toBeTruthy();

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

    // Keyboard activation (Enter on folder, Space on file) and live focus summary in footer.
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
});
