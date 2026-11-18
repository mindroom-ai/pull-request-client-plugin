import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { GitHubError } from './github';
import {
  RemoveServerToken,
  TokenForm,
  type TokenFormReason,
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
 * Why a token form shows beside `error`, the view of a read that gave no pull request, or none:
 * the token MindRoom cannot read is what to mend, beside any failure; a read that failed of itself
 * (no answer, or GitHub's own error) takes none, nor a rate limit that another token would not
 * raise (MindRoom's connection has a token's).
 */
export function useErrorTokenReason(error: unknown): TokenFormReason | undefined {
  const { token } = useGitHubToken();
  const { via, unreadable } = useGitHubAccess();
  const kind = error instanceof GitHubError ? error.kind : 'failed';
  if (unreadable) return 'unreadable';
  if (kind === 'failed' || (kind === 'rateLimited' && via !== undefined)) return undefined;
  if (kind === 'notFound' && token !== undefined) return 'badToken';
  return kind === 'badToken' && via === 'server' ? 'override' : kind;
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
  withTokenForm = true,
}: {
  error: unknown;
  onRetry: () => void;
  compact?: boolean;
  /** Without a token form of its own: the panel's one shows where it would (`useErrorTokenReason`). */
  withTokenForm?: boolean;
}) {
  const t = usePluginTranslation('pull-requests');
  const { token, forget } = useGitHubToken();
  const { via, connection, unreadable, recheck } = useGitHubAccess();
  const focusTokenForm = usePanelTokenFormFor(compact ? error : undefined);
  const message = useGitHubErrorMessage(error);
  const reason = useErrorTokenReason(error);
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
  const form = withTokenForm && reason ? <TokenForm reason={reason} /> : null;
  if (kind === 'failed') {
    return (
      <div>
        <p className="mrpr-status">{message}</p>
        {retry}
        {form}
      </div>
    );
  }
  // Any other answer without the token MindRoom cannot read says little, and asking again gets
  // the same.
  if (unreadable) return form && <div>{form}</div>;
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
      {form}
    </div>
  );
}
