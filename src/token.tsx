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
  type Ref,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePluginStorage, usePluginTranslation } from '@mindroom/client-sdk/core';
import { GitHubError } from './github';

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

export function TokenForm({
  reason,
  inputRef,
}: {
  reason: 'notFound' | 'rateLimited' | 'badToken';
  inputRef?: Ref<HTMLInputElement>;
}) {
  const t = usePluginTranslation('pull-requests');
  const { setToken } = useGitHubToken();
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
  const { token } = useGitHubToken();
  const kind = error instanceof GitHubError ? error.kind : undefined;
  const reason =
    token === undefined && (kind === 'notFound' || kind === 'rateLimited') ? kind : undefined;
  useEffect(() => (form && reason ? form.need(reason) : undefined), [form, reason]);
  return form && reason ? form.focus : undefined;
}
