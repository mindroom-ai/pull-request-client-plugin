import { useCallback, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePluginStorage, usePluginTranslation } from '@mindroom/client-sdk/core';

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

export function TokenForm({ reason }: { reason: 'notFound' | 'rateLimited' | 'badToken' }) {
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
