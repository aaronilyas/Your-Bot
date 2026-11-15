import type { DesktopGateway, DesktopGatewayV2 } from '@your-bot/contracts';
import { Gateway, type GatewayOptions } from './gateway.js';

export type { GatewayOptions, AnyAgentAdapter } from './gateway.js';
export { ownerOf, publicBot } from './gateway.js';
export { isWithin } from './paths.js';

/**
 * v1 factory (unchanged contract): accepts only `version: 1` commands and v1 subscriptions, while
 * applying the same ownership, bot and authorization model internally.
 * Construct once in Electron main (or an authenticated transport host), never in the renderer.
 */
export async function createGateway(options: GatewayOptions): Promise<DesktopGateway> {
  return await open(options, false) as unknown as DesktopGateway;
}

/** v2 factory: accepts `version: 1 | 2` commands and `subscribe(..., {contractVersion: 2})`. */
export async function createGatewayV2(options: GatewayOptions): Promise<DesktopGatewayV2> {
  return await open(options, true) as unknown as DesktopGatewayV2;
}

async function open(options: GatewayOptions, acceptV2: boolean): Promise<Gateway> {
  const gateway = new Gateway(options, acceptV2);
  try { await gateway.initialize(); return gateway; }
  catch (error) { await gateway.close(); throw error; }
}
