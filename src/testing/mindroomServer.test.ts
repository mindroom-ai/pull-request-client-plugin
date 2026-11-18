import { MindroomServerError, type MindroomServer } from '@mindroom/client-sdk/server';
import { describe, expect, it, vi } from 'vitest';
import { allowedPath, githubServer } from './mindroomServer';

describe('allowedPath', () => {
  it.each([
    '/graphql',
    '/repos/o/r',
    '/repos/o/r/pulls/1/files?per_page=100&page=2',
    '/repos/o/r/compare/release/1.0...abc123',
    '/repos/o/r/commits/a%3Fb',
  ])('takes %s', (path) => {
    expect(allowedPath(path)).toBe(true);
  });

  it.each([
    '/repos/o',
    '/user',
    '/graphql/x',
    '/repos/o/r//pulls',
    '/repos/o/r/../x',
    '/repos/o/r/%2e%2e/x',
    '/repos/o/r/compare/release%2F1.0...abc',
    '/repos/o/r/a%5Cb',
    '/repos/o/r/a%0Ab',
    '/repos/o/r/a b',
    `/repos/o/r/${'a'.repeat(4096)}`,
  ])('refuses %s', (path) => {
    expect(allowedPath(path)).toBe(false);
  });
});

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const put = (token: string) => ({
  method: 'PUT',
  body: JSON.stringify({ token }),
  headers: { 'Content-Type': 'application/json' },
});
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: MindroomServerError) => ({ status: error.status, body: error.body })
  );

describe('githubServer, a token saved in MindRoom', () => {
  // GitHub knows `ghp_good` as `pat-login`, refuses `ghp_bad`, and is down for `ghp_down`.
  const github = vi.fn(async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization');
    if (url === 'https://api.github.com/user') {
      if (auth === 'Bearer ghp_good') return respond({ login: 'pat-login' });
      if (auth === 'Bearer ghp_down') return respond({}, 503);
      return respond({ message: 'Bad credentials' }, 401);
    }
    return respond({ auth });
  });
  const read = { method: 'GET', path: '/repos/o/r' };
  const ask = (server: MindroomServer, payload: unknown) =>
    server.request('/api/github/request', { method: 'POST', body: JSON.stringify(payload) });

  it('names the GitHub App connection in its status', async () => {
    const { server } = githubServer(github);
    expect(await server.request('/api/github/status')).toEqual({
      connected: true,
      via: 'app',
      login: 'octo',
    });
  });

  it('saves a token GitHub takes, which comes before the App, and says so', async () => {
    const { server, storedToken } = githubServer(github);
    expect(await server.request('/api/github/token', put('ghp_good'))).toEqual({
      connected: true,
      via: 'token',
      login: 'pat-login',
    });
    expect(storedToken()).toBe('ghp_good');
    expect(await server.request('/api/github/status')).toEqual({
      connected: true,
      via: 'token',
      login: 'pat-login',
      app_connected: true,
    });
    expect(await ask(server, read)).toMatchObject({ body: { auth: 'Bearer ghp_good' } });
  });

  it('goes with the token alone once the App is gone, and without either answers 409', async () => {
    const mindroom = githubServer(github);
    mindroom.connected(false);
    expect(await failure(ask(mindroom.server, read))).toEqual({
      status: 409,
      body: { error: 'github_not_connected' },
    });
    await mindroom.server.request('/api/github/token', put('ghp_good'));
    expect(await mindroom.server.request('/api/github/status')).toEqual({
      connected: true,
      via: 'token',
      login: 'pat-login',
    });
    expect(await ask(mindroom.server, read)).toMatchObject({ body: { auth: 'Bearer ghp_good' } });
  });

  it('refuses a token GitHub refuses, one it cannot check, and one of the wrong form', async () => {
    const { server, storedToken } = githubServer(github);
    expect(await failure(server.request('/api/github/token', put('ghp_bad')))).toEqual({
      status: 400,
      body: { error: 'github_token_rejected' },
    });
    expect(await failure(server.request('/api/github/token', put('ghp_down')))).toEqual({
      status: 502,
      body: { error: 'github_unreachable' },
    });
    for (const token of ['', 'ghp a', 'ghp\u0000a', 'a'.repeat(513)]) {
      // As MindRoom answers any body it refuses: one code, nothing of what was sent.
      expect(await failure(server.request('/api/github/token', put(token)))).toEqual({
        status: 422,
        body: { error: 'github_request_invalid' },
      });
    }
    expect(storedToken()).toBeUndefined();
  });

  it('removes the token, again and again, answering the status after', async () => {
    const mindroom = githubServer(github);
    await mindroom.server.request('/api/github/token', put('ghp_good'));
    const remove = { method: 'DELETE' };
    expect(await mindroom.server.request('/api/github/token', remove)).toEqual({
      connected: true,
      via: 'app',
      login: 'octo',
    });
    mindroom.connected(false);
    expect(await mindroom.server.request('/api/github/token', remove)).toEqual({
      connected: false,
    });
    expect(mindroom.storedToken()).toBeUndefined();
    expect(mindroom.tokenRequests()).toEqual(['PUT', 'DELETE', 'DELETE']);
  });
});
