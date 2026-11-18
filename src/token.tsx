import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type MutableRefObject,
  type ReactNode,
  type Ref,
} from 'react';
import {
  CancelledError,
  useQuery,
  useQueryClient,
  type Query,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { usePluginStorage, usePluginTranslation } from '@mindroom/client-sdk/core';
import { useMatrixClient } from '@mindroom/client-sdk/matrix';
import {
  MindroomServerError,
  useMindroomServerStatus,
  type MindroomServer,
} from '@mindroom/client-sdk/server';
import { GitHubError, type GitHubAuth, type GitHubViaServer } from './github';

const KEY = 'githubToken';

// Every card and panel reads the token from storage; this set tells all of them at once when one
// of them changes it.
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  // Another tab of the same account changes it too.
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
};

/** The GitHub token of the signed-in account, kept in the plugin's storage. */
export function useGitHubToken(): {
  token: string | undefined;
  setToken(value: string): void;
  forget(): void;
} {
  const storage = usePluginStorage('pull-requests');
  const queryClient = useQueryClient();
  const token = useSyncExternalStore(subscribe, () => storage.getItem(KEY)) ?? undefined;
  const changed = useCallback(
    (stored: boolean) => {
      notify();
      // What the old token (or none) was refused says nothing about the new one, and results
      // fetched with it may differ now. A new token keeps the token's keys, so what shows under
      // them is read again here, with the new one.
      readAgain(queryClient, stored ? true : undefined);
    },
    [queryClient]
  );
  return useMemo(
    () => ({
      token,
      setToken: (value: string) => {
        storage.setItem(KEY, value);
        changed(true);
      },
      forget: () => {
        storage.removeItem(KEY);
        changed(false);
      },
    }),
    [changed, storage, token]
  );
}

/** The token stored now, for a request that runs after the render that started it. */
export function useStoredToken(): () => string | undefined {
  const storage = usePluginStorage('pull-requests');
  return useCallback(() => storage.getItem(KEY) ?? undefined, [storage]);
}

type RoomServer = { server: MindroomServer | undefined; pending: boolean };

/**
 * The room's MindRoom server, through which the parts inside may reach GitHub as the person, and
 * whether the room does not know yet if it has one.
 */
export const GitHubServerContext = createContext<RoomServer>({ server: undefined, pending: false });

/** Gives the parts inside the MindRoom server of the room `roomId`, when it has one. */
export function RoomGitHub({ roomId, children }: { roomId: string; children: ReactNode }) {
  const { server, pending } = useMindroomServerStatus(roomId);
  const value = useMemo(() => ({ server, pending }), [server, pending]);
  return <GitHubServerContext.Provider value={value}>{children}</GitHubServerContext.Provider>;
}

type ServerStatus = {
  connected: boolean;
  login: string | undefined;
  /** With the token the person saved in MindRoom, or the GitHub App connection, while connected. */
  via?: 'token' | 'app';
  /** While `via` is the token: whether MindRoom goes with the App once the token is removed. */
  appConnected?: boolean;
};

const NOT_CONNECTED: ServerStatus = { connected: false, login: undefined };

// Not under `pull-requests`, whose queries a new token asks again: the status is the server's.
const statusKey = (origin: string) => ['pull-requests-github-status', origin] as const;

// The connection changes when the person connects or disconnects GitHub in MindRoom, rarely. One
// that is not there is asked again sooner, on focus, so that connecting shows soon; never at once,
// so that a server whose status and requests disagree cannot keep the parts switching.
const statusStaleTime = (status: ServerStatus | undefined) =>
  status?.connected ? 300_000 : 30_000;

/** Which connection a status names, for telling when it changed. */
const identity = (status: ServerStatus) =>
  status.connected ? `connected:${status.via ?? ''}:${status.login ?? ''}` : 'none';

/** How GitHub is reached in a key of `queries.ts`, after the pull request or the repository. */
const accessOf = (queryKey: QueryKey) => queryKey[queryKey[1] === 'repo' ? 4 : 5];

const serverKey = (origin: string, login: string | undefined) =>
  `server:${origin}:${login ?? 'unknown'}`;

/**
 * The parts reach GitHub as another account now, or as none. Nothing is read again here under the
 * keys they leave: a read there would go with the new access (or be cancelled, `authFor`), and the
 * parts read under their new keys themselves. What was read stays, stale, for its own access; the
 * part that shows it next reads it again. A refusal is not asked again when its part next shows
 * (`retryOnMount: false`), so the refusals with nothing read that no part shows are forgotten:
 * they are asked anew then. One a part shows is asked again once that part shows it anew, under a
 * key it changes to. `refetch`, the key the parts keep (a new token's), is read again where it
 * shows, once each read still under way there is cancelled: it went with the access before, and a
 * query with nothing read yet would take its answer for the read again.
 */
function readAgain(queryClient: QueryClient, refetch?: AccessKey) {
  const queryKey = ['pull-requests'];
  queryClient
    .getQueryCache()
    .findAll({
      queryKey,
      type: 'inactive',
      predicate: ({ state }) => state.status === 'error' && state.data === undefined,
    })
    .forEach((query) => query.reset());
  void queryClient.invalidateQueries({ queryKey, refetchType: 'none' });
  if (refetch === undefined) return;
  const kept = { queryKey, predicate: (query: Query) => accessOf(query.queryKey) === refetch };
  // What shows now; a part that shows it later reads it itself, as the key is invalidated.
  const shown = new Set(queryClient.getQueryCache().findAll({ ...kept, type: 'active' }));
  void queryClient.cancelQueries(kept).then(() =>
    queryClient.refetchQueries(
      { queryKey, type: 'active', predicate: (query) => shown.has(query) },
      // A read started since goes with the access now: it is the read again.
      { cancelRefetch: false }
    )
  );
}

/**
 * Keeps `status` as the server's, and reads everything again when it names another connection, or
 * when `saved`: a token was saved or removed in MindRoom, which the same status may name as well.
 * Another way to the same login, or another token of it, keeps its keys, so what shows under them
 * is read again here.
 */
function setStatus(queryClient: QueryClient, origin: string, status: ServerStatus, saved = false) {
  const before = queryClient.getQueryData<ServerStatus>(statusKey(origin));
  queryClient.setQueryData(statusKey(origin), status);
  if (!before) return;
  const sameLogin = before.connected && status.connected && before.login === status.login;
  if (identity(before) === identity(status) && !(saved && sameLogin)) return;
  readAgain(queryClient, sameLogin ? serverKey(origin, status.login) : undefined);
}

// How often a token was saved in or removed from each server, by the query client that keeps its
// status: what the server answered to a request sent before the last time says nothing of now.
const savedTimes = new WeakMap<QueryClient, Map<string, number>>();
const savedTime = (queryClient: QueryClient, origin: string) =>
  savedTimes.get(queryClient)?.get(origin) ?? 0;

/**
 * Sets `status`, a server's answer to saving or removing a token there, once no status asked
 * before it is still under way, and fences off what answers to requests sent before it.
 */
async function setSavedStatus(queryClient: QueryClient, origin: string, status: ServerStatus) {
  await queryClient.cancelQueries({ queryKey: statusKey(origin) });
  const times = savedTimes.get(queryClient) ?? new Map<string, number>();
  savedTimes.set(queryClient, times);
  times.set(origin, savedTime(queryClient, origin) + 1);
  setStatus(queryClient, origin, status, true);
}

/** The status in a server's answer (of `/api/github/status`, or of saving or removing a token). */
function statusOf(answer: unknown): ServerStatus {
  const status =
    typeof answer === 'object' && answer !== null ? (answer as Record<string, unknown>) : {};
  if (status.connected !== true) return NOT_CONNECTED;
  const { login } = status;
  return {
    connected: true,
    login: typeof login === 'string' && login !== '' ? login : undefined,
    // A server from before the token was saved there knows the App alone.
    via: status.via === 'token' ? 'token' : 'app',
    appConnected: status.via === 'token' && status.app_connected === true,
  };
}

async function readStatus(server: MindroomServer): Promise<ServerStatus> {
  return statusOf(await server.request('/api/github/status'));
}

/**
 * Requests through `server` as the person's connected GitHub account, `account` the signed-in
 * account and the login. Once the server says that connection is gone, the parts read without it,
 * and the status is asked again once it is stale.
 */
function viaServer(
  queryClient: QueryClient,
  server: MindroomServer,
  account: string
): GitHubViaServer {
  const sent = savedTime(queryClient, server.origin);
  return {
    server,
    account,
    // Not for a request sent before a token was saved or removed there: that says nothing of now.
    disconnected: () => {
      if (sent === savedTime(queryClient, server.origin)) {
        setStatus(queryClient, server.origin, NOT_CONNECTED);
      }
    },
  };
}

/** What the query keys carry of how GitHub is reached, as `GitHubAccess.key`. */
export type AccessKey = boolean | string;

/** How the parts reach GitHub now, as `useGitHubAccess` gives it. */
export type GitHubAccess = {
  /** With the token stored in the browser, through MindRoom, or neither (anonymous, no writes). */
  via: 'token' | 'server' | undefined;
  /** The GitHub login connected in MindRoom, when the server named it. */
  login: string | undefined;
  /** Through MindRoom: whether it goes with the token saved there or with the GitHub App. */
  connection: 'token' | 'app' | undefined;
  /** With the token saved in MindRoom: whether the GitHub App is used once it is removed. */
  appConnected: boolean;
  /**
   * What the query keys carry of it, never a token: false without either, true with the token,
   * `server:<origin>:<login>` through MindRoom (`unknown` for a login the server did not name),
   * so no two of them share what was read.
   */
  key: AccessKey;
  /**
   * While the room does not know its server yet, or the server has not said whether GitHub is
   * connected there, with no token stored; nothing should read yet.
   */
  pending: boolean;
  /**
   * How a request that starts now goes, and the key that names it, for one that runs after the
   * render that started it, as a write does.
   */
  current(): { key: AccessKey; auth: GitHubAuth | undefined };
  /**
   * How a read under `key` goes, which is the access the key names and never another: without one
   * for `false`; else the access now, when that is still the one `key` names. When it is not, the
   * read throws `CancelledError`, which leaves what was read under `key` as it was; the parts
   * read under their new key.
   */
  authFor(key: AccessKey): GitHubAuth | undefined;
  /**
   * Asks the server again whether GitHub is connected there, as a part's Try again does; resolves
   * to whether the parts read again by themselves now, under the keys of another connection: one
   * that differs from the one before, or the first connected one when none was known.
   */
  recheck(): Promise<boolean>;
};

/** Whose GitHub account the requests through MindRoom use, while they go that way. */
export function GitHubConnectedNote() {
  const t = usePluginTranslation('pull-requests');
  const { via, login, connection } = useGitHubAccess();
  if (via !== 'server') return null;
  const how = t(`token.how.${connection ?? 'app'}`);
  return <>{login ? t('token.connected', { login, how }) : t('token.connectedNoLogin', { how })}</>;
}

// The token's routes change what MindRoom keeps for the person, and the token goes in the body: a
// redirect, which the browser would follow to another origin with the body, fails instead.
const NO_REDIRECT: RequestRedirect = 'error';

/**
 * Why saving a token in MindRoom failed: GitHub refused it, it is no token, the server has no
 * route for it (one from before tokens were saved there), or anything else.
 */
type SaveProblem = 'rejected' | 'invalid' | 'unsupported' | 'failed';

/**
 * The token the person saves in the room's MindRoom server, which MindRoom uses before the GitHub
 * App, on every device; undefined in a room without one. Each answer is the status, set as the
 * status query's own is, so the parts switch to it as they would.
 */
function useServerToken() {
  const { server } = useContext(GitHubServerContext);
  const queryClient = useQueryClient();
  const storedToken = useStoredToken();
  const { forget } = useGitHubToken();
  return useMemo(() => {
    if (!server) return undefined;
    const answered = (now: ServerStatus) => {
      const before = queryClient.getQueryData<ServerStatus>(statusKey(server.origin));
      // Saving answers with the token's account alone; the App connection there stays.
      const app = now.via === 'token' && (before?.via === 'app' || before?.appConnected === true);
      return setSavedStatus(queryClient, server.origin, app ? { ...now, appConnected: true } : now);
    };
    return {
      /** Where it saves the token: the server's origin. */
      origin: server.origin,
      /** Saves `token` there; resolves to what went wrong, or undefined once it is saved. */
      save: async (token: string): Promise<SaveProblem | undefined> => {
        let answer: unknown;
        try {
          answer = await server.request('/api/github/token', {
            method: 'PUT',
            body: JSON.stringify({ token }),
            headers: { 'Content-Type': 'application/json' },
            redirect: NO_REDIRECT,
          });
        } catch (error) {
          const status = error instanceof MindroomServerError ? error.status : 0;
          const body = error instanceof MindroomServerError ? error.body : undefined;
          const code =
            typeof body === 'object' && body !== null
              ? (body as { error?: unknown }).error
              : undefined;
          if (status === 400 && code === 'github_token_rejected') return 'rejected';
          if (status === 404 || status === 405) return 'unsupported';
          return status === 422 ? 'invalid' : 'failed';
        }
        // Saved only once MindRoom says it uses the token now; an answer that does not leaves the
        // status, and the token of this browser, as they were.
        const now = statusOf(answer);
        if (!now.connected || now.via !== 'token') return 'failed';
        await answered(now);
        // The token of this browser comes first, and would hide the one just saved.
        if (storedToken() !== undefined) forget();
        return undefined;
      },
      /** Removes it there; resolves to whether it did. */
      remove: async (): Promise<boolean> => {
        try {
          await answered(
            statusOf(
              await server.request('/api/github/token', { method: 'DELETE', redirect: NO_REDIRECT })
            )
          );
          return true;
        } catch {
          return false;
        }
      },
    };
  }, [forget, queryClient, server, storedToken]);
}

/** Removes the token saved in MindRoom, while the requests through MindRoom go with it. */
export function RemoveServerToken() {
  const t = usePluginTranslation('pull-requests');
  const { via, connection, appConnected } = useGitHubAccess();
  const serverToken = useServerToken();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [removed, setRemoved] = useState(false);
  const fallsBack = useId();
  const said = useRef<HTMLSpanElement>(null);
  const shown = via === 'server' && connection === 'token' && serverToken !== undefined;
  // The button goes once the token is removed: focus goes to what says so, not to the page.
  useEffect(() => {
    if (removed && !shown) said.current?.focus();
  }, [removed, shown]);
  if (!shown) {
    return removed ? (
      <span ref={said} tabIndex={-1}>
        {t('token.removed')}
      </span>
    ) : null;
  }
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    setRemoved(false);
    const done = await serverToken.remove();
    setBusy(false);
    setFailed(!done);
    setRemoved(done);
  };
  return (
    <>
      <button
        type="button"
        className="mrpr-link-button"
        // Not disabled, which would take the focus from it while it is pressed.
        aria-disabled={busy || undefined}
        aria-describedby={appConnected ? fallsBack : undefined}
        onClick={() => void remove()}
      >
        {t('token.remove')}
      </button>
      {appConnected ? (
        <>
          {' '}
          <span id={fallsBack}>{t('token.removeFallsBack')}</span>
        </>
      ) : null}
      {failed ? <span role="alert"> {t('token.removeFailed')}</span> : null}
    </>
  );
}

/**
 * How to reach GitHub: the token stored in the browser comes first; else, while the room's
 * MindRoom server says the person's GitHub account is connected there, through that server;
 * else anonymously. The server is asked once for the status, and not while a token is stored.
 */
export function useGitHubAccess(): GitHubAccess {
  const { token } = useGitHubToken();
  const storedToken = useStoredToken();
  const { server, pending: serverPending } = useContext(GitHubServerContext);
  const userId = useMatrixClient().getSafeUserId();
  const queryClient = useQueryClient();
  const origin = server?.origin ?? '';
  const status = useQuery({
    queryKey: statusKey(origin),
    queryFn: async () => {
      const sent = savedTime(queryClient, origin);
      const now = await readStatus(server as MindroomServer);
      // A status asked before a token was saved or removed there is older than the one set then.
      if (sent !== savedTime(queryClient, origin)) {
        return queryClient.getQueryData<ServerStatus>(statusKey(origin)) ?? now;
      }
      setStatus(queryClient, origin, now);
      return now;
    },
    enabled: server !== undefined && token === undefined,
    staleTime: statusStaleTime(queryClient.getQueryData<ServerStatus>(statusKey(origin))),
    retry: false,
    retryOnMount: false,
  });
  const connected = server !== undefined && token === undefined && status.data?.connected === true;
  const login = connected ? status.data?.login : undefined;
  const connection = connected ? status.data?.via : undefined;
  const appConnected = connected && status.data?.appConnected === true;
  const current = useCallback((): { key: AccessKey; auth: GitHubAuth | undefined } => {
    const stored = storedToken();
    if (stored !== undefined) return { key: true, auth: stored };
    const now = server && queryClient.getQueryData<ServerStatus>(statusKey(server.origin));
    if (!server || !now?.connected) return { key: false, auth: undefined };
    return {
      key: serverKey(server.origin, now.login),
      auth: viaServer(queryClient, server, `${userId} ${now.login ?? ''}`),
    };
  }, [queryClient, server, storedToken, userId]);
  const authFor = useCallback(
    (key: AccessKey): GitHubAuth | undefined => {
      // Anonymous is always at hand, also in a room that reads otherwise now and shares the key.
      if (key === false) return undefined;
      const now = current();
      if (now.key !== key) throw new CancelledError({ revert: true });
      return now.auth;
    },
    [current]
  );
  const recheck = useCallback(async () => {
    if (!server || storedToken() !== undefined) return false;
    const key = statusKey(server.origin);
    const before = queryClient.getQueryData<ServerStatus>(key);
    await queryClient.invalidateQueries({ queryKey: key });
    const now = queryClient.getQueryData<ServerStatus>(key);
    if (now === undefined) return false;
    // A first status after a failed one reads everything again only when it is connected,
    // through the new keys; one that is not leaves the reading again to the caller.
    return before === undefined ? now.connected : identity(before) !== identity(now);
  }, [queryClient, server, storedToken]);
  return useMemo(
    () => ({
      via: token !== undefined ? 'token' : connected ? 'server' : undefined,
      login,
      connection,
      appConnected,
      key: token !== undefined ? true : connected ? serverKey(origin, login) : false,
      pending: token === undefined && (serverPending || (server !== undefined && status.isPending)),
      current,
      authFor,
      recheck,
    }),
    [
      appConnected,
      authFor,
      connected,
      connection,
      current,
      login,
      origin,
      recheck,
      server,
      serverPending,
      status.isPending,
      token,
    ]
  );
}

/** The host of `origin`, as the person knows the server by. */
const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

export function TokenForm({
  reason,
  inputRef,
  onCancel,
  onSaved,
}: {
  /** Why it shows; `override`, to use a token instead of MindRoom's connection, has no hint. */
  reason: 'notFound' | 'rateLimited' | 'badToken' | 'override';
  inputRef?: Ref<HTMLInputElement>;
  /** Closes the form without saving, for one the person opened; without it, none shows. */
  onCancel?: () => void;
  /** Once a token is saved, in the browser or in MindRoom. */
  onSaved?: () => void;
}) {
  const t = usePluginTranslation('pull-requests');
  const { setToken } = useGitHubToken();
  const { via } = useGitHubAccess();
  const serverToken = useServerToken();
  const [value, setValue] = useState('');
  // In a room with a MindRoom server, the token is saved there only once the person chose that
  // server, by its name: the room's server may be any that an agent's account published. Another
  // server, once the room has one, is not chosen until the person chooses it.
  const [chosen, setChosen] = useState<string>();
  if (chosen !== undefined && chosen !== serverToken?.origin) setChosen(undefined);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<SaveProblem>();
  const field = useRef<HTMLInputElement | null>(null);
  const setField = useCallback(
    (element: HTMLInputElement | null) => {
      field.current = element;
      if (typeof inputRef === 'function') inputRef(element);
      else if (inputRef) (inputRef as MutableRefObject<HTMLInputElement | null>).current = element;
    },
    [inputRef]
  );
  const inMindroom = serverToken !== undefined && chosen === serverToken.origin;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed === '' || saving) return;
    setProblem(undefined);
    if (!inMindroom) {
      setValue('');
      setToken(trimmed);
      onSaved?.();
      return;
    }
    setSaving(true);
    const failure = await serverToken.save(trimmed);
    setSaving(false);
    setProblem(failure);
    // The field keeps the token until MindRoom saved it, so that the person can try again there.
    if (failure !== undefined) {
      field.current?.focus();
      return;
    }
    setValue('');
    onSaved?.();
  };
  return (
    <form className="mrpr-token" onSubmit={(event) => void submit(event)}>
      {via === 'server' ? (
        <p className="mrpr-status">
          <GitHubConnectedNote /> {t('token.overrides')}
        </p>
      ) : null}
      {reason === 'override' ? null : <p className="mrpr-status">{t(`token.hint.${reason}`)}</p>}
      <div className="mrpr-token-row">
        <input
          ref={setField}
          className="mrpr-input"
          type="password"
          autoComplete="off"
          aria-label={t('token.label')}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        {/* Not disabled while saving, which would take the focus from it. */}
        <button className="mrpr-button" type="submit" aria-disabled={saving || undefined}>
          {t('token.save')}
        </button>
        {onCancel ? (
          <button className="mrpr-button" type="button" onClick={onCancel}>
            {t('token.cancel')}
          </button>
        ) : null}
        <span className="mrpr-status" aria-live="polite">
          {saving ? t('token.saving') : null}
        </span>
      </div>
      {serverToken ? (
        <div className="mrpr-token-where" role="radiogroup" aria-label={t('token.where')}>
          {[false, true].map((only) => (
            <label key={String(only)}>
              <input
                type="radio"
                name="mrpr-token-where"
                checked={only !== inMindroom}
                onChange={() => setChosen(only ? undefined : serverToken.origin)}
              />{' '}
              {only
                ? t('token.inBrowser')
                : t('token.inMindroom', { host: hostOf(serverToken.origin) })}
            </label>
          ))}
        </div>
      ) : null}
      {problem ? (
        <p className="mrpr-status" role="alert">
          {t(`token.problem.${problem}`)}
        </p>
      ) : null}
      <p className="mrpr-status">{t(inMindroom ? 'token.noteMindroom' : 'token.note')}</p>
    </form>
  );
}

type TokenReason = 'notFound' | 'rateLimited';

type PanelTokenFormState = {
  /** Asks for the form for this reason; the returned function withdraws the ask. */
  need(reason: TokenReason): () => void;
  focus(): void;
};

/** The panel's one token form, for the parts inside it whose failures a token would fix. */
export const PanelTokenFormContext = createContext<PanelTokenFormState | undefined>(undefined);

/**
 * The panel's token form: shown while one of its parts shows a failure that a token fixes, GitHub's
 * rate limit before not finding the repository, and focused from those parts.
 */
export function usePanelTokenForm() {
  const [needs, setNeeds] = useState<readonly TokenReason[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const context = useMemo(
    (): PanelTokenFormState => ({
      need: (reason) => {
        setNeeds((current) => [...current, reason]);
        return () =>
          setNeeds((current) => {
            const index = current.indexOf(reason);
            return index < 0 ? current : [...current.slice(0, index), ...current.slice(index + 1)];
          });
      },
      focus: () => inputRef.current?.focus(),
    }),
    []
  );
  const reason: TokenReason | undefined = needs.includes('rateLimited')
    ? 'rateLimited'
    : needs.includes('notFound')
    ? 'notFound'
    : undefined;
  return { context, reason, inputRef };
}

/**
 * For a part of the panel that shows `error`: while it is one a token fixes and none is stored,
 * the panel shows its token form, and this gives what focuses it; otherwise undefined.
 */
export function usePanelTokenFormFor(error: unknown): (() => void) | undefined {
  const form = useContext(PanelTokenFormContext);
  const { via } = useGitHubAccess();
  const kind = error instanceof GitHubError ? error.kind : undefined;
  // A token overrides MindRoom's connection where that cannot read the repository, but has the
  // same rate limit.
  const reason =
    via !== 'token' && (kind === 'notFound' || (kind === 'rateLimited' && via === undefined))
      ? kind
      : undefined;
  useEffect(() => (form && reason ? form.need(reason) : undefined), [form, reason]);
  return form && reason ? form.focus : undefined;
}
