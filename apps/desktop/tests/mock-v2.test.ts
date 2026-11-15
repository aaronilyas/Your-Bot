// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BackendTransportV2 } from '@your-bot/contracts';
import { App } from '../src/renderer/App';
import { createMockTransport } from '../src/mock/transport';

const transports: BackendTransportV2[] = [];
afterEach(async () => { cleanup(); await Promise.all(transports.splice(0).map(transport => transport.close?.())); });
async function setup() {
  const transport = createMockTransport({ chunkDelayMs: 1 }); transports.push(transport);
  render(createElement(App, { transport, demo: true }));
  await screen.findByText('Browser demo');
  return userEvent.setup();
}
const nav = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

describe('simulated v2 demo', () => {
  it('is clearly marked as simulated and groups conversations by bot', async () => {
    await setup();
    expect(screen.getByText(/Everything here is simulated/)).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Bot Coding bot (simulated)' })).getByText('Tidy the project (simulated)')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Bot Local assistant' })).getByText('A fresh perspective')).toBeTruthy();
  });
  it('turns “Always allow…” into a standing grant that silently covers the next matching request and is audited', async () => {
    const user = await setup();
    await user.click(screen.getByRole('button', { name: 'Tidy the project (simulated)' }));
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'please run the tests');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    const dialog = await screen.findByRole('dialog', { name: 'Your permission is needed' });
    expect(within(dialog).getByText('process.spawn')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Always allow…' }));
    await user.click(within(dialog).getByRole('button', { name: 'Always allow' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await screen.findByText(/permission flow is ready|Let’s make this concrete/, undefined, { timeout: 5000 });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop response' })).toBeNull(), { timeout: 5000 });
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'run the build again');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByText(/Simulated: allowed by your standing grant/);
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(nav('Permissions'));
    const grants = await screen.findByText(/command npm/);
    expect(grants).toBeTruthy();
    const log = await screen.findByRole('list', { name: 'Audit log' });
    await waitFor(() => expect(within(log).getAllByText('standing').length).toBeGreaterThan(0));
  });
  it('blocks a manual routine run on an approval that can be reviewed from the run list', async () => {
    const user = await setup();
    await user.click(nav('Routines'));
    await user.click(screen.getByRole('button', { name: 'Run Morning repo check now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Your permission is needed' });
    expect(within(dialog).getByRole('heading', { name: 'Routine run' })).toBeTruthy();
    expect(within(dialog).getByText('Morning repo check')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
    expect(within(nav('Notifications')).getByLabelText(/waiting/)).toBeTruthy();
    const card = screen.getByRole('article', { name: 'Routine Morning repo check' });
    await user.click(within(card).getByRole('button', { name: 'Runs' }));
    await user.click(await within(card).findByRole('button', { name: 'Review approval' }));
    await user.click(await screen.findByRole('button', { name: 'Allow once' }));
    await waitFor(() => expect(within(card).getAllByText('completed').length).toBeGreaterThan(1));
  });
  it('creates bots and pairs a simulated device', async () => {
    const user = await setup();
    await user.click(nav('Bots'));
    await user.click(screen.getByRole('button', { name: 'New bot' }));
    const dialog = await screen.findByRole('dialog', { name: 'New bot' });
    await user.type(within(dialog).getByLabelText('Name'), 'Scratch bot');
    await user.click(within(dialog).getByRole('button', { name: 'Create bot' }));
    await screen.findByRole('article', { name: 'Bot Scratch bot' });
    await user.click(nav('Devices'));
    await user.click(screen.getByRole('button', { name: 'Pair a device' }));
    expect(((await screen.findByLabelText('Pairing code')) as HTMLInputElement).value).toMatch(/^ybp1\.SIMULATED-NOT-A-REAL-CODE/);
  });
});
