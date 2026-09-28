import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, getCurrentTools, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	ModelRuntime,
	SessionManager,
	SettingsManager,
	DefaultResourceLoader,
	createAgentSession,
	initTheme,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { renderAdvancedDispatchResult, renderCompactDispatchResult } from "./renderers.ts";
import { parseAgentDefinition, loadAgentsFromDir } from "./agents.ts";
import { formatParallelHandoff } from "./handoffs.ts";
import {
	collectSdkTask,
	createEmptyUsage,
	COMBINED_HANDOFF_MAX_BYTES,
	COMBINED_HANDOFF_MAX_LINES,
} from "./sdk-runner-core.ts";
import type { SingleResult } from "./sdk-orchestration-core.ts";

function result(agent: string, text: string, failed = false): SingleResult {
	return {
		state: failed ? "failed" : "succeeded",
		agent,
		agentSource: "user",
		task: "test",
		exitCode: failed ? 1 : 0,
		messages: [{ role: "assistant", content: [{ type: "text", text }] }],
		stderr: "",
		usage: createEmptyUsage(),
		timedOut: false,
		aborted: false,
		timeoutSeconds: 1,
		timing: { totalMs: 0, setupMs: 0, timedOut: false },
	};
}

test("parallel handoffs retain every agent status and a fair share of each result", () => {
	for (let count = 1; count <= 8; count++) {
		const results = Array.from({ length: count }, (_, i) =>
			result(`agent-${i}`, `finding-${i}\n` + "😀".repeat(30_000), i === count - 1),
		);
		const output = formatParallelHandoff(results);
		for (let i = 0; i < count; i++) {
			assert.match(output, new RegExp(`agent-${i}:`));
			assert.match(output, new RegExp(`finding-${i}`));
		}
		assert.match(output, new RegExp(`agent-${count - 1}: failed`));
		assert.ok(Buffer.byteLength(output) <= COMBINED_HANDOFF_MAX_BYTES);
		assert.ok(output.split("\n").length <= COMBINED_HANDOFF_MAX_LINES);
	}
});

test("frontmatter validates runtime types and distinguishes empty and omitted tools", () => {
	const parse = (extra = "") =>
		parseAgentDefinition(
			`---\nname: scout\ndescription: Read-only scout\n${extra}---\nInspect code.`,
			"/agents/scout.md",
			"user",
		);
	assert.equal(parse().tools, undefined);
	assert.deepEqual(parse("tools: []\n").tools, []);
	assert.deepEqual(parse('tools: ""\n').tools, []);
	assert.deepEqual(parse("tools: [read, grep]\n").tools, ["read", "grep"]);
	assert.throws(() => parse("model: 42\n"), /scout.md.*model/);
	assert.throws(() => parse("tools: [read, invalid]\n"), /scout.md.*tools/);
	assert.throws(() => parse("tools: 12\n"), /scout.md.*tools/);
	assert.throws(() => parseAgentDefinition("---\nname: [broken\n---", "bad.md", "user"), /bad.md/);
});

test("duplicate definitions warn and keep the first source", () => {
	const root = mkdtempSync(join(tmpdir(), "subagent-agents-"));
	try {
		const content = "---\nname: duplicate\ndescription: test\n---\n";
		const firstPath = join(root, "a.md");
		const duplicatePath = join(root, "b.md");
		writeFileSync(firstPath, content);
		writeFileSync(duplicatePath, content);
		const warnings: string[] = [];
		const agents = loadAgentsFromDir(root, "user", (warning) => warnings.push(warning));
		assert.deepEqual(
			agents.map((agent) => agent.filePath),
			[firstPath],
		);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /Duplicate agent name "duplicate"/);
		assert.ok(warnings[0].includes(firstPath));
		assert.ok(warnings[0].includes(duplicatePath));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test(
	"registered tools execute with the real SDK and continue durable sessions after reload",
	{ timeout: 15_000 },
	async () => {
		const root = mkdtempSync(join(tmpdir(), "subagent-integration-"));
		const oldDir = process.env.PI_CODING_AGENT_DIR;
		const oldHome = process.env.HOME;
		const oldOffline = process.env.PI_OFFLINE;
		process.env.PI_CODING_AGENT_DIR = root;
		process.env.HOME = root;
		process.env.PI_OFFLINE = "1";
		const events = new Map<string, (...args: any[]) => any>();
		const tools = new Map<string, ToolDefinition<any>>();
		const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
		let active: string[] = ["read", "subagent", "load_subagents", "subagent_advanced"];
		const pi = {
			on: (name: string, handler: (...args: any[]) => any) => events.set(name, handler),
			registerTool: (tool: ToolDefinition<any>) => tools.set(tool.name, tool),
			registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) =>
				commands.set(name, command),
			getActiveTools: () => active,
			setActiveTools: (names: string[]) => {
				active = names;
			},
		} as unknown as ExtensionAPI;
		try {
			mkdirSync(join(root, "agents"));
			writeFileSync(
				join(root, "agents", "test.md"),
				"---\nname: test\ndescription: Test agent\nmodel: offline/faux\ntools: []\n---\nKeep answers short.",
			);
			const malformedPath = join(root, "agents", "malformed.md");
			writeFileSync(malformedPath, "---\nname: [broken\n---\n");
			mkdirSync(join(root, "extensions"));
			writeFileSync(join(root, "extensions", "forbidden.ts"), 'throw new Error("Child loaded extensions");');
			const modelRuntime = await ModelRuntime.create({
				credentials: new InMemoryCredentialStore(),
				modelsPath: null,
				modelsStorePath: join(root, "models-store.json"),
				allowModelNetwork: false,
				refreshOnCreate: false,
			});
			const faux = fauxProvider({ provider: "offline", models: [{ id: "faux" }], tokensPerSecond: Infinity });
			modelRuntime.registerNativeProvider(faux.provider);
			const parent = SessionManager.create(root, join(root, "parent"));
			parent.appendMessage({ role: "user", content: "parent", timestamp: Date.now() });
			parent.appendMessage(fauxAssistantMessage("parent ready"));
			const notifications: Array<{ message: string; level: string | undefined }> = [];
			const ctx = {
				cwd: root,
				isProjectTrusted: () => true,
				sessionManager: parent,
				hasUI: true,
				ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
			} as unknown as ExtensionContext;
			register(pi, async () => ({ modelRuntime }));
			await events.get("session_start")!({}, ctx);
			const startupWarning = notifications.find(({ message }) => message.includes(malformedPath));
			assert.ok(startupWarning, `missing startup warning for ${malformedPath}`);
			assert.equal(startupWarning.level, "warning");
			notifications.length = 0;
			let diagnostic = "";
			await commands.get("implement-review")!.handler("test", {
				...ctx,
				ui: {
					notify: (message: string) => {
						diagnostic = message;
					},
				},
			});
			assert.match(diagnostic, /Missing workflow agent "implementor"/);
			assert.deepEqual(active, ["read", "load_subagents"]);
			const invoke = async (name: string, args: Record<string, unknown>) =>
				tools.get(name)!.execute("call", args, undefined, undefined, ctx);
			const loaded = await invoke("load_subagents", {});
			assert.ok(active.includes("subagent"), `compact tool not activated: ${active}`);
			assert.ok(active.includes("subagent_advanced"), `advanced tool not activated: ${active}`);
			assert.match(JSON.stringify(loaded.content), /Available agents:/);
			assert.deepEqual((loaded.details as any).added.sort(), ["subagent", "subagent_advanced"]);
			const alreadyLoaded = await invoke("load_subagents", {});
			assert.match(JSON.stringify(alreadyLoaded.content), /already enabled/);
			assert.deepEqual((alreadyLoaded.details as any).added, []);
			assert.match(tools.get("load_subagents")!.promptSnippet ?? "", /on demand/);
			// Tree navigation before the loader call hides the dispatch tools again.
			await events.get("session_tree")!({ type: "session_tree", newLeafId: null, oldLeafId: null }, ctx);
			assert.deepEqual(active, ["read", "load_subagents"]);
			parent.appendMessage({
				role: "toolResult",
				toolCallId: "load",
				toolName: "load_subagents",
				content: [{ type: "text", text: "Enabled subagent and subagent_advanced." }],
				details: { added: ["subagent", "subagent_advanced"] },
				isError: false,
				timestamp: Date.now(),
			});
			await events.get("session_tree")!({ type: "session_tree", newLeafId: null, oldLeafId: null }, ctx);
			assert.deepEqual(active, ["read", "load_subagents", "subagent", "subagent_advanced"]);
			const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
			assert.doesNotThrow(() => tools.get("subagent")!.renderCall!({}, theme, {} as never).render(80));
			const compactSchema = tools.get("subagent")!.parameters as { properties: Record<string, unknown> };
			assert.deepEqual(Object.keys(compactSchema.properties).sort(), ["agent", "cwd", "task"]);
			const advancedSchema = tools.get("subagent_advanced")!.parameters as { properties: Record<string, unknown> };
			assert.ok(!("chain" in advancedSchema.properties));

			const parentTranscripts = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((file) =>
				file.endsWith(".jsonl"),
			);
			assert.equal(parentTranscripts.length, 1);
			faux.setResponses([
				(context) => {
					assert.equal(getCurrentTools(context.messages).length, 0);
					return fauxAssistantMessage("fresh result");
				},
			]);
			const fresh = await invoke("subagent", { agent: "test", task: "fresh task" });
			assert.match(JSON.stringify(fresh.content), /fresh result/);
			assert.equal((fresh.details as any).continuation, undefined);
			assert.ok(
				notifications.some(({ message, level }) => level === "warning" && message.includes(malformedPath)),
				`missing dispatch warning for ${malformedPath}`,
			);
			assert.deepEqual(
				readdirSync(root, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".jsonl")),
				parentTranscripts,
			);

			faux.setResponses([fauxAssistantMessage("remember the codeword walnut")]);
			const created = await invoke("subagent_advanced", {
				agent: "test",
				task: "Remember walnut",
				continuation: { action: "create", thread: "memory" },
			});
			const record = (created.details as any).continuation;
			assert.ok(record, JSON.stringify(created));
			assert.equal(record.action, "create");
			const durableTranscripts = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((file) =>
				file.endsWith(".jsonl"),
			);
			assert.equal(durableTranscripts.length, parentTranscripts.length + 1);
			parent.appendMessage({
				role: "toolResult",
				toolCallId: "create",
				toolName: "subagent_advanced",
				content: created.content,
				details: JSON.parse(JSON.stringify(created.details)),
				isError: false,
				timestamp: Date.now(),
			});
			// Recreate the extension instance and reopen parent history as a real reload would.
			await events.get("session_shutdown")!({}, ctx);
			const reopened = SessionManager.open(parent.getSessionFile()!);
			(ctx as any).sessionManager = reopened;
			register(pi, async () => ({ modelRuntime }));
			await events.get("session_start")!({ reason: "reload" }, ctx);
			faux.setResponses([
				(context) => {
					assert.match(JSON.stringify(context.messages), /remember the codeword walnut/);
					return fauxAssistantMessage("walnut");
				},
			]);
			const resumed = await invoke("subagent_advanced", {
				agent: "test",
				task: "What was the codeword?",
				continuation: { action: "resume", thread: "memory" },
			});
			assert.equal(
				(resumed.details as any).continuation?.childSessionId,
				record.childSessionId,
				JSON.stringify(resumed),
			);
			assert.notEqual((resumed.details as any).continuation?.childLeafId, record.childLeafId);
			assert.match(JSON.stringify(resumed.content), /walnut/);
			assert.deepEqual(
				readdirSync(root, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".jsonl")),
				durableTranscripts,
			);

			const failure = await invoke("subagent", { agent: "missing", task: "test" });
			assert.deepEqual(events.get("tool_result")!({ toolName: "subagent", details: failure.details }), {
				isError: true,
			});
			await assert.rejects(
				invoke("subagent_advanced", {
					agent: "malformed",
					task: "test",
					continuation: { action: "resume", thread: "missing" },
				}),
				(error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					assert.match(message, /Unknown agent for continuation: "malformed"/);
					assert.ok(message.includes(malformedPath), message);
					return true;
				},
			);
			await assert.rejects(
				invoke("subagent_advanced", { agent: "test", task: "one", tasks: [{ agent: "test", task: "two" }] }),
				/exactly one/,
			);
			await assert.rejects(
				invoke("subagent_advanced", { chain: [{ agent: "test", task: "one" }] }),
				/chain mode is no longer supported/i,
			);
			await assert.rejects(
				invoke("subagent_advanced", { agent: "test", task: "one", chain: [] }),
				/chain mode is no longer supported/i,
			);
			await events.get("session_shutdown")!({}, ctx);
		} finally {
			for (const [key, value] of Object.entries({
				PI_CODING_AGENT_DIR: oldDir,
				HOME: oldHome,
				PI_OFFLINE: oldOffline,
			})) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		}
	},
);

test(
	"advanced continuation keeps a same-thread lock through unsettled setup cleanup",
	{ timeout: 15_000 },
	async () => {
		const root = mkdtempSync(join(tmpdir(), "subagent-continuation-lock-"));
		const oldDir = process.env.PI_CODING_AGENT_DIR;
		const oldHome = process.env.HOME;
		const oldOffline = process.env.PI_OFFLINE;
		process.env.PI_CODING_AGENT_DIR = root;
		process.env.HOME = root;
		process.env.PI_OFFLINE = "1";
		const tools = new Map<string, ToolDefinition<any>>();
		let active: string[] = ["subagent_advanced"];
		const pi = {
			on: () => undefined,
			registerTool: (tool: ToolDefinition<any>) => tools.set(tool.name, tool),
			registerCommand: () => undefined,
			getActiveTools: () => active,
			setActiveTools: (names: string[]) => {
				active = names;
			},
		} as unknown as ExtensionAPI;
		let finishServices!: () => void;
		const servicesReady = new Promise<void>((resolve) => (finishServices = resolve));
		let serviceStarted!: () => void;
		const started = new Promise<void>((resolve) => (serviceStarted = resolve));
		let serviceReturned!: () => void;
		const returned = new Promise<void>((resolve) => (serviceReturned = resolve));
		let serviceInvoked = false;
		const services = async () => {
			serviceInvoked = true;
			serviceStarted();
			await servicesReady;
			serviceReturned();
			return { modelRuntime: {} as ModelRuntime };
		};
		try {
			mkdirSync(join(root, "agents"));
			writeFileSync(
				join(root, "agents", "test.md"),
				"---\nname: test\ndescription: Test agent\n---\nKeep answers short.",
			);
			const parent = SessionManager.create(root, join(root, "parent"));
			parent.appendMessage({ role: "user", content: "parent", timestamp: Date.now() });
			parent.appendMessage(fauxAssistantMessage("parent ready"));
			const ctx = {
				cwd: root,
				isProjectTrusted: () => true,
				sessionManager: parent,
				hasUI: true,
				ui: { notify: () => undefined },
			} as unknown as ExtensionContext;
			register(pi, services);
			const invoke = (callId: string, params: Record<string, unknown>, signal?: AbortSignal) =>
				tools.get("subagent_advanced")!.execute(callId, params, signal, undefined, ctx);
			const controller = new AbortController();
			const firstPending = invoke(
				"first",
				{ agent: "test", task: "blocked", continuation: { action: "create", thread: "same-thread" } },
				controller.signal,
			);
			await started;
			controller.abort();
			const first = await firstPending;
			assert.equal((first.details as any).results[0].state, "cancelled");

			const contentionController = new AbortController();
			contentionController.abort();
			await assert.rejects(
				invoke(
					"second",
					{
						agent: "test",
						task: "contended",
						continuation: { action: "create", thread: "same-thread" },
					},
					contentionController.signal,
				),
				/already in use/i,
			);

			finishServices();
			await returned;
			let released = false;
			for (let attempt = 0; attempt < 50; attempt++) {
				try {
					await invoke("after-settlement", {
						agent: "test",
						task: "retry",
						continuation: { action: "resume", thread: "same-thread" },
					});
					assert.fail("resume should not find a continuation record");
				} catch (error: unknown) {
					const message = error instanceof Error ? error.message : String(error);
					if (/does not exist on this parent/i.test(message)) {
						released = true;
						break;
					}
					assert.match(message, /already in use/i);
					await new Promise<void>((resolve) => setTimeout(resolve, 0));
				}
			}
			assert.equal(released, true, "same-thread lock was not released after settlement");
		} finally {
			finishServices();
			if (serviceInvoked) await returned;
			for (const [key, value] of Object.entries({
				PI_CODING_AGENT_DIR: oldDir,
				HOME: oldHome,
				PI_OFFLINE: oldOffline,
			})) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		}
	},
);

test(
	"real SDK does not start a run when authentication finishes after cancellation",
	{ timeout: 15_000 },
	async (t) => {
		const root = mkdtempSync(join(tmpdir(), "subagent-preflight-"));
		let finishPreparation!: () => void;
		const prepared = new Promise<void>((resolve) => {
			finishPreparation = resolve;
		});
		try {
			const modelRuntime = await ModelRuntime.create({
				credentials: new InMemoryCredentialStore(),
				modelsPath: null,
				modelsStorePath: join(root, "models-store.json"),
				allowModelNetwork: false,
				refreshOnCreate: false,
			});
			const faux = fauxProvider({ provider: "preflight-test", tokensPerSecond: Infinity });
			modelRuntime.registerNativeProvider(faux.provider);
			faux.setResponses([fauxAssistantMessage("must not run")]);
			const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
			const loader = new DefaultResourceLoader({
				cwd: root,
				agentDir: root,
				settingsManager,
				noExtensions: true,
				noSkills: true,
			});
			await loader.reload();
			const { session } = await createAgentSession({
				cwd: root,
				agentDir: root,
				modelRuntime,
				model: faux.getModel(),
				tools: [],
				resourceLoader: loader,
				settingsManager,
				sessionManager: SessionManager.inMemory(root),
			});
			try {
				const auth = await modelRuntime.checkAuth(faux.provider.id);
				assert.ok(auth);
				let startPreparation!: () => void;
				const preparing = new Promise<void>((resolve) => {
					startPreparation = resolve;
				});
				t.mock.method(modelRuntime, "hasConfiguredAuth", () => false);
				t.mock.method(modelRuntime, "checkAuth", async () => {
					startPreparation();
					await prepared;
					return auth;
				});
				let starts = 0;
				session.subscribe((event) => {
					if (event.type === "agent_start") starts++;
				});
				const controller = new AbortController();
				const pending = collectSdkTask(
					{
						agent: {
							name: "test",
							description: "test",
							source: "user",
							filePath: join(root, "test.md"),
							systemPrompt: "",
						},
						task: "must not run",
						cwd: root,
						signal: controller.signal,
						timeoutSeconds: 0,
					},
					session,
					undefined,
					{ cleanupGraceMs: 0 },
				);
				await preparing;
				controller.abort();
				const result = await pending;
				assert.equal(result.aborted, true);
				assert.ok(result.settlement);
				finishPreparation();
				await result.settlement;
				assert.equal(starts, 0);
				assert.equal(faux.state.callCount, 0);
				assert.deepEqual(session.messages, []);
			} finally {
				finishPreparation();
				session.dispose();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);

test("renderers show active state and render completed output only once", () => {
	initTheme("dark", false);
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
	const running = { ...result("test", ""), state: "running" as const, toolCalls: [] };
	const partial = {
		content: [{ type: "text" as const, text: "working" }],
		details: { mode: "single" as const, agentScope: "user" as const, projectAgentsDir: null, results: [running] },
	};
	assert.match(renderCompactDispatchResult(partial, false, true, theme).render(80).join("\n"), /⏳/);
	assert.match(
		renderAdvancedDispatchResult(partial, { expanded: false, isPartial: true }, theme).render(80).join("\n"),
		/⏳/,
	);
	const parallel = { ...partial, details: { ...partial.details, mode: "parallel" as const } };
	const lines = renderAdvancedDispatchResult(parallel, { expanded: false, isPartial: true }, theme)
		.render(80)
		.join("\n");
	assert.match(lines, /0\/1 done, 1 running/);
	const final = {
		...partial,
		content: [{ type: "text" as const, text: "unique final output" }],
		details: { ...partial.details, results: [{ ...running, state: "succeeded" as const }] },
	};
	const expanded = renderAdvancedDispatchResult(final, { expanded: true, isPartial: false }, theme)
		.render(80)
		.join("\n");
	assert.equal(expanded.split("unique final output").length - 1, 1);
});
