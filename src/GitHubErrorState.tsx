import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { GitHubError } from './github';
import {
  RemoveServerToken,
  TokenForm,
  useGitHubAccess,
  useGitHubToken,
  usePanelTokenFormFor,
} from './token';

/** Why GitHub gave no answer, in one sentence, by the error and how GitHub is reached. */
export function useGitHubErrorMessage(error: unknown): string {
  const t = usePluginTranslation('pull-requests');
  const { via, connection } = useGitHubAccess();
  const kind = error instanceof GitHubError ? error.kind : 'failed';
  const status = error instanceof GitHubError ? error.status : 0;
  if (kind === 'failed') {
    return status === 0 ? t('error.failed') : t('error.failedStatus', { status });
  }
  if (kind === 'notFound' && via === 'token') return t('error.notFoundWithToken');
  if (via === 'server' && connection === 'token') {
    if (kind === 'notFound') return t('error.notFoundWithServerToken');
    if (kind === 'badToken') return t('error.badServerToken');
  }
  if (kind === 'notFound' && via === 'server') return t('error.notFoundWithServer');
  if (kind === 'badToken' && via === 'server') return t('error.badConnection');
  return t(`error.${kind}`);
}

/**
 * What the card and the panel say when GitHub's answer is no pull request: why, and what to do.
 * A part inside the panel's tabs is `compact`: the reason and a retry, and, where a token would
 * help, a button to the panel's one token form instead of a form of its own.
 */
export function GitHubErrorState({
  error,
  onRetry,
  compact = false,
  tokenForm = true,
}: {
  error: unknown;
  onRetry: () => void;
  compact?: boolean;
  /** Without its own token form for the token MindRoom cannot read: the panel shows that one. */
  tokenForm?: boolean;
}) {
  const t = usePluginTranslation('pull-requests');
  const { token, forget } = useGitHubToken();
  const { via, connection, unreadable, recheck } = useGitHubAccess();
  const focusTokenForm = usePanelTokenFormFor(compact ? error : undefined);
  const message = useGitHubErrorMessage(error);
  const hasToken = token !== undefined;
  const kind = error instanceof GitHubError ? error.kind : 'failed';
  const savedTokenNotFound = kind === 'notFound' && hasToken;
  const retry = (
    <button
      className="mrpr-button"
      type="button"
      // MindRoom is asked first whether GitHub is connected there: once that changed, everything
      // is read again with it, and this read too.
      onClick={() => void recheck().then((changed) => (changed ? undefined : onRetry()))}
    >
      {t('error.retry')}
    </button>
  );
  if (compact) {
    return (
      <div className="mrpr-error-compact">
        <p className="mrpr-status" role={kind === 'failed' ? undefined : 'alert'}>
          {message}
        </p>
        {retry}
        {focusTokenForm ? (
          <button type="button" className="mrpr-link-button" onClick={focusTokenForm}>
            {t('token.add')}
          </button>
        ) : null}
      </div>
    );
  }
  // The token MindRoom cannot read is what to mend, beside a read that failed of itself, which
  // may work again; any other answer without it says little, and asking again gets the same.
  const mend = unreadable && tokenForm ? <TokenForm reason="unreadable" /> : null;
  if (kind === 'failed') {
    return (
      <div>
        <p className="mrpr-status">{message}</p>
        {retry}
        {mend}
      </div>
    );
  }
  if (unreadable) return mend && <div>{mend}</div>;
  // MindRoom's connection has a token's limit: another token would not raise it.
  if (kind === 'rateLimited' && via !== undefined) {
    return (
      <p className="mrpr-status" role="alert">
        {message}
      </p>
    );
  }
  return (
    <div>
      <p className="mrpr-status" role="alert">
        {message}
      </p>
      {hasToken && (kind === 'badToken' || savedTokenNotFound) ? (
        <button className="mrpr-button" type="button" onClick={forget}>
          {t('token.forget')}
        </button>
      ) : null}
      {/* The token saved in MindRoom comes before the App, and nothing loads while it fails. */}
      {via === 'server' &&
      connection === 'token' &&
      (kind === 'badToken' || kind === 'notFound') ? (
        <p className="mrpr-status">
          <RemoveServerToken />
        </p>
      ) : null}
      <TokenForm
        reason={
          savedTokenNotFound
            ? 'badToken'
            : kind === 'badToken' && via === 'server'
            ? 'override'
            : kind
        }
      />
    </div>
  );
}
