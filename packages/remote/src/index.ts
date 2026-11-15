/** @your-bot/remote: TLS WebSocket remote host, device pairing, and remote clients. */
export { createRemoteHost, DEFAULT_LIMITS, type RemoteHost, type RemoteHostOptions, type RemoteHostLimits } from './server.js';
export {
  RemoteTransport, RemoteError, Link, connectPinned, connectDevice, pairWithCode, credentialsFrom,
  type BackendTransportV2, type DeviceCredentials, type PairedHost, type ReadyInfo, type RemoteTransportOptions, type TransportStatus,
} from './client.js';
export { HostDirectory, type SavedHost, type StoredKey } from './directory.js';
export { MultiHostClient, type HostState, type PendingApproval } from './multi.js';
export { runCli, configDirectory, type CliIO } from './cli.js';
export {
  PROTOCOL, WS_PATH, MAX_FRAME_BYTES, CLOSE, ALL_CAPABILITIES_V2, DEFAULT_DEVICE_CAPABILITIES,
  authMessage, encodePairingCode, decodePairingCode, type PairingPayload, type ServerFrame, type ClientFrame,
} from './protocol.js';
export { certificateFingerprint, normalizeFingerprint, createSelfSignedCertificate } from './certificate.js';
export { parseRemoteCommand, OWNER_ONLY_COMMANDS } from './validation.js';
