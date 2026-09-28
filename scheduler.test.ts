import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { RunScheduler } from "./scheduler.ts";
import { runSingleAgent, runParallel, type OrchestrationContext } from "./sdk-orchestration-core.ts";
import { createEmptyUsage, type SdkTaskResult } from "./sdk-runner-core.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const agent = {
	name: "test",
	description: "test",
	source: "user" as const,
	filePath: "/tmp/test.md",
	systemPrompt: "",
};
const success = (): SdkTaskResult => ({
	exitCode: 0,
	messages: [],
	trace: [],
	usage: createEmptyUsage(),
	timedOut: false,
	aborted: false,
	timing: { setupMs: 0, totalMs: 0, timedOut: false },
});

test("shared scheduler caps concurrent single calls and parallel batches together", async () => {
	let active = 0,
		maximum = 0;
	const context: OrchestrationContext = {
		defaultCwd: tmpdir(),
		agents: [agent],
		scheduler: new RunScheduler(2),
		sdkServices: { modelRuntime: {} as ModelRuntime },
		runTask: async () => {
			maximum = Math.max(maximum, ++active);
			await new Promise((r) => setTimeout(r, 2));
			active--;
			return success();
		},
	};
	const tasks = Array.from({ length: 8 }, () => ({ agent: "test", task: "test" }));
	await Promise.all([
		runParallel({ ...context, tasks }),
		runParallel({ ...context, tasks }),
		runSingleAgent(context, { agentName: "test", task: "test" }),
	]);
	assert.equal(maximum, 2);
	assert.equal(active, 0);
});

test("aborted queued work is removed without stealing a slot", async () => {
	const scheduler = new RunScheduler(1);
	const release = await scheduler.acquire();
	const controller = new AbortController();
	const cancelled = scheduler.acquire(controller.signal);
	controller.abort();
	await assert.rejects(cancelled, /aborted while queued/);
	release();
	const next = await scheduler.acquire();
	next();
	next();
	const final = await scheduler.acquire();
	final();
});

test("timed-out work retains its slot and registry until actual settlement", async () => {
	let settle!: () => void;
	const settlement = new Promise<void>((resolve) => {
		settle = resolve;
	});
	let finished = 0;
	const scheduler = new RunScheduler(1);
	const context: OrchestrationContext = {
		defaultCwd: tmpdir(),
		agents: [agent],
		scheduler,
		sdkServices: { modelRuntime: {} as ModelRuntime },
		runRegistry: {
			start: () => ({
				runId: "test",
				observeEvent: () => {},
				appendOutput: () => {},
				finish: () => {
					finished++;
				},
			}),
		},
		runTask: async () => ({ ...success(), timedOut: true, exitCode: 1, settlement }),
	};
	const result = await runSingleAgent(context, { agentName: "test", task: "test" });
	assert.equal(result.state, "failed");
	assert.equal(finished, 0);
	await assert.rejects(scheduler.acquire(), /quarantined/);
	settle();
	await settlement;
	assert.equal(finished, 1);
	const release = await scheduler.acquire();
	release();
});

test("full quarantine rejects existing waiters without releasing held slots", async () => {
	const scheduler = new RunScheduler(2);
	const first = await scheduler.acquire();
	const second = await scheduler.acquire();
	const controller = new AbortController();
	const queued = scheduler.acquire(controller.signal);
	const rejected = assert.rejects(queued, /quarantined/);
	first.quarantine();
	first.quarantine();
	second.quarantine();
	await rejected;
	controller.abort();
	await assert.rejects(scheduler.acquire(), /quarantined/);
	first();
	first();
	first.quarantine();
	const recovered = await scheduler.acquire();
	recovered();
	second();
});

test("partial quarantine preserves FIFO admission through the remaining healthy slot", async () => {
	const scheduler = new RunScheduler(2);
	const quarantined = await scheduler.acquire();
	const healthy = await scheduler.acquire();
	quarantined.quarantine();
	const order: number[] = [];
	const first = scheduler.acquire().then((release) => {
		order.push(1);
		release();
	});
	const second = scheduler.acquire().then((release) => {
		order.push(2);
		release();
	});
	healthy();
	await Promise.all([first, second]);
	assert.deepEqual(order, [1, 2]);
	quarantined();
});
