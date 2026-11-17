import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { GitHubError } from './github';
import { TokenForm, useGitHubAccess, useGitHubToken, usePanelTokenFormFor } from './token';

/** Why GitHub gave no answer, in one sentence, by the error and how GitHub is reached. */
export function useGitHubErrorMessage(error: unknown): string {
  const t = usePluginTranslation('pull-requests');
  const { via } = useGitHubAccess();
  const kind = error instanceof GitHubError ? error.kind : 'failed';
  const status = error instanceof GitHubError ? error.status : 0;
  if (kind === 'failed') {
    return status === 0 ? t('error.failed') : t('error.failedStatus', { status });
  }
  if (kind === 'notFound' && via === 'token') return t('error.notFoundWithToken');
  if (kind === 'notFound' && via === 'server') return t('error.notFoundWithServer');
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
}: {
  error: unknown;
  onRetry: () => void;
  compact?: boolean;
}) {
  const t = usePluginTranslation('pull-requests');
  const { token, forget } = useGitHubToken();
  const { via } = useGitHubAccess();
  const focusTokenForm = usePanelTokenFormFor(compact ? error : undefined);
  const message = useGitHubErrorMessage(error);
  const hasToken = token !== undefined;
  const kind = error instanceof GitHubError ? error.kind : 'failed';
  const savedTokenNotFound = kind === 'notFound' && hasToken;
  const retry = (
    <button className="mrpr-button" type="button" onClick={onRetry}>
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
  if (kind === 'failed') {
    return (
      <div>
        <p className="mrpr-status">{message}</p>
        {retry}
      </div>
    );
  }
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
      {kind === 'badToken' || savedTokenNotFound ? (
        <button className="mrpr-button" type="button" onClick={forget}>
          {t('token.forget')}
        </button>
      ) : null}
      <TokenForm reason={savedTokenNotFound ? 'badToken' : kind} />
    </div>
  );
}
