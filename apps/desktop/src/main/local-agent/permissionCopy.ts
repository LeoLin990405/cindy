import type { LocalAgentConfirmation, LocalAgentPermission } from '../../shared/localAgent.js';
import { t } from '../i18n.js';

type ConfirmationCopy = Omit<LocalAgentConfirmation, 'requestId'>;
type ClientIdentity = { id: string; name: string; version?: string };

/** Display only: permissions must come from the host's validated request, never UI defaults. */
export function localAgentPermissionConfirmation(
  client: ClientIdentity,
  permissions: readonly LocalAgentPermission[],
): ConfirmationCopy {
  const execute = permissions.includes('agent:execute');
  const read = permissions.includes('tasks:read');
  const details: string[] = [];
  // Keep the existing execute-only disclosure unchanged.
  if (execute) details.push(t('localAgent.connectDetail'));
  if (read) {
    details.push(t('localAgent.connectReadDetail'));
    if (!execute) details.push(t('localAgent.readOnlyDetail'));
  }
  details.push(t('localAgent.clientIdentity')
    .replaceAll('{{id}}', () => client.id)
    .replaceAll('{{version}}', () => client.version ?? '—'));
  return {
    title: t('localAgent.connectTitle'),
    message: t('localAgent.connectMessage').replaceAll('{{app}}', () => client.name),
    detail: details.join('\n\n'),
    confirmText: t('localAgent.allow'),
    cancelText: t('localAgent.cancel'),
  };
}

/** Undefined is the all-connections disclosure, not a default grant of authority. */
export function localAgentRevokeDetail(permissions?: readonly LocalAgentPermission[]): string {
  if (!permissions) {
    return `${t('localAgent.revokeDetail')}\n\n${t('localAgent.revokeReadDetail')}`;
  }
  const details: string[] = [];
  if (permissions.includes('agent:execute')) details.push(t('localAgent.revokeOneDetail'));
  if (permissions.includes('tasks:read')) details.push(t('localAgent.revokeReadOneDetail'));
  return details.join('\n\n');
}
