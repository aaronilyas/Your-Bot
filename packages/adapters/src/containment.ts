import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { PermissionRequest } from '@your-bot/contracts';

/** Host-owned launch input. No parent environment, API key, host cwd or user home is supplied. */
export interface HarnessLaunchRequest {
  command: string;
  args: readonly string[];
  signal: AbortSignal;
}

export interface NativePermissionPlan {
  request: Omit<PermissionRequest, 'id' | 'principalId' | 'sessionId' | 'taskId'>;
  /** Must enforce this exact operation at the OS boundary, once, without broadening any scope.
   * The plan/operation must be revoked on signal abort or harness termination.
   * Return false if the containment cannot safely apply the decision.
   */
  allowOnce(signal: AbortSignal): Promise<boolean>;
}

export interface ContainedHarness {
  process: ChildProcessWithoutNullStreams;
  /** Absolute path INSIDE the sandbox to private scratch; never the user's project/home. */
  cwd: string;
  /** Must terminate the complete containment, including descendants, and release scratch. */
  terminate(): Promise<void>;
  /** Optional trusted OS-enforcement bridge. Absent: all native ACP permissions are denied.
   * Do not infer enforceability from the harness's tool name/kind or capability advertisement.
   */
  preparePermission?(toolCall: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<NativePermissionPlan | undefined>;
}

/** A trusted host capability, not data from ProviderConfig or a harness attestation.
 * Implementation MUST use an OS sandbox (e.g. Linux bubblewrap + seccomp): readonly
 * minimal runtime, private scratch, no user home, no inherited secrets, no shell
 * tools, bounded resources, scoped networking, and complete descendant teardown.
 * Bare spawn(), shell:false, capability negotiation and env:{} are NOT containment.
 * launch must honor abort and clean up even if aborted before returning its handle.
 */
export interface ContainmentLauncher {
  launch(request: HarnessLaunchRequest): Promise<ContainedHarness>;
}
