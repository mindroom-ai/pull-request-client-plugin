// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import type { WorkerPoolManager } from '@pierre/diffs/worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeTab, resetDiffWorkerPool } from './CodeTab';
import plugin from './index';
import { act } from './testing/act';
import {
  createFakeDiffWorkerClass,
  withMockedCreateObjectURL,
  type FakeDiffWorkerRecord,
} from './testing/fakeDiffWorker';
import { GitHubServerContext } from './token';

vi.mock('@pierre/diffs/worker/worker-portable.js?raw', () => ({
  default: '/* fake diff worker */',
}));

const captured = vi.hoisted(() => ({
  manager: undefined as WorkerPoolManager | undefined,
}));

vi.mock('@pierre/diffs/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pierre/diffs/react')>();
  const { forwardRef, useContext, useImperativeHandle } = await import('react');
  return {
    CodeView: forwardRef(function CodeView(_props, ref) {
      captured.manager = useContext(actual.WorkerPoolContext);
      useImperativeHandle(ref, () => ({ scrollTo: vi.fn() }));
      return <div data-testid="diff-view" />;
    }),
    WorkerPoolContext: actual.WorkerPoolContext,
  };
});

vi.mock('./diff/DiffFileTree', () => ({
  DiffFileTree: () => null,
}));

const created: FakeDiffWorkerRecord[] = [];
const FakeDiffWorker = createFakeDiffWorkerClass(created);
const FailingInitDiffWorker = createFakeDiffWorkerClass(created, { failInitialize: true });

function renderCodeTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return renderPluginComponent(
    <QueryClientProvider client={client}>
      <GitHubServerContext.Provider value={{ server: undefined, pending: false }}>
        <CodeTab
          pullRequest={{ owner: 'mindroom-ai', repo: 'mindroom-chat', number: 200 }}
          files={[
            {
              path: 'src/app.ts',
              sha: 'a'.repeat(40),
              previousPath: null,
              url: '',
              status: 'modified',
              additions: 1,
              deletions: 1,
              patch: '@@ -1 +1 @@\n-old\n+new',
            },
          ]}
          threads={{ status: 'success', items: [] }}
          commits={{ status: 'success', items: [] }}
          commit={undefined}
          onCommitChange={() => {}}
        />
      </GitHubServerContext.Provider>
    </QueryClientProvider>,
    { id: 'pull-requests', plugin, themeKind: 'light' }
  );
}

describe('CodeTab diff worker fallbacks', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    created.length = 0;
    captured.manager = undefined;
  });

  afterEach(() => {
    resetDiffWorkerPool();
    vi.unstubAllGlobals();
  });

  it('falls back to a data URL worker when URL.createObjectURL throws and keeps it across unmount', async () => {
    await withMockedCreateObjectURL(
      vi.fn(() => {
        throw new Error('Blob URLs unavailable');
      }),
      async () => {
        vi.stubGlobal('Worker', FakeDiffWorker);
        const tab = await renderCodeTab();
        await vi.waitFor(() => expect(captured.manager?.isInitialized()).toBe(true), {
          timeout: 10_000,
        });
        expect(created).toHaveLength(1);
        expect(created[0].url).toMatch(/^data:text\/javascript;charset=utf-8,/);

        await act(async () => {
          tab.unmount();
        });
        expect(created[0].terminate).not.toHaveBeenCalled();

        resetDiffWorkerPool();
        expect(created[0].terminate).toHaveBeenCalledTimes(1);
      }
    );
  });

  it('keeps @pierre/diffs main-thread fallback on startup worker failure without respawning', async () => {
    await withMockedCreateObjectURL(
      vi.fn(() => 'blob:diff-worker-startup-fail'),
      async () => {
        vi.stubGlobal('Worker', FailingInitDiffWorker);
        const firstOpen = await renderCodeTab();
        const firstManager = captured.manager;
        await vi.waitFor(() => expect(firstManager?.getStats().workersFailed).toBe(true), {
          timeout: 10_000,
        });
        expect(firstManager?.isWorkingPool()).toBe(false);
        expect(created).toHaveLength(1);
        expect(created[0].terminate).toHaveBeenCalledTimes(1);

        await act(async () => {
          firstOpen.unmount();
        });

        const secondOpen = await renderCodeTab();
        expect(captured.manager).toBe(firstManager);
        expect(created).toHaveLength(1);

        await act(async () => {
          secondOpen.unmount();
        });
      }
    );
  });
});
