export default {
  name: 'local-agent-confirmation', entry: './fixture.tsx', viewport: { width: 900, height: 650 },
  real: 'permissionCopy, LocalAgentConfirmationHost, ConfirmDialogProvider and themed ConfirmDialog',
  stubs: {
    'src/main/i18n': 'import i18n from "@/i18n"; export const t = key => i18n.t(key);',
  },
  notCovered: 'Main IPC sender validation and actual API grants are verified separately in service and isolated Desktop checks.',
  cases: {
    default: { about: 'Approve through the shared themed confirmation', data: { action: 'allow' } },
    observation: { about: 'Read-only approval discloses existing and future sessions, not execution', data: { action: 'allow', permissions: ['tasks:read'] } },
    combined: { about: 'Combined approval discloses both permissions', data: { action: 'allow', permissions: ['agent:execute', 'tasks:read'] } },
    'revoke-observation': { about: 'Revoking observation leaves observed sessions running', data: { action: 'revoke', permissions: ['tasks:read'] } },
    'revoke-combined': { about: 'Revoking both only stops connection-owned executions', data: { action: 'revoke', permissions: ['agent:execute', 'tasks:read'] } },
    'revoke-all': { about: 'All-grant disclosure distinguishes executions from observed sessions', data: { action: 'revoke', all: true } },
    cancel: { about: 'Cancel returns a negative decision', data: { action: 'cancel' } },
    escape: { about: 'Escape dismisses without granting', data: { action: 'escape' } },
    revoke: { about: 'Confirm revocation with the existing localized copy', data: { action: 'revoke' } },
    abort: { about: 'Main dismissal cannot yield a late approval', data: { action: 'abort' } },
    queued: { about: 'Cancelling the first request preserves the second', data: { action: 'queued' } },
    narrow: { about: 'Combined permissions and long unverified identity wrap at 320px', viewport: { width: 320, height: 640 }, data: { action: 'allow', long: true, permissions: ['agent:execute', 'tasks:read'] } },
  },
  async check(page, ui) {
    const app = ui.data.long ? 'ApplicationWithAnUnbrokenLongName独立客户端'.repeat(3) : 'Notes';
    const revoke = ui.data.action === 'revoke';
    // Production copy + real dialog: the old execute-only fixture could not catch
    // a read-only request accidentally presenting execution authority (UI tier).
    const permissions = ui.data.permissions ?? ['agent:execute'];
    const request = revoke ? {
      requestId: 'first',
      title: await ui.t('localAgent.title'),
      message: await ui.t(ui.data.all ? 'localAgent.revokeMessage' : 'localAgent.revokeOneMessage', { app }),
      detail: await page.evaluate(permissions => window.localAgentRevokeDetail(permissions), ui.data.all ? undefined : permissions),
      confirmText: await ui.t('localAgent.revoke'),
      cancelText: await ui.t('localAgent.cancel'),
    } : await page.evaluate(({ app, permissions }) => ({
      requestId: 'first',
      ...window.localAgentPermissionConfirmation({ id: 'org.example.notes', name: app, version: '1.2' }, permissions),
    }), { app, permissions });
    const executeDetail = await ui.t(revoke ? (ui.data.all ? 'localAgent.revokeDetail' : 'localAgent.revokeOneDetail') : 'localAgent.connectDetail');
    const readDetail = await ui.t(revoke ? (ui.data.all ? 'localAgent.revokeReadDetail' : 'localAgent.revokeReadOneDetail') : 'localAgent.connectReadDetail');
    if (request.detail.includes(executeDetail) !== (Boolean(ui.data.all) || permissions.includes('agent:execute'))) throw new Error('Wrong execution disclosure');
    if (request.detail.includes(readDetail) !== (Boolean(ui.data.all) || permissions.includes('tasks:read'))) throw new Error('Wrong observation disclosure');
    if (!revoke) {
      const restricted = permissions.includes('tasks:read') && !permissions.includes('agent:execute');
      if (request.detail.includes(await ui.t('localAgent.readOnlyDetail')) !== restricted) throw new Error('Wrong read-only restrictions');
      if (!request.detail.includes(await ui.t('localAgent.clientIdentity', { id: 'org.example.notes', version: '1.2' }))) throw new Error('Missing unverified identity');
    }
    const emit = (name, payload) => page.evaluate(({ name, payload }) => window.__uiPage.emit(name, payload), { name, payload });
    await emit('confirmation', request);
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    const cancel = dialog.getByRole('button', { name: request.cancelText, exact: true });
    await cancel.waitFor();
    if (!(await cancel.evaluate(el => el === document.activeElement))) throw new Error('Cancel must receive initial focus');
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Tab');
      if (!(await dialog.evaluate(el => el.contains(document.activeElement)))) throw new Error('Focus escaped modal');
    }
    if (!(await dialog.evaluate(el => {
      const b = el.getBoundingClientRect();
      return b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight && el.scrollWidth <= el.clientWidth;
    }))) throw new Error('Dialog overflows viewport');
    if (ui.data.action === 'queued') {
      await emit('confirmation', { ...request, requestId: 'second' });
      await emit('dismiss', 'first');
      await page.waitForFunction(() => document.querySelector('[role=alertdialog]')?.getAttribute('data-state') === 'open');
      // Wait for the shared provider's exit/next transition, not a second modal implementation.
      // real-wait: shared production modal exit animation finishes before the next queue item.
      await page.waitForTimeout(250);
      await dialog.getByRole('button', { name: request.confirmText, exact: true }).click();
    } else if (ui.data.action === 'abort') await emit('dismiss', 'first');
    else if (ui.data.action === 'escape') await page.keyboard.press('Escape');
    else if (ui.data.action === 'cancel') await cancel.click();
    else await dialog.getByRole('button', { name: request.confirmText, exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const answers = await page.evaluate(() => window.answers ?? []);
    const expected = ui.data.action === 'abort' ? [] : [{
      requestId: ui.data.action === 'queued' ? 'second' : 'first',
      confirmed: !['cancel', 'escape'].includes(ui.data.action),
    }];
    if (JSON.stringify(answers) !== JSON.stringify(expected)) throw new Error('Wrong/late confirmation reply');
    // Leave the production dialog visible for the theme/locale screenshot and audit.
    await emit('confirmation', { ...request, requestId: 'screenshot' });
    await dialog.waitFor();
  },
};
