// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeTab } from './CodeTab';
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

vi.mock('@pierre/diffs/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pierre/diffs/react')>();
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    CodeView: forwardRef(function CodeView(_props, ref) {
      useImperativeHandle(ref, () => ({ scrollTo: vi.fn() }));
      return <div data-testid="diff-view" />;
    }),
    WorkerPoolContextProvider: actual.WorkerPoolContextProvider,
  };
});

vi.mock('./diff/DiffFileTree', () => ({
  DiffFileTree: () => null,
}));

const created: FakeDiffWorkerRecord[] = [];
const FakeDiffWorker = createFakeDiffWorkerClass(created);

describe('CodeTab diff worker data URL fallback', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    created.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to a data URL worker when URL.createObjectURL throws', async () => {
    await withMockedCreateObjectURL(
      vi.fn(() => {
        throw new Error('Blob URLs unavailable');
      }),
      async () => {
        vi.stubGlobal('Worker', FakeDiffWorker);
        const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
        const tab = await renderPluginComponent(
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
        await vi.waitFor(() => expect(created).toHaveLength(1), { timeout: 10_000 });
        expect(created[0].url).toMatch(/^data:text\/javascript;charset=utf-8,/);
        await act(async () => {
          tab.unmount();
        });
        expect(created[0].terminate).toHaveBeenCalledTimes(1);
      }
    );
  });
});
