# Architecture and trade-offs

## Execution path

```text
Pi parent session
  ├─ compact subagent tool
  └─ advanced loader → advanced tool
            │
            ▼
     validate request, agents, cwd and continuation ownership
            │
            ▼
     FIFO admission control (4 shared slots)
            │
            ▼
     active-run registry → /agents (no model call)
            │
            ▼
     lazy shared ModelRuntime
            │
            ▼
     SDK child session
       ├─ fresh: in-memory session
       ├─ continuation: private JSONL + instance-local lock
       └─ no child extensions or skills
            │
            ▼
     collector → bounded handoff + lifecycle state + usage
            │
            ▼
     renderer / parent tool result
```

## Why in-process SDK sessions?

The SDK avoids spawning another Pi process per task and makes lifecycle events, usage, cancellation, and session persistence directly available. A lazy runtime avoids initialization until the first actual dispatch; concurrent first callers share initialization.

The trade-off is weaker failure isolation. A blocked event loop or uncooperative tool can affect the host. This design provides cooperative cancellation and bounded waiting, not process termination. A subprocess/container backend would be a different, valid design when hard isolation matters more than integration overhead. There are no published speedup claims for this implementation.

## Separation of concerns

| Module                      | Responsibility                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `agents.ts`                 | Runtime-validated frontmatter, discovery, scope precedence                                      |
| `index.ts`                  | Pi schemas, tool/command registration, request validation, parent-branch continuation selection |
| `sdk-orchestration-core.ts` | Single and parallel dispatch; explicit run states; usage adaptation                             |
| `scheduler.ts`              | Shared FIFO admission and abortable queue                                                       |
| `sdk-runner.ts`             | SDK construction, shared services, continuation commitment                                      |
| `sdk-runner-core.ts`        | Event collection, cancellation, retention and text bounds                                       |
| `continuation.ts`           | Strict records, path/owner/ancestry validation, in-memory contention guard                      |
| `run-registry.ts`           | Instance-local in-memory run snapshots and bounded tails                                        |
| `handoffs.ts`               | Fair parallel output allocation                                                                 |
| `renderers.ts`              | TUI presentation independent of execution                                                       |
| `implement-review.ts`       | Generated guided workflow, not a state machine                                                  |

## Cancellation contract

1. Admit a task, then start its deadline before service/session setup.
2. A timeout or parent abort wins once; subsequent cancellation sources cannot change its classification.
3. Setup cancellation returns promptly and observes late setup fulfillment/rejection.
4. Running cancellation requests SDK abort and waits for a bounded grace period. The SDK prompt preflight callback checks the same cancellation state synchronously before agent execution, preventing delayed authentication or pre-prompt compaction from starting a new run after cancellation, even after the tool result has returned.
5. If the prompt is unsettled, defer disposal until it settles. If abort/disposal is unsettled, retain its promise.
6. Return a stable failure; retain the run registration, scheduler slot, and instance-local continuation lock until cleanup actually completes. Late errors go to an isolated diagnostic sink.
7. Mark retained slots quarantined. If every slot is quarantined, reject existing waiters and new admissions instead of hanging batches behind unsettled work. A slot becomes available only after actual settlement.

A timeout is not proof that file writes stopped. Repeating a task while its prior instance remains active can duplicate side effects. Queue waiting is cancellable but does not consume the task's execution deadline.

## Continuation commitment

The parent stores only an accepted continuation pointer in tool-result details. The child transcript is independently persisted by Pi. After an accepted turn, the runner reopens that transcript and verifies:

- the expected child session identity and cwd;
- complete, cycle-free ancestry and the expected prior leaf;
- a new segment containing the accepted user task and a completed assistant response;
- stable canonical agent definition and child file paths.

Only then does the tool return a new pointer. A failed dispatch returns no new continuation pointer. Resume branches from the parent's last accepted leaf rather than trusting the child's latest physical entry. Failed branches may remain in the transcript; filesystem effects are never reverted.

This is not an atomic transaction spanning two session files. A crash after child persistence but before the parent result is committed can leave an unreferenced child branch/file. The previous accepted pointer remains the recovery anchor. Avoid concurrent independent writers to a parent session.

## Boundaries and observability

- Lifecycle state is explicit, not inferred from a partially populated exit code.
- Parallel handoffs reserve status for every agent before distributing output space. A verbose early result cannot erase a later failure.
- Tool traces contain names/events only; payloads and private reasoning are not serialized into them.
- Multipart assistant text shares one aggregate byte/line budget and marks omitted text. Streaming truncation uses explicit state, never a marker-string comparison.
- Collector text/messages are bounded before being retained. This does not cap the SDK's own context or allocations made by a provider/tool before it emits an event.
- Run snapshots and tails are instance-local and in memory; there are no registry files, heartbeat timers, or stale-owner detection. A replacement instance cannot inspect retired-instance runs. Absence of a record is not proof that work stopped.

## Verification strategy

Offline tests cover helper invariants and injected failures, run admission, instance-local continuation exclusion through settlement, behavioral rendering, registered tool execution with Pi's deterministic faux provider, continuation reload, and unpacked-package loading through Pi's resource loader. Source-text regex checks are not used as a substitute for tool execution tests.

Live provider behavior remains an opt-in smoke check; SDK/provider cooperation and shell descendant cleanup cannot be proven by fake-provider tests alone.

## Deliberate non-goals

These were considered and left out on purpose. Revisit them only for a reproduced bug, a Pi lifecycle/API change, or a new requirement.

- **No persistent run registry.** No disk snapshots, heartbeats, or stale-owner detection; `/agents` does not survive reload or restart.
- **No cross-process continuation.** The continuation lock is instance-local; there are no lease files or recovery daemon. Concurrent writers to one parent session are unsupported.
- **No quarantine expiry.** Elapsed time does not prove that work stopped, so only actual settlement releases a slot.
- **No fail-hard discovery.** Invalid definitions are skipped with warnings so healthy agents stay usable.
- **No chain mode.** Single and parallel dispatch cover the use cases; chains were removed.
- **No global configuration bag.** Each bound (handoff, retained messages, traces, tails) lives with the module that owns the data.
- **SDK layers stay separate.** Construction (`sdk-runner.ts`), event collection (`sdk-runner-core.ts`) and batch dispatch (`sdk-orchestration-core.ts`) have distinct responsibilities; merging them would not remove lifecycle states.
- **Benchmarks are opt-in tooling.** `sdk-smoke.ts` is excluded from the package and not imported at runtime.
