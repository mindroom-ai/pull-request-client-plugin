import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { GitHubError } from './github';
import { TokenForm, useGitHubToken } from './token';

/** What the card and the panel say when GitHub's answer is no pull request: why, and what to do. */
export function GitHubErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const t = usePluginTranslation('pull-requests');
  const { forget } = useGitHubToken();
  const kind = error instanceof GitHubError ? error.kind : 'failed';
  if (kind === 'failed') {
    return (
      <div>
        <p className="mrpr-status">{t('error.failed')}</p>
        <button className="mrpr-button" type="button" onClick={onRetry}>
          {t('error.retry')}
        </button>
      </div>
    );
  }
  return (
    <div>
      <p className="mrpr-status" role="alert">
        {t(`error.${kind}`)}
      </p>
      {kind === 'badToken' ? (
        <button className="mrpr-button" type="button" onClick={forget}>
          {t('token.forget')}
        </button>
      ) : null}
      <TokenForm reason={kind} />
    </div>
  );
}
