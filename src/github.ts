// GitHub's REST API for one pull request and its files, the only network this plugin uses.
// It must stay free of the diff libraries: this module loads with the plugin's entry, and
// those load only with the side panel.

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
  author: Actor | null;
  labels: { name: string; color: string }[];
  requestedReviewers: Actor[];
  requestedTeams: string[];
  mergeableState: string | null;
  autoMerge: { method: 'merge' | 'squash' | 'rebase' } | null;
  headSha: string;
  headRepo: string | null;
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
    await getJson(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, token, signal)
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
    author: actor(user),
    labels: list(raw.labels).flatMap((label) =>
      typeof label.name === 'string' ? [{ name: label.name, color: text(label.color) }] : []
    ),
    requestedReviewers: list(raw.requested_reviewers).map(actorOf),
    requestedTeams: list(raw.requested_teams).map((team) => text(team.name)),
    mergeableState: textOrNull(raw.mergeable_state),
    autoMerge: autoMerge(record(raw.auto_merge)?.merge_method),
    headSha: text(head?.sha),
    headRepo: textOrNull(record(head?.repo)?.full_name),
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

/** A list read page by page (100 at most per page, 10 pages at most), mapped item by item. */
async function fetchPaged<T>(
  path: string,
  token: string | undefined,
  signal: AbortSignal | undefined,
  map: (item: Json) => T | null
): Promise<Paged<T>> {
  const items: T[] = [];
  for (let page = 1; page <= LIST_PAGES; page += 1) {
    const raw = await getJson(`${path}?per_page=${PAGE_SIZE}&page=${page}`, token, signal);
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
  return fetchPaged(`${repoPath(ref)}/pulls/${ref.number}/reviews`, token, signal, (item) => {
    const state = text(item.state);
    // A pending review is the viewer's own draft, not yet part of the conversation.
    if (!REVIEW_STATES.has(state)) return null;
    return {
      id: count(item.id),
      state: state as ReviewState,
      author: actor(record(item.user)),
      body: text(item.body),
      commitId: text(item.commit_id),
      submittedAt: text(item.submitted_at),
      url: text(item.html_url),
    };
  });
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
  return fetchPaged(`${repoPath(ref)}/issues/${ref.number}/comments`, token, signal, comment);
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
  return fetchPaged(`${repoPath(ref)}/pulls/${ref.number}/comments`, token, signal, (item) => ({
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
  }));
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
