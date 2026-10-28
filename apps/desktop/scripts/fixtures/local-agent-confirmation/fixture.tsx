import { mountPage, subscription } from '../../ui-page/harness';
import { LocalAgentConfirmationHost } from '../../../src/renderer/components/LocalAgentConfirmationHost';
import { localAgentPermissionConfirmation, localAgentRevokeDetail } from '../../../src/main/local-agent/permissionCopy';

Object.assign(window, { localAgentPermissionConfirmation, localAgentRevokeDetail });

mountPage({
  host: {
    localAgent: {
      onConfirmation: subscription('confirmation'),
      onConfirmationDismissed: subscription('dismiss'),
      answerConfirmation: async (requestId: string, confirmed: boolean) => {
        const state = window as unknown as { answers: unknown[] };
        (state.answers ??= []).push({ requestId, confirmed });
        return true;
      },
    },
  },
  render: () => <LocalAgentConfirmationHost />,
});
