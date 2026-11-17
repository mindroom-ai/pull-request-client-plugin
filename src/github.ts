// GitHub's REST API for one pull request and its files, and the writes that change its state, the
// only network this plugin uses.
// It must stay free of the diff libraries: this module loads with the plugin's entry, and
// those load only with the side panel.
import { imageSources, type ImageSources } from './images';

export type PullRequestRef = { owner: string; repo: string; number: number };

export type Actor = {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  url: string | null;
  isBot: boolean;
};

export type PullRequest = {
  title: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  body: string;
  /** Where the description's images load from, out of GitHub's HTML of it. */
  images: ImageSources;
  author: Actor | null;
  labels: { name: string; color: string }[];
  requestedReviewers: Actor[];
  requestedTeams: string[];
  /** The GraphQL id, which the writes GitHub offers only there take. */
  nodeId: string;
  /** Null while GitHub has not computed it yet. */
  mergeable: boolean | null;
  mergeableState: string | null;
  autoMerge: { method: 'merge' | 'squash' | 'rebase' } | null;
  headSha: string;
  headRepo: string | null;
  /** The head repository's GraphQL id, which reading and deleting its branch take; '' without one. */
  headRepoId: string;
  baseRepo: string;
  mergedAt: string | null;
  closedAt: string | null;
  commentCount: number;
  reviewCommentCount: number;
  commitCount: number;
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
  /** The SHA of the file's blob, which changes with its content, patch or not. */
  sha: string | null;
  url: string;
};

const API = 'https://api.github.com';
const PAGE_SIZE = 100;
const MAX_PAGES = 30;
const LIST_PAGES = 10;
const OWNER = /^[A-Za-z0-9-]{1,39}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const NUMBER = /^[1-9][0-9]*$/;
const JSON_MEDIA = 'application/vnd.github+json';
// The same JSON with each body also as GitHub's HTML (`body_html`), whose images have addresses
// that load: a private repository's attachments are signed there.
const FULL_MEDIA = 'application/vnd.github.full+json';

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

type RateLimit = { token: string | undefined; status: number; resetsAt: number };

// The rate limit GitHub last answered, for requests with a token and for those without (which it
// counts against the address), while it lasts. Until it resets, a request gets the same answer
// from here without asking, so the chips of a busy room do not keep spending what the panel needs.
// A request with another token than the one limited starts afresh: a new token is a new budget.
const rateLimits = new Map<boolean, RateLimit>();

/** When GitHub's rate limit resets, in milliseconds since the epoch; in a minute when it says not. */
function resetTime(response: Response): number {
  const header = response.headers.get('x-ratelimit-reset');
  const seconds = header ? Number(header) : NaN;
  return Number.isFinite(seconds) ? seconds * 1000 : Date.now() + 60_000;
}

async function getJson(
  path: string,
  token: string | undefined,
  signal: AbortSignal | undefined,
  accept: string = JSON_MEDIA
): Promise<unknown> {
  const withToken = Boolean(token);
  const limit = rateLimits.get(withToken);
  if (limit && limit.token === token && Date.now() < limit.resetsAt) {
    throw new GitHubError('rateLimited', limit.status);
  }
  rateLimits.delete(withToken);
  const headers: Record<string, string> = {
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response: Response;
  try {
    // GitHub allows a minute of caching, so without this a read just after a write could show
    // the state from before it. The browser revalidates by ETag, and a 304 costs no rate limit.
    response = await fetch(`${API}${path}`, { headers, signal, cache: 'no-cache' });
  } catch (error) {
    // An aborted request is the caller's own doing, not a failure of GitHub.
    if (signal?.aborted) throw error;
    throw new GitHubError('failed', 0);
  }
  if (!response.ok) {
    const kind = errorKind(response, withToken);
    if (kind === 'rateLimited') {
      rateLimits.set(withToken, { token, status: response.status, resetsAt: resetTime(response) });
    }
    throw new GitHubError(kind, response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new GitHubError('failed', response.status);
  }
}

// `branchMoved` is this module's own refusal: the branch to delete got commits since its pull
// request, so it is left alone.
export type GitHubWriteErrorKind = 'noAccess' | 'refused' | 'badToken' | 'branchMoved' | 'failed';

/** A write GitHub refused or did not take, with GitHub's own reason in `detail` when it gave one. */
export class GitHubWriteError extends Error {
  constructor(
    readonly kind: GitHubWriteErrorKind,
    readonly status: number,
    readonly detail: string | null = null
  ) {
    super(`GitHub write failed: ${kind} (${status})`);
    this.name = 'GitHubWriteError';
  }
}

function writeErrorKind(status: number): GitHubWriteErrorKind {
  if (status === 401) return 'badToken';
  // A token without write access to the repository gets these, not a 401.
  if (status === 403 || status === 404) return 'noAccess';
  if (status === 405 || status === 409 || status === 422) return 'refused';
  return 'failed';
}

// GitHub's reasons do not echo the token, but a detail is shown, so one that did is dropped.
function reason(value: unknown, token: string): string | null {
  return typeof value === 'string' && !value.includes(token) ? value : null;
}

/**
 * A write to GitHub's REST API, with GitHub's answer when it sent one. Writes do not go through
 * the read rate limit: a refusal is GitHub's answer to this write, and the reads keep their own.
 */
async function sendRest(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  token: string,
  signal?: AbortSignal
): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: JSON_MEDIA,
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${token}`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new GitHubWriteError('failed', 0);
  }
  // A DELETE answers 204 without a body, and a write's success does not depend on its body.
  const answer: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new GitHubWriteError(
      writeErrorKind(response.status),
      response.status,
      reason(record(answer)?.message, token)
    );
  }
  return answer;
}

/**
 * A GraphQL request, for what GitHub offers only there. GraphQL answers a refusal with 200 and
 * an `errors` array, so that is a refusal here too, not a success.
 */
async function graphql(
  query: string,
  variables: Json,
  token: string,
  signal?: AbortSignal
): Promise<Json | null> {
  const answer = record(await sendRest('POST', '/graphql', { query, variables }, token, signal));
  if (!answer) throw new GitHubWriteError('failed', 200);
  const [error] = list(answer.errors);
  if (error) {
    const kind = error.type === 'FORBIDDEN' || error.type === 'NOT_FOUND' ? 'noAccess' : 'refused';
    throw new GitHubWriteError(kind, 200, reason(error.message, token));
  }
  return record(answer.data);
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

function actor(user: Json | null): Actor | null {
  if (!user) return null;
  const login = text(user.login);
  return {
    login,
    name: null,
    avatarUrl: textOrNull(user.avatar_url),
    url: textOrNull(user.html_url),
    isBot: user.type === 'Bot' || login.endsWith('[bot]'),
  };
}

// A requested reviewer that GitHub sent without a login still shows, as an empty one.
function actorOf(user: Json): Actor {
  return actor(user) as Actor;
}

function list(value: unknown): Json[] {
  const items: unknown[] = Array.isArray(value) ? value : [];
  return items.flatMap((item) => {
    const entry = record(item);
    return entry ? [entry] : [];
  });
}

function autoMerge(method: unknown): PullRequest['autoMerge'] {
  return method === 'merge' || method === 'squash' || method === 'rebase' ? { method } : null;
}

export async function fetchPullRequest(
  ref: PullRequestRef,
  token: string | undefined,
  signal?: AbortSignal
): Promise<PullRequest> {
  const raw = record(
    await getJson(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, token, signal, FULL_MEDIA)
  );
  if (!raw) throw new GitHubError('failed', 200);
  const user = record(raw.user);
  const base = record(raw.base);
  const head = record(raw.head);
  const merged = typeof raw.merged_at === 'string' && raw.merged_at !== '';
  return {
    title: text(raw.title),
    state: merged ? 'merged' : raw.state === 'closed' ? 'closed' : 'open',
    draft: raw.draft === true,
    body: text(raw.body),
    images: imageSources(raw.body_html),
    author: actor(user),
    labels: list(raw.labels).flatMap((label) =>
      typeof label.name === 'string' ? [{ name: label.name, color: text(label.color) }] : []
    ),
    requestedReviewers: list(raw.requested_reviewers).map(actorOf),
    requestedTeams: list(raw.requested_teams).map((team) => text(team.name)),
    nodeId: text(raw.node_id),
    mergeable: typeof raw.mergeable === 'boolean' ? raw.mergeable : null,
    mergeableState: textOrNull(raw.mergeable_state),
    autoMerge: autoMerge(record(raw.auto_merge)?.merge_method),
    headSha: text(head?.sha),
    headRepo: textOrNull(record(head?.repo)?.full_name),
    headRepoId: text(record(head?.repo)?.node_id),
    baseRepo: text(record(base?.repo)?.full_name) || `${ref.owner}/${ref.repo}`,
    mergedAt: textOrNull(raw.merged_at),
    closedAt: textOrNull(raw.closed_at),
    commentCount: count(raw.comments),
    reviewCommentCount: count(raw.review_comments),
    commitCount: count(raw.commits),
    createdAt: text(raw.created_at),
    updatedAt: text(raw.updated_at),
    baseRef: text(base?.ref),
    headRef: text(head?.ref),
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

function mapFiles(raw: unknown, url: string): PullRequestFile[] {
  return list(raw).map((entry) => {
    const status = text(entry.status);
    return {
      path: text(entry.filename),
      previousPath: textOrNull(entry.previous_filename),
      status: FILE_STATUSES.has(status) ? (status as PullRequestFile['status']) : 'changed',
      additions: count(entry.additions),
      deletions: count(entry.deletions),
      patch: textOrNull(entry.patch),
      sha: textOrNull(entry.sha),
      url,
    };
  });
}

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
    files.push(...mapFiles(raw, url));
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

const repoPath = (ref: PullRequestRef) => `/repos/${ref.owner}/${ref.repo}`;

export type Paged<T> = { items: T[]; truncated: boolean };

/**
 * A list read page by page (100 at most per page, 10 pages at most), mapped item by item; with
 * `accept`, in another of GitHub's media types.
 */
async function fetchPaged<T>(
  path: string,
  token: string | undefined,
  signal: AbortSignal | undefined,
  map: (item: Json) => T | null,
  accept?: string
): Promise<Paged<T>> {
  const items: T[] = [];
  for (let page = 1; page <= LIST_PAGES; page += 1) {
    const raw = await getJson(`${path}?per_page=${PAGE_SIZE}&page=${page}`, token, signal, accept);
    if (!Array.isArray(raw)) throw new GitHubError('failed', 200);
    for (const item of list(raw)) {
      const mapped = map(item);
      if (mapped !== null) items.push(mapped);
    }
    if (raw.length < PAGE_SIZE) return { items, truncated: false };
  }
  return { items, truncated: true };
}

export type CheckStatus =
  | 'pending'
  | 'action-required'
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped'
  | 'neutral';

export type PullRequestCheck = {
  name: string;
  status: CheckStatus;
  description: string | null;
  url: string | null;
  updatedAt: string | null;
};

const CONCLUSIONS: Record<string, CheckStatus> = {
  action_required: 'action-required',
  success: 'success',
  failure: 'failure',
  timed_out: 'failure',
  startup_failure: 'failure',
  cancelled: 'cancelled',
  skipped: 'skipped',
  neutral: 'neutral',
  stale: 'neutral',
};

const STATE_STATUSES: Record<string, CheckStatus> = {
  pending: 'pending',
  success: 'success',
  failure: 'failure',
  error: 'failure',
};

/**
 * A link a check's integration set, kept only when it is a web address: any other scheme, such as
 * `javascript:`, must not reach a link's href.
 */
function webUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function checkRun(run: Json): PullRequestCheck {
  const output = record(run.output);
  return {
    name: text(run.name),
    // A run that is not completed (queued, in_progress, waiting, requested, pending) is pending.
    status: run.status === 'completed' ? CONCLUSIONS[text(run.conclusion)] ?? 'neutral' : 'pending',
    description: textOrNull(output?.title) || null,
    url: webUrl(run.html_url) ?? webUrl(run.details_url),
    updatedAt: textOrNull(run.completed_at) ?? textOrNull(run.started_at),
  };
}

function commitStatus(entry: Json): PullRequestCheck {
  return {
    name: text(entry.context),
    status: STATE_STATUSES[text(entry.state)] ?? 'neutral',
    description: textOrNull(entry.description) || null,
    url: webUrl(entry.target_url),
    updatedAt: textOrNull(entry.updated_at),
  };
}

// A 404 for the checks of a commit means GitHub has none to show, not that the request failed.
async function getOrNothing(
  path: string,
  token: string | undefined,
  signal: AbortSignal | undefined
): Promise<Json> {
  try {
    return record(await getJson(path, token, signal)) ?? {};
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return {};
    throw error;
  }
}

/** The checks of one of the two lists, and whether GitHub has more of them than it sent. */
function checksOf(
  answer: PromiseSettledResult<Json>,
  key: 'check_runs' | 'statuses',
  map: (item: Json) => PullRequestCheck
): Paged<PullRequestCheck> {
  if (answer.status === 'rejected') return { items: [], truncated: false };
  const items = list(answer.value[key]).map(map);
  const total = answer.value.total_count;
  return { items, truncated: typeof total === 'number' && total > items.length };
}

/**
 * The check runs and commit statuses of a commit as one list; of two with a name, the newer.
 * Each list is asked for on its own, so one that fails leaves the other's checks; only when both
 * fail is the answer an error. Each comes as one page of 100, and the list is cut short when
 * GitHub counts more.
 */
export async function fetchChecks(
  ref: PullRequestRef,
  headSha: string,
  token: string | undefined,
  signal?: AbortSignal
): Promise<Paged<PullRequestCheck>> {
  const base = `${repoPath(ref)}/commits/${encodeURIComponent(headSha)}`;
  const [runs, statuses] = await Promise.allSettled([
    getOrNothing(`${base}/check-runs?per_page=${PAGE_SIZE}`, token, signal),
    getOrNothing(`${base}/status?per_page=${PAGE_SIZE}`, token, signal),
  ]);
  if (runs.status === 'rejected' && statuses.status === 'rejected') throw runs.reason;
  const parts = [
    checksOf(runs, 'check_runs', checkRun),
    checksOf(statuses, 'statuses', commitStatus),
  ];
  const byName = new Map<string, PullRequestCheck>();
  for (const check of parts.flatMap((part) => part.items)) {
    const kept = byName.get(check.name);
    // ISO timestamps in one format order as text; a check without one is the older.
    if (!kept || (check.updatedAt ?? '') > (kept.updatedAt ?? '')) byName.set(check.name, check);
  }
  return { items: [...byName.values()], truncated: parts.some((part) => part.truncated) };
}

/** How many commits the pull request's base branch has that its head lacks. */
export async function fetchBehindBy(
  ref: PullRequestRef,
  baseRef: string,
  headSha: string,
  token: string | undefined,
  signal?: AbortSignal
): Promise<number> {
  const raw = record(
    await getJson(
      `${repoPath(ref)}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(headSha)}`,
      token,
      signal
    )
  );
  if (!raw) throw new GitHubError('failed', 200);
  return count(raw.behind_by);
}

export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';

export type Review = {
  id: number;
  state: ReviewState;
  author: Actor | null;
  body: string;
  /** Where the body's images load from, out of GitHub's HTML of it. */
  images: ImageSources;
  commitId: string;
  submittedAt: string;
  url: string;
};

const REVIEW_STATES: ReadonlySet<string> = new Set([
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
]);

export function fetchReviews(
  ref: PullRequestRef,
  token: string | undefined,
  signal?: AbortSignal
): Promise<Paged<Review>> {
  return fetchPaged(
    `${repoPath(ref)}/pulls/${ref.number}/reviews`,
    token,
    signal,
    (item) => {
      const state = text(item.state);
      // A pending review is the viewer's own draft, not yet part of the conversation.
      if (!REVIEW_STATES.has(state)) return null;
      return {
        id: count(item.id),
        state: state as ReviewState,
        author: actor(record(item.user)),
        body: text(item.body),
        images: imageSources(item.body_html),
        commitId: text(item.commit_id),
        submittedAt: text(item.submitted_at),
        url: text(item.html_url),
      };
    },
    FULL_MEDIA
  );
}

export type ReactionContent =
  | '+1'
  | '-1'
  | 'laugh'
  | 'hooray'
  | 'confused'
  | 'heart'
  | 'rocket'
  | 'eyes';

export type Reaction = { content: ReactionContent; count: number };

const REACTIONS: readonly ReactionContent[] = [
  '+1',
  '-1',
  'laugh',
  'hooray',
  'confused',
  'heart',
  'rocket',
  'eyes',
];

export type Comment = {
  id: number;
  author: Actor | null;
  body: string;
  /** Where the body's images load from, out of GitHub's HTML of it. */
  images: ImageSources;
  createdAt: string;
  url: string;
  reactions: Reaction[];
};

function comment(item: Json): Comment {
  const summary = record(item.reactions);
  return {
    id: count(item.id),
    author: actor(record(item.user)),
    body: text(item.body),
    images: imageSources(item.body_html),
    createdAt: text(item.created_at),
    url: text(item.html_url),
    reactions: REACTIONS.map((content) => ({ content, count: count(summary?.[content]) })).filter(
      (reaction) => reaction.count > 0
    ),
  };
}

export function fetchConversationComments(
  ref: PullRequestRef,
  token: string | undefined,
  signal?: AbortSignal
): Promise<Paged<Comment>> {
  return fetchPaged(
    `${repoPath(ref)}/issues/${ref.number}/comments`,
    token,
    signal,
    comment,
    FULL_MEDIA
  );
}

export type ReviewComment = Comment & {
  path: string;
  line: number | null;
  originalLine: number | null;
  side: 'LEFT' | 'RIGHT';
  inReplyToId: number | null;
  reviewId: number | null;
  outdated: boolean;
  commitId: string;
};

const numberOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null);

export function fetchReviewComments(
  ref: PullRequestRef,
  token: string | undefined,
  signal?: AbortSignal
): Promise<Paged<ReviewComment>> {
  return fetchPaged(
    `${repoPath(ref)}/pulls/${ref.number}/comments`,
    token,
    signal,
    (item) => ({
      ...comment(item),
      path: text(item.path),
      line: numberOrNull(item.line),
      originalLine: numberOrNull(item.original_line),
      side: item.side === 'LEFT' ? 'LEFT' : 'RIGHT',
      inReplyToId: numberOrNull(item.in_reply_to_id),
      reviewId: numberOrNull(item.pull_request_review_id),
      // GitHub clears `position` once the comment's lines are no longer in the diff.
      outdated: item.position === null || item.position === undefined,
      commitId: text(item.commit_id),
    }),
    FULL_MEDIA
  );
}

export type Commit = {
  sha: string;
  headline: string;
  author: Actor | null;
  authorName: string;
  committedAt: string;
  url: string;
};

export function fetchCommits(
  ref: PullRequestRef,
  token: string | undefined,
  signal?: AbortSignal
): Promise<Paged<Commit>> {
  return fetchPaged(`${repoPath(ref)}/pulls/${ref.number}/commits`, token, signal, (item) => {
    const commit = record(item.commit);
    return {
      sha: text(item.sha),
      headline: text(commit?.message).split('\n')[0] ?? '',
      author: actor(record(item.author)),
      authorName: text(record(commit?.author)?.name),
      committedAt: text(record(commit?.committer)?.date),
      url: text(item.html_url),
    };
  });
}

/** The files one commit changed, shaped like the pull request's. */
export async function fetchCommitFiles(
  ref: PullRequestRef,
  sha: string,
  token: string | undefined,
  signal?: AbortSignal
): Promise<PullRequestFile[]> {
  const raw = record(
    await getJson(`${repoPath(ref)}/commits/${encodeURIComponent(sha)}`, token, signal)
  );
  if (!raw) throw new GitHubError('failed', 200);
  return mapFiles(raw.files, `https://github.com/${ref.owner}/${ref.repo}/commit/${sha}`);
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export type Repository = {
  /** Whether the viewer may merge, close and change the repository's pull requests. */
  canWrite: boolean;
  /** The methods the repository allows, in GitHub's order. */
  mergeMethods: MergeMethod[];
  autoMergeAllowed: boolean;
  defaultBranch: string;
};

const REPOSITORY_QUERY = `query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    viewerPermission
    mergeCommitAllowed
    squashMergeAllowed
    rebaseMergeAllowed
    autoMergeAllowed
    defaultBranchRef { name }
  }
}`;

const WRITE_PERMISSIONS: ReadonlySet<unknown> = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

/** What the viewer may do in a repository, and how it merges; only GraphQL tells both at once. */
export async function fetchRepository(
  owner: string,
  repo: string,
  token: string,
  signal?: AbortSignal
): Promise<Repository> {
  const data = await graphql(REPOSITORY_QUERY, { owner, repo }, token, signal);
  const raw = record(data?.repository);
  if (!raw) throw new GitHubWriteError('failed', 200);
  const allowed: [MergeMethod, unknown][] = [
    ['merge', raw.mergeCommitAllowed],
    ['squash', raw.squashMergeAllowed],
    ['rebase', raw.rebaseMergeAllowed],
  ];
  return {
    canWrite: WRITE_PERMISSIONS.has(raw.viewerPermission),
    mergeMethods: allowed.flatMap(([method, on]) => (on === true ? [method] : [])),
    autoMergeAllowed: raw.autoMergeAllowed === true,
    defaultBranch: text(record(raw.defaultBranchRef)?.name),
  };
}

export type PullRequestAction =
  | 'merge'
  | 'enable-auto-merge'
  | 'disable-auto-merge'
  | 'ready'
  | 'draft'
  | 'close'
  | 'reopen'
  | 'update-branch'
  | 'update-branch-rebase'
  | 'delete-branch';

// The mutations that take only the pull request.
const ON_PULL_REQUEST = (mutation: string) =>
  `mutation($pullRequestId: ID!) {
  ${mutation}(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}`;

const ENABLE_AUTO_MERGE = `mutation(
  $pullRequestId: ID!
  $mergeMethod: PullRequestMergeMethod!
  $expectedHeadOid: GitObjectID!
) {
  enablePullRequestAutoMerge(
    input: {
      pullRequestId: $pullRequestId
      mergeMethod: $mergeMethod
      expectedHeadOid: $expectedHeadOid
    }
  ) { clientMutationId }
}`;

const UPDATE_BRANCH = `mutation(
  $pullRequestId: ID!
  $expectedHeadOid: GitObjectID!
  $updateMethod: PullRequestBranchUpdateMethod!
) {
  updatePullRequestBranch(
    input: {
      pullRequestId: $pullRequestId
      expectedHeadOid: $expectedHeadOid
      updateMethod: $updateMethod
    }
  ) { clientMutationId }
}`;

const HEAD_BRANCH_QUERY = `query($repositoryId: ID!, $ref: String!) {
  node(id: $repositoryId) {
    ... on Repository {
      ref(qualifiedName: $ref) { target { oid } }
    }
  }
}`;

const headBranchRef = (pr: PullRequest) => `refs/heads/${pr.headRef}`;

/**
 * The commit the pull request's branch points at now, in its own repository, or null when the
 * branch is gone: what T3 Code reads before it deletes a branch. A name alone does not tell the
 * pull request's branch from one pushed to since, or made anew under its name.
 */
export async function fetchHeadBranchSha(
  pr: PullRequest,
  token: string,
  signal?: AbortSignal
): Promise<string | null> {
  const variables = { repositoryId: pr.headRepoId, ref: headBranchRef(pr) };
  const data = await graphql(HEAD_BRANCH_QUERY, variables, token, signal);
  const repository = record(data?.node);
  // Without the repository's `ref` the answer says nothing about the branch, not that it is gone.
  if (!repository || !('ref' in repository)) throw new GitHubWriteError('failed', 200);
  if (repository.ref === null) return null;
  const oid = text(record(record(repository.ref)?.target)?.oid);
  if (oid === '') throw new GitHubWriteError('failed', 200);
  return oid;
}

// Git's name for no commit: a ref updated to it is deleted.
const NO_COMMIT = '0000000000000000000000000000000000000000';

const DELETE_BRANCH = `mutation($input: UpdateRefsInput!) {
  updateRefs(input: $input) { clientMutationId }
}`;

/**
 * Deletes the pull request's branch only while it still ends at the pull request's last commit,
 * as T3 Code does: a branch that got commits since, or that was made anew under the same name
 * (and may head another pull request), is not this pull request's to delete. GitHub checks
 * `beforeOid` as it deletes, so a push that comes between the read and the write is refused too.
 * A branch already gone is what was asked for.
 */
async function deleteHeadBranch(pr: PullRequest, token: string): Promise<void> {
  const sha = await fetchHeadBranchSha(pr, token);
  if (sha === null) return;
  if (sha !== pr.headSha) throw new GitHubWriteError('branchMoved', 0);
  const update = { name: headBranchRef(pr), beforeOid: pr.headSha, afterOid: NO_COMMIT };
  await graphql(
    DELETE_BRANCH,
    { input: { repositoryId: pr.headRepoId, refUpdates: [update] } },
    token
  );
}

/**
 * One action on a pull request, as it was loaded: the writes that depend on its head send the
 * loaded head sha, so GitHub refuses them if the branch moved since.
 */
export async function runPullRequestAction(
  ref: PullRequestRef,
  pr: PullRequest,
  action: PullRequestAction,
  method: MergeMethod,
  token: string
): Promise<void> {
  const pull = `${repoPath(ref)}/pulls/${ref.number}`;
  const pullRequestId = pr.nodeId;
  switch (action) {
    case 'merge':
      await sendRest('PUT', `${pull}/merge`, { merge_method: method, sha: pr.headSha }, token);
      return;
    case 'close':
      await sendRest('PATCH', pull, { state: 'closed' }, token);
      return;
    case 'reopen':
      await sendRest('PATCH', pull, { state: 'open' }, token);
      return;
    case 'delete-branch':
      await deleteHeadBranch(pr, token);
      return;
    case 'ready':
      await graphql(ON_PULL_REQUEST('markPullRequestReadyForReview'), { pullRequestId }, token);
      return;
    case 'draft':
      await graphql(ON_PULL_REQUEST('convertPullRequestToDraft'), { pullRequestId }, token);
      return;
    case 'disable-auto-merge':
      await graphql(ON_PULL_REQUEST('disablePullRequestAutoMerge'), { pullRequestId }, token);
      return;
    case 'enable-auto-merge':
      await graphql(
        ENABLE_AUTO_MERGE,
        { pullRequestId, mergeMethod: method.toUpperCase(), expectedHeadOid: pr.headSha },
        token
      );
      return;
    // One path for both ways, as T3 Code. GitHub makes the branch's new commit after it
    // answers, so the caller waits for the new head before it says the branch is updated.
    case 'update-branch':
    case 'update-branch-rebase':
      await graphql(
        UPDATE_BRANCH,
        {
          pullRequestId,
          expectedHeadOid: pr.headSha,
          updateMethod: action === 'update-branch' ? 'MERGE' : 'REBASE',
        },
        token
      );
      return;
  }
}
