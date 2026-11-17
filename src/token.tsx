import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { usePluginStorage, usePluginTranslation } from '@mindroom/client-sdk/core';
import { useMindroomServer, type MindroomServer } from '@mindroom/client-sdk/server';
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
  const changed = useCallback(() => {
    notify();
    // What the old token (or none) was refused says nothing about the new one. A refusal is
    // not asked again when its part next shows (`retryOnMount: false`), which is right only
    // for the token that got it, so the refusals are forgotten: they are asked anew then.
    // Only those with nothing read: what shows stays on screen while it is read again.
    void queryClient.resetQueries({
      queryKey: ['pull-requests'],
      predicate: ({ state }) => state.status === 'error' && state.data === undefined,
    });
    // Results fetched with the old token (or none) may differ now. The queries read the stored
    // token as they fetch, so this refetch already uses the new one.
    void queryClient.invalidateQueries({ queryKey: ['pull-requests'] });
  }, [queryClient]);
  return useMemo(
    () => ({
      token,
      setToken: (value: string) => {
        storage.setItem(KEY, value);
        changed();
      },
      forget: () => {
        storage.removeItem(KEY);
        changed();
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

/** The room's MindRoom server, through which the parts inside may reach GitHub as the person. */
export const GitHubServerContext = createContext<MindroomServer | undefined>(undefined);

/** Gives the parts inside the MindRoom server of the room `roomId`, when it has one. */
export function RoomGitHub({ roomId, children }: { roomId: string; children: ReactNode }) {
  const server = useMindroomServer(roomId);
  return <GitHubServerContext.Provider value={server}>{children}</GitHubServerContext.Provider>;
}

type ServerStatus = { connected: boolean; login: string | undefined };

// Not under `pull-requests`, whose queries a new token asks again: the status is the server's.
const statusKey = (origin: string) => ['pull-requests-github-status', origin] as const;

// The connection changes when the person connects or disconnects GitHub in MindRoom, rarely.
const STATUS_STALE_TIME = 300_000;

async function readStatus(server: MindroomServer): Promise<ServerStatus> {
  const answer: unknown = await server.request('/api/github/status');
  const status = typeof answer === 'object' && answer !== null ? (answer as ServerStatus) : null;
  const login = status?.login;
  return {
    connected: status?.connected === true,
    login: typeof login === 'string' && login !== '' ? login : undefined,
  };
}

/**
 * Requests through `server` as the person's connected GitHub account. Once the server says that
 * connection is gone, the parts read without it, and the status is asked again once it is stale,
 * so that a server whose status and requests disagree cannot keep the parts switching.
 */
function viaServer(queryClient: QueryClient, server: MindroomServer): GitHubViaServer {
  return {
    server,
    disconnected: () =>
      queryClient.setQueryData<ServerStatus>(statusKey(server.origin), {
        connected: false,
        login: undefined,
      }),
  };
}

/** How the parts reach GitHub now, as `useGitHubAccess` gives it. */
export type GitHubAccess = {
  /** With the token stored in the browser, through MindRoom, or neither (anonymous, no writes). */
  via: 'token' | 'server' | undefined;
  /** The GitHub login connected in MindRoom, when the server named it. */
  login: string | undefined;
  /**
   * What the query keys carry of it, never a token: false without either, true with the token,
   * `server:<origin>` through MindRoom, so no two of them share what was read.
   */
  key: boolean | string;
  /** While the server has not said whether GitHub is connected there; nothing should read yet. */
  pending: boolean;
  /** How a request that starts now goes, for one that runs after the render that started it. */
  current(): GitHubAuth | undefined;
};

/** Whose GitHub account the requests through MindRoom use, while they go that way. */
export function GitHubConnectedNote() {
  const t = usePluginTranslation('pull-requests');
  const { via, login } = useGitHubAccess();
  if (via !== 'server') return null;
  return <>{login ? t('token.connected', { login }) : t('token.connectedNoLogin')}</>;
}

/**
 * How to reach GitHub: the token stored in the browser comes first; else, while the room's
 * MindRoom server says the person's GitHub account is connected there, through that server;
 * else anonymously. The server is asked once for the status, and not while a token is stored.
 */
export function useGitHubAccess(): GitHubAccess {
  const { token } = useGitHubToken();
  const storedToken = useStoredToken();
  const server = useContext(GitHubServerContext);
  const queryClient = useQueryClient();
  const origin = server?.origin ?? '';
  const status = useQuery({
    queryKey: statusKey(origin),
    queryFn: () => readStatus(server as MindroomServer),
    enabled: server !== undefined && token === undefined,
    staleTime: STATUS_STALE_TIME,
    retry: false,
    retryOnMount: false,
  });
  const connected = server !== undefined && token === undefined && status.data?.connected === true;
  const current = useCallback((): GitHubAuth | undefined => {
    const stored = storedToken();
    if (stored !== undefined) return stored;
    if (server === undefined) return undefined;
    const now = queryClient.getQueryData<ServerStatus>(statusKey(server.origin));
    return now?.connected ? viaServer(queryClient, server) : undefined;
  }, [queryClient, server, storedToken]);
  return useMemo(
    () => ({
      via: token !== undefined ? 'token' : connected ? 'server' : undefined,
      login: connected ? status.data?.login : undefined,
      key: token !== undefined ? true : connected ? `server:${origin}` : false,
      pending: server !== undefined && token === undefined && status.isPending,
      current,
    }),
    [connected, current, origin, server, status.data?.login, status.isPending, token]
  );
}

export function TokenForm({
  reason,
  inputRef,
}: {
  reason: 'notFound' | 'rateLimited' | 'badToken';
  inputRef?: Ref<HTMLInputElement>;
}) {
  const t = usePluginTranslation('pull-requests');
  const { setToken } = useGitHubToken();
  const { via } = useGitHubAccess();
  const [value, setValue] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed === '') return;
    setToken(trimmed);
    setValue('');
  };
  return (
    <form className="mrpr-token" onSubmit={submit}>
      {via === 'server' ? (
        <p className="mrpr-status">
          <GitHubConnectedNote /> {t('token.overrides')}
        </p>
      ) : null}
      <p className="mrpr-status">{t(`token.hint.${reason}`)}</p>
      <div className="mrpr-token-row">
        <input
          ref={inputRef}
          className="mrpr-input"
          type="password"
          autoComplete="off"
          aria-label={t('token.label')}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button className="mrpr-button" type="submit">
          {t('token.save')}
        </button>
      </div>
      <p className="mrpr-status">{t('token.note')}</p>
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
