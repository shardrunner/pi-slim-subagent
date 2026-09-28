import assert from "node:assert/strict";
import test from "node:test";
import { RunScheduler } from "./scheduler.ts";
import { getFinalOutput, runParallel } from "./sdk-orchestration-core.ts";
import {
	collectSdkTask,
	createEmptyUsage,
	sanitizeAssistantMessage,
	FINAL_HANDOFF_MAX_BYTES,
	FINAL_HANDOFF_MAX_LINES,
	type AgentSessionEvent,
	type SessionLike,
} from "./sdk-runner-core.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const agent = {
	name: "test",
	description: "test",
	source: "user" as const,
	filePath: "/tmp/test.md",
	systemPrompt: "",
};

test("a batch returns failures instead of waiting behind quarantined capacity", async () => {
	const controller = new AbortController();
	const scheduler = new RunScheduler(4);
	let settle!: () => void;
	const settlement = new Promise<void>((resolve) => {
		settle = resolve;
	});
	let started = 0;
	const watchdog = setTimeout(() => controller.abort(), 1000);
	try {
		const results = await runParallel({
			defaultCwd: "/tmp",
			agents: [agent],
			scheduler,
			signal: controller.signal,
			sdkServices: { modelRuntime: {} as ModelRuntime },
			tasks: Array.from({ length: 8 }, () => ({ agent: "test", task: "test" })),
			runTask: async () => {
				started++;
				return {
					exitCode: 1,
					messages: [],
					trace: [],
					usage: createEmptyUsage(),
					timedOut: true,
					aborted: false,
					stopReason: "timeout",
					settlement,
					timing: { setupMs: 0, totalMs: 0, timedOut: true },
				};
			},
		});
		assert.equal(controller.signal.aborted, false, "batch depended on external cancellation to finish");
		assert.equal(started, 4);
		assert.equal(results.length, 8);
		for (const result of results.slice(4)) {
			assert.equal(result.state, "failed");
			assert.match(result.errorMessage!, /quarantined/);
		}
		await assert.rejects(scheduler.acquire(), /quarantined/);
	} finally {
		clearTimeout(watchdog);
		controller.abort();
		settle();
		await settlement;
	}
	const release = await scheduler.acquire();
	release();
});

test("multipart final text has one aggregate bound and always marks omitted text", () => {
	for (const parts of [
		["x".repeat(FINAL_HANDOFF_MAX_BYTES), "IMPORTANT FINDING"],
		["Quoted [Output truncated.]", " actual answer"],
		Array.from({ length: 40 }, (_, index) => `part-${index}\n`),
		["a\n".repeat(400), "b\n".repeat(400)],
	]) {
		const output = getFinalOutput([
			sanitizeAssistantMessage({ role: "assistant", content: parts.map((text) => ({ type: "text", text })) }),
		]);
		assert.ok(Buffer.byteLength(output) <= FINAL_HANDOFF_MAX_BYTES);
		assert.ok(output.split("\n").length <= FINAL_HANDOFF_MAX_LINES);
		const original = parts.join("");
		if (
			Buffer.byteLength(original) <= FINAL_HANDOFF_MAX_BYTES &&
			original.split("\n").length <= FINAL_HANDOFF_MAX_LINES
		)
			assert.equal(output, original);
		else assert.match(output, /\[Output truncated\.\]$/);
	}
	const message = sanitizeAssistantMessage({
		role: "assistant",
		content: [
			...Array.from({ length: 40 }, () => ({ type: "thinking", thinking: "private" })),
			{ type: "text", text: "final finding" },
		],
	});
	assert.equal(getFinalOutput([message]), "final finding");
});

test("literal truncation markers do not stop streaming and real truncation resets next turn", async () => {
	let emit!: (event: AgentSessionEvent) => void;
	const updates: string[] = [];
	const session: SessionLike = {
		subscribe: (callback) => {
			emit = callback;
			return () => {};
		},
		prompt: async () => {
			const start = () => emit({ type: "message_start", message: { role: "assistant", content: [] } });
			const delta = (text: string) =>
				emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
			start();
			delta("Quoted [Output truncated.]");
			delta(" actual answer");
			assert.equal(updates.at(-1), "Quoted [Output truncated.] actual answer");
			delta("x".repeat(FINAL_HANDOFF_MAX_BYTES));
			const truncated = updates.at(-1);
			assert.match(truncated!, /\[Output truncated\.\]$/);
			delta("must not grow");
			assert.equal(updates.at(-1), truncated);
			start();
			delta("next turn");
			assert.equal(updates.at(-1), "next turn");
		},
		abort: async () => {},
		dispose: () => {},
	};
	const result = await collectSdkTask(
		{ agent, task: "test", cwd: "/tmp", timeoutSeconds: 1 },
		session,
		(update) => {
			if (update.streamingText !== undefined) updates.push(update.streamingText);
		},
		{ streamingUpdateDelayMs: 0 },
	);
	assert.equal(result.exitCode, 0, result.errorMessage);
});
