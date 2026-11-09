// GitHub's REST API for one pull request and its files, the only network this plugin uses.
// It must stay free of the diff libraries: this module loads with the plugin's entry, and
// those load only with the side panel.

export type PullRequestRef = { owner: string; repo: string; number: number };

export type PullRequest = {
  title: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  body: string;
  author: { login: string; avatarUrl: string | null; url: string | null } | null;
  createdAt: string;
  updatedAt: string;
  baseRef: string;
  headRef: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  url: string;
};

export type PullRequestFile = {
  path: string;
  previousPath: string | null;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  patch: string | null;
  url: string;
};

const API = 'https://api.github.com';
const PAGE_SIZE = 100;
const MAX_PAGES = 30;
const OWNER = /^[A-Za-z0-9-]{1,39}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const NUMBER = /^[1-9][0-9]*$/;

/** The pull request a github.com link points at, or undefined for any other link. */
export function parsePullRequestUrl(url: URL): PullRequestRef | undefined {
  if (url.protocol !== 'https:') return undefined;
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return undefined;
  const [, owner, repo, kind, number] = url.pathname.split('/');
  if (owner === undefined || repo === undefined || number === undefined) return undefined;
  if (kind !== 'pull' || !OWNER.test(owner) || !REPO.test(repo) || !NUMBER.test(number)) {
    return undefined;
  }
  const value = Number(number);
  return Number.isSafeInteger(value) ? { owner, repo, number: value } : undefined;
}

export function pullRequestUrl(ref: PullRequestRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}

export type GitHubErrorKind = 'notFound' | 'rateLimited' | 'badToken' | 'failed';

export class GitHubError extends Error {
  constructor(readonly kind: GitHubErrorKind, readonly status: number) {
    super(`GitHub request failed: ${kind} (${status})`);
    this.name = 'GitHubError';
  }
}

function errorKind(response: Response, hasToken: boolean): GitHubErrorKind {
  const { status } = response;
  if (status === 404 || (status === 401 && !hasToken)) return 'notFound';
  if (status === 401) return 'badToken';
  if (status === 429) return 'rateLimited';
  if (status === 403 && response.headers.get('x-ratelimit-remaining') === '0') return 'rateLimited';
  return 'failed';
}

async function getJson(
  path: string,
  token: string | undefined,
  signal: AbortSignal | undefined
): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { headers, signal });
  } catch (error) {
    // An aborted request is the caller's own doing, not a failure of GitHub.
    if (signal?.aborted) throw error;
    throw new GitHubError('failed', 0);
  }
  if (!response.ok) throw new GitHubError(errorKind(response, Boolean(token)), response.status);
  try {
    return await response.json();
  } catch {
    throw new GitHubError('failed', response.status);
  }
}

type Json = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function count(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function record(value: unknown): Json | null {
  return typeof value === 'object' && value !== null ? (value as Json) : null;
}

export async function fetchPullRequest(
  ref: PullRequestRef,
  token: string | undefined,
  signal?: AbortSignal
): Promise<PullRequest> {
  const raw = record(
    await getJson(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, token, signal)
  );
  if (!raw) throw new GitHubError('failed', 200);
  const user = record(raw.user);
  const merged = typeof raw.merged_at === 'string' && raw.merged_at !== '';
  return {
    title: text(raw.title),
    state: merged ? 'merged' : raw.state === 'closed' ? 'closed' : 'open',
    draft: raw.draft === true,
    body: text(raw.body),
    author: user
      ? {
          login: text(user.login),
          avatarUrl: textOrNull(user.avatar_url),
          url: textOrNull(user.html_url),
        }
      : null,
    createdAt: text(raw.created_at),
    updatedAt: text(raw.updated_at),
    baseRef: text(record(raw.base)?.ref),
    headRef: text(record(raw.head)?.ref),
    additions: count(raw.additions),
    deletions: count(raw.deletions),
    changedFiles: count(raw.changed_files),
    url: text(raw.html_url) || pullRequestUrl(ref),
  };
}

const FILE_STATUSES: ReadonlySet<string> = new Set([
  'added',
  'removed',
  'modified',
  'renamed',
  'copied',
  'changed',
  'unchanged',
]);

export async function fetchPullRequestFiles(
  ref: PullRequestRef,
  token: string | undefined,
  signal?: AbortSignal
): Promise<PullRequestFile[]> {
  const url = `${pullRequestUrl(ref)}/files`;
  const files: PullRequestFile[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const raw = await getJson(
      `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files?per_page=${PAGE_SIZE}&page=${page}`,
      token,
      signal
    );
    if (!Array.isArray(raw)) throw new GitHubError('failed', 200);
    for (const item of raw as unknown[]) {
      const entry = record(item);
      if (!entry) continue;
      const status = text(entry.status);
      files.push({
        path: text(entry.filename),
        previousPath: textOrNull(entry.previous_filename),
        status: FILE_STATUSES.has(status) ? (status as PullRequestFile['status']) : 'changed',
        additions: count(entry.additions),
        deletions: count(entry.deletions),
        patch: textOrNull(entry.patch),
        url,
      });
    }
    if (raw.length < PAGE_SIZE) break;
  }
  return files;
}

/**
 * One file as a git patch, which the diff view parses; null when GitHub sent no patch, except for
 * a pure rename, which becomes a header-only rename. GitHub gives no similarity, so the 99% of a
 * rename with changes only makes the parser type it as changed; a pure rename says 100%.
 */
export function filePatch(file: PullRequestFile): string | null {
  const from = file.previousPath ?? file.path;
  const diff = `diff --git a/${from} b/${file.path}\n`;
  const rename = (similarity: number) =>
    `similarity index ${similarity}%\nrename from ${from}\nrename to ${file.path}\n`;
  if (file.patch === null) {
    const pure = file.status === 'renamed' && file.additions === 0 && file.deletions === 0;
    return pure ? `${diff}${rename(100)}` : null;
  }
  let head = diff;
  if (file.status === 'added') head += 'new file mode 100644\n';
  else if (file.status === 'removed') head += 'deleted file mode 100644\n';
  else if (file.status === 'renamed') head += rename(99);
  head += file.status === 'added' ? '--- /dev/null\n' : `--- a/${from}\n`;
  head += file.status === 'removed' ? '+++ /dev/null\n' : `+++ b/${file.path}\n`;
  return `${head}${file.patch}\n`;
}
