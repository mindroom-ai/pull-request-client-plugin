// A stand-in for the room's MindRoom server in tests: its GitHub routes as MindRoom serves them
// (`GET /api/github/status`, `POST /api/github/request`, `PUT` and `DELETE /api/github/token`),
// sending each GitHub request on to a test's own stand-in for GitHub, as the browser would send it.
import { MindroomServerError, type MindroomServer } from '@mindroom/client-sdk/server';
import { vi } from 'vitest';

type GitHub = (url: string, init?: RequestInit) => Promise<Response>;
type Payload = { method: string; path: string; body?: unknown; accept?: string };

// MindRoom's rule for the paths it sends to GitHub (`github_requests.py`, `_path_kind`): `/graphql`
// or under `/repos/<owner>/<repo>`, with an optional query, of RFC 3986 path characters, 4096 at
// most, and no segment that decodes to `.` or `..`, or to anything holding `/`, `\` or a control.
const PCHAR = "(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})";
const PATH = new RegExp(`^(/graphql|/repos(?:/${PCHAR}+){2,})(?:\\?(?:${PCHAR}|[/?])*)?$`);
// eslint-disable-next-line no-control-regex
const REFUSED = /[/\\\u0000-\u001f\u007f-\u009f]/;

/** Whether MindRoom sends a request for `path` on to GitHub. */
export function allowedPath(path: string): boolean {
  const match = path.length <= 4096 ? PATH.exec(path) : null;
  if (!match) return false;
  return match[1]!
    .split('/')
    .slice(1)
    .every((segment) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return false;
      }
      return decoded !== '.' && decoded !== '..' && !REFUSED.test(decoded);
    });
}

const PASSED = ['x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after', 'x-github-request-id'];

// MindRoom refuses a token that is empty, longer than 512, or holds a space or a control.
// eslint-disable-next-line no-control-regex
const MALFORMED = /^$|[\s\u0000-\u001f\u007f-\u009f]|^.{513}/s;

/**
 * A MindRoom server whose answer of `/api/github/status` is `status` (`{ connected: true, via:
 * 'app', login: 'octo' }` unless given), the person's GitHub App connection, and which sends each
 * GitHub request to `github`: a read as a GET without a method, a write with its method and its
 * body as JSON. `connected(false)` makes it answer as MindRoom does once the App connection is no
 * longer there: 409 `github_not_connected` while no token is saved either. A token saved with
 * `PUT /api/github/token` is checked with GitHub's `/user`, comes before the App, and goes with
 * each request as its `Authorization`.
 */
export function githubServer(
  github: GitHub,
  status: unknown = { connected: true, via: 'app', login: 'octo' },
  origin = 'https://mindroom.example.org'
) {
  let connected = true;
  let saved: { token: string; login: string } | undefined;
  const statusNow = () => {
    const app = connected ? status : { connected: false };
    if (!saved) return app;
    const withApp = (app as { connected?: unknown }).connected === true;
    return {
      connected: true,
      via: 'token',
      login: saved.login,
      ...(withApp && { app_connected: true }),
    };
  };
  const saveToken = async (init?: RequestInit) => {
    const { token } = JSON.parse(String(init?.body)) as { token?: unknown };
    if (typeof token !== 'string' || MALFORMED.test(token)) {
      // MindRoom names none of what it refused, as the token could be among it.
      throw new MindroomServerError('Unprocessable Entity', 422, {
        error: 'github_request_invalid',
      });
    }
    const unreachable = new MindroomServerError('Bad Gateway', 502, {
      error: 'github_unreachable',
    });
    const response = await github('https://api.github.com/user', {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
    }).catch(() => {
      throw unreachable;
    });
    if (response.status === 401 || response.status === 403) {
      throw new MindroomServerError('Bad Request', 400, { error: 'github_token_rejected' });
    }
    if (!response.ok) throw unreachable;
    const { login } = (await response.json()) as { login: string };
    saved = { token, login };
    return { connected: true, via: 'token', login };
  };
  const request = vi.fn(async (path: string, init?: RequestInit): Promise<unknown> => {
    if (path === '/api/github/status') return statusNow();
    if (path === '/api/github/token' && init?.method === 'PUT') return saveToken(init);
    if (path === '/api/github/token' && init?.method === 'DELETE') {
      saved = undefined;
      return statusNow();
    }
    if (path !== '/api/github/request') throw new MindroomServerError('Not Found', 404);
    if (!connected && !saved) {
      throw new MindroomServerError('Conflict', 409, { error: 'github_not_connected' });
    }
    const { method, path: githubPath, body, accept } = JSON.parse(String(init?.body)) as Payload;
    if (!allowedPath(githubPath)) {
      throw new MindroomServerError('Bad Request', 400, { error: 'github_path_not_allowed' });
    }
    const headers: Record<string, string> = { Accept: accept ?? 'application/vnd.github+json' };
    if (saved) headers.Authorization = `Bearer ${saved.token}`;
    const response = await github(
      `https://api.github.com${githubPath}`,
      method === 'GET' ? { headers } : { method, headers, body: JSON.stringify(body) }
    );
    const text = await response.text();
    let answer: unknown = text === '' ? null : text;
    try {
      answer = text === '' ? null : JSON.parse(text);
    } catch {
      // GitHub's text, such as a diff, stays text.
    }
    const passed: Record<string, string> = {};
    for (const name of PASSED) {
      const value = response.headers.get(name);
      if (value !== null) passed[name] = value;
    }
    return { status: response.status, body: answer, headers: passed };
  });
  const server = { origin, request } as unknown as MindroomServer & { request: typeof request };
  return {
    server,
    /** The GitHub requests the server was asked to send. */
    githubRequests: () =>
      request.mock.calls
        .filter(([path]) => path === '/api/github/request')
        .map(([, init]) => JSON.parse(String(init?.body)) as Payload),
    /** The times it was asked for the status. */
    statusRequests: () =>
      request.mock.calls.filter(([path]) => path === '/api/github/status').length,
    /** The methods of the requests for the saved token, in order. */
    tokenRequests: () =>
      request.mock.calls
        .filter(([path]) => path === '/api/github/token')
        .map(([, init]) => init?.method),
    /** The token saved in it now, if any. */
    storedToken: () => saved?.token,
    connected: (value: boolean) => {
      connected = value;
    },
  };
}
