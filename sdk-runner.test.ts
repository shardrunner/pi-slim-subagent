import { RunScheduler } from "./scheduler.ts";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
	formatResultStatus,
	formatTimingFooter,
	runParallel as corerunParallel,
	runSingleAgent as corerunSingleAgent,
	selectThinkingLevel,
	selectTimeoutSeconds,
	type SingleResult,
} from "./sdk-orchestration-core.ts";
import type { AgentConfig } from "./agents.ts";
import { buildImplementReviewWorkflowPrompt, createImplementReviewThreadNames } from "./implement-review.ts";
import { isForbiddenPiJsonModeArgv } from "./sdk-smoke.ts";
import {
	reconcileDynamicallyLoadedTool,
	reconcileDynamicallyLoadedTools,
	wasToolDynamicallyLoaded,
} from "./tool-activation.ts";
import {
	aggregateNestedUsage,
	appendAgentSystemPrompt,
	boundCombinedHandoffs,
	boundFinalHandoff,
	boundText,
	collectSdkTask,
	createEmptyUsage,
	createSdkTaskCancellation,
	disableSkills,
	isPathInside,
	normalizeDispatchTimeoutSeconds,
	normalizeTimeoutSeconds,
	sanitizeAssistantMessage,
	truncateUtf8AtByteLimit,
	validateChildCwd,
	type AgentSessionEvent,
	type SessionLike,
	type SdkTaskRequest,
	type SdkTaskResult,
	type SdkTaskUpdate,
} from "./sdk-runner-core.ts";
import {
	buildCreateAgentSessionOptions,
	createLazySdkRunnerServices,
	preferCurrentStreamingText,
	runSdkTask,
	selectSessionThinkingLevel,
	type SdkRunnerServices,
} from "./sdk-runner.ts";

test("prefers current streaming text without duplicating finalized output", () => {
	assert.equal(preferCurrentStreamingText("first turn", "second turn"), "second turn");
	assert.equal(preferCurrentStreamingText("same output", "same output"), "same output");
	assert.equal(preferCurrentStreamingText("final output", undefined), "final output");
});

test("recognizes path ancestry without textual-prefix collisions", () => {
	assert.equal(isPathInside("/root/superpowers/skills/a/SKILL.md", "/root/superpowers"), true);
	assert.equal(isPathInside("/root/superpowers-copy/skills/a/SKILL.md", "/root/superpowers"), false);
});

test("validates child cwd before protected project resources can load", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-cwd-"));
	try {
		const parent = path.join(root, "parent");
		const trustedChild = path.join(parent, "child");
		const plainExternal = path.join(root, "plain-external");
		const protectedExternal = path.join(root, "protected-external");
		mkdirSync(path.join(trustedChild, ".pi"), { recursive: true });
		writeFileSync(path.join(trustedChild, ".pi", "settings.json"), "{}", "utf8");
		mkdirSync(plainExternal, { recursive: true });
		mkdirSync(path.join(protectedExternal, ".pi", "skills"), { recursive: true });

		assert.equal(
			validateChildCwd({ requestedCwd: "child", defaultCwd: parent, projectTrusted: true }),
			realpathSync.native(trustedChild),
		);
		assert.throws(
			() => validateChildCwd({ requestedCwd: "child", defaultCwd: parent, projectTrusted: false }),
			/protected project resources.*not trusted/i,
		);
		assert.equal(
			validateChildCwd({ requestedCwd: plainExternal, defaultCwd: parent, projectTrusted: false }),
			realpathSync.native(plainExternal),
		);
		assert.throws(
			() => validateChildCwd({ requestedCwd: protectedExternal, defaultCwd: parent, projectTrusted: true }),
			/outside the trusted cwd/i,
		);
		assert.throws(
			() => validateChildCwd({ requestedCwd: path.join(root, "missing"), defaultCwd: parent, projectTrusted: true }),
			/does not exist/i,
		);
		const file = path.join(root, "file");
		writeFileSync(file, "not a directory", "utf8");
		assert.throws(
			() => validateChildCwd({ requestedCwd: file, defaultCwd: parent, projectTrusted: true }),
			/not a directory/i,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("bounds text by aggregate UTF-8 byte and line budgets", () => {
	const boundedByBytes = boundText(`${"a".repeat(95)}€tail`, { maxBytes: 100, maxLines: 10 });
	assert.equal(Buffer.byteLength(boundedByBytes, "utf8") <= 100, true);
	assert.equal(boundedByBytes.endsWith("[Output truncated.]"), true);
	assert.equal(boundedByBytes.includes("€"), false);

	const boundedByLines = boundText(Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n"), {
		maxBytes: 1024,
		maxLines: 5,
	});
	assert.equal(boundedByLines.split("\n").length <= 5, true);
	assert.equal(boundedByLines.endsWith("[Output truncated.]"), true);
});

test("gives individual and combined handoffs distinct safety budgets", () => {
	const output = Array.from({ length: 3000 }, (_, index) => `finding ${index}: ${"x".repeat(40)}`).join("\n");
	const individual = boundFinalHandoff(output);
	const combined = boundCombinedHandoffs(output);

	assert.equal(Buffer.byteLength(individual, "utf8") <= 24 * 1024, true);
	assert.equal(individual.split("\n").length <= 600, true);
	assert.match(individual, /\[Output truncated\.\]$/);
	assert.equal(Buffer.byteLength(combined, "utf8") > 24 * 1024, true);
	assert.equal(Buffer.byteLength(combined, "utf8") <= 50 * 1024, true);
	assert.equal(combined.split("\n").length <= 2000, true);
	assert.match(combined, /\[Output truncated\.\]$/);
});

test("aggregates nested model usage in Pi's standard usage shape", () => {
	assert.deepEqual(
		aggregateNestedUsage([
			{
				input: 10,
				output: 4,
				cacheRead: 3,
				cacheWrite: 2,
				cost: 0.5,
				costInput: 0.125,
				costOutput: 0.25,
				costCacheRead: 0.0625,
				costCacheWrite: 0.0625,
				contextTokens: 19,
				turns: 1,
			},
			{
				input: 7,
				output: 2,
				cacheRead: 1,
				cacheWrite: 0,
				cost: 0.2,
				costInput: 0.125,
				costOutput: 0.0625,
				costCacheRead: 0.0125,
				costCacheWrite: 0,
				contextTokens: 10,
				turns: 1,
			},
		]),
		{
			input: 17,
			output: 6,
			cacheRead: 4,
			cacheWrite: 2,
			totalTokens: 29,
			cost: { input: 0.25, output: 0.3125, cacheRead: 0.075, cacheWrite: 0.0625, total: 0.7 },
		},
	);
});

test("sanitizes finalized assistant messages before retaining them", () => {
	const sanitized = sanitizeAssistantMessage({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "private reasoning" },
			{ type: "text", text: "safe final text" },
			{ type: "toolCall", name: "read", arguments: { path: "/secret", token: "credential" } },
		],
		providerMetadata: { secret: "metadata" },
	});

	assert.deepEqual(sanitized, {
		role: "assistant",
		content: [
			{ type: "text", text: "safe final text" },
			{ type: "toolCall", name: "read", arguments: {} },
		],
	});
});

test("detects standalone and node/bun-wrapped Pi JSON invocations by argv", () => {
	const flags = ["--mode", "json", "-p", "--no-session"];
	assert.equal(isForbiddenPiJsonModeArgv(["pi", ...flags]), true);
	assert.equal(isForbiddenPiJsonModeArgv(["/usr/local/bin/pi", "--mode=json", "-p", "--no-session"]), true);
	assert.equal(isForbiddenPiJsonModeArgv(["node", "/opt/pi/dist/cli.js", ...flags]), true);
	assert.equal(isForbiddenPiJsonModeArgv(["bun", "/opt/pi/dist/cli.js", ...flags]), true);
	assert.equal(isForbiddenPiJsonModeArgv(["node", "/opt/not-pi/dist/cli.js", ...flags]), false);
	assert.equal(isForbiddenPiJsonModeArgv(["node", "/opt/pi/dist/cli.js", "--mode json", "-p", "--no-session"]), false);
});

test("rejects Pi-helper executable and wrapped-script lookalikes", () => {
	const flags = ["--mode", "json", "-p", "--no-session"];
	assert.equal(isForbiddenPiJsonModeArgv(["/usr/bin/pi-helper", ...flags]), false);
	assert.equal(isForbiddenPiJsonModeArgv(["node", "/tmp/pi-helper.js", ...flags]), false);
});

test("normalizes internal timeouts while dispatches enforce a finite positive bound", () => {
	assert.equal(normalizeTimeoutSeconds(0), 0);
	assert.equal(normalizeDispatchTimeoutSeconds(undefined), 1500);
	assert.equal(normalizeDispatchTimeoutSeconds(0.2), 0.2);
	assert.equal(normalizeDispatchTimeoutSeconds(45), 45);
	assert.equal(normalizeDispatchTimeoutSeconds(7200), 7200);
	assert.throws(() => normalizeDispatchTimeoutSeconds(0), /positive/);
	assert.throws(() => normalizeDispatchTimeoutSeconds(-1), /non-negative/);
	assert.throws(() => normalizeDispatchTimeoutSeconds(Number.NaN), /finite/);
	assert.throws(() => normalizeDispatchTimeoutSeconds(7200.001), /supported maximum.*7200/);
});

test("selects item timeout before top-level timeout and rejects disabled deadlines", () => {
	assert.equal(selectTimeoutSeconds(undefined, undefined), 1500);
	assert.equal(selectTimeoutSeconds(undefined, 30), 30);
	assert.equal(selectTimeoutSeconds(7, 30), 7);
	assert.throws(() => selectTimeoutSeconds(0, 30), /positive/);
	assert.throws(() => selectTimeoutSeconds(-1, 30), /non-negative/);
	assert.throws(() => selectTimeoutSeconds(Number.POSITIVE_INFINITY, 30), /finite/);
	assert.throws(() => selectTimeoutSeconds(undefined, Number.NaN), /finite/);
});

test("builds a bounded opt-in persistent implement-review workflow", () => {
	assert.deepEqual(createImplementReviewThreadNames(1234567890, "01234567"), {
		implementor: "irkf12oi-01234567-implementor",
		reviewer: "irkf12oi-01234567-reviewer",
	});
	const prompt = buildImplementReviewWorkflowPrompt("Add exact TCP reads", {
		implementor: "irabc-implementor",
		reviewer: "irabc-reviewer",
	});
	assert.match(prompt, /explicitly authorizes the bounded advanced-subagent workflow/i);
	assert.match(prompt, /agent `implementor`.*continuation `create:irabc-implementor`/s);
	assert.match(prompt, /agent `code-reviewer`.*continuation `create:irabc-reviewer`/s);
	assert.match(prompt, /focused validation.*commit the completed implementation/i);
	assert.match(prompt, /report the resulting commit SHA and its base/i);
	assert.match(prompt, /review the implementation commit or exact commit range/i);
	assert.match(prompt, /commit material corrections separately/i);
	assert.match(prompt, /resume `irabc-implementor` exactly once/i);
	assert.match(prompt, /resume `irabc-reviewer` at most once/i);
	assert.match(prompt, /default timeout: 1500 seconds per dispatch/i);
	assert.match(prompt, /Do not ask the reviewer to run builds or tests/i);
	assert.match(prompt, /Run focused checks during implementation and corrections; run full repository gates once/i);
	assert.doesNotMatch(prompt, /\{previous\}/);
	assert.throws(
		() => buildImplementReviewWorkflowPrompt("   ", createImplementReviewThreadNames(1)),
		/usage: \/implement-review <task>/i,
	);
});

test("selects item thinking level before the top-level default", () => {
	assert.equal(selectThinkingLevel(undefined, undefined), undefined);
	assert.equal(selectThinkingLevel(undefined, "xhigh"), "xhigh");
	assert.equal(selectThinkingLevel("off", "xhigh"), "off");
});

test("finds a UTF-8-safe prefix for parallel output", () => {
	const cap = 50 * 1024;
	const prefix = "a".repeat(cap - 1);
	const output = `${prefix}€tail`;
	const truncated = truncateUtf8AtByteLimit(output, cap);

	assert.equal(truncated.text, prefix);
	assert.equal(truncated.byteLength, cap - 1);
	assert.equal(truncated.text.includes("€"), false);
});

test("appends the selected agent prompt after the normal resource prompt", () => {
	assert.deepEqual(appendAgentSystemPrompt(["base", "context"], " selected agent "), [
		"base",
		"context",
		" selected agent ",
		"Return a concise final handoff. Lead with the outcome. Include only actionable findings or changes, exact evidence or paths needed, and validation status. Omit exploration narrative, repeated task context, and generic advice.",
	]);
	assert.deepEqual(appendAgentSystemPrompt(["base"], "   "), [
		"base",
		"Return a concise final handoff. Lead with the outcome. Include only actionable findings or changes, exact evidence or paths needed, and validation status. Omit exploration narrative, repeated task context, and generic advice.",
	]);
});

test("shares the empty usage initializer for new result boundaries", () => {
	assert.deepEqual(createEmptyUsage(), {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		costInput: 0,
		costOutput: 0,
		costCacheRead: 0,
		costCacheWrite: 0,
		contextTokens: 0,
		turns: 0,
	});
});

test("selects a dispatch thinking level over the configured model suffix", () => {
	assert.equal(selectSessionThinkingLevel("xhigh", "medium"), "xhigh");
	assert.equal(selectSessionThinkingLevel(undefined, "high"), "high");
	assert.equal(selectSessionThinkingLevel("off", "max"), "off");
});

test("builds production SDK session options with the shared model runtime", () => {
	const loader = {};
	const settingsManager = {};
	const sessionManager = {};
	const services = { modelRuntime: {} } as SdkRunnerServices;
	const agent = { ...orchestrationAgent("luna"), tools: ["read", "bash"] };
	const options = buildCreateAgentSessionOptions({
		request: request({ agent }),
		services,
		agentDir: "/agent",
		loader,
		settingsManager,
		model: { id: "model" },
		thinkingLevel: "high",
		sessionManager,
	});

	assert.equal(options.cwd, "/tmp");
	assert.equal(options.agentDir, "/agent");
	assert.strictEqual(options.modelRuntime, services.modelRuntime);
	assert.equal("authStorage" in options, false);
	assert.equal("modelRegistry" in options, false);
	assert.deepEqual(options.tools, ["read", "bash"]);
	assert.strictEqual(options.resourceLoader, loader);
	assert.strictEqual(options.sessionManager, sessionManager);
	assert.strictEqual(options.settingsManager, settingsManager);
	assert.deepEqual(options.model, { id: "model" });
	assert.equal(options.thinkingLevel, "high");
});

test("restores dynamically loaded tools while preserving explicit active-tool selections", () => {
	const marker = [
		{
			type: "message",
			message: { role: "toolResult", details: { added: ["subagent", "subagent_advanced"] } },
		},
	];
	assert.equal(wasToolDynamicallyLoaded([], "subagent_advanced"), false);
	assert.equal(
		wasToolDynamicallyLoaded(
			[
				{ type: "active_tools_change", activeToolNames: ["read", "subagent_advanced"] },
				{
					type: "message",
					message: { role: "toolResult", details: { added: ["subagent_advanced"] } },
				},
			],
			"subagent_advanced",
		),
		true,
	);
	assert.equal(
		wasToolDynamicallyLoaded(
			[
				{
					type: "message",
					message: { role: "toolResult", details: { added: ["another_tool"] } },
				},
			],
			"subagent_advanced",
		),
		false,
	);
	assert.equal(wasToolDynamicallyLoaded(marker, "subagent"), true);
	assert.equal(wasToolDynamicallyLoaded(marker, "another_tool"), false);
	assert.equal(
		wasToolDynamicallyLoaded(
			[{ type: "message", message: { role: "toolResult", details: { added: "subagent" } } }],
			"subagent",
		),
		false,
	);
	assert.deepEqual(
		reconcileDynamicallyLoadedTool([], ["read", "subagent_advanced"], "load_subagents", "subagent_advanced"),
		["read", "subagent_advanced"],
	);
	assert.deepEqual(reconcileDynamicallyLoadedTool(marker, ["read"], "load_subagents", "subagent_advanced"), ["read"]);
	assert.deepEqual(
		reconcileDynamicallyLoadedTool(
			[],
			["read", "load_subagents", "subagent_advanced"],
			"load_subagents",
			"subagent_advanced",
		),
		["read", "load_subagents"],
	);
	assert.deepEqual(
		reconcileDynamicallyLoadedTool(marker, ["read", "load_subagents"], "load_subagents", "subagent_advanced"),
		["read", "load_subagents", "subagent_advanced"],
	);
	// Both dispatch tools hide behind the loader until it runs.
	assert.deepEqual(
		reconcileDynamicallyLoadedTools([], ["read", "load_subagents", "subagent", "subagent_advanced"], "load_subagents", [
			"subagent",
			"subagent_advanced",
		]),
		["read", "load_subagents"],
	);
	assert.deepEqual(
		reconcileDynamicallyLoadedTools(marker, ["read", "load_subagents"], "load_subagents", [
			"subagent",
			"subagent_advanced",
		]),
		["read", "load_subagents", "subagent", "subagent_advanced"],
	);
});

test("rolls back the parent listener when deadline timer setup throws", () => {
	const controller = new AbortController();
	const instrumentation = instrumentSignal(controller.signal);
	try {
		assert.throws(
			() =>
				createSdkTaskCancellation(request({ signal: controller.signal, timeoutSeconds: 1 }), {
					setTimeout: () => {
						throw new Error("timer setup failed");
					},
					clearTimeout: () => undefined,
				}),
			/timer setup failed/,
		);
		assert.equal(instrumentation.addCalls(), 1);
		assert.equal(instrumentation.removeCalls(), 1);
	} finally {
		instrumentation.restore();
	}
});

test("reports a parent listener rollback failure alongside timer setup failure", () => {
	const controller = new AbortController();
	const signal = controller.signal as AbortSignal & { removeEventListener: (...args: any[]) => void };
	const originalRemove = signal.removeEventListener;
	signal.removeEventListener = (() => {
		throw new Error("listener rollback failed");
	}) as typeof signal.removeEventListener;
	try {
		assert.throws(
			() =>
				createSdkTaskCancellation(request({ signal, timeoutSeconds: 1 }), {
					setTimeout: () => {
						throw new Error("timer setup failed");
					},
					clearTimeout: () => undefined,
				}),
			/timer setup failed.*removeEventListener\(\).*listener rollback failed/s,
		);
	} finally {
		signal.removeEventListener = originalRemove;
	}
});

test("formats timeout, abort, existing failure, and timing statuses", () => {
	assert.equal(
		formatResultStatus({ timedOut: true, aborted: false, timeoutSeconds: 1200, stopReason: "timeout" } as SingleResult),
		"timed out after 1200s",
	);
	assert.equal(
		formatResultStatus({ timedOut: false, aborted: true, timeoutSeconds: 30, stopReason: "aborted" } as SingleResult),
		"aborted",
	);
	assert.equal(
		formatResultStatus({ timedOut: false, aborted: false, timeoutSeconds: 30, stopReason: "length" } as SingleResult),
		"length",
	);
	assert.equal(
		formatTimingFooter({ setupMs: 1, totalMs: 2600, firstTextDeltaMs: 1400, timedOut: false }),
		"total:2.6s ttft:1.4s",
	);
});

class FakeSession implements SessionLike {
	listeners = new Set<(event: AgentSessionEvent) => void>();
	retainedListeners: Array<(event: AgentSessionEvent) => void> = [];
	unsubscribeCalls = 0;
	promptCalls: string[] = [];
	abortCalls = 0;
	disposeCalls = 0;
	promptImpl: ((text: string) => Promise<void>) | undefined;
	abortImpl: (() => Promise<void>) | undefined;
	disposeImpl: (() => void) | undefined;

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		this.retainedListeners.push(listener);
		return () => {
			this.unsubscribeCalls++;
			this.listeners.delete(listener);
		};
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of [...this.retainedListeners]) listener(event);
	}

	prompt(text: string): Promise<void> {
		this.promptCalls.push(text);
		return this.promptImpl?.(text) ?? Promise.resolve();
	}

	abort(): Promise<void> {
		this.abortCalls++;
		return this.abortImpl?.() ?? Promise.resolve();
	}

	dispose(): void {
		this.disposeCalls++;
		this.disposeImpl?.();
	}
}

function request(overrides: Partial<SdkTaskRequest> = {}): SdkTaskRequest {
	return {
		agent: {
			name: "luna",
			description: "test agent",
			systemPrompt: "",
			source: "user",
			filePath: "/tmp/luna.md",
		},
		task: "say hi",
		cwd: "/tmp",
		...overrides,
	};
}

function orchestrationAgent(name: string): AgentConfig {
	return {
		name,
		description: `${name} test agent`,
		systemPrompt: "",
		source: "user",
		filePath: `/tmp/${name}.md`,
	};
}

function sdkResult(text: string, overrides: Partial<SdkTaskResult> = {}): SdkTaskResult {
	return {
		exitCode: 0,
		trace: [],
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text }],
				stopReason: "stop",
			},
		],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			costInput: 0,
			costOutput: 0,
			costCacheRead: 0,
			costCacheWrite: 0,
			contextTokens: 1,
			turns: 1,
		},
		timedOut: false,
		aborted: false,
		timing: { setupMs: 1, totalMs: 2, firstTextDeltaMs: 1, timedOut: false },
		...overrides,
	};
}

function deferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value?: T) => void;
	reject: (error: unknown) => void;
} {
	let resolvePromise!: (value: T | PromiseLike<T>) => void;
	let rejectPromise!: (error: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return {
		promise,
		resolve: (value?: T) => resolvePromise(value as T),
		reject: rejectPromise,
	};
}

async function waitForCondition(condition: () => boolean, timeoutMs = 200): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
	assert.equal(condition(), true);
}

function instrumentSignal(signal: AbortSignal): {
	addCalls: () => number;
	removeCalls: () => number;
	restore: () => void;
} {
	const signalWithMethods = signal as AbortSignal & {
		addEventListener: (...args: any[]) => void;
		removeEventListener: (...args: any[]) => void;
	};
	const originalAdd = signalWithMethods.addEventListener.bind(signal);
	const originalRemove = signalWithMethods.removeEventListener.bind(signal);
	let addCalls = 0;
	let removeCalls = 0;
	signalWithMethods.addEventListener = ((...args: any[]) => {
		addCalls++;
		return originalAdd(...args);
	}) as typeof signalWithMethods.addEventListener;
	signalWithMethods.removeEventListener = ((...args: any[]) => {
		removeCalls++;
		return originalRemove(...args);
	}) as typeof signalWithMethods.removeEventListener;
	return {
		addCalls: () => addCalls,
		removeCalls: () => removeCalls,
		restore: () => {
			signalWithMethods.addEventListener = originalAdd as typeof signalWithMethods.addEventListener;
			signalWithMethods.removeEventListener = originalRemove as typeof signalWithMethods.removeEventListener;
		},
	};
}

function instrumentDeadlineTimers(delayMs: number): {
	created: () => number;
	cleared: () => number;
	restore: () => void;
} {
	const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
	const originalClearTimeout = globalThis.clearTimeout.bind(globalThis);
	const handles = new Set<unknown>();
	let created = 0;
	let cleared = 0;
	globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
		const handle = originalSetTimeout(callback, delay, ...args);
		if (delay === delayMs) {
			created++;
			handles.add(handle);
		}
		return handle;
	}) as typeof globalThis.setTimeout;
	globalThis.clearTimeout = ((handle: unknown) => {
		if (handles.delete(handle)) cleared++;
		return originalClearTimeout(handle as ReturnType<typeof setTimeout>);
	}) as typeof globalThis.clearTimeout;
	return {
		created: () => created,
		cleared: () => cleared,
		restore: () => {
			globalThis.setTimeout = originalSetTimeout as typeof globalThis.setTimeout;
			globalThis.clearTimeout = originalClearTimeout as typeof globalThis.clearTimeout;
		},
	};
}

test("collects finalized assistant messages and streams text deltas", async () => {
	const session = new FakeSession();
	const updates: SdkTaskUpdate[] = [];
	session.promptImpl = async () => {
		session.emit({ type: "agent_start" });
		session.emit({ type: "message_start", message: { role: "assistant", content: [] } });
		session.emit({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
			assistantMessageEvent: { type: "text_delta", delta: "Hi" },
		});
		session.emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Hi" }],
				model: "luna-max",
				stopReason: "stop",
				usage: {
					input: 11,
					output: 7,
					cacheRead: 3,
					cacheWrite: 2,
					totalTokens: 18,
					cost: { input: 0.1, output: 0.12, cacheRead: 0.02, cacheWrite: 0.01, total: 0.25 },
				},
			},
		});
		session.emit({ type: "agent_end", messages: [] });
	};

	const result = await collectSdkTask(request(), session, (update) => updates.push(update));

	assert.deepEqual(session.promptCalls, ["Task: say hi"]);
	assert.equal(result.messages.length, 1);
	assert.equal(result.messages[0].role, "assistant");
	assert.equal(
		updates.some((update) => update.text === "Hi"),
		true,
	);
	assert.deepEqual(result.usage, {
		input: 11,
		output: 7,
		cacheRead: 3,
		cacheWrite: 2,
		cost: 0.25,
		costInput: 0.1,
		costOutput: 0.12,
		costCacheRead: 0.02,
		costCacheWrite: 0.01,
		contextTokens: 18,
		turns: 1,
	});
	assert.equal(result.model, "luna-max");
	assert.equal(result.stopReason, "stop");
	assert.equal(result.exitCode, 0);
	assert.equal(typeof result.timing.firstEventMs, "number");
	assert.equal(typeof result.timing.firstTextDeltaMs, "number");
	assert.equal(session.disposeCalls, 1);
});

test("reports bounded reasoning, tool, and assistant activity without exposing private thinking", async () => {
	const session = new FakeSession();
	const events: Array<{ phase: string; toolName?: string; clearTool?: boolean }> = [];
	const output: string[] = [];
	const traces: string[] = [];
	session.promptImpl = async () => {
		session.emit({ type: "agent_start" });
		session.emit({ type: "message_start", message: { role: "assistant", content: [] } });
		session.emit({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" },
		});
		session.emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "visible" },
		});
		session.emit({ type: "tool_execution_start", toolName: "read", toolCallId: "call-1", args: { path: "/secret" } });
		session.emit({ type: "tool_execution_end", toolName: "read", toolCallId: "call-1", result: { secret: true } });
		session.emit({ type: "agent_end", messages: [] });
	};

	const result = await collectSdkTask(
		request({
			observer: {
				observeEvent: (event) => events.push(event),
				appendOutput: (delta) => output.push(delta),
				appendTrace: (entry) => traces.push(entry),
			},
		}),
		session,
	);

	assert.deepEqual(output, ["visible"]);
	assert.equal(output.join("").includes("private reasoning"), false);
	assert.equal(
		traces.some((entry) => entry.includes("reasoning active")),
		true,
	);
	assert.equal(
		traces.some((entry) => entry === "tool started: read"),
		true,
	);
	assert.equal(
		traces.some((entry) => entry === "tool completed: read"),
		true,
	);
	assert.equal(traces.join("\n").includes("private reasoning"), false);
	assert.deepEqual(result.trace, traces);
	assert.doesNotMatch(traces.join("\n"), /secret/);
	assert.equal(
		events.some((event) => event.phase === "tool" && event.toolName === "read"),
		true,
	);
	assert.equal(
		events.some((event) => event.clearTool === true),
		true,
	);
	assert.equal(events.at(-1)?.phase, "cleanup");
});

test("observes finalized assistant output when a provider emits no text deltas", async () => {
	const session = new FakeSession();
	const output: string[] = [];
	session.promptImpl = async () => {
		session.emit({ type: "message_start", message: { role: "assistant", content: [] } });
		session.emit({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "final only" }], stopReason: "stop" },
		});
	};
	await collectSdkTask(
		request({
			observer: { observeEvent: () => {}, appendOutput: (delta) => output.push(delta) },
		}),
		session,
	);
	assert.deepEqual(output, ["final only"]);
});

test("reports latest context size while accumulating billable usage", async () => {
	const session = new FakeSession();
	session.promptImpl = async () => {
		for (const [text, totalTokens] of [
			["first", 10],
			["second", 24],
		] as const) {
			session.emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text }],
					stopReason: "stop",
					usage: { input: 8, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens },
				},
			});
		}
	};

	const result = await collectSdkTask(request(), session);

	assert.equal(result.usage.input, 16);
	assert.equal(result.usage.output, 4);
	assert.equal(result.usage.cacheRead, 2);
	assert.equal(result.usage.turns, 2);
	assert.equal(result.usage.contextTokens, 24);
});

test("coalesces cumulative text updates and flushes the latest text before completion", async () => {
	const session = new FakeSession();
	const updates: SdkTaskUpdate[] = [];
	let scheduled: (() => void) | undefined;
	let cleared = 0;
	session.promptImpl = async () => {
		session.emit({ type: "message_start", message: { role: "assistant", content: [] } });
		for (const delta of ["a", "b", "c", "d"]) {
			session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
		}
	};

	const result = await collectSdkTask(request({ timeoutSeconds: 0 }), session, (update) => updates.push(update), {
		streamingUpdateDelayMs: 10,
		timerApi: {
			setTimeout: (callback) => {
				scheduled = callback;
				return scheduled;
			},
			clearTimeout: () => {
				cleared++;
				scheduled = undefined;
			},
		},
	});

	assert.equal(result.streamingText, "abcd");
	assert.deepEqual(updates.map((update) => update.text).filter(Boolean), ["a", "abcd"]);
	assert.equal(scheduled, undefined);
	assert.equal(cleared, 1);
});

test("does not emit a coalesced update after cancellation cleanup", async () => {
	const controller = new AbortController();
	const session = new FakeSession();
	const updates: SdkTaskUpdate[] = [];
	let scheduled: (() => void) | undefined;
	let releasePrompt: (() => void) | undefined;
	session.promptImpl = () => {
		session.emit({ type: "message_start", message: { role: "assistant", content: [] } });
		session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a" } });
		session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "b" } });
		return new Promise<void>((resolve) => (releasePrompt = resolve));
	};
	session.abortImpl = async () => releasePrompt?.();

	const running = collectSdkTask(
		request({ signal: controller.signal, timeoutSeconds: 0 }),
		session,
		(update) => updates.push(update),
		{
			streamingUpdateDelayMs: 10,
			timerApi: {
				setTimeout: (callback) => {
					scheduled = callback;
					return scheduled;
				},
				clearTimeout: () => undefined,
			},
		},
	);
	await waitForCondition(() => scheduled !== undefined);
	controller.abort();
	const updateCount = updates.length;
	assert.ok(scheduled);
	scheduled();
	const result = await running;

	assert.equal(result.aborted, true);
	assert.equal(updates.length, updateCount);
});

test("measures model-phase timings from the prompt timestamp", async () => {
	const session = new FakeSession();
	const updates: SdkTaskUpdate[] = [];
	let currentTime = 100;
	session.promptImpl = async () => {
		currentTime = 110;
		session.emit({ type: "agent_start" });
		currentTime = 120;
		session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hi" } });
		currentTime = 145;
		session.emit({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "Hi" }], stopReason: "stop" },
		});
	};

	const result = await collectSdkTask(request(), session, (update) => updates.push(update), {
		startedAt: 0,
		setupMs: 100,
		now: () => currentTime,
	});

	assert.equal(result.timing.setupMs, 100);
	assert.equal(result.timing.firstEventMs, 10);
	assert.equal(result.timing.firstTextDeltaMs, 20);
	assert.equal(result.timing.completionMs, 45);
	assert.equal(result.timing.totalMs, 145);
});

test("retains only the current partial assistant text across turns", async () => {
	const session = new FakeSession();
	const updates: SdkTaskUpdate[] = [];
	session.promptImpl = async () => {
		session.emit({ type: "message_start", message: { role: "assistant", content: [] } });
		session.emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "first" },
		});
		session.emit({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "first" }], stopReason: "stop" },
		});
		session.emit({ type: "message_start", message: { role: "assistant", content: [] } });
		session.emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "second" },
		});
	};

	const result = await collectSdkTask(request(), session, (update) => updates.push(update));

	assert.equal(result.streamingText, "second");
	assert.equal(updates.at(-1)?.text, "second");
});

test("drops finalized tool-result payloads and ignores late events after cleanup", async () => {
	const session = new FakeSession();
	const updates: SdkTaskUpdate[] = [];
	session.promptImpl = async () => {
		session.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: {} });
		session.emit({
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "read",
			args: {},
			partialResult: { content: [{ type: "text", text: "progress" }] },
		});
		session.emit({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "file" }],
				isError: false,
			},
		});
		session.emit({
			type: "tool_result_end",
			message: {
				role: "toolResult",
				toolCallId: "call-2",
				toolName: "read",
				content: [{ type: "text", text: "second file" }],
				isError: false,
			},
		});
	};

	const result = await collectSdkTask(request({ task: "read it" }), session, (update) => updates.push(update));
	const updatesBeforeLateEvent = updates.length;
	session.emit({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "late" }] },
	});

	assert.deepEqual(result.messages, []);
	assert.equal(JSON.stringify(result).includes("second file"), false);
	assert.equal(JSON.stringify(result).includes('"file"'), false);
	assert.equal(result.progress?.partialResult, undefined);
	assert.equal(result.progress?.args, undefined);
	assert.equal(
		updates.some((update) => update.progress?.toolName === "read"),
		true,
	);
	assert.equal(updates.length, updatesBeforeLateEvent);
	assert.equal(session.unsubscribeCalls, 1);
	assert.equal(session.listeners.size, 0);
	assert.equal(session.retainedListeners.length, 1);
	assert.equal(session.disposeCalls, 1);
});

test("aborts an already-cancelled parent before prompting", async () => {
	const controller = new AbortController();
	controller.abort();
	const session = new FakeSession();

	const result = await collectSdkTask(request({ signal: controller.signal }), session);

	assert.equal(session.promptCalls.length, 0);
	assert.equal(session.abortCalls, 1);
	assert.equal(result.aborted, true);
	assert.equal(result.timedOut, false);
	assert.equal(result.stopReason, "aborted");
	assert.equal(session.disposeCalls, 1);
});

test("cooperatively aborts a running prompt and cleans up the parent listener", async () => {
	const controller = new AbortController();
	const signalInstrumentation = instrumentSignal(controller.signal);
	const session = new FakeSession();
	let releasePrompt: (() => void) | undefined;
	session.promptImpl = () => new Promise<void>((resolve) => (releasePrompt = resolve));
	session.abortImpl = async () => releasePrompt?.();

	try {
		const running = collectSdkTask(request({ signal: controller.signal, timeoutSeconds: 0 }), session);
		controller.abort();
		const result = await running;

		assert.equal(session.abortCalls, 1);
		assert.equal(result.aborted, true);
		assert.equal(result.timedOut, false);
		assert.equal(result.exitCode, 1);
		controller.abort();
		assert.equal(session.abortCalls, 1);
		assert.equal(session.unsubscribeCalls, 1);
		assert.equal(signalInstrumentation.addCalls(), 1);
		assert.equal(signalInstrumentation.removeCalls(), 1);
		assert.equal(session.disposeCalls, 1);
	} finally {
		releasePrompt?.();
		signalInstrumentation.restore();
	}
});

test("aborts once at the deadline and reports a timeout", async () => {
	const session = new FakeSession();
	let releasePrompt: (() => void) | undefined;
	session.promptImpl = () => new Promise<void>((resolve) => (releasePrompt = resolve));
	session.abortImpl = async () => releasePrompt?.();

	const result = await collectSdkTask(request({ timeoutSeconds: 0.01 }), session);

	assert.equal(session.abortCalls, 1);
	assert.equal(result.timedOut, true);
	assert.equal(result.aborted, false);
	assert.equal(result.stopReason, "timeout");
	assert.equal(result.exitCode, 1);
	assert.equal(session.disposeCalls, 1);
});

test("does not create a deadline when timeoutSeconds is zero", async () => {
	const session = new FakeSession();
	session.promptImpl = async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	};

	const result = await collectSdkTask(request({ timeoutSeconds: 0 }), session);
	await new Promise((resolve) => setTimeout(resolve, 25));

	assert.equal(result.timedOut, false);
	assert.equal(session.abortCalls, 0);
	assert.equal(session.disposeCalls, 1);
});

test("closes cancellation sources before session disposal", async () => {
	const controller = new AbortController();
	const signalInstrumentation = instrumentSignal(controller.signal);
	const session = new FakeSession();
	session.disposeImpl = () => controller.abort();

	try {
		const result = await collectSdkTask(request({ signal: controller.signal, timeoutSeconds: 0 }), session);

		assert.equal(result.aborted, false);
		assert.equal(result.timedOut, false);
		assert.equal(result.exitCode, 0);
		assert.equal(session.abortCalls, 0);
		assert.equal(signalInstrumentation.removeCalls(), 1);
		assert.equal(session.disposeCalls, 1);
	} finally {
		signalInstrumentation.restore();
	}
});

test("records completion when prompt settles after agent_end", async () => {
	const session = new FakeSession();
	session.promptImpl = async () => {
		session.emit({ type: "agent_end" });
		await new Promise((resolve) => setTimeout(resolve, 20));
	};

	const result = await collectSdkTask(request(), session);

	assert.ok((result.timing.completionMs ?? 0) >= 15);
});

test("clears a transient retry error after the latest assistant succeeds", async () => {
	const session = new FakeSession();
	session.promptImpl = async () => {
		session.emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "transient retry failure",
			},
		});
		session.emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "recovered" }],
				stopReason: "stop",
			},
		});
	};

	const result = await collectSdkTask(request(), session);

	assert.equal(result.errorMessage, undefined);
	assert.equal(result.stopReason, "stop");
	assert.equal(result.exitCode, 0);
});

test("preserves the primary prompt error and disposes after failure", async () => {
	const session = new FakeSession();
	session.promptImpl = async () => {
		throw new Error("model failed");
	};

	const result = await collectSdkTask(request(), session);

	assert.equal(result.errorMessage, "model failed");
	assert.equal(result.stopReason, "error");
	assert.equal(result.exitCode, 1);
	assert.equal(typeof result.timing.completionMs, "number");
	assert.equal(session.disposeCalls, 1);
});

test("redacts locator-bearing continuation prompt failures but preserves provider diagnostics", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-continuation-prompt-"));
	try {
		const parentDirectory = path.join(root, "parent");
		mkdirSync(parentDirectory, { recursive: true, mode: 0o700 });
		const childFile = path.join(parentDirectory, "child.jsonl");
		const childSessionId = "child-session-id";
		const childLeafId = "child-leaf-id";
		const agentFile = path.join(root, "agent.md");
		writeFileSync(agentFile, "agent", "utf8");
		const target = {
			action: "resume" as const,
			parentScopedDirectory: parentDirectory,
			record: {
				version: 1 as const,
				action: "create" as const,
				thread: "review-thread",
				parentSessionId: "parent-session-id",
				childSessionId,
				childSessionFile: childFile,
				childLeafId,
				agent: { name: "luna", source: "user" as const, filePath: agentFile },
				cwd: "/tmp",
			},
		};
		const run = async (errorMessage: string): Promise<{ result: SdkTaskResult; session: FakeSession }> => {
			const session = new FakeSession();
			session.promptImpl = async () => {
				throw new Error(errorMessage);
			};
			const result = await runSdkTask(
				request({
					agent: { ...request().agent, filePath: agentFile },
					timeoutSeconds: 0,
					continuation: target,
				}),
				{} as SdkRunnerServices,
				undefined,
				{ createSession: async () => session },
			);
			return { result, session };
		};

		const locatorFailure = await run(`child session write failed at ${childFile} (${childSessionId}/${childLeafId})`);
		assert.equal(locatorFailure.result.errorMessage, "Continuation commitment failed");
		assert.equal(locatorFailure.result.exitCode, 1);
		assert.equal(locatorFailure.session.disposeCalls, 1);

		const providerFailureText = "provider failed: temporary upstream outage";
		const providerFailure = await run(providerFailureText);
		assert.equal(providerFailure.result.errorMessage, providerFailureText);
		assert.equal(providerFailure.result.exitCode, 1);
		assert.equal(providerFailure.session.disposeCalls, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("returns promptly when cancelled setup never settles", async () => {
	const controller = new AbortController();
	const neverSettles = new Promise<SessionLike>(() => undefined);
	const running = runSdkTask(
		request({ signal: controller.signal, timeoutSeconds: 0 }),
		{} as SdkRunnerServices,
		undefined,
		{ createSession: async () => neverSettles },
	);

	controller.abort();
	const result = await Promise.race([
		running,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cancelled setup did not return")), 100)),
	]);
	assert.equal(result.aborted, true);
	assert.equal(result.timedOut, false);
	assert.equal(result.messages.length, 0);
});

test("returns promptly with timeout classification when setup never settles", async () => {
	const neverSettles = new Promise<SessionLike>(() => undefined);
	const running = runSdkTask(request({ timeoutSeconds: 0.01 }), {} as SdkRunnerServices, undefined, {
		createSession: async () => neverSettles,
	});

	const result = await Promise.race([
		running,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed-out setup did not return")), 100)),
	]);
	assert.equal(result.timedOut, true);
	assert.equal(result.aborted, false);
	assert.equal(result.stopReason, "timeout");
});

test("returns promptly when lazy service initialization never settles and the parent aborts", async () => {
	const controller = new AbortController();
	const neverSettles = new Promise<SdkRunnerServices>(() => undefined);
	let factoryCalls = 0;
	const running = runSingleAgent(
		{
			defaultCwd: "/parent",
			agents: [orchestrationAgent("luna")],
			sdkServices: () => {
				factoryCalls++;
				return neverSettles;
			},
			signal: controller.signal,
		},
		{ agentName: "luna", task: "wait for services", timeoutSeconds: 1200 },
	);

	await waitForCondition(() => factoryCalls === 1);
	controller.abort();
	const result = await Promise.race([
		running,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("service wait did not abort")), 100)),
	]);

	assert.equal(result.aborted, true);
	assert.equal(result.timedOut, false);
	assert.equal(result.stopReason, "aborted");
});

test("returns promptly with timeout classification when lazy service initialization never settles", async () => {
	const neverSettles = new Promise<SdkRunnerServices>(() => undefined);
	let factoryCalls = 0;
	const running = runSingleAgent(
		{
			defaultCwd: "/parent",
			agents: [orchestrationAgent("luna")],
			sdkServices: () => {
				factoryCalls++;
				return neverSettles;
			},
		},
		{ agentName: "luna", task: "wait for services", timeoutSeconds: 0.01 },
	);

	await waitForCondition(() => factoryCalls === 1);
	const result = await Promise.race([
		running,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("service wait did not time out")), 100)),
	]);

	assert.equal(result.aborted, false);
	assert.equal(result.timedOut, true);
	assert.equal(result.stopReason, "timeout");
});

test("classifies an already-aborted dispatch before a rejecting shared service", async () => {
	const controller = new AbortController();
	controller.abort();
	const initialization = deferred<SdkRunnerServices>();
	const running = runSingleAgent(
		{
			defaultCwd: "/parent",
			agents: [orchestrationAgent("luna")],
			sdkServices: initialization.promise,
			signal: controller.signal,
		},
		{ agentName: "luna", task: "already cancelled" },
	);

	const result = await running;
	const snapshot = JSON.stringify(result);
	initialization.reject(new Error("shared service rejected after abort"));
	await new Promise((resolve) => setTimeout(resolve, 5));

	assert.equal(result.aborted, true);
	assert.equal(result.timedOut, false);
	assert.equal(result.stopReason, "aborted");
	assert.equal(JSON.stringify(result), snapshot);
});

test("shares one pending lazy service initialization across timed-out first callers", async () => {
	let factoryCalls = 0;
	const initialization = deferred<SdkRunnerServices>();
	const getServices = createLazySdkRunnerServices(() => {
		factoryCalls++;
		return initialization.promise;
	});
	const context = {
		defaultCwd: "/parent",
		agents: [orchestrationAgent("luna")],
		sdkServices: getServices,
	};
	const first = runSingleAgent(context, { agentName: "luna", task: "first", timeoutSeconds: 0.01 });
	const second = runSingleAgent(context, { agentName: "luna", task: "second", timeoutSeconds: 0.01 });

	await waitForCondition(() => factoryCalls === 1);
	const timeoutGuard = () =>
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("shared wait did not time out")), 100));
	const results = await Promise.all([Promise.race([first, timeoutGuard()]), Promise.race([second, timeoutGuard()])]);
	const snapshots = results.map((result) => JSON.stringify(result));

	assert.equal(factoryCalls, 1);
	assert.ok(results.every((result) => result.timedOut && !result.aborted && result.stopReason === "timeout"));
	initialization.reject(new Error("late shared service rejection"));
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(
		results.map((result) => JSON.stringify(result)),
		snapshots,
	);
});

test("keeps a cancelled result stable after late shared service resolution and session cleanup", async () => {
	const controller = new AbortController();
	const initialization = deferred<SdkRunnerServices>();
	const services = {} as SdkRunnerServices;
	let factoryCalls = 0;
	const session = new FakeSession();
	let receivedServices: SdkRunnerServices | undefined;
	const running = runSdkTask(
		request({ signal: controller.signal, timeoutSeconds: 0 }),
		() => {
			factoryCalls++;
			return initialization.promise;
		},
		undefined,
		{
			createSession: async (_request, resolvedServices) => {
				receivedServices = resolvedServices;
				return session;
			},
		},
	);

	await waitForCondition(() => factoryCalls === 1);
	controller.abort();
	const result = await running;
	const snapshot = JSON.stringify(result);
	initialization.resolve(services);
	await waitForCondition(() => session.disposeCalls === 1);

	assert.strictEqual(receivedServices, services);
	assert.equal(session.abortCalls, 1);
	assert.equal(JSON.stringify(result), snapshot);
});

test("observes a late shared service rejection without mutating a cancelled result", async () => {
	const controller = new AbortController();
	const initialization = deferred<SdkRunnerServices>();
	let factoryCalls = 0;
	const running = runSdkTask(
		request({ signal: controller.signal, timeoutSeconds: 0 }),
		() => {
			factoryCalls++;
			return initialization.promise;
		},
		undefined,
		{ createSession: async () => new FakeSession() },
	);

	await waitForCondition(() => factoryCalls === 1);
	controller.abort();
	const result = await running;
	const snapshot = JSON.stringify(result);
	initialization.reject(new Error("late shared service failure"));
	await new Promise((resolve) => setTimeout(resolve, 5));

	assert.equal(result.aborted, true);
	assert.equal(JSON.stringify(result), snapshot);
});

test("isolates a throwing late cleanup sink and reports every failure through fallback", async () => {
	const controller = new AbortController();
	const session = new FakeSession();
	session.abortImpl = async () => {
		throw new Error("late abort failed");
	};
	session.disposeImpl = () => {
		throw new Error("late dispose failed");
	};
	const setup = deferred<SessionLike>();
	const sinkCalls: string[] = [];
	const fallbackCalls: string[] = [];
	const originalConsoleError = console.error;
	console.error = ((...args: unknown[]) => fallbackCalls.push(args.join(" "))) as typeof console.error;
	try {
		const running = runSdkTask(
			request({ signal: controller.signal, timeoutSeconds: 0 }),
			{} as SdkRunnerServices,
			undefined,
			{
				createSession: async () => setup.promise,
				onCleanupDiagnostic: (message) => {
					sinkCalls.push(message);
					throw new Error("diagnostic sink failed");
				},
			},
		);

		controller.abort();
		const result = await running;
		setup.resolve(session);
		await waitForCondition(() => session.disposeCalls === 1);

		assert.equal(result.aborted, true);
		assert.deepEqual(sinkCalls, ["session.abort(): late abort failed", "session.dispose(): late dispose failed"]);
		assert.equal(fallbackCalls.length, 2);
		assert.match(fallbackCalls[0], /diagnostic sink failed/);
		assert.match(fallbackCalls[0], /session\.abort\(\): late abort failed/);
		assert.match(fallbackCalls[1], /session\.dispose\(\): late dispose failed/);
	} finally {
		console.error = originalConsoleError;
	}
});

test("reports late abort and dispose cleanup failures without mutating the cancelled result", async () => {
	const controller = new AbortController();
	const session = new FakeSession();
	session.abortImpl = async () => {
		throw new Error("late abort failed");
	};
	session.disposeImpl = () => {
		throw new Error("late dispose failed");
	};
	const setup = deferred<SessionLike>();
	const diagnostics: string[] = [];
	const running = runSdkTask(
		request({ signal: controller.signal, timeoutSeconds: 0 }),
		{} as SdkRunnerServices,
		undefined,
		{
			createSession: async () => setup.promise,
			onCleanupDiagnostic: (message) => diagnostics.push(message),
		},
	);

	controller.abort();
	const result = await running;
	const snapshot = JSON.stringify(result);
	setup.resolve(session);
	await waitForCondition(() => session.disposeCalls === 1);

	assert.deepEqual(diagnostics, ["session.abort(): late abort failed", "session.dispose(): late dispose failed"]);
	assert.equal(session.abortCalls, 1);
	assert.equal(session.disposeCalls, 1);
	assert.equal(JSON.stringify(result), snapshot);
});

test("cleans up a late session exactly once without mutating the returned result", async () => {
	const controller = new AbortController();
	const session = new FakeSession();
	const setup = deferred<SessionLike>();
	const running = runSdkTask(
		request({ signal: controller.signal, timeoutSeconds: 0 }),
		{} as SdkRunnerServices,
		undefined,
		{ createSession: async () => setup.promise },
	);

	controller.abort();
	const result = await running;
	const snapshot = JSON.stringify(result);
	assert.equal(result.aborted, true);
	assert.equal(session.abortCalls, 0);
	assert.equal(session.disposeCalls, 0);

	setup.resolve(session);
	await waitForCondition(() => session.disposeCalls === 1);
	assert.equal(session.abortCalls, 1);
	assert.equal(session.disposeCalls, 1);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(JSON.stringify(result), snapshot);
});

test("observes a late setup rejection without mutating the returned result", async () => {
	const controller = new AbortController();
	const setup = deferred<SessionLike>();
	const running = runSdkTask(
		request({ signal: controller.signal, timeoutSeconds: 0 }),
		{} as SdkRunnerServices,
		undefined,
		{ createSession: async () => setup.promise },
	);

	controller.abort();
	const result = await running;
	const snapshot = JSON.stringify(result);
	setup.reject(new Error("late setup failure"));
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(result.cleanupError, undefined);
	assert.equal(JSON.stringify(result), snapshot);
});

test("continues collecting a final assistant message and usage after parent abort", async () => {
	const controller = new AbortController();
	const session = new FakeSession();
	let releasePrompt: (() => void) | undefined;
	session.promptImpl = () =>
		new Promise<void>((resolve) => {
			releasePrompt = resolve;
			session.emit({ type: "message_start", message: { role: "assistant", content: [] } });
			session.emit({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "partial" },
			});
		});
	session.abortImpl = async () => {
		session.emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "final after abort" }],
				model: "test-model",
				stopReason: "stop",
				usage: { input: 4, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 7, cost: { total: 0.5 } },
			},
		});
		releasePrompt?.();
	};

	const updates: SdkTaskUpdate[] = [];
	const running = collectSdkTask(request({ signal: controller.signal, timeoutSeconds: 0 }), session, (update) =>
		updates.push(update),
	);
	controller.abort();
	const result = await running;

	assert.equal(result.aborted, true);
	assert.equal(result.messages.length, 1);
	assert.equal((result.messages[0].content as Array<{ text: string }>)[0]?.text, "final after abort");
	assert.equal(result.usage.output, 3);
	assert.equal(result.model, "test-model");
	assert.equal(result.stopReason, "aborted");
	assert.equal(
		updates.some((update) => update.text === "final after abort"),
		false,
	);
});

test("retains an abort cleanup error without replacing a primary error", async () => {
	const controller = new AbortController();
	const session = new FakeSession();
	session.promptImpl = async () => {
		await new Promise((resolve) => setTimeout(resolve, 1));
		throw new Error("model failed");
	};
	session.abortImpl = async () => {
		throw new Error("abort failed");
	};

	const running = collectSdkTask(request({ signal: controller.signal }), session);
	controller.abort();
	const result = await running;

	assert.equal(result.errorMessage, "model failed");
	assert.match(result.cleanupError ?? "", /abort failed/);
	assert.equal(session.abortCalls, 1);
	assert.equal(session.disposeCalls, 1);
});

test("covers setup deadline cancellation and disposes a session created afterward", async () => {
	const session = new FakeSession();
	const setup = deferred();
	const setupSession = setup.promise.then(() => session);
	const timerInstrumentation = instrumentDeadlineTimers(15);
	const cancellation = createSdkTaskCancellation(request({ timeoutSeconds: 0.015 }));

	try {
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(timerInstrumentation.created(), 1);
		assert.equal(cancellation.cause, "timedOut");
		assert.equal(session.promptCalls.length, 0);

		setup.resolve();
		const lateSession = await setupSession;
		const result = await collectSdkTask(request({ timeoutSeconds: 0.015 }), lateSession, undefined, { cancellation });
		assert.equal(result.timedOut, true);
		assert.equal(result.aborted, false);
		assert.equal(result.stopReason, "timeout");
		assert.equal(session.promptCalls.length, 0);
		assert.equal(session.abortCalls, 1);
		assert.equal(session.disposeCalls, 1);
		assert.equal(timerInstrumentation.cleared(), 1);
	} finally {
		setup.resolve();
		cancellation.cleanup();
		timerInstrumentation.restore();
	}
});

test("installs parent cancellation during setup and classifies it without prompting", async () => {
	const controller = new AbortController();
	const signalInstrumentation = instrumentSignal(controller.signal);
	const session = new FakeSession();
	const setup = deferred();
	const setupSession = setup.promise.then(() => session);
	const cancellation = createSdkTaskCancellation(request({ signal: controller.signal, timeoutSeconds: 0 }));

	try {
		assert.equal(signalInstrumentation.addCalls(), 1);
		controller.abort();
		assert.equal(cancellation.cause, "aborted");
		setup.resolve();
		const lateSession = await setupSession;
		const result = await collectSdkTask(
			request({ signal: controller.signal, timeoutSeconds: 0 }),
			lateSession,
			undefined,
			{ cancellation },
		);

		assert.equal(result.aborted, true);
		assert.equal(result.timedOut, false);
		assert.equal(result.stopReason, "aborted");
		assert.equal(session.promptCalls.length, 0);
		assert.equal(session.abortCalls, 1);
		assert.equal(session.disposeCalls, 1);
		assert.equal(signalInstrumentation.removeCalls(), 1);
	} finally {
		setup.resolve();
		cancellation.cleanup();
		signalInstrumentation.restore();
	}
});

test("first cancellation source wins when abort and timeout fire together", async () => {
	const runRace = async (parentFirst: boolean) => {
		const controller = new AbortController();
		const session = new FakeSession();
		const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
		const originalClearTimeout = globalThis.clearTimeout.bind(globalThis);
		let deadline: (() => void) | undefined;
		const fakeHandle = {};
		globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
			if (delay === 10) {
				deadline = () => callback(...args);
				return fakeHandle as ReturnType<typeof setTimeout>;
			}
			return originalSetTimeout(callback, delay, ...args);
		}) as typeof globalThis.setTimeout;
		globalThis.clearTimeout = ((handle: unknown) => {
			if (handle === fakeHandle) return;
			return originalClearTimeout(handle as ReturnType<typeof setTimeout>);
		}) as typeof globalThis.clearTimeout;
		session.promptImpl = async () => {
			assert.ok(deadline);
			if (parentFirst) {
				controller.abort();
				deadline();
			} else {
				deadline();
				controller.abort();
			}
		};

		try {
			return await collectSdkTask(request({ signal: controller.signal, timeoutSeconds: 0.01 }), session);
		} finally {
			globalThis.setTimeout = originalSetTimeout as typeof globalThis.setTimeout;
			globalThis.clearTimeout = originalClearTimeout as typeof globalThis.clearTimeout;
		}
	};

	const parentFirst = await runRace(true);
	assert.equal(parentFirst.aborted, true);
	assert.equal(parentFirst.timedOut, false);
	assert.equal(parentFirst.stopReason, "aborted");
	const timeoutFirst = await runRace(false);
	assert.equal(timeoutFirst.aborted, false);
	assert.equal(timeoutFirst.timedOut, true);
	assert.equal(timeoutFirst.stopReason, "timeout");
});

test("starts and finishes run tracking around every known-agent dispatch", async () => {
	const lifecycle: string[] = [];
	let observedRequest: SdkTaskRequest | undefined;
	const agent = { ...orchestrationAgent("luna"), thinkingLevel: "medium" as const };
	const result = await runSingleAgent(
		{
			defaultCwd: "/tmp",
			agents: [agent],
			sdkServices: {} as SdkRunnerServices,
			runRegistry: {
				start(input) {
					lifecycle.push(`start:${input.agent}:${input.timeoutSeconds}:${input.thinkingLevel}`);
					return {
						runId: "run-1",
						observeEvent: () => {},
						appendOutput: () => {},
						finish: () => lifecycle.push("finish"),
					};
				},
			},
			runTask: async (taskRequest) => {
				observedRequest = taskRequest;
				throw new Error("provider failed");
			},
		},
		{ agentName: "luna", task: "inspect", cwd: "/tmp", thinkingLevel: "xhigh", timeoutSeconds: 33 },
	);

	assert.deepEqual(lifecycle, ["start:luna:33:xhigh", "finish"]);
	assert.equal(observedRequest?.observer !== undefined, true);
	assert.equal(observedRequest?.thinkingLevel, "xhigh");
	assert.equal(result.exitCode, 1);
	assert.match(result.errorMessage ?? "", /provider failed/);
});

test("rejects oversized continuation identity before child dispatch side effects", async () => {
	const agent = { ...orchestrationAgent("luna"), filePath: `/${"x".repeat(5000)}` };
	let runnerCalls = 0;
	let registryCalls = 0;
	const result = await runSingleAgent(
		{
			defaultCwd: "/parent",
			agents: [agent],
			sdkServices: {} as SdkRunnerServices,
			runRegistry: {
				start() {
					registryCalls++;
					return { runId: "run", observeEvent: () => {}, appendOutput: () => {}, finish: () => {} };
				},
			},
			runTask: async () => {
				runnerCalls++;
				return sdkResult("unexpected");
			},
		},
		{
			agentName: "luna",
			task: "inspect",
			continuation: {
				action: "create",
				thread: "thread",
				parentSessionId: "parent",
				parentScopedDirectory: "/private/continuations/parent",
			},
		},
	);
	assert.equal(result.exitCode, 1);
	assert.equal(runnerCalls, 0);
	assert.equal(registryCalls, 0);
	assert.equal(result.errorMessage, "Continuation state validation failed");
});

test("keeps fresh single dispatches free of continuation targets and metadata", async () => {
	let observedRequest: SdkTaskRequest | undefined;
	const result = await runSingleAgent(
		{
			defaultCwd: "/parent",
			agents: [orchestrationAgent("luna")],
			sdkServices: {} as SdkRunnerServices,
			runTask: async (request) => {
				observedRequest = request;
				return sdkResult("fresh");
			},
		},
		{ agentName: "luna", task: "fresh task" },
	);

	assert.equal(observedRequest?.continuation, undefined);
	assert.equal(result.continuation, undefined);
	assert.equal(JSON.stringify(result.messages).includes("continuation"), false);
});

test("passes an internal continuation target and adapts only the committed snapshot", async () => {
	const target = {
		action: "create" as const,
		thread: "feature-a-review",
		parentSessionId: "parent-session",
		parentScopedDirectory: "/private/continuations/parent",
	};
	let observedRequest: SdkTaskRequest | undefined;
	const result = await runSingleAgent(
		{
			defaultCwd: "/parent",
			agents: [orchestrationAgent("luna")],
			sdkServices: {} as SdkRunnerServices,
			runTask: async (request) => {
				observedRequest = request;
				return sdkResult("committed", {
					continuation: {
						sessionId: "child-session",
						sessionFile: "/private/continuations/parent/child.jsonl",
						leafId: "child-leaf",
						cwd: "/parent",
					},
				});
			},
		},
		{ agentName: "luna", task: "review the change", continuation: target },
	);

	assert.deepEqual(observedRequest?.continuation, target);
	assert.deepEqual(result.continuation, {
		version: 1,
		action: "create",
		thread: "feature-a-review",
		parentSessionId: "parent-session",
		childSessionId: "child-session",
		childSessionFile: "/private/continuations/parent/child.jsonl",
		childLeafId: "child-leaf",
		agent: {
			name: "luna",
			source: "user",
			filePath: "/tmp/luna.md",
		},
		cwd: "/parent",
	});
	assert.equal((result.messages[0].content as Array<{ text?: string }>)[0].text, "committed");
	assert.equal(result.trace?.join("\n").includes("child-session"), false);
});

test("fails accepted continuation turns that cannot produce a durable snapshot without locator leakage", async () => {
	// Canonical root: tmpdir() may be a symlink (macOS /var -> /private/var).
	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-continuation-commit-")));
	try {
		const parentDirectory = path.join(root, "parent-locator-directory");
		mkdirSync(parentDirectory, { recursive: true, mode: 0o700 });
		const childFile = path.join(parentDirectory, "child-locator-session.jsonl");
		writeFileSync(childFile, "{}\n", "utf8");
		const agentFile = path.join(root, "agent.md");
		writeFileSync(agentFile, "agent", "utf8");
		const childSessionId = "child-locator-session-id";
		const leafId = "child-locator-leaf-id";
		const entries = [
			{ id: "child-locator-root-entry", parentId: null },
			{
				id: "child-locator-user-entry",
				parentId: "child-locator-root-entry",
				message: { role: "user", content: "say hi" },
			},
			{
				id: leafId,
				parentId: "child-locator-user-entry",
				message: { role: "assistant", content: [], stopReason: "stop" },
			},
		];
		const manager = (persisted: boolean, sessionFile = childFile, leaf = leafId) => ({
			getSessionId: () => childSessionId,
			getCwd: () => "/tmp",
			getEntries: () => entries,
			getLeafId: () => leaf,
			getSessionFile: () => sessionFile,
			isPersisted: () => persisted,
			branch: () => undefined,
		});
		const createTarget = {
			action: "create" as const,
			thread: "thread-locator-name",
			parentSessionId: "parent-locator-session-id",
			parentScopedDirectory: parentDirectory,
		};

		const cases: Array<{
			name: string;
			attachManager: boolean;
			persisted?: boolean;
			sessionFile?: string;
			target?: NonNullable<SdkTaskRequest["continuation"]>;
			leaf?: string;
		}> = [
			{ name: "missing association", attachManager: false },
			{ name: "non-persisted manager", attachManager: true, persisted: false },
			{
				name: "missing child file",
				attachManager: true,
				persisted: true,
				sessionFile: path.join(parentDirectory, "missing-locator-session.jsonl"),
			},
			{
				name: "unchanged leaf",
				attachManager: true,
				persisted: true,
				target: {
					action: "resume",
					parentScopedDirectory: parentDirectory,
					record: {
						version: 1,
						action: "create",
						thread: "thread-locator-name",
						parentSessionId: "parent-locator-session-id",
						childSessionId,
						childSessionFile: childFile,
						childLeafId: leafId,
						agent: { name: "luna", source: "user", filePath: agentFile },
						cwd: "/tmp",
					},
				},
			},
		];

		for (const testCase of cases) {
			const session = new FakeSession();
			if (testCase.attachManager) {
				(session as FakeSession & { sessionManager: unknown }).sessionManager = manager(
					testCase.persisted ?? true,
					testCase.sessionFile,
					testCase.leaf,
				);
			}
			const result = await runSdkTask(
				request({
					agent: { ...request().agent, filePath: agentFile },
					continuation: testCase.target ?? createTarget,
				}),
				{} as SdkRunnerServices,
				undefined,
				{
					createSession: async () => session,
					openContinuationSession: () => manager(true),
				},
			);
			assert.equal(result.exitCode, 1, testCase.name);
			assert.equal(result.continuation, undefined, testCase.name);
			assert.equal(result.errorMessage, "Continuation commitment failed", testCase.name);
			for (const locator of [
				parentDirectory,
				childFile,
				childSessionId,
				leafId,
				"child-locator-root-entry",
				"child-locator-user-entry",
			])
				assert.equal(result.errorMessage?.includes(locator), false, `${testCase.name}: ${locator}`);
		}

		const successfulSession = new FakeSession();
		(successfulSession as FakeSession & { sessionManager: unknown }).sessionManager = manager(true);
		const successful = await runSdkTask(
			request({ agent: { ...request().agent, filePath: agentFile }, continuation: createTarget }),
			{} as SdkRunnerServices,
			undefined,
			{ createSession: async () => successfulSession, openContinuationSession: () => manager(true) },
		);
		assert.equal(successful.exitCode, 0);
		assert.equal(successful.continuation?.agentFilePath, agentFile);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("does not adapt a continuation snapshot from a failed dispatch", async () => {
	const target = {
		action: "resume" as const,
		parentScopedDirectory: "/private/continuations/parent",
		record: {
			version: 1 as const,
			action: "create" as const,
			thread: "feature-a-review",
			parentSessionId: "parent-session",
			childSessionId: "child-session",
			childSessionFile: "/private/continuations/parent/child.jsonl",
			childLeafId: "prior-leaf",
			agent: { name: "luna", source: "user" as const, filePath: "/tmp/luna.md" },
			cwd: "/parent",
		},
	};
	const result = await runSingleAgent(
		{
			defaultCwd: "/parent",
			agents: [orchestrationAgent("luna")],
			sdkServices: {} as SdkRunnerServices,
			runTask: async () =>
				sdkResult("failed", {
					exitCode: 1,
					stopReason: "error",
					errorMessage: "provider failed",
					continuation: {
						sessionId: "child-session",
						sessionFile: "/private/continuations/parent/child.jsonl",
						leafId: "new-leaf",
						cwd: "/parent",
					},
				}),
		},
		{ agentName: "luna", task: "retry the review", continuation: target },
	);

	assert.equal(result.continuation, undefined);
	assert.equal(result.exitCode, 1);
});

test("carries injected tool progress through SingleResult details without changing final content", async () => {
	const progress = {
		type: "tool_execution_update" as const,
		toolCallId: "call-1",
		toolName: "bash",
		partialResult: "half done",
	};
	const updates: SingleResult[] = [];
	const result = await runSingleAgent(
		{
			defaultCwd: "/parent",
			agents: [orchestrationAgent("luna")],
			sdkServices: {} as SdkRunnerServices,
			runTask: async (_request, _services, onUpdate) => {
				const update = sdkResult("final answer", { progress });
				onUpdate?.(update);
				return update;
			},
		},
		{ agentName: "luna", task: "run it" },
		(current) => updates.push(current),
	);

	assert.equal(updates[0].progress?.toolName, "bash");
	assert.equal(updates[0].progress?.type, "tool_execution_update");
	assert.equal(updates[0].progress?.partialResult, "half done");
	assert.equal(result.progress?.toolName, "bash");
	assert.equal((result.messages[0].content as Array<{ text: string }>)[0]?.text, "final answer");
});

test("disables all child skills while retaining discovery diagnostics", () => {
	const diagnostics = [{ path: "/root/skills", message: "warning" }];
	const filtered = disableSkills({
		skills: [
			{ name: "pi", filePath: "/root/skills/pi/SKILL.md" },
			{ name: "ordinary", filePath: "/root/skills/ordinary/SKILL.md" },
		],
		diagnostics,
	});

	assert.deepEqual(filtered.skills, []);
	assert.strictEqual(filtered.diagnostics, diagnostics);
});

test("adapts a rejected shared service into an explicit single failure", async () => {
	const result = await runSingleAgent(
		{
			defaultCwd: "/parent",
			agents: [orchestrationAgent("luna")],
			sdkServices: Promise.reject(new Error("shared service rejected")),
		},
		{ agentName: "luna", task: "single" },
	);

	assert.equal(result.exitCode, 1);
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, "shared service rejected");
});

test("constructs lazy orchestration without initializing services and adapts first-dispatch rejection", async () => {
	let factoryCalls = 0;
	const getServices = createLazySdkRunnerServices(async () => {
		factoryCalls++;
		throw new Error("lazy service rejected");
	});
	const context = {
		defaultCwd: "/parent",
		agents: [orchestrationAgent("luna")],
		sdkServices: getServices,
	};

	assert.equal(factoryCalls, 0);
	const result = await runSingleAgent(context, { agentName: "luna", task: "first dispatch" });

	assert.equal(factoryCalls, 1);
	assert.equal(result.agent, "luna");
	assert.equal(result.task, "first dispatch");
	assert.equal(result.exitCode, 1);
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, "lazy service rejected");
	assert.equal(result.stderr, "lazy service rejected");
	assert.deepEqual(result.messages, []);
});

test("shares concurrent first-dispatch service initialization", async () => {
	let factoryCalls = 0;
	const initialization = deferred<SdkRunnerServices>();
	const getServices = createLazySdkRunnerServices(() => {
		factoryCalls++;
		return initialization.promise;
	});
	const context = {
		defaultCwd: "/parent",
		agents: [orchestrationAgent("luna")],
		sdkServices: getServices,
	};
	const first = runSingleAgent(context, { agentName: "luna", task: "first" });
	const second = runSingleAgent(context, { agentName: "luna", task: "second" });

	await waitForCondition(() => factoryCalls === 1);
	assert.equal(factoryCalls, 1);
	initialization.reject(new Error("concurrent service rejected"));
	const results = await Promise.all([first, second]);

	assert.deepEqual(
		results.map((result) => result.task),
		["first", "second"],
	);
	assert.ok(results.every((result) => result.exitCode === 1 && result.stopReason === "error"));
	assert.deepEqual(
		results.map((result) => result.errorMessage),
		["concurrent service rejected", "concurrent service rejected"],
	);
});

test("adapts a throwing runner into an explicit single failure", async () => {
	const result = await runSingleAgent(
		{
			defaultCwd: "/parent",
			agents: [orchestrationAgent("luna")],
			sdkServices: {} as SdkRunnerServices,
			runTask: async () => {
				throw new Error("runner exploded");
			},
		},
		{ agentName: "luna", task: "single" },
	);

	assert.equal(result.exitCode, 1);
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, "runner exploded");
});

test("adapts a rejected shared service for every parallel result in stable order", async () => {
	const tasks = ["first", "second", "third"].map((task, index) => ({ agent: `agent-${index}`, task }));
	const results = await runParallel({
		tasks,
		defaultCwd: "/parent",
		agents: tasks.map((task) => orchestrationAgent(task.agent)),
		sdkServices: Promise.reject(new Error("parallel services rejected")),
	});

	assert.deepEqual(
		results.map((result) => result.task),
		tasks.map((task) => task.task),
	);
	assert.deepEqual(
		results.map((result) => result.errorMessage),
		tasks.map(() => "parallel services rejected"),
	);
	assert.ok(results.every((result) => result.exitCode === 1 && result.stopReason === "error"));
});

test("adapts a throwing runner for every parallel result in stable order", async () => {
	const tasks = ["first", "second", "third"].map((task, index) => ({ agent: `agent-${index}`, task }));
	const results = await runParallel({
		tasks,
		defaultCwd: "/parent",
		agents: tasks.map((task) => orchestrationAgent(task.agent)),
		sdkServices: {} as SdkRunnerServices,
		runTask: async (request) => {
			throw new Error(`runner failed: ${request.task}`);
		},
	});

	assert.deepEqual(
		results.map((result) => result.task),
		tasks.map((task) => task.task),
	);
	assert.deepEqual(
		results.map((result) => result.errorMessage),
		tasks.map((task) => `runner failed: ${task.task}`),
	);
	assert.ok(results.every((result) => result.exitCode === 1 && result.stopReason === "error"));
});

test("parallel keeps stable order, propagates cwd and timeout, and caps concurrency at four", async () => {
	const tasks = Array.from({ length: 8 }, (_, index) => ({
		agent: `agent-${index}`,
		task: `task-${index}`,
		cwd: `/cwd/${index}`,
		...(index === 3 ? { timeoutSeconds: 4, thinkingLevel: "low" as const } : {}),
	}));
	const calls: SdkTaskRequest[] = [];
	let active = 0;
	let maximumActive = 0;
	const results = await runParallel({
		tasks,
		topLevelTimeoutSeconds: 30,
		topLevelThinkingLevel: "xhigh",
		defaultCwd: "/parent",
		agents: tasks.map((task) => orchestrationAgent(task.agent)),
		sdkServices: {} as SdkRunnerServices,
		runTask: async (request) => {
			calls.push(request);
			active++;
			maximumActive = Math.max(maximumActive, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			return sdkResult(request.task);
		},
	});

	assert.equal(maximumActive, 4);
	assert.deepEqual(
		results.map((result) => (result.messages[0] as any).content[0].text),
		tasks.map((task) => task.task),
	);
	const callByTask = new Map(calls.map((call) => [call.task, call]));
	for (const task of tasks) {
		assert.equal(callByTask.get(task.task)?.cwd, task.cwd);
		assert.equal(callByTask.get(task.task)?.timeoutSeconds, task.timeoutSeconds ?? 30);
		assert.equal(callByTask.get(task.task)?.thinkingLevel, task.thinkingLevel ?? "xhigh");
	}
});

test("parallel awaits active runner cleanup after parent cancellation", async () => {
	const controller = new AbortController();
	const started = deferred<void>();
	const releases: Array<() => void> = [];
	let startedCount = 0;
	let settledCount = 0;
	let abortNoticeCount = 0;
	const running = runParallel({
		tasks: Array.from({ length: 4 }, (_, index) => ({ agent: `agent-${index}`, task: `task-${index}` })),
		topLevelTimeoutSeconds: 1200,
		defaultCwd: "/parent",
		agents: Array.from({ length: 4 }, (_, index) => orchestrationAgent(`agent-${index}`)),
		signal: controller.signal,
		sdkServices: {} as SdkRunnerServices,
		runTask: async (request) => {
			startedCount++;
			if (startedCount === 4) started.resolve();
			request.signal?.addEventListener("abort", () => abortNoticeCount++, { once: true });
			return new Promise<SdkTaskResult>((resolve) => {
				releases.push(() => {
					settledCount++;
					resolve(sdkResult(request.task));
				});
			});
		},
	});

	await started.promise;
	controller.abort();
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(abortNoticeCount, 4);
	assert.equal(settledCount, 0);
	for (const release of releases) release();
	await running;
	assert.equal(settledCount, 4);
});

function runSingleAgent(...args: Parameters<typeof corerunSingleAgent>): ReturnType<typeof corerunSingleAgent> {
	args[0] = { ...args[0], scheduler: args[0].scheduler ?? new RunScheduler(4) };
	return corerunSingleAgent(...args);
}
function runParallel(...args: Parameters<typeof corerunParallel>): ReturnType<typeof corerunParallel> {
	args[0] = { ...args[0], scheduler: args[0].scheduler ?? new RunScheduler(4) };
	return corerunParallel(...args);
}
