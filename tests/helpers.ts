import type { BackendTransport, DesktopGateway, Principal } from '@your-bot/contracts';

/** Same gateway semantics as IPC; identity is bound outside the command payload. */
export function inProcessTransport(gateway: DesktopGateway, principal: Principal): BackendTransport {
  return {
    dispatch: command => gateway.dispatch(command, principal),
    subscribe: listener => gateway.subscribe(listener, principal),
  };
}

export const localPrincipal: Principal = {
  id: 'desktop-owner', kind: 'local',
  capabilities: ['conversation', 'settings', 'tool.execute', 'file.read', 'file.write', 'file.delete', 'library.install', 'network', 'process.spawn'],
};
