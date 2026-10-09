import { app } from 'electron';
import { createDesktopHost, type GatewayFactory } from './host';
/** Production integration replaces this factory. This executable fails visibly closed. */
const disconnectedFactory: GatewayFactory = () => ({
  async dispatch(command) { return { ok: false, commandId: command.id, error: { code: 'DISCONNECTED', message: 'No gateway is connected. Wire createDesktopHost({ gatewayFactory }) to your backend.', retryable: true } }; },
  subscribe() { return () => {}; },
  async requestPermission() { throw new Error('No gateway is connected'); },
  async cancelTask() {}, async close() {},
});
createDesktopHost({ gatewayFactory: disconnectedFactory, developmentURL: process.env.YOUR_BOT_RENDERER_URL }).catch(error => { console.error('Desktop startup failed', error); app.exit(1); });
app.on('window-all-closed', () => app.quit());
