import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { pluginRootStyle } from './theme';

// Placeholder: the panel with the files and their diffs replaces it.
export default function PullRequestPanel() {
  const t = usePluginTranslation('pull-requests');
  return (
    <div className="mrpr-root" style={pluginRootStyle()}>
      <p className="mrpr-status">{t('emptyPanel')}</p>
    </div>
  );
}
