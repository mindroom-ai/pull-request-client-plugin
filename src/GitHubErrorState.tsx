import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { GitHubError } from './github';
import { TokenForm, useGitHubToken, usePanelTokenFormFor } from './token';

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
  const focusTokenForm = usePanelTokenFormFor(compact ? error : undefined);
  const hasToken = token !== undefined;
  const kind = error instanceof GitHubError ? error.kind : 'failed';
  const status = error instanceof GitHubError ? error.status : 0;
  const savedTokenNotFound = kind === 'notFound' && hasToken;
  const message =
    kind === 'failed'
      ? status === 0
        ? t('error.failed')
        : t('error.failedStatus', { status })
      : savedTokenNotFound
      ? t('error.notFoundWithToken')
      : t(`error.${kind}`);
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
  if (kind === 'rateLimited' && hasToken) {
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
