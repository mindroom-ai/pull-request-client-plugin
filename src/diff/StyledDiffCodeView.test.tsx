// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '../testing/act';
import { StyledDiffCodeView, type StyledDiffCodeViewOptions } from './StyledDiffCodeView';

const captured = vi.hoisted(() => ({
  props: undefined as Record<string, unknown> | undefined,
}));

vi.mock('@pierre/diffs/react', () => ({
  CodeView: function CodeView(props: Record<string, unknown>) {
    captured.props = props;
    return <div data-testid="code-view" />;
  },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  captured.props = undefined;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('StyledDiffCodeView', () => {
  it('passes a referentially stable options object across re-renders when inputs are unchanged', async () => {
    const options: StyledDiffCodeViewOptions<undefined> = {
      theme: 'pierre-light',
      themeType: 'light',
      diffStyle: 'unified',
      overflow: 'wrap',
    };
    const items: never[] = [];

    await act(async () => {
      root.render(<StyledDiffCodeView items={items} options={options} unsafeCSSExtra="/* a */" />);
    });
    const firstOptions = captured.props?.options as Record<string, unknown>;

    await act(async () => {
      root.render(<StyledDiffCodeView items={items} options={options} unsafeCSSExtra="/* a */" />);
    });
    const secondOptions = captured.props?.options as Record<string, unknown>;
    expect(secondOptions).toBe(firstOptions);
    expect(secondOptions.itemMetrics).toBe(firstOptions.itemMetrics);
    expect(secondOptions.layout).toBe(firstOptions.layout);

    await act(async () => {
      root.render(<StyledDiffCodeView items={items} options={options} unsafeCSSExtra="/* b */" />);
    });
    const thirdOptions = captured.props?.options as Record<string, unknown>;
    expect(thirdOptions).not.toBe(secondOptions);
    expect(thirdOptions.itemMetrics).toBe(secondOptions.itemMetrics);
    expect(thirdOptions.layout).toBe(secondOptions.layout);
  });

  it('enables the worker pool when Worker is defined and falls back when Worker is undefined', async () => {
    await act(async () => {
      root.render(<StyledDiffCodeView items={[]} />);
    });
    expect(captured.props?.disableWorkerPool).toBe(true);

    vi.stubGlobal('Worker', class FakeWorker {});
    await act(async () => {
      root.render(<StyledDiffCodeView items={[]} />);
    });
    expect(captured.props?.disableWorkerPool).toBe(false);
  });
});
