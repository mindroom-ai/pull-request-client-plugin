// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullRequest, PullRequestRef } from '../github';
import plugin from '../index';
import { HeaderActions } from './HeaderActions';
import {
  resetPullRequestActions,
  usePullRequestActions,
  type ActionResult,
} from './usePullRequestActions';

vi.mock('focus-trap-react', async () => ({
  default: (await import('../testing/focusTrapStandIn')).FocusTrapStandIn,
}));

const STORAGE = 'mindroom.plugin:%40plugin-tester%3Aexample.org/pull-requests/';
const GRAPHQL = 'https://api.github.com/graphql';
const PULL = 'https://api.github.com/repos/o/r/pulls/7';

const ref: PullRequestRef = { owner: 'o', repo: 'r', number: 7 };

const open: PullRequest = {
  title: 'T',
  state: 'open',
  draft: false,
  body: '',
  images: { byUrl: {}, byAttachment: {} },
  author: null,
  labels: [],
  requestedReviewers: [],
  requestedTeams: [],
  nodeId: 'PR_kw7',
  mergeable: true,
  mergeableState: 'clean',
  autoMerge: null,
  headSha: 'head7',
  headRepo: 'o/r',
  headRepoId: 'R_or',
  baseRepo: 'o/r',
  mergedAt: null,
  closedAt: null,
  commentCount: 0,
  reviewCommentCount: 0,
  commitCount: 1,
  createdAt: '',
  updatedAt: '',
  baseRef: 'main',
  headRef: 'feature',
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  url: 'https://github.com/o/r/pull/7',
};
const merged: PullRequest = { ...open, state: 'merged', mergedAt: '2026-11-15T00:00:00Z' };
// What GitHub does not merge yet: a required check still runs, or a review is missing.
const blocked: PullRequest = { ...open, mergeableState: 'blocked' };

let repository: Record<string, unknown>;
let checkRuns: Record<string, unknown>[];
// The commit the pull request's branch points at on GitHub; null once the branch is gone.
let headBranch: string | null;
// The pull request's state on GitHub when its branch is asked about, which the panel may not
// have read yet.
let stateNow: 'OPEN' | 'CLOSED' | 'MERGED';

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// Polls outside React's act environment, so that what the answered requests change renders.
const waitUntil = async (check: () => void) => {
  const scope = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  scope.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await vi.waitFor(check);
  } finally {
    scope.IS_REACT_ACT_ENVIRONMENT = true;
  }
};

const click = (element: HTMLElement) => act(async () => element.click());

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const isRepositoryQuery = (url: string, init?: RequestInit) =>
  url === GRAPHQL && String(init?.body).includes('viewerPermission');
const isHeadBranchQuery = (url: string, init?: RequestInit) =>
  url === GRAPHQL && String(init?.body).includes('ref(qualifiedName');
const isRead = (url: string, init?: RequestInit) =>
  isRepositoryQuery(url, init) ||
  isHeadBranchQuery(url, init) ||
  init?.method === undefined ||
  init.method === 'GET';
const writes = () =>
  fetchMock.mock.calls
    .filter(([url, init]) => !isRead(url, init))
    .map(([url, init]) => `${init?.method} ${url}`);
const graphqlRequests = () => fetchMock.mock.calls.filter(([url]) => url === GRAPHQL);

// The writes a test holds until it answers them; every one is answered after the test, so no
// pull request stays locked for the next.
const held: (() => void)[] = [];
const hold = (answer: () => Response) =>
  new Promise<Response>((resolve) => held.push(() => resolve(answer())));
const answerHeld = async () => {
  await act(async () => {
    held.splice(0).forEach((release) => release());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

let writeAnswer: () => Promise<Response>;

function Harness({ pullRequest }: { pullRequest: PullRequest }) {
  const actions = usePullRequestActions(ref, pullRequest);
  return (
    <div data-testid="header-row">
      <HeaderActions pullRequestRef={ref} pullRequest={pullRequest} actions={actions} />
    </div>
  );
}

let client: QueryClient;
const ui = (pullRequest: PullRequest) => (
  <QueryClientProvider client={client}>
    <Harness pullRequest={pullRequest} />
  </QueryClientProvider>
);
const show = (pullRequest: PullRequest = open) =>
  renderPluginComponent(ui(pullRequest), { id: 'pull-requests', plugin });
type View = Awaited<ReturnType<typeof show>>;

// The app's test setup draws menus as plain components, so a row is found by its text.
const row = (view: View, name: string) => {
  const button = view.getByText(name).closest('button');
  if (!button) throw new Error(`No button for ${name}`);
  return button;
};
const moreActions = (view: View) => view.getByRole('button', { name: 'More actions' });
const openMenu = async (view: View) => {
  await waitUntil(() => expect(moreActions(view)).toBeTruthy());
  await click(moreActions(view));
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  // Not a word of GitHub's reasons: a reason with the token in it is not shown.
  localStorage.setItem(`${STORAGE}githubToken`, 'ghp_test');
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  repository = {
    viewerPermission: 'WRITE',
    mergeCommitAllowed: true,
    squashMergeAllowed: true,
    rebaseMergeAllowed: true,
    autoMergeAllowed: true,
    defaultBranchRef: { name: 'main' },
  };
  checkRuns = [];
  headBranch = 'head7';
  stateNow = 'MERGED';
  writeAnswer = async () => respond({ merged: true });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url, init) => {
    if (isRepositoryQuery(url, init)) return respond({ data: { repository } });
    if (isHeadBranchQuery(url, init)) {
      const node = { ref: headBranch === null ? null : { target: { oid: headBranch } } };
      return respond({ data: { node, repository: { pullRequest: { state: stateNow } } } });
    }
    if (url.includes('/check-runs')) return respond({ check_runs: checkRuns });
    if (url.includes('/status')) return respond({ statuses: [] });
    return writeAnswer();
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  await answerHeld();
  resetPullRequestActions();
  vi.unstubAllGlobals();
});

describe('HeaderActions', () => {
  it('draws nothing without a token, and asks GitHub nothing', async () => {
    localStorage.clear();
    const view = await show();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(view.getByTestId('header-row').innerHTML).toBe('');
    expect(graphqlRequests()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('draws nothing on a repository the viewer can only read', async () => {
    repository = { ...repository, viewerPermission: 'READ' };
    const view = await show();
    await waitUntil(() =>
      expect(client.getQueryData(['pull-requests', 'repo', 'o', 'r'])).toMatchObject({
        canWrite: false,
      })
    );
    expect(view.getByTestId('header-row').innerHTML).toBe('');
    expect(fetchMock.mock.calls.filter(([url]) => url.includes('/check-runs'))).toEqual([]);
  });

  it('merges with a squash-only repository on the second click', async () => {
    repository = { ...repository, mergeCommitAllowed: false, rebaseMergeAllowed: false };
    const view = await show();
    await waitUntil(() => expect(view.getByRole('button', { name: 'Squash and merge' })));
    await click(view.getByRole('button', { name: 'Squash and merge' }));
    expect(view.getByRole('button', { name: 'Confirm merge?' })).toBeTruthy();
    expect(writes()).toEqual([]);
    await click(view.getByRole('button', { name: 'Confirm merge?' }));
    expect(writes()).toEqual([`PUT ${PULL}/merge`]);
    const [, init] = fetchMock.mock.calls.find(([, call]) => call?.method === 'PUT')!;
    expect(JSON.parse(String(init?.body))).toEqual({ merge_method: 'squash', sha: 'head7' });
  });

  it('tells a token without write access from a failure', async () => {
    writeAnswer = async () =>
      respond({ message: 'Resource not accessible by personal access token' }, 403);
    const view = await show();
    await waitUntil(() => expect(view.getByRole('button', { name: 'Merge' })));
    await click(view.getByRole('button', { name: 'Merge' }));
    await click(view.getByRole('button', { name: 'Confirm merge?' }));
    await waitUntil(() =>
      expect(view.getByRole('status').textContent).toContain('Could not merge this pull request')
    );
    const status = view.getByRole('status');
    // The hint, then GitHub's own reason.
    expect(status.textContent).toContain(
      'GitHub refused it. The saved token may not have write access to this repository (Pull requests and Contents: Read and write). Resource not accessible by personal access token'
    );
    expect(status.textContent).not.toContain('Could not reach GitHub.');
  });

  it("shows GitHub's reason after the hint, as for a token its organization has not allowed", async () => {
    const sso =
      'Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.';
    writeAnswer = async () => respond({ message: sso }, 403);
    const view = await show();
    await openMenu(view);
    await click(row(view, 'Convert to draft'));
    await waitUntil(() => expect(view.getByRole('status').textContent).toContain(sso));
    expect(view.getByRole('status').textContent).toContain(
      'The saved token may not have write access to this repository'
    );
  });

  it.each([
    [
      "a server error, with GitHub's message",
      async () => respond({ message: 'Server Error' }, 502),
      'Could not close this pull request GitHub answered with an error. Server Error',
    ],
    [
      'a server error without a message',
      async () => new Response('', { status: 500 }),
      'Could not close this pull request GitHub answered with an error.',
    ],
    [
      "a rate limit, with GitHub's message",
      async () => respond({ message: 'You have exceeded a secondary rate limit.' }, 429),
      "Could not close this pull request GitHub's rate limit is used up for now. Try again later. You have exceeded a secondary rate limit.",
    ],
    [
      'no answer',
      async (): Promise<Response> => {
        throw new TypeError('Failed to fetch');
      },
      'Could not close this pull request Could not reach GitHub.',
    ],
  ])('says what went wrong after %s', async (_name, answer, line) => {
    writeAnswer = answer;
    const view = await show();
    await openMenu(view);
    await click(row(view, 'Close pull request'));
    await click(row(view, 'Confirm close?'));
    await waitUntil(() => expect(view.getByRole('status').textContent).toBe(line));
  });

  it('keeps its status region in place, so that what it says next is announced', async () => {
    writeAnswer = () => hold(() => respond({ message: 'Pull Request is not mergeable' }, 405));
    const view = await show();
    await waitUntil(() => expect(view.getByRole('button', { name: 'Merge' })));
    const region = view.getByRole('status');
    expect(region.textContent).toBe('');
    await openMenu(view);
    await click(row(view, 'Convert to draft'));
    expect(view.getByRole('status')).toBe(region);
    expect(region.textContent).toBe('Converting to draft...');
    await answerHeld();
    await waitUntil(() => expect(region.textContent).toContain('Could not convert'));
    expect(view.getByRole('status')).toBe(region);
    await click(view.getByRole('button', { name: 'Dismiss' }));
    expect(view.getByRole('status')).toBe(region);
    expect(region.textContent).toBe('');
  });

  it("shows GitHub's reason for a refusal after the title", async () => {
    writeAnswer = async () => respond({ message: 'Pull Request is not mergeable' }, 405);
    const view = await show();
    await waitUntil(() => expect(view.getByRole('button', { name: 'Merge' })));
    await click(view.getByRole('button', { name: 'Merge' }));
    await click(view.getByRole('button', { name: 'Confirm merge?' }));
    await waitUntil(() =>
      expect(view.getByRole('status').textContent).toContain('Pull Request is not mergeable')
    );
    expect(view.getByRole('status').textContent).toContain('Could not merge this pull request');
    await click(view.getByRole('button', { name: 'Dismiss' }));
    expect(view.getByRole('status').textContent).toBe('');
  });

  it("lists an open pull request's actions in the menu's order", async () => {
    const view = await show(blocked);
    await openMenu(view);
    const methods = view.getAllByRole('menuitemradio');
    expect(methods.map((method) => method.textContent)).toEqual([
      'Merge',
      'Squash and merge',
      'Rebase and merge',
    ]);
    expect(methods[0].getAttribute('aria-checked')).toBe('true');
    // The rows as drawn, top to bottom: the method group is only radios.
    expect(view.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Enable auto-merge',
      'Convert to draft',
      'Close pull request',
      'Refresh',
    ]);
  });

  it('offers no auto-merge on a pull request GitHub can merge now, which it would refuse', async () => {
    checkRuns = [{ name: 'ci', status: 'in_progress', conclusion: null }];
    const view = await show();
    await waitUntil(() =>
      expect(
        client.getQueryState(['pull-requests', 'pr', 'o', 'r', 7, true, 'checks', 'head7'])
      ).toMatchObject({ status: 'success' })
    );
    expect(view.getByRole('button', { name: 'Merge' })).toBeTruthy();
    await openMenu(view);
    expect(view.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Convert to draft',
      'Close pull request',
      'Refresh',
    ]);
  });

  it('shows no method group with one method', async () => {
    repository = { ...repository, mergeCommitAllowed: false, rebaseMergeAllowed: false };
    const view = await show();
    await openMenu(view);
    expect(view.queryAllByRole('menuitemradio')).toEqual([]);
  });

  it('a chosen method names the primary control', async () => {
    const view = await show();
    await openMenu(view);
    await click(view.getByRole('menuitemradio', { name: 'Rebase and merge' }));
    expect(view.getByRole('button', { name: 'Rebase and merge' })).toBeTruthy();
  });

  it('offers auto-merge while the checks run', async () => {
    checkRuns = [{ name: 'ci', status: 'in_progress', conclusion: null }];
    const view = await show(blocked);
    await waitUntil(() => expect(view.getByRole('button', { name: 'Auto-merge (merge)' })));
    await click(view.getByRole('button', { name: 'Auto-merge (merge)' }));
    expect(view.getByRole('button', { name: 'Confirm auto-merge?' })).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it('shows the Conflicts badge on a conflicting pull request, and no merge', async () => {
    const view = await show({ ...open, mergeableState: 'dirty' });
    await waitUntil(() => expect(view.getByText('Conflicts')).toBeTruthy());
    expect(view.queryByRole('button', { name: 'Merge' })).toBeNull();
  });

  it('closes on the second click of its menu row', async () => {
    writeAnswer = async () => respond({ state: 'closed' });
    const view = await show();
    await openMenu(view);
    await click(row(view, 'Close pull request'));
    expect(writes()).toEqual([]);
    // Escape disarms the row and leaves the menu open.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(view.queryByText('Confirm close?')).toBeNull();
    await click(row(view, 'Close pull request'));
    await click(row(view, 'Confirm close?'));
    expect(writes()).toEqual([`PATCH ${PULL}`]);
  });

  it('asks in a dialog before it deletes the branch of a merged pull request', async () => {
    // GitHub deletes the branch, after which it reads as gone.
    writeAnswer = async () => {
      headBranch = null;
      return respond({ data: { updateRefs: {} } });
    };
    const view = await show(merged);
    await openMenu(view);
    await click(row(view, 'Delete branch'));
    const dialog = view.getByRole('dialog', { name: 'Delete branch feature?' });
    expect(dialog.textContent).toContain(
      'This deletes feature from o/r on GitHub. Local branches and worktrees are not changed.'
    );
    expect(writes()).toEqual([]);
    await click(view.getByRole('button', { name: 'Cancel' }));
    expect(view.queryByRole('dialog')).toBeNull();
    expect(writes()).toEqual([]);

    await openMenu(view);
    await click(row(view, 'Delete branch'));
    const confirm = view
      .getByRole('dialog')
      .querySelector<HTMLButtonElement>('button:last-of-type')!;
    expect(confirm.textContent).toBe('Delete branch');
    await click(confirm);
    await waitUntil(() => expect(view.getByRole('status').textContent).toContain('Branch deleted'));
    // Only where the pull request left it: GitHub refuses if the branch moved since.
    expect(writes()).toEqual([`POST ${GRAPHQL}`]);
    const [, init] = fetchMock.mock.calls.find(([, call]) =>
      String(call?.body).includes('updateRefs')
    )!;
    expect(JSON.parse(String(init?.body)).variables.input).toEqual({
      repositoryId: 'R_or',
      refUpdates: [
        {
          name: 'refs/heads/feature',
          beforeOid: 'head7',
          afterOid: '0000000000000000000000000000000000000000',
        },
      ],
    });
    // The branch is gone, so the menu offers it no more, once that is read.
    await openMenu(view);
    await waitUntil(() => expect(view.queryByText('Delete branch')).toBeNull());
  });

  it.each([
    ['is gone', null],
    ['got commits since the pull request', 'newer'],
  ])('offers no Delete branch for a branch that %s', async (_name, sha) => {
    headBranch = sha;
    const view = await show(merged);
    await waitUntil(() =>
      expect(fetchMock.mock.calls.some(([url, init]) => isHeadBranchQuery(url, init))).toBe(true)
    );
    await openMenu(view);
    expect(view.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Refresh']);
  });

  it('leaves a branch that got commits after the menu was drawn, and says so', async () => {
    const view = await show(merged);
    await openMenu(view);
    await click(row(view, 'Delete branch'));
    headBranch = 'newer';
    await click(view.getByRole('dialog').querySelector<HTMLButtonElement>('button:last-of-type')!);
    await waitUntil(() =>
      expect(view.getByRole('status').textContent).toContain(
        'Could not delete this branch The branch has new commits since this pull request, so it was not deleted.'
      )
    );
    expect(writes()).toEqual([]);
  });

  it('leaves the branch of a pull request that was opened again on GitHub, and says so', async () => {
    // The panel still shows it closed, with Delete branch; deleting it would close it again.
    stateNow = 'CLOSED';
    const view = await show({ ...open, state: 'closed', closedAt: '2026-11-15T00:00:00Z' });
    await openMenu(view);
    await click(row(view, 'Delete branch'));
    stateNow = 'OPEN';
    await click(view.getByRole('dialog').querySelector<HTMLButtonElement>('button:last-of-type')!);
    await waitUntil(() =>
      expect(view.getByRole('status').textContent).toContain(
        'Could not delete this branch This pull request is open again, so its branch was not deleted.'
      )
    );
    expect(writes()).toEqual([]);
  });

  it('asks GitHub nothing about the branch of an open pull request', async () => {
    const view = await show();
    await openMenu(view);
    expect(fetchMock.mock.calls.filter(([url, init]) => isHeadBranchQuery(url, init))).toEqual([]);
  });

  // The header with an outcome the runner left, on the pull request as the panel has it.
  const dismissResult = vi.fn();
  const withResult = (result: ActionResult, pullRequest: PullRequest) => {
    const actions = {
      repo: {
        canWrite: true,
        mergeMethods: ['merge' as const],
        autoMergeAllowed: false,
        defaultBranch: 'main',
      },
      method: 'merge' as const,
      chooseMethod: () => {},
      pending: null,
      result,
      perform: () => {},
      dismissResult,
    };
    return (
      <QueryClientProvider client={client}>
        <HeaderActions pullRequestRef={ref} pullRequest={pullRequest} actions={actions} />
      </QueryClientProvider>
    );
  };

  it('says an update whose new head did not show yet was requested, not made', async () => {
    const view = await renderPluginComponent(
      withResult({ action: 'update-branch', outcome: 'requested' }, open),
      { id: 'pull-requests', plugin }
    );
    expect(view.getByRole('status').textContent).toBe('Branch update requested');
    await click(view.getByRole('button', { name: 'Dismiss' }));
    expect(dismissResult).toHaveBeenCalled();
  });

  it('shows that a merge is done while the panel could not read the merged pull request', async () => {
    // GitHub merged it, but the read after that failed: the header still has Merge.
    const unread: ActionResult = { action: 'merge', outcome: 'done', unread: true };
    const view = await renderPluginComponent(withResult(unread, open), {
      id: 'pull-requests',
      plugin,
    });
    const status = view.getByRole('status');
    expect(view.getByRole('button', { name: 'Merge' })).toBeTruthy();
    expect(status.textContent).toBe('Pull request merged');
    expect(status.className).toBe('mrpr-action-result');
    expect(view.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    // Once the panel has read it, the header says so itself, and the line is only announced.
    view.rerender(withResult(unread, merged));
    expect(view.getByRole('status')).toBe(status);
    expect(status.textContent).toBe('Pull request merged');
    expect(status.className).toBe('mrpr-sr-only');
    expect(view.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('draws no Merge button on a merged pull request', async () => {
    const view = await show(merged);
    await waitUntil(() => expect(moreActions(view)).toBeTruthy());
    expect(view.queryByRole('button', { name: 'Merge' })).toBeNull();
  });

  it('refreshes the pull request without a write', async () => {
    const view = await show();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await openMenu(view);
    await click(row(view, 'Refresh'));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['pull-requests', 'pr', 'o', 'r', 7] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['pull-requests', 'repo', 'o', 'r'] });
    expect(writes()).toEqual([]);
  });

  // Disabled for the click and for a screen reader, yet still able to hold the focus.
  const isOff = (button: HTMLElement) =>
    button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true';

  it('disables every control while an action runs, and says what runs', async () => {
    writeAnswer = () => hold(() => respond({}));
    const view = await show();
    await openMenu(view);
    await click(row(view, 'Convert to draft'));
    expect(writes()).toHaveLength(1);
    const buttons = Array.from(view.getByTestId('header-row').querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThan(1);
    expect(buttons.every(isOff)).toBe(true);
    expect(view.getByRole('status').textContent).toBe('Converting to draft...');
    // Neither the menu opens nor the merge arms meanwhile.
    await click(moreActions(view));
    expect(moreActions(view).getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByText('Refresh')).toBeNull();
    await click(view.getByRole('button', { name: 'Merge' }));
    expect(view.queryByRole('button', { name: 'Confirm merge?' })).toBeNull();
    expect(writes()).toHaveLength(1);
    await answerHeld();
    await waitUntil(() => expect(isOff(view.getByRole('button', { name: 'Merge' }))).toBe(false));
    expect(isOff(moreActions(view))).toBe(false);
  });

  it('the pending primary control says so', async () => {
    writeAnswer = () => hold(() => respond({ merged: true }));
    const view = await show();
    await waitUntil(() => expect(view.getByRole('button', { name: 'Merge' })));
    await click(view.getByRole('button', { name: 'Merge' }));
    await click(view.getByRole('button', { name: 'Confirm merge?' }));
    const pending = view.getByRole('button', { name: 'Merging...' });
    expect(isOff(pending)).toBe(true);
    expect(isOff(moreActions(view))).toBe(true);
  });

  describe('for a screen reader and the keyboard', () => {
    const status = (view: View) => view.getByRole('status');
    const announcedOnly = (view: View) => {
      expect(status(view).className).toBe('mrpr-sr-only');
      // Nothing to press in a line nobody sees.
      expect(status(view).querySelector('button')).toBeNull();
    };

    it('announces a merge that runs and that it is done, though the header shows both', async () => {
      writeAnswer = () => hold(() => respond({ merged: true }));
      const view = await show();
      await waitUntil(() => expect(view.getByRole('button', { name: 'Merge' })));
      const region = status(view);
      await click(view.getByRole('button', { name: 'Merge' }));
      await click(view.getByRole('button', { name: 'Confirm merge?' }));
      expect(status(view)).toBe(region);
      expect(region.textContent).toBe('Merging...');
      announcedOnly(view);
      await answerHeld();
      await waitUntil(() => expect(region.textContent).toBe('Pull request merged'));
      expect(status(view)).toBe(region);
      announcedOnly(view);
    });

    it.each([
      ['Convert to draft', 'Converted to draft'],
      ['Enable auto-merge', 'Auto-merge enabled'],
    ])("announces the outcome of the menu's %s", async (name, outcome) => {
      writeAnswer = async () => respond({ data: {} });
      const view = await show(blocked);
      await openMenu(view);
      await click(row(view, name));
      if (name === 'Enable auto-merge') await click(row(view, 'Confirm auto-merge?'));
      await waitUntil(() => expect(status(view).textContent).toBe(outcome));
      announcedOnly(view);
    });

    it('gives the focus back to More actions at once after a menu action, and leaves it there', async () => {
      writeAnswer = () => hold(() => respond({ data: {} }));
      const view = await show();
      await openMenu(view);
      await click(row(view, 'Convert to draft'));
      expect(writes()).toHaveLength(1);
      // Not on the page's body, where a keyboard would start over from the top.
      expect(document.activeElement).toBe(moreActions(view));
      await answerHeld();
      await waitUntil(() => expect(isOff(moreActions(view))).toBe(false));
      expect(document.activeElement).toBe(moreActions(view));
    });

    it('keeps the focus on the primary control while its action runs', async () => {
      writeAnswer = () => hold(() => respond({ data: {} }));
      const view = await show({ ...open, draft: true });
      await waitUntil(() => expect(view.getByRole('button', { name: 'Ready for review' })));
      const ready = view.getByRole('button', { name: 'Ready for review' });
      ready.focus();
      await click(ready);
      expect(ready.textContent).toBe('Marking ready for review...');
      // A browser takes the focus from a control with `disabled`, so it is off by ARIA alone.
      expect(ready.hasAttribute('disabled')).toBe(false);
      expect(ready.getAttribute('aria-disabled')).toBe('true');
      expect(document.activeElement).toBe(ready);
      // A second press of it sends nothing more.
      await click(ready);
      expect(writes()).toHaveLength(1);
      await answerHeld();
      await waitUntil(() => expect(isOff(ready)).toBe(false));
      expect(document.activeElement).toBe(ready);
    });

    it('moves the focus to More actions when a merge takes the focused control away', async () => {
      writeAnswer = () => hold(() => respond({ merged: true }));
      const view = await show();
      await waitUntil(() => expect(view.getByRole('button', { name: 'Merge' })));
      const merge = view.getByRole('button', { name: 'Merge' });
      merge.focus();
      await click(merge);
      await click(view.getByRole('button', { name: 'Confirm merge?' }));
      expect(document.activeElement).toBe(merge);
      // The read after the merge shows it merged, which has no primary control.
      view.rerender(ui(merged));
      expect(view.queryByRole('button', { name: 'Merging...' })).toBeNull();
      await answerHeld();
      await waitUntil(() => expect(isOff(moreActions(view))).toBe(false));
      expect(document.activeElement).toBe(moreActions(view));
    });

    it('leaves the focus where the viewer put it meanwhile', async () => {
      writeAnswer = () => hold(() => respond({ data: {} }));
      const view = await show();
      await openMenu(view);
      await click(row(view, 'Convert to draft'));
      const elsewhere = document.createElement('button');
      document.body.append(elsewhere);
      elsewhere.focus();
      await answerHeld();
      await waitUntil(() => expect(isOff(moreActions(view))).toBe(false));
      expect(document.activeElement).toBe(elsewhere);
      elsewhere.remove();
    });
  });
});
