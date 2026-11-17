import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubError } from './github';
import { refreshPullRequest } from './queries';

const REF = { owner: 'o', repo: 'r', number: 7 };
const PULL = ['pull-requests', 'pr', 'o', 'r', 7] as const;

let client: QueryClient;
const unsubscribes: (() => void)[] = [];
/** A query of the pull request under `access` that is on screen, answering `answer()`. */
const shown = (access: boolean | string, answer: () => Promise<unknown>) => {
  const observer = new QueryObserver(client, {
    queryKey: [...PULL, access],
    queryFn: answer,
    retry: false,
  });
  unsubscribes.push(observer.subscribe(() => {}));
};
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  unsubscribes.splice(0).forEach((unsubscribe) => unsubscribe());
  client.clear();
});

describe('refreshPullRequest', () => {
  it('settles on the read with the access the write used, not on another room shown without', async () => {
    client = new QueryClient();
    let reads = 0;
    shown('server:https://m.example.org:octo', async () => ({ title: `read ${++reads}` }));
    // A room without the server shows the private pull request as not found.
    shown(false, () => Promise.reject(new GitHubError('notFound', 404)));
    await settled();
    await expect(
      refreshPullRequest(client, REF, 'server:https://m.example.org:octo')
    ).resolves.toBe(true);
    expect(reads).toBe(2);
  });

  it('says the read failed when the read with the access the write used fails', async () => {
    client = new QueryClient();
    let fail = false;
    shown(true, () =>
      fail ? Promise.reject(new GitHubError('notFound', 404)) : Promise.resolve({ title: 'T' })
    );
    await settled();
    fail = true;
    await expect(refreshPullRequest(client, REF, true)).resolves.toBe(false);
  });
});
