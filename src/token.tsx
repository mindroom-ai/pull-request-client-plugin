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
  /**
   * While not connected: MindRoom cannot read the token saved there (`503
   * github_token_unreadable`), and uses nothing until another is saved or it is removed.
   */
  unreadable?: boolean;
};

const NOT_CONNECTED: ServerStatus = { connected: false, login: undefined };
const UNREADABLE: ServerStatus = { connected: false, login: undefined, unreadable: true };

// Not under `pull-requests`, whose queries a new token asks again: the status is the server's.
const statusKey = (origin: string) => ['pull-requests-github-status', origin] as const;

// The connection changes when the person connects or disconnects GitHub in MindRoom, rarely. One
// that is not there is asked again sooner, on focus, so that connecting shows soon; never at once,
// so that a server whose status and requests disagree cannot keep the parts switching.
const statusStaleTime = (status: ServerStatus | undefined) =>
  status?.connected ? 300_000 : 30_000;

/** Which connection a status names, for telling when it changed. */
const identity = (status: ServerStatus) =>
  status.connected
    ? `connected:${status.via ?? ''}:${status.login ?? ''}`
    : status.unreadable
    ? 'unreadable'
    : 'none';

/** How GitHub is reached in a key of `queries.ts`, after the pull request or the repository. */
const accessOf = (queryKey: QueryKey) => queryKey[queryKey[1] === 'repo' ? 4 : 5];

const serverKey = (origin: string, login: string | undefined, generation: number) =>
  `server:${origin}:${login ?? 'unknown'}:${generation}`;

/**
 * The parts reach GitHub as another account now, or as none. Nothing is read again here under the
 * keys they leave: a read there would go with the new access (or be cancelled, `authFor`), and the
 * parts read under their new keys themselves. What was read stays, stale, for its own access; the
 * part that shows it next reads it again. A refusal is not asked again when its part next shows
 * (`retryOnMount: false`), so the refusals with nothing read that no part shows are forgotten:
 * they are asked anew then. One a part shows is asked again once that part shows it anew, under a
 * key it changes to. `refetch`, the key the parts keep (a new token's), is read again where it
 * shows.
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
  void queryClient.refetchQueries({
    queryKey,
    type: 'active',
    predicate: (query) => accessOf(query.queryKey) === refetch,
  });
}

/**
 * The credential a server uses for the person: `generation` counts each one it may have changed
 * to, and goes in the keys, so that no two credentials share what was read, also of one login;
 * `writing` while a token is being saved in or removed from it, when nobody knows which one a
 * request would go with, so none starts.
 *
 * Invariant: `fence` only ever goes up, and it goes up at every event after which an older answer
 * must not apply: the start of a token being saved or removed, and every status kept that names
 * another connection (`setStatus`), whoever it came from. An answer to a status or a request is
 * applied only while the fence is the one read when that request started. The generation is no
 * fence: it goes back once the server refused a change.
 */
type Credential = { generation: number; fence: number; writing: boolean };
const FIRST: Credential = { generation: 0, fence: 0, writing: false };
const credentials = new WeakMap<QueryClient, Map<string, Credential>>();
const credentialOf = (queryClient: QueryClient, origin: string) =>
  credentials.get(queryClient)?.get(origin) ?? FIRST;
function setCredential(queryClient: QueryClient, origin: string, credential: Credential) {
  const servers = credentials.get(queryClient) ?? new Map<string, Credential>();
  credentials.set(queryClient, servers);
  servers.set(origin, credential);
  notify();
}

/**
 * Keeps `status` as the server's. One that names another connection is another credential, read
 * under keys of its own; a token being saved or removed there took its generation as it started.
 */
function setStatus(queryClient: QueryClient, origin: string, status: ServerStatus) {
  const before = queryClient.getQueryData<ServerStatus>(statusKey(origin));
  queryClient.setQueryData(statusKey(origin), status);
  if (!before || identity(before) === identity(status)) return;
  const credential = credentialOf(queryClient, origin);
  setCredential(queryClient, origin, {
    ...credential,
    fence: credential.fence + 1,
    generation: credential.generation + (credential.writing ? 0 : 1),
  });
  readAgain(queryClient);
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

// A token saved or removed holds every read through its server until its outcome is known, and so
// does a status not yet known, so MindRoom gets this long to answer each request of them, three
// times its own limit with GitHub.
const changeLimit = () => AbortSignal.timeout(30_000);

/**
 * The query of a server's status. Its answer is kept as the server's (`setStatus`), unless the
 * fence moved since it was asked: that says nothing of now.
 */
const statusQuery = (queryClient: QueryClient, server: MindroomServer | undefined) => ({
  queryKey: statusKey(server?.origin ?? ''),
  queryFn: async () => {
    const { origin } = server as MindroomServer;
    const { fence } = credentialOf(queryClient, origin);
    // The limit is each request's own: the query keeps this function for whoever asks next.
    const now = await (server as MindroomServer)
      .request('/api/github/status', { signal: changeLimit() })
      .then(statusOf, (error: unknown) => {
        // Asking again would get the same: this one is a state of its own, kept as a status.
        if (isUnreadable(error)) return UNREADABLE;
        throw error;
      });
    if (fence !== credentialOf(queryClient, origin).fence) {
      return queryClient.getQueryData<ServerStatus>(statusKey(origin)) ?? now;
    }
    setStatus(queryClient, origin, now);
    return now;
  },
  retry: false,
});

/** Asks `server` for its status now, whoever shows it, as part of saving or removing a token. */
const askStatus = (queryClient: QueryClient, server: MindroomServer) =>
  queryClient.fetchQuery({ ...statusQuery(queryClient, server), staleTime: 0 });

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
  const { fence } = credentialOf(queryClient, server.origin);
  return {
    server,
    account,
    // Not for a request sent before the fence moved: that says nothing of now.
    disconnected: () => {
      if (fence === credentialOf(queryClient, server.origin).fence) {
        setStatus(queryClient, server.origin, NOT_CONNECTED);
      }
    },
    unreadable: () => {
      if (fence === credentialOf(queryClient, server.origin).fence) {
        setStatus(queryClient, server.origin, UNREADABLE);
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
   * MindRoom cannot read the token saved there, with no token stored: nothing goes through it
   * (`via` is undefined) until another is saved there or it is removed.
   */
  unreadable: boolean;
  /**
   * What the query keys carry of it, never a token: false without either, true with the token,
   * `server:<origin>:<login>:<generation>` through MindRoom (`unknown` for a login the server
   * did not name; the generation counts the credentials the server may have used, as a token
   * saved or removed there is another one of the same login), so no two share what was read.
   */
  key: AccessKey;
  /**
   * While the room does not know its server yet, the server has not said whether GitHub is
   * connected there, or a token is being saved in or removed from it, with no token stored;
   * nothing should read yet. Meanwhile the parts show what they read before.
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
   * to whether the parts read again by themselves now: whether the key a read starts with changed.
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

/** The HTTP status and the error code with which the server refused a request, 0 without one. */
function refusalOf(error: unknown): { status: number; code: unknown } {
  if (!(error instanceof MindroomServerError)) return { status: 0, code: undefined };
  const { status, body } = error;
  const code =
    typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  return { status, code };
}

/** Whether MindRoom answered that it cannot read the token saved there. */
function isUnreadable(error: unknown): boolean {
  const { status, code } = refusalOf(error);
  return status === 503 && code === 'github_token_unreadable';
}

/**
 * The token the person saves in the room's MindRoom server, which MindRoom uses before the GitHub
 * App, on every device; undefined in a room without one.
 */
function useServerToken() {
  const { server } = useContext(GitHubServerContext);
  const queryClient = useQueryClient();
  const storedToken = useStoredToken();
  const { forget } = useGitHubToken();
  const origin = server?.origin ?? '';
  const { writing } = useSyncExternalStore(subscribe, () => credentialOf(queryClient, origin));
  return useMemo(() => {
    if (!server) return undefined;
    /**
     * Sends one change of the token, alone: from its start the server may use another credential,
     * so the reads under way through it are cancelled and none starts until its status is known
     * again, from `send`'s answer or, once that failed, asked anew.
     */
    const change = async (send: () => Promise<ServerStatus>): Promise<unknown> => {
      const before = credentialOf(queryClient, origin);
      let generation = before.generation + 1;
      setCredential(queryClient, origin, { generation, fence: before.fence + 1, writing: true });
      void queryClient.cancelQueries({ queryKey: statusKey(origin) });
      void queryClient.cancelQueries({
        queryKey: ['pull-requests'],
        predicate: ({ queryKey }) => String(accessOf(queryKey)).startsWith(`server:${origin}:`),
      });
      try {
        setStatus(queryClient, origin, await send());
        return undefined;
      } catch (error) {
        const { status, code } = refusalOf(error);
        if ((status >= 400 && status < 500) || code === 'github_unreachable') {
          // MindRoom answered that it changed nothing: its credential, and so the keys, are
          // the ones before.
          generation -= 1;
        } else {
          // Whether it took the change is not known: without its status, nothing goes through
          // it as an account it may no longer use.
          await askStatus(queryClient, server).catch(() =>
            setStatus(queryClient, origin, NOT_CONNECTED)
          );
        }
        return error ?? new Error('failed');
      } finally {
        const { fence } = credentialOf(queryClient, origin);
        setCredential(queryClient, origin, { generation, fence, writing: false });
      }
    };
    return {
      /** Where it saves the token: the server's origin. */
      origin,
      /** While a token is being saved or removed there, as of this render. */
      writing,
      /** The same as of now: a second press in one event finds it under way. */
      busy: () => credentialOf(queryClient, origin).writing,
      /** Saves `token` there; resolves to what went wrong, or undefined once it is saved. */
      save: async (token: string): Promise<SaveProblem | undefined> => {
        const error = await change(async () => {
          const saved = statusOf(
            await server.request('/api/github/token', {
              method: 'PUT',
              body: JSON.stringify({ token }),
              headers: { 'Content-Type': 'application/json' },
              redirect: NO_REDIRECT,
              signal: changeLimit(),
            })
          );
          // Saved only once MindRoom says it uses the token now; an answer that does not leaves
          // the token of this browser as it was.
          if (!saved.connected || saved.via !== 'token') throw new Error('not saved');
          // Saving answers with the token's account alone; the status says whether the App
          // connection is there too. One that cannot read the token just saved did not save it.
          const now = await askStatus(queryClient, server).catch(() => saved);
          if (now.unreadable) throw new Error('not saved');
          return now;
        });
        if (error === undefined) {
          // The token of this browser comes first, and would hide the one just saved.
          if (storedToken() !== undefined) forget();
          return undefined;
        }
        const { status, code } = refusalOf(error);
        if (status === 400 && code === 'github_token_rejected') return 'rejected';
        if (status === 404 || status === 405) return 'unsupported';
        return status === 422 ? 'invalid' : 'failed';
      },
      /** Removes it there; resolves to whether it did. */
      remove: async (): Promise<boolean> =>
        (await change(async () =>
          statusOf(
            await server.request('/api/github/token', {
              method: 'DELETE',
              redirect: NO_REDIRECT,
              signal: changeLimit(),
            })
          )
        )) === undefined,
    };
  }, [forget, origin, queryClient, server, storedToken, writing]);
}

// The element a part focused in place of one that went with the focus, until another has it.
let placed: Element | null = null;

/** Focuses `element` in place of a control that went while it had the focus. */
export function placeFocus(element: HTMLElement | null | undefined) {
  element?.focus();
  placed = element ?? null;
}

/**
 * That a token was removed from MindRoom: the origin it was removed from, and whether the note
 * that says so takes the focus, once, as the button that had it went.
 */
type Removal = { origin: string; focus: boolean };
type RemovedToken = {
  removed: Removal | undefined;
  setRemoved(removal: Removal | undefined): void;
};

/** Where a token's removal is kept, for one part whose own parts may go and come back meanwhile. */
function useRemovedToken(): RemovedToken {
  const [removed, setRemoved] = useState<Removal>();
  return useMemo(() => ({ removed, setRemoved }), [removed]);
}

const NO_REMOVAL: RemovedToken = { removed: undefined, setRemoved: () => undefined };
const RemovedTokenContext = createContext<RemovedToken | undefined>(undefined);

/**
 * The panel's: there what removed the token goes once it is removed (the header, an error), and
 * what shows next may be another of them, so the panel says it was removed (`RemovedTokenNote`).
 * Forgotten with the panel.
 */
export function RemovedTokenProvider({ children }: { children: ReactNode }) {
  const value = useRemovedToken();
  return <RemovedTokenContext.Provider value={value}>{children}</RemovedTokenContext.Provider>;
}

/**
 * Says that the token was removed from MindRoom, from the room's server, and takes the focus as it
 * does: the button that removed it goes with it. Gone once a token is used again.
 */
export function RemovedTokenNote({
  note: own,
  className,
}: {
  /** Whose removal it says; the panel's, inside it, without one. */
  note?: RemovedToken;
  /** For a note of its own line: the class of the paragraph it is then. */
  className?: string;
}) {
  const lifted = useContext(RemovedTokenContext);
  const note = own ?? lifted ?? NO_REMOVAL;
  const t = usePluginTranslation('pull-requests');
  const { via, connection } = useGitHubAccess();
  const serverToken = useServerToken();
  const said = useRef<HTMLSpanElement>(null);
  const writing = serverToken?.writing === true;
  const removal = note.removed;
  const removed = serverToken !== undefined && removal?.origin === serverToken.origin;
  // A token saved again, here or in the browser, is not the one removed.
  const used = via === 'token' || (via === 'server' && connection === 'token');
  const shown = removed && !used;
  const focus = shown && removal?.focus === true;
  const { setRemoved } = note;
  useEffect(() => {
    if (removed && used && !writing) setRemoved(undefined);
  }, [removed, setRemoved, used, writing]);
  useEffect(() => {
    if (!focus || !removal) return;
    said.current?.focus();
    setRemoved({ ...removal, focus: false });
  }, [focus, removal, setRemoved]);
  // Always there, a live region that says it also where the focus stays elsewhere.
  const text = shown ? (
    <span ref={said} tabIndex={-1}>
      {t('token.removed')}
    </span>
  ) : null;
  return className === undefined ? (
    <span aria-live="polite">{text}</span>
  ) : (
    <p className={className} aria-live="polite">
      {text}
    </p>
  );
}

/** Removes the token saved in MindRoom, while the requests through MindRoom go with it. */
export function RemoveServerToken() {
  const lifted = useContext(RemovedTokenContext);
  const own = useRemovedToken();
  // Outside the panel it says itself that the token was removed, where it was.
  return lifted ? (
    <RemoveButton note={lifted} />
  ) : (
    <>
      <RemoveButton note={own} />
      <RemovedTokenNote note={own} />
    </>
  );
}

function RemoveButton({ note }: { note: RemovedToken }) {
  const t = usePluginTranslation('pull-requests');
  const { via, connection, appConnected, unreadable } = useGitHubAccess();
  const serverToken = useServerToken();
  const [failed, setFailed] = useState(false);
  const fallsBack = useId();
  const button = useRef<HTMLButtonElement>(null);
  // Also the token MindRoom cannot read, which removing there mends.
  const shown =
    ((via === 'server' && connection === 'token') || unreadable) && serverToken !== undefined;
  if (!shown) return null;
  const remove = async () => {
    if (serverToken.busy()) return;
    setFailed(false);
    note.setRemoved(undefined);
    const done = await serverToken.remove();
    setFailed(!done);
    // The focus follows from the button, or from where it fell once the button went, but not
    // from where the person moved it meanwhile.
    const active = document.activeElement;
    const focus = [null, document.body, button.current, placed].includes(active);
    note.setRemoved(done ? { origin: serverToken.origin, focus } : undefined);
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className="mrpr-link-button"
        // Not disabled, which would take the focus from it while it is pressed.
        aria-disabled={serverToken.writing || undefined}
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
  const credential = useSyncExternalStore(subscribe, () => credentialOf(queryClient, origin));
  const status = useQuery({
    ...statusQuery(queryClient, server),
    // Not while a token is saved or removed there: that asks, or answers, the status itself.
    enabled: server !== undefined && token === undefined && !credential.writing,
    staleTime: statusStaleTime(queryClient.getQueryData<ServerStatus>(statusKey(origin))),
    retryOnMount: false,
  });
  const connected = server !== undefined && token === undefined && status.data?.connected === true;
  const login = connected ? status.data?.login : undefined;
  const connection = connected ? status.data?.via : undefined;
  const appConnected = connected && status.data?.appConnected === true;
  const unreadable =
    server !== undefined && token === undefined && status.data?.unreadable === true;
  const current = useCallback((): { key: AccessKey; auth: GitHubAuth | undefined } => {
    const stored = storedToken();
    if (stored !== undefined) return { key: true, auth: stored };
    const now = server && queryClient.getQueryData<ServerStatus>(statusKey(server.origin));
    if (!server || !now?.connected) return { key: false, auth: undefined };
    const { generation, writing } = credentialOf(queryClient, server.origin);
    // Which credential the server uses is not known while a token is saved or removed there.
    if (writing) return { key: false, auth: undefined };
    return {
      key: serverKey(server.origin, now.login, generation),
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
    // The parts read again by themselves once the token is saved or removed.
    if (credentialOf(queryClient, server.origin).writing) return true;
    const before = current().key;
    await queryClient.invalidateQueries({ queryKey: statusKey(server.origin) });
    // Only the parts under another key read by themselves; a status that changed and left the
    // key (as from a token MindRoom cannot read to none, both anonymous) leaves it to the caller.
    return current().key !== before;
  }, [current, queryClient, server, storedToken]);
  return useMemo(
    () => ({
      via: token !== undefined ? 'token' : connected ? 'server' : undefined,
      login,
      connection,
      appConnected,
      unreadable,
      // While a token is saved or removed there, the key before: what was read stays on screen.
      key:
        token !== undefined
          ? true
          : connected
          ? serverKey(origin, login, credential.generation - (credential.writing ? 1 : 0))
          : false,
      pending:
        token === undefined &&
        (serverPending || (server !== undefined && (status.isPending || credential.writing))),
      current,
      authFor,
      recheck,
    }),
    [
      appConnected,
      authFor,
      connected,
      connection,
      credential,
      current,
      login,
      origin,
      recheck,
      server,
      serverPending,
      status.isPending,
      token,
      unreadable,
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

/** Why the token form shows, which its hint says. */
export type TokenFormReason = 'notFound' | 'rateLimited' | 'badToken' | 'unreadable' | 'override';

export function TokenForm({
  reason,
  inputRef,
  onCancel,
  onSaved,
}: {
  /**
   * Why it shows; `override`, to use a token instead of MindRoom's connection, has no hint;
   * `unreadable`, MindRoom cannot read the token saved there, also offers to remove it.
   */
  reason: TokenFormReason;
  inputRef?: Ref<HTMLInputElement>;
  /** Closes the form without saving, for one the person opened; without it, none shows. */
  onCancel?: () => void;
  /** Once a token is saved, in the browser or in MindRoom. */
  onSaved?: () => void;
}) {
  const t = usePluginTranslation('pull-requests');
  const { token, setToken } = useGitHubToken();
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
  const writing = serverToken?.writing === true;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed === '' || serverToken?.busy()) return;
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
      {reason === 'unreadable' ? (
        <p className="mrpr-status">
          <span role="alert">{t('token.hint.unreadable')}</span> <RemoveServerToken />
        </p>
      ) : reason === 'override' ? null : (
        <p className="mrpr-status">{t(`token.hint.${reason}`)}</p>
      )}
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
        <button className="mrpr-button" type="submit" aria-disabled={writing || undefined}>
          {t('token.save')}
        </button>
        {onCancel ? (
          <button
            className="mrpr-button"
            type="button"
            // The form stays while it saves: what comes of it is said here.
            aria-disabled={saving || undefined}
            onClick={() => (saving ? undefined : onCancel())}
          >
            {t('token.cancel')}
          </button>
        ) : null}
        <span className="mrpr-status" aria-live="polite">
          {saving ? t('token.saving') : null}
        </span>
      </div>
      {serverToken ? (
        <div className="mrpr-token-where" role="radiogroup" aria-label={t('token.where')}>
          {[true, false].map((only) => (
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
      <p className="mrpr-status">
        {t(inMindroom ? 'token.noteMindroom' : 'token.note')}
        {inMindroom && token !== undefined ? ` ${t('token.noteForgets')}` : null}
      </p>
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
