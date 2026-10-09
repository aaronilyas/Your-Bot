/** Frozen wire contract v1. All wire values are JSON serializable. */
export const CONTRACT_VERSION = 1 as const;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type SessionId = string;
export type TaskId = string;
export type CommandId = string;
export type Capability = 'conversation' | 'settings' | 'tool.execute' | 'file.read' | 'file.write' | 'file.delete' | 'library.install' | 'network' | 'process.spawn';
/** Created by the authenticated host, never accepted from the renderer. */
export interface Principal { id: string; kind: 'local' | 'remote'; capabilities: Capability[]; }
export interface FileScope { path: string; access: 'read' | 'write' | 'delete'; }
export interface PermissionRequest {
  id: string; principalId: string; sessionId: SessionId; taskId: TaskId;
  capability: Capability; reason: string; paths?: FileScope[]; packages?: string[];
}
export interface PermissionDecision {
  requestId: string; outcome: 'allow' | 'deny'; scope: 'once' | 'task';
}
/** Non-wire, core-issued authorization. Executors MUST validate all scopes. */
export interface AuthorizationContext {
  principal: Principal; sessionId: SessionId; taskId: TaskId; grants: PermissionRequest[];
}
export interface StructuredError { code: string; message: string; retryable?: boolean; }
export interface ChatMessage { id: string; role: 'user' | 'assistant' | 'tool'; content: string; createdAt: string; taskId?: TaskId; }
export interface Session { id: SessionId; title: string; agentId: string; modelId?: string; createdAt: string; updatedAt: string; messages: ChatMessage[]; }
export interface ModelInfo { id: string; name: string; }
export interface AgentInfo { id: string; name: string; kind: 'acp' | 'local'; models: ModelInfo[]; available: boolean; limitation?: string; }
export interface ProviderConfig {
  id: string; name: string; kind: 'lmstudio' | 'llamacpp' | 'openai-compatible' | 'acp';
  endpoint?: string; modelId?: string; apiKey?: string; command?: string; args?: string[];
  /** ACP launch is only enabled with an enforced containment implementation. */
  enabled: boolean;
}
export interface AppSettings { providers: ProviderConfig[]; }
export interface AppSnapshot { sessions: Session[]; agents: AgentInfo[]; settings: AppSettings; activeTasks: {id: TaskId; sessionId: SessionId}[]; pendingPermissions: PermissionRequest[]; lastSequence: number; }
export type CommandPayload =
  | { type: 'state.sync'; afterSequence?: number }
  | { type: 'session.create'; title?: string; agentId: string; modelId?: string }
  | { type: 'session.open'; sessionId: SessionId }
  | { type: 'session.delete'; sessionId: SessionId }
  | { type: 'session.selectAgent'; sessionId: SessionId; agentId: string; modelId?: string }
  | { type: 'message.send'; sessionId: SessionId; content: string }
  | { type: 'task.cancel'; taskId: TaskId }
  | { type: 'permission.decide'; decision: PermissionDecision }
  | { type: 'settings.update'; settings: AppSettings }
  | { type: 'models.refresh'; agentId?: string }
  | { type: 'tool.run'; sessionId: SessionId; invocation: ToolInvocation };
export type DesktopCommand = CommandPayload & { version: 1; id: CommandId };
export type CommandResult = { ok: true; commandId: CommandId; sessionId?: SessionId; taskId?: TaskId; snapshot?: AppSnapshot; session?: Session } | { ok: false; commandId: CommandId; error: StructuredError };
export type EventPayload =
  | { type: 'state.snapshot'; snapshot: AppSnapshot }
  | { type: 'session.updated'; session: Session }
  | { type: 'session.deleted'; sessionId: SessionId }
  | { type: 'task.started'; taskId: TaskId; sessionId: SessionId }
  | { type: 'message.delta'; taskId: TaskId; sessionId: SessionId; text: string }
  | { type: 'task.status'; taskId: TaskId; sessionId: SessionId; status: string }
  | { type: 'task.completed'; taskId: TaskId; sessionId: SessionId }
  | { type: 'task.cancelled'; taskId: TaskId; sessionId: SessionId }
  | { type: 'task.failed'; taskId: TaskId; sessionId: SessionId; error: StructuredError }
  | { type: 'permission.requested'; request: PermissionRequest }
  | { type: 'permission.resolved'; requestId: string; outcome: 'allow' | 'deny' }
  | { type: 'tool.output'; taskId: TaskId; sessionId: SessionId; toolCallId: string; stream: 'stdout' | 'stderr' | 'status'; text: string }
  | { type: 'agents.updated'; agents: AgentInfo[] };
export type DesktopEvent = EventPayload & { version: 1; sequence: number; timestamp: string; principalId: string };
export type Unsubscribe = () => void;
export interface BackendTransport {
  dispatch(command: DesktopCommand): Promise<CommandResult>;
  subscribe(listener: (event: DesktopEvent) => void): Unsubscribe;
  close?(): Promise<void>;
}
export interface DesktopGateway {
  dispatch(command: DesktopCommand, principal: Principal): Promise<CommandResult>;
  subscribe(listener: (event: DesktopEvent) => void, principal: Principal): Unsubscribe;
  requestPermission(request: PermissionRequest): Promise<PermissionDecision>;
  cancelTask(taskId: TaskId, principal: Principal): Promise<void>;
  close(): Promise<void>;
}
export interface ToolInvocation {
  id: string; kind: 'skill' | 'python' | 'library.install'; skillId?: string;
  input: JsonValue; code?: string; packages?: string[]; paths?: FileScope[]; timeoutMs?: number;
}
export interface ToolResult { ok: boolean; value?: JsonValue; error?: StructuredError; }
export interface ToolExecutionContext {
  authorization: AuthorizationContext; signal: AbortSignal;
  requestPermission(request: Omit<PermissionRequest, 'id' | 'principalId' | 'sessionId' | 'taskId'>): Promise<PermissionDecision>;
  emit(output: {stream: 'stdout' | 'stderr' | 'status'; text: string}): void;
}
export interface ToolExecutor {
  execute(invocation: ToolInvocation, context: ToolExecutionContext): Promise<ToolResult>;
  cancel(taskId: TaskId): Promise<void>;
  close(): Promise<void>;
}
export type AgentUpdate = {type:'text';text:string} | {type:'status';status:string} | {type:'tool';invocation:ToolInvocation};
export interface AgentRunContext {
  session: Session; taskId: TaskId; principal: Principal; signal: AbortSignal;
  emit(update: AgentUpdate): void;
  executeTool(invocation: ToolInvocation): Promise<ToolResult>;
  requestPermission(request: Omit<PermissionRequest, 'id' | 'principalId' | 'sessionId' | 'taskId'>): Promise<PermissionDecision>;
}
export interface AgentAdapter {
  readonly id: string;
  getInfo(): Promise<AgentInfo>;
  run(context: AgentRunContext): Promise<void>;
  cancel(taskId: TaskId): Promise<void>;
  close(): Promise<void>;
}
