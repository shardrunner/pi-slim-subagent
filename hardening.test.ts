import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import type { PromptOptions } from "@earendil-works/pi-coding-agent";
import { ActiveRunRegistry } from "./run-registry.ts";
import {
	boundText,
	collectSdkTask,
	createEmptyUsage,
	type SdkTaskRequest,
	type SessionLike,
} from "./sdk-runner-core.ts";
import { runParallel } from "./sdk-orchestration-core.ts";

const agent = {
	name: "test",
	description: "test",
	source: "user" as const,
	filePath: "/tmp/test.md",
	systemPrompt: "",
};
const request: SdkTaskRequest = { agent, task: "test", cwd: tmpdir(), timeoutSeconds: 0.01 };

test("line and byte bounds hold even for very small budgets", () => {
	for (let maxLines = 1; maxLines < 8; maxLines++) {
		for (let maxBytes = 1; maxBytes < 100; maxBytes++) {
			const bounded = boundText("😀\na\nb\nc\nd\ne\nf\ng", { maxLines, maxBytes });
			assert.ok(bounded.split("\n").length <= maxLines);
			assert.ok(Buffer.byteLength(bounded) <= maxBytes);
		}
	}
});

test("active parallel updates never advertise a successful completion", async () => {
	let sawUpdate = false;
	await runParallel({
		defaultCwd: tmpdir(),
		agents: [agent],
		sdkServices: { modelRuntime: {} as import("@earendil-works/pi-coding-agent").ModelRuntime },
		tasks: [{ agent: "test", task: "test" }],
		runTask: async (_request, _services, update) => {
			const result = {
				exitCode: 0,
				messages: [],
				trace: [],
				usage: createEmptyUsage(),
				timedOut: false,
				aborted: false,
				timing: { setupMs: 0, totalMs: 0, timedOut: false },
			};
			update?.({ ...result, streamingText: "working" });
			return result;
		},
		onUpdate: (results) => {
			if (results[0].streamingText) {
				sawUpdate = true;
				assert.equal(results[0].state, "running");
			}
		},
	});
	assert.ok(sawUpdate);
});

test("cancelled uncooperative prompts return with tracked late cleanup", async () => {
	let finish!: () => void;
	let disposed = false;
	const session: SessionLike = {
		subscribe: () => () => {},
		prompt: () =>
			new Promise<void>((r) => {
				finish = r;
			}),
		abort: async () => {},
		dispose: () => {
			disposed = true;
		},
	};
	const result = await collectSdkTask(request, session, undefined, { cleanupGraceMs: 5 });
	assert.equal(result.timedOut, true);
	assert.ok(result.settlement);
	assert.equal(disposed, false);
	finish();
	await result.settlement;
	assert.equal(disposed, true);
});

for (const cause of ["aborted", "timedOut"] as const) {
	for (const late of [false, true]) {
		test(`cancellation during prompt preparation prevents execution (${cause}, late=${late})`, async () => {
			const controller = new AbortController();
			let startPreparation!: () => void;
			let finishPreparation!: () => void;
			let observeAbort!: () => void;
			const preparing = new Promise<void>((resolve) => {
				startPreparation = resolve;
			});
			const prepared = new Promise<void>((resolve) => {
				finishPreparation = resolve;
			});
			const aborted = new Promise<void>((resolve) => {
				observeAbort = resolve;
			});
			let executed = false;
			let disposed = false;
			const session: SessionLike = {
				subscribe: () => () => {},
				async prompt(_text: string, options?: PromptOptions) {
					startPreparation();
					await prepared;
					options?.preflightResult?.("started");
					executed = true;
				},
				async abort() {
					observeAbort(); // No active run exists to abort yet.
				},
				dispose() {
					disposed = true;
				},
			};
			const pending = collectSdkTask(
				{ ...request, signal: controller.signal, timeoutSeconds: cause === "timedOut" ? 0.01 : 0 },
				session,
				undefined,
				{ cleanupGraceMs: late ? 0 : 1000 },
			);
			await preparing;
			if (cause === "aborted") controller.abort();
			await aborted;
			if (!late) finishPreparation();
			const result = await pending;
			const snapshot = JSON.stringify(result);
			if (late) {
				assert.ok(result.settlement);
				assert.equal(disposed, false);
				finishPreparation();
				await result.settlement;
			}
			assert.equal(executed, false);
			assert.equal(disposed, true);
			assert.equal(result[cause], true);
			assert.equal(result.exitCode, 1);
			assert.equal(JSON.stringify(result), snapshot);
		});
	}
}

for (const disposition of ["handled", "queued"] as const) {
	test(`prompt preflight ${disposition} is a failed leaf dispatch without agent events`, async () => {
		let disposed = false;
		const session: SessionLike = {
			subscribe: () => () => {},
			async prompt(_text: string, options?: PromptOptions) {
				options?.preflightResult?.(disposition);
			},
			abort: async () => {},
			dispose: () => {
				disposed = true;
			},
		};
		const result = await collectSdkTask({ ...request, timeoutSeconds: 0 }, session);
		assert.equal(result.exitCode, 1);
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", new RegExp(`prompt was ${disposition}; expected started`));
		assert.deepEqual(result.messages, []);
		assert.equal(disposed, true);
	});
}

test("unsettled disposal is bounded and late cleanup cannot mutate the result", async () => {
	let dispose!: () => void;
	const session: SessionLike = {
		subscribe: () => () => {},
		prompt: async () => {},
		abort: async () => {},
		dispose: () =>
			new Promise<void>((resolve) => {
				dispose = resolve;
			}),
	};
	const result = await collectSdkTask({ ...request, timeoutSeconds: 1 }, session, undefined, { cleanupGraceMs: 5 });
	assert.equal(result.exitCode, 1);
	assert.ok(result.settlement);
	const snapshot = JSON.stringify(result);
	dispose();
	await result.settlement;
	assert.equal(JSON.stringify(result), snapshot);
});

test("session shutdown preserves unsettled run evidence until its owner finishes", () => {
	const registry = new ActiveRunRegistry();
	const handle = registry.start({ agent: "test", task: "test", cwd: tmpdir(), timeoutSeconds: 1 });
	handle.observeEvent({ phase: "cleanup" });
	registry.shutdown({ preserveActive: true });
	assert.equal(registry.get(handle.runId).phase, "cleanup");
	handle.finish();
	assert.deepEqual(registry.list(), []);
	registry.shutdown();
});

test("collector retention bounds multi-part messages and never serializes tool payloads", async () => {
	let listener: ((event: import("./sdk-runner-core.ts").AgentSessionEvent) => void) | undefined;
	let payloadReads = 0;
	const payload = {
		toJSON() {
			payloadReads++;
			throw new Error("must not serialize");
		},
	};
	const session: SessionLike = {
		subscribe: (callback) => {
			listener = callback;
			return () => {};
		},
		prompt: async () => {
			listener!({ type: "tool_execution_start", toolName: "read", args: payload });
			listener!({ type: "tool_execution_end", toolName: "read", result: payload });
			for (let i = 0; i < 40; i++)
				listener!({
					type: "message_end",
					message: {
						role: "assistant",
						content: Array.from({ length: 32 }, () => ({ type: "text", text: "x".repeat(30_000) })),
					},
				});
		},
		abort: async () => {},
		dispose: () => {},
	};
	const result = await collectSdkTask({ ...request, timeoutSeconds: 1 }, session);
	assert.ok(result.messages.length <= 32);
	assert.ok(Buffer.byteLength(JSON.stringify(result.messages)) <= 64 * 1024);
	assert.equal(payloadReads, 0);
	assert.deepEqual(result.trace, ["tool started: read", "tool completed: read"]);
});
