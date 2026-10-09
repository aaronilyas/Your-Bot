// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/renderer/App';
import { createMockTransport } from '../src/mock/transport';
import type { BackendTransport } from '@your-bot/contracts';
const transports: BackendTransport[] = [];
afterEach(async () => { cleanup(); await Promise.all(transports.splice(0).map(transport => transport.close?.())); });
function setup() { const transport = createMockTransport({ chunkDelayMs: 1 }); transports.push(transport); const dispatch = vi.spyOn(transport, 'dispatch'); render(createElement(App, { transport, demo: true })); return { transport, dispatch, user: userEvent.setup() }; }
describe('conversation UI', () => {
  it('creates and switches sessions, sends and renders a streamed final response', async () => {
    const { user, dispatch } = setup();
    await screen.findByText('Browser demo');
    await user.click(screen.getByRole('button', { name: /New conversation/ }));
    await screen.findByRole('heading', { name: 'Where shall we begin?' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Agent' }), 'acp-demo');
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe('demo-code'));
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Help me plan');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByText(/Let’s make this concrete/);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop response' })).toBeNull());
    expect(screen.getAllByText(/Let’s make this concrete/)).toHaveLength(1);
    expect(dispatch.mock.calls.some(([command]) => command.type === 'session.selectAgent' && command.agentId === 'acp-demo')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'A fresh perspective' }));
    await screen.findByText(/Hello. I’m Your Bot/);
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('');
  });
  it('shows exact permission scope and sends only the selected decision', async () => {
    const { user, dispatch } = setup(); await screen.findByText('Browser demo');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Read my workspace');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    const dialog = await screen.findByRole('dialog', { name: 'Your permission is needed' });
    expect(within(dialog).getByText('/demo/workspace/README.md')).toBeTruthy();
    expect(within(dialog).getByText('file.read')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Allow once' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const decision = dispatch.mock.calls.map(([command]) => command).find(command => command.type === 'permission.decide');
    expect(decision?.type === 'permission.decide' && decision.decision).toEqual({ requestId: expect.any(String), outcome: 'allow', scope: 'once' });
    await screen.findByText(/permission flow is ready/);
    await user.click(screen.getByText(/Tool activity ·/));
    expect(screen.getByText(/Simulated read:/)).toBeTruthy();
  });
  it('denies approval and cancels without continuing simulated file work', async () => {
    const { user } = setup(); await screen.findByText('Browser demo');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Read a file');
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Deny' }));
    await screen.findByText('Cancelled');
    expect(screen.queryByText(/Simulated read:/)).toBeNull();
  });
  it('edits and saves endpoints through transport without exposing credentials', async () => {
    const { user, dispatch } = setup(); await screen.findByText('Browser demo');
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Provider settings' });
    await user.clear(within(dialog).getByLabelText('Endpoint'));
    await user.type(within(dialog).getByLabelText('Endpoint'), 'http://127.0.0.1:8080/v1');
    await user.click(within(dialog).getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const command = dispatch.mock.calls.map(([command]) => command).find(command => command.type === 'settings.update');
    expect(command?.type === 'settings.update' && command.settings.providers[0].endpoint).toBe('http://127.0.0.1:8080/v1');
    expect(JSON.stringify(command)).not.toContain('apiKey');
  });
  it('keeps drafts scoped to each session and confirms deletion', async () => {
    const { user } = setup(); await screen.findByText('Browser demo');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Unsent draft');
    await user.click(screen.getByRole('button', { name: /New conversation/ }));
    await screen.findByRole('heading', { name: 'Where shall we begin?' });
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('');
    await user.click(screen.getByRole('button', { name: 'A fresh perspective' }));
    await screen.findByText(/Hello. I’m Your Bot/);
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('Unsent draft');
    await user.click(screen.getByRole('button', { name: 'Delete A fresh perspective' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete conversation?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete conversation' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'A fresh perspective' })).toBeNull());
  });
  it('renders disconnected state and reconnects without allowing message submission', async () => {
    let connected = false;
    const mock = createMockTransport(); transports.push(mock);
    const transport: BackendTransport = { subscribe: mock.subscribe, dispatch: command => connected ? mock.dispatch(command) : Promise.resolve({ ok: false, commandId: command.id, error: { code: 'DISCONNECTED', message: 'Offline' } }) };
    render(createElement(App, { transport }));
    await screen.findByText('Offline');
    expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(true);
    connected = true; await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await screen.findByText('Backend connected');
  });
});
