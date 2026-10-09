# Contract v1 integration observations (no frozen contract edits)

Two limitations need explicit parent/core handling. Neither blocks integration
against b133e1d; the package implements conservative behavior today.

1. `executeTool(invocation)` and `requestPermission(request)` cannot receive an
   adapter-owned deadline/abort signal. The adapter stops waiting on its internal
   timeout, but cannot stop an already running core operation or revoke its pending
   approval. Core should abort the task executor and retire pending approvals when
   any `run()` rejects, including `TIMEOUT`, not only on explicit task.cancel.
   A future additive callback signal parameter could eliminate this gap.

2. Stored `ChatMessage` has no tool call ID, function invocation or ACP opaque
   session metadata. Local adapters replay historical tool messages as labelled
   context, and ACP creates a fresh session with a transcript each turn. Exact
   structured tool replay and native harness continuation would require optional
   persistence fields or an opaque adapter state store.

Standard ACP native tool permission metadata is informational and cannot be
converted into an enforceable blanket grant. This is not a contract bug: either
provide the trusted containment-specific once-operation plan or use the explicit
Your Bot tool extension that routes execution through core. All filesystem and
terminal client RPCs remain refused.
