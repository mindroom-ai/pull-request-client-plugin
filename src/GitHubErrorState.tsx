import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { GitHubError } from './github';
import { TokenForm, useGitHubToken } from './token';

/** What the card and the panel say when GitHub's answer is no pull request: why, and what to do. */
export function GitHubErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const t = usePluginTranslation('pull-requests');
  const { token, forget } = useGitHubToken();
  const hasToken = token !== undefined;
  const kind = error instanceof GitHubError ? error.kind : 'failed';
  if (kind === 'failed') {
    const status = error instanceof GitHubError ? error.status : 0;
    return (
      <div>
        <p className="mrpr-status">
          {status === 0 ? t('error.failed') : t('error.failedStatus', { status })}
        </p>
        <button className="mrpr-button" type="button" onClick={onRetry}>
          {t('error.retry')}
        </button>
      </div>
    );
  }
  if (kind === 'rateLimited' && hasToken) {
    return (
      <p className="mrpr-status" role="alert">
        {t('error.rateLimited')}
      </p>
    );
  }
  const savedTokenNotFound = kind === 'notFound' && hasToken;
  return (
    <div>
      <p className="mrpr-status" role="alert">
        {savedTokenNotFound ? t('error.notFoundWithToken') : t(`error.${kind}`)}
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
