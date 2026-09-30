/**
 * Subagent tools - Delegate tasks to specialized agents.
 *
 * Of this extension's tools, only load_subagents is active at startup. It enables the compact tool
 * for one fresh user-scoped dispatch and the advanced tool for single, parallel, continuation,
 * project-agent, and override requests.
 * Each dispatch starts a fresh in-process SDK session by default. Only an explicit advanced continuation
 * reuses context.
 */

import { lstatSync } from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderCompactDispatchResult, renderAdvancedDispatchResult } from "./renderers.ts";
import { formatParallelHandoff } from "./handoffs.ts";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents, discoverUserAgents, formatAgentList } from "./agents.ts";
import { buildImplementReviewWorkflowPrompt, createImplementReviewThreadNames } from "./implement-review.ts";
import { createLazySdkRunnerServices } from "./sdk-runner.ts";
import {
	formatResultStatus,
	getCurrentOutput,
	isFailedResult,
	runParallel,
	runSingleAgent,
	selectThinkingLevel,
	selectTimeoutSeconds,
	type ParallelItemInput,
	type SingleResult,
} from "./sdk-orchestration-core.ts";
import {
	aggregateNestedUsage,
	boundFinalHandoff,
	boundText,
	COMBINED_HANDOFF_MAX_BYTES,
	COMBINED_HANDOFF_MAX_LINES,
	DEFAULT_TIMEOUT_SECONDS,
	FINAL_HANDOFF_MAX_BYTES,
	FINAL_HANDOFF_MAX_LINES,
	MAX_TIMEOUT_SECONDS,
	SUBAGENT_DISPATCH_GUIDANCE,
	TRACE_ENTRY_MAX_BYTES,
	TRACE_ENTRY_MAX_LINES,
	TRACE_MAX_ENTRIES,
	TRACE_TOTAL_MAX_BYTES,
	TRACE_TOTAL_MAX_LINES,
	validateChildCwd,
} from "./sdk-runner-core.ts";
import { ActiveRunRegistry, type RunSnapshot } from "./run-registry.ts";
import {
	assertContinuationIdentity,
	canonicalizeContinuationAgentIdentity,
	ContinuationIdentityError,
	ContinuationLock,
	continuationFailure,
	continuationRootDirectory,
	ensureContinuationDirectories,
	findLatestContinuationRecord,
	MAX_CONTINUATION_THREAD_BYTES,
	parseContinuationRecord,
	validateContinuationChildPath,
	validateContinuationThread,
	type ContinuationAction,
	type ContinuationRecord,
} from "./continuation.ts";
import type { SdkContinuationTarget } from "./sdk-runner-core.ts";
import { reconcileDynamicallyLoadedTools } from "./tool-activation.ts";
import {
	ADVANCED_SUBAGENT_LOADER_TOOL_NAME,
	ADVANCED_SUBAGENT_TOOL_NAME,
	COMPACT_SUBAGENT_TOOL_NAME,
} from "./tool-names.ts";
const MAX_PARALLEL_TASKS = 8;
const DETAILS_TEXT_MAX_BYTES = 2 * 1024;
const DETAILS_TEXT_MAX_LINES = 80;
const DETAILS_TOOL_CALL_LIMIT = 32;
const DETAILS_IDENTIFIER_MAX_BYTES = 256;

function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function formatRunSummary(run: RunSnapshot, now: number): string {
	const tool = run.currentTool ? ` tool:${run.currentTool}` : "";
	const activityAge =
		run.lastOutputAt === undefined ? "no activity" : `activity ${formatDuration(now - run.lastOutputAt)} ago`;
	return `[${run.runId.slice(0, 8)}] ${run.agent} reasoning:${run.thinkingLevel ?? "resolving"} ${run.status}/${run.phase} elapsed:${formatDuration(now - run.startedAt)} ${activityAge}${tool}`;
}

function formatRunDetails(run: RunSnapshot, now: number): string[] {
	const lines = [
		`Run: ${run.runId}`,
		`Agent: ${run.agent}`,
		`Reasoning: ${run.thinkingLevel ?? "resolving"}`,
		`Status: ${run.status}`,
		`Phase: ${run.phase}${run.currentTool ? ` (${run.currentTool})` : ""}`,
		`PID: ${run.pid}`,
		`Cwd: ${run.cwd}`,
		`Elapsed: ${formatDuration(now - run.startedAt)}`,
		`Last event: ${new Date(run.lastEventAt).toISOString()} (${formatDuration(now - run.lastEventAt)} ago)`,
		`Last activity/output: ${run.lastOutputAt === undefined ? "never" : `${new Date(run.lastOutputAt).toISOString()} (${formatDuration(now - run.lastOutputAt)} ago)`}`,
		`Timeout: ${run.timeoutSeconds === 0 ? "disabled" : `${run.timeoutSeconds}s`}`,
		"Task:",
		...run.taskPreview.split("\n"),
		"",
		"--- Activity and output tail ---",
	];
	lines.push(...(run.tail ? run.tail.split("\n") : ["(no activity or assistant output yet)"]));
	return lines;
}

interface ParsedContinuationParam {
	action: ContinuationAction;
	thread: string;
}

function parseContinuationParam(value: unknown): ParsedContinuationParam {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Continuation must be an object");
	}
	const action = (value as { action?: unknown }).action;
	if (action !== "create" && action !== "resume") {
		throw new Error('Continuation action must be "create" or "resume"');
	}
	return {
		action,
		thread: validateContinuationThread((value as { thread?: unknown }).thread),
	};
}

export type SubagentResultDetails = Omit<
	SingleResult,
	"messages" | "stderr" | "cleanupError" | "streamingText" | "task" | "errorMessage" | "continuation" | "settlement"
> & {
	task: string;
	toolCalls: string[];
};

export interface SubagentDetails {
	mode: "single" | "parallel";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SubagentResultDetails[];
	continuation?: ContinuationRecord;
	elapsedMs?: number;
}

function getResultOutput(result: SingleResult, isError = isFailedResult(result)): string {
	const currentOutput = getCurrentOutput(result);
	if (isError) return result.errorMessage || result.stderr || currentOutput || "(no output)";
	return currentOutput || "(no output)";
}

function boundModelVisibleContent(output: string): string {
	return boundFinalHandoff(output);
}

function collectToolCallNames(result: SingleResult): string[] {
	const names: string[] = [];
	for (const message of result.messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type !== "toolCall" || typeof part.name !== "string") continue;
			names.push(boundText(part.name, { maxBytes: 128, maxLines: 1 }));
			if (names.length >= DETAILS_TOOL_CALL_LIMIT) return names;
		}
	}
	return names;
}

function sanitizeTraceForDetails(trace: readonly string[]): string[] {
	const retained: string[] = [];
	for (const entry of trace.slice(-TRACE_MAX_ENTRIES)) {
		retained.push(boundText(entry, { maxBytes: TRACE_ENTRY_MAX_BYTES, maxLines: TRACE_ENTRY_MAX_LINES }));
		while (
			Buffer.byteLength(retained.join("\n"), "utf8") > TRACE_TOTAL_MAX_BYTES ||
			retained.join("\n").split("\n").length > TRACE_TOTAL_MAX_LINES
		) {
			retained.shift();
		}
	}
	return retained;
}

function sanitizeContinuationForDetails(continuation: ContinuationRecord): ContinuationRecord {
	return parseContinuationRecord(continuation);
}

function sanitizeResultForDetails(result: SingleResult): SubagentResultDetails {
	const boundIdentifier = (value: string): string =>
		boundText(value, { maxBytes: DETAILS_IDENTIFIER_MAX_BYTES, maxLines: 1 });
	return {
		state: result.state,
		agent: boundIdentifier(result.agent),
		agentSource: result.agentSource,
		task: boundText(result.task, { maxBytes: DETAILS_TEXT_MAX_BYTES, maxLines: DETAILS_TEXT_MAX_LINES }),
		trace: sanitizeTraceForDetails(result.trace ?? []),
		exitCode: result.exitCode,
		usage: { ...result.usage },
		model: result.model === undefined ? undefined : boundIdentifier(result.model),
		stopReason: result.stopReason === undefined ? undefined : boundIdentifier(result.stopReason),
		timedOut: result.timedOut,
		aborted: result.aborted,
		timeoutSeconds: result.timeoutSeconds,
		timing: { ...result.timing },
		progress:
			result.progress === undefined
				? undefined
				: {
						type: result.progress.type,
						...(result.progress.toolName === undefined
							? {}
							: {
									toolName: boundText(result.progress.toolName, { maxBytes: 128, maxLines: 1 }),
								}),
						...(result.progress.isError === undefined ? {} : { isError: result.progress.isError }),
					},
		toolCalls: collectToolCallNames(result),
	};
}

export const TimeoutSeconds = Type.Optional(
	Type.Number({
		exclusiveMinimum: 0,
		maximum: MAX_TIMEOUT_SECONDS,
		description: `Task timeout in seconds. Default: ${DEFAULT_TIMEOUT_SECONDS}; must be finite and positive.`,
	}),
);

export const ThinkingLevelParam = Type.Optional(
	StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
		description:
			"Reasoning level for this task, or the default for parallel items. Overrides the agent model suffix and global default.",
	}),
);

export const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the child SDK session" })),
	thinkingLevel: ThinkingLevelParam,
	timeoutSeconds: TimeoutSeconds,
});

export const ContinuationParam = Type.Object({
	action: StringEnum(["create", "resume"] as const, {
		description: "Create or resume a named single-agent continuation",
	}),
	thread: Type.String({
		minLength: 1,
		maxLength: MAX_CONTINUATION_THREAD_BYTES,
		pattern: "^[A-Za-z][A-Za-z0-9_-]*$",
		description: "Bounded ASCII continuation thread identifier",
	}),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const CompactSubagentParams = Type.Object({
	agent: Type.String({ description: "Name of the user-scoped agent to invoke" }),
	task: Type.String({ description: "Task to delegate" }),
	cwd: Type.Optional(Type.String({ description: "Working directory; omit to inherit the parent cwd" })),
});

export const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	thinkingLevel: ThinkingLevelParam,
	timeoutSeconds: TimeoutSeconds,
	agentScope: Type.Optional(AgentScopeSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for the child SDK session (single mode)" })),
	continuation: Type.Optional(ContinuationParam),
});

function reportDiscoveryWarnings(warnings: string[], ctx: ExtensionContext): void {
	if (!warnings.length) return;
	const text = boundText(warnings.join("\n"), { maxBytes: DETAILS_TEXT_MAX_BYTES, maxLines: DETAILS_TEXT_MAX_LINES });
	if (ctx.hasUI) ctx.ui.notify(text, "warning");
	else console.error(text);
}

function assertAgentScopeTrusted(agentScope: AgentScope, projectTrusted: boolean): void {
	if (agentScope !== "user" && !projectTrusted) {
		throw new Error("Project agents require a trusted project; approve the project before using project agent scope");
	}
}

export default function (pi: ExtensionAPI, sdkServices = createLazySdkRunnerServices()) {
	const runRegistry = new ActiveRunRegistry();
	const continuationLock = new ContinuationLock();
	const catalogWarnings: string[] = [];
	const userAgentCatalog = formatAgentList(
		discoverUserAgents((warning) => catalogWarnings.push(warning)),
		20,
	);
	const catalogText = `${userAgentCatalog.text}${
		userAgentCatalog.remaining > 0 ? `; ${userAgentCatalog.remaining} more` : ""
	}`;

	pi.on("session_shutdown", () => {
		// Timed-out work can still be settling after its tool result has returned.
		runRegistry.shutdown({ preserveActive: true });
	});

	const reconcileDispatchTools = (ctx: ExtensionContext): void => {
		const active = pi.getActiveTools();
		const reconciled = reconcileDynamicallyLoadedTools(
			ctx.sessionManager.getBranch(),
			active,
			ADVANCED_SUBAGENT_LOADER_TOOL_NAME,
			[COMPACT_SUBAGENT_TOOL_NAME, ADVANCED_SUBAGENT_TOOL_NAME],
		);
		if (reconciled !== active) pi.setActiveTools(reconciled);
	};

	pi.on("session_start", (_event, ctx) => {
		reportDiscoveryWarnings(catalogWarnings, ctx);
		reconcileDispatchTools(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		// Navigating before the loader call must hide the dispatch tools again.
		reconcileDispatchTools(ctx);
	});

	pi.registerTool({
		name: COMPACT_SUBAGENT_TOOL_NAME,
		exposure: "model-only",
		label: "Subagent",
		description: [
			"Delegate one fresh task to a user-scoped subagent.",
			`Available agents: ${catalogText}.`,
			SUBAGENT_DISPATCH_GUIDANCE,
			"Omit cwd to inherit the parent working directory.",
			`Final handoffs are capped at ${FINAL_HANDOFF_MAX_LINES} lines or ${FINAL_HANDOFF_MAX_BYTES} bytes.`,
		].join(" "),
		parameters: CompactSubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const defaultCwd = validateChildCwd({
				defaultCwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
				configDirName: CONFIG_DIR_NAME,
			});
			const cwd = validateChildCwd({
				requestedCwd: params.cwd,
				defaultCwd,
				projectTrusted: ctx.isProjectTrusted(),
				configDirName: CONFIG_DIR_NAME,
			});
			const { agents, warnings } = discoverAgents(defaultCwd, "user");
			reportDiscoveryWarnings(warnings, ctx);
			const makeDetails = (results: SingleResult[], elapsedMs?: number): SubagentDetails => ({
				mode: "single",
				agentScope: "user",
				projectAgentsDir: null,
				results: results.map(sanitizeResultForDetails),
				...(elapsedMs === undefined ? {} : { elapsedMs }),
			});
			const startedAt = performance.now();
			const result = await runSingleAgent(
				{ defaultCwd, agents, sdkServices, runRegistry, signal },
				{
					agentName: params.agent!,
					task: params.task!,
					cwd,
					timeoutSeconds: selectTimeoutSeconds(undefined, undefined),
				},
				onUpdate
					? (currentResult) =>
							onUpdate({
								content: [
									{
										type: "text",
										text: boundModelVisibleContent(getCurrentOutput(currentResult) || "(running...)"),
									},
								],
								details: makeDetails([currentResult], performance.now() - startedAt),
							})
					: undefined,
			);
			const elapsedMs = performance.now() - startedAt;
			const output =
				getResultOutput(result) + (isFailedResult(result) && warnings.length ? `\n${warnings.join("\n")}` : "");
			return {
				content: [
					{
						type: "text",
						text: boundModelVisibleContent(
							isFailedResult(result) ? `Agent ${formatResultStatus(result) || "failed"}: ${output}` : output,
						),
					},
				],
				isError: isFailedResult(result),
				details: makeDetails([result], elapsedMs),
				usage: aggregateNestedUsage([result.usage]),
			};
		},

		renderCall(args, theme) {
			const task = args.task ?? "";
			const preview = task.length > 60 ? `${task.slice(0, 60)}...` : task;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent ?? "…")}\n  ${theme.fg("dim", preview)}`,
				0,
				0,
			);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			return renderCompactDispatchResult(result as AgentToolResult<SubagentDetails>, expanded, isPartial, theme);
		},
	});

	pi.registerTool({
		name: ADVANCED_SUBAGENT_LOADER_TOOL_NAME,
		exposure: "model-only",
		label: "Load Subagents",
		description:
			"Enable subagent delegation for this session: single fresh dispatches plus advanced parallel, continuation, project-local, and override modes. Call when delegating work to a specialized subagent.",
		promptSnippet: "Subagents available on demand: call load_subagents to enable delegation.",
		parameters: Type.Object({}),
		async execute() {
			const active = pi.getActiveTools();
			const added = [COMPACT_SUBAGENT_TOOL_NAME, ADVANCED_SUBAGENT_TOOL_NAME].filter((name) => !active.includes(name));
			if (added.length === 0) {
				return {
					content: [{ type: "text", text: `Subagent delegation is already enabled. ${catalogText}.` }],
					details: { added: [] },
				};
			}
			pi.setActiveTools([...new Set([...active, ...added])]);
			return {
				content: [
					{
						type: "text",
						text: `Enabled ${added.join(" and ")}. Available agents: ${catalogText}. Use subagent for one fresh task; use subagent_advanced for parallel, continuation, project-local, or override behavior.`,
					},
				],
				details: { added },
			};
		},
	});

	pi.registerCommand("implement-review", {
		description: "Guide one persistent implementor and code-reviewer workflow (model-coordinated)",
		handler: async (args, ctx) => {
			try {
				const configured = new Set(
					discoverUserAgents((warning) => reportDiscoveryWarnings([warning], ctx)).map((agent) => agent.name),
				);
				for (const name of ["implementor", "code-reviewer"]) {
					if (!configured.has(name))
						throw new Error(`Missing workflow agent "${name}"; install or configure its definition first`);
				}
				const prompt = buildImplementReviewWorkflowPrompt(args, createImplementReviewThreadNames());
				if (ctx.isIdle()) pi.sendUserMessage(prompt);
				else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			} catch (error: unknown) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("agents", {
		description: "List active subagents or inspect one run without using model tokens",
		handler: async (args, ctx) => {
			const requestedId = args.trim();
			const now = Date.now();
			try {
				try {
					reportDiscoveryWarnings(discoverAgents(ctx.cwd, ctx.isProjectTrusted() ? "both" : "user").warnings, ctx);
				} catch (error: unknown) {
					reportDiscoveryWarnings([error instanceof Error ? error.message : String(error)], ctx);
				}
				if (requestedId) {
					if (/\s/.test(requestedId)) throw new Error("Usage: /agents [run-id]");
					const run = runRegistry.get(requestedId);
					const lines = formatRunDetails(run, now);
					if (ctx.mode === "tui") await ctx.ui.select(`Subagent ${run.runId.slice(0, 8)} — Esc to close`, lines);
					else ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				const runs = runRegistry.list();
				if (runs.length === 0) {
					ctx.ui.notify("No active subagent runs.", "info");
					return;
				}
				const summaries = runs.map((run) => formatRunSummary(run, now));
				if (ctx.mode !== "tui") {
					ctx.ui.notify(summaries.join("\n"), "info");
					return;
				}
				const selected = await ctx.ui.select("Subagents — Enter for details, Esc to close", summaries);
				if (!selected) return;
				const selectedIndex = summaries.indexOf(selected);
				if (selectedIndex < 0) return;
				const run = runs[selectedIndex];
				await ctx.ui.select(`Subagent ${run.runId.slice(0, 8)} — Esc to close`, formatRunDetails(run, Date.now()));
			} catch (error: unknown) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: ADVANCED_SUBAGENT_TOOL_NAME,
		exposure: "model-only",
		label: "Subagent Advanced",
		description: [
			"Delegate tasks to specialized subagents. Dispatches are fresh by default; only an explicit top-level single-mode continuation (create or resume) reuses context.",
			"Modes: single (agent + task), parallel (tasks array).",
			"Set thinkingLevel per dispatch; parallel items may override the top-level default.",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
			`Each final handoff is capped at ${FINAL_HANDOFF_MAX_LINES} lines or ${FINAL_HANDOFF_MAX_BYTES} bytes; combined parallel output is capped at ${COMBINED_HANDOFF_MAX_LINES} lines or ${COMBINED_HANDOFF_MAX_BYTES} bytes.`,
			"Omit cwd, thinkingLevel, timeoutSeconds, and agentScope when their defaults are intended.",
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const projectTrusted = ctx.isProjectTrusted();
			assertAgentScopeTrusted(agentScope, projectTrusted);
			const defaultCwd = validateChildCwd({
				defaultCwd: ctx.cwd,
				projectTrusted,
				configDirName: CONFIG_DIR_NAME,
			});
			const validateRequestedCwd = (requestedCwd?: string): string =>
				validateChildCwd({
					requestedCwd,
					defaultCwd,
					projectTrusted,
					configDirName: CONFIG_DIR_NAME,
				});
			const discovery = discoverAgents(defaultCwd, agentScope);
			reportDiscoveryWarnings(discovery.warnings, ctx);
			const agents = discovery.agents;

			if ("chain" in params) throw new Error("Chain mode is no longer supported");
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasTasks) + Number(hasSingle);
			if (modeCount !== 1) {
				throw new Error("Provide exactly one subagent mode: single or parallel");
			}

			const hasContinuation = params.continuation !== undefined;
			if (hasContinuation && (!hasSingle || modeCount !== 1)) {
				throw new Error("Continuation is only supported for top-level agent + task mode");
			}

			let continuationPreparation:
				| {
						parentSessionId: string;
						thread: string;
						action: ContinuationAction;
						selectedAgent: AgentConfig;
						cwd: string;
						parentScopedDirectory: string;
				  }
				| undefined;
			if (hasContinuation) {
				const continuation = parseContinuationParam(params.continuation);
				const selectedAgent = agents.find((candidate) => candidate.name === params.agent);
				if (!selectedAgent) {
					throw new Error(
						boundModelVisibleContent(
							`Unknown agent for continuation: "${params.agent}"\n${discovery.warnings.join("\n")}`,
						),
					);
				}
				try {
					selectedAgent.filePath = canonicalizeContinuationAgentIdentity(selectedAgent).filePath;
				} catch {
					throw continuationFailure("preparation");
				}

				let parentSessionFile: string | undefined;
				try {
					parentSessionFile = ctx.sessionManager.getSessionFile();
				} catch {
					throw continuationFailure("preparation");
				}
				if (typeof parentSessionFile !== "string") {
					throw continuationFailure("preparation");
				}
				let parentStats;
				try {
					parentStats = lstatSync(parentSessionFile);
				} catch {
					throw continuationFailure("preparation");
				}
				if (parentStats.isSymbolicLink() || !parentStats.isFile()) {
					throw continuationFailure("preparation");
				}

				let parentSessionId: string;
				try {
					parentSessionId = ctx.sessionManager.getSessionId();
				} catch {
					throw continuationFailure("preparation");
				}
				let directories;
				try {
					directories = ensureContinuationDirectories(continuationRootDirectory(getAgentDir()), parentSessionId);
				} catch {
					throw continuationFailure("preparation");
				}
				let cwd: string;
				try {
					cwd = validateRequestedCwd(params.cwd);
				} catch {
					throw continuationFailure("preparation");
				}
				continuationPreparation = {
					parentSessionId,
					thread: continuation.thread,
					action: continuation.action,
					selectedAgent,
					cwd,
					parentScopedDirectory: directories.parentDirectory,
				};
			}

			const makeDetails =
				(mode: "single" | "parallel") =>
				(results: SingleResult[], elapsedMs?: number, includeContinuation = false): SubagentDetails => {
					const continuation =
						includeContinuation && mode === "single" && results.length === 1 ? results[0]?.continuation : undefined;
					return {
						mode,
						agentScope,
						projectAgentsDir:
							discovery.projectAgentsDir === null
								? null
								: boundText(discovery.projectAgentsDir, {
										maxBytes: DETAILS_TEXT_MAX_BYTES,
										maxLines: 1,
									}),
						results: results.map(sanitizeResultForDetails),
						...(continuation === undefined ? {} : { continuation: sanitizeContinuationForDetails(continuation) }),
						...(elapsedMs === undefined ? {} : { elapsedMs }),
					};
				};

			const finalizeSingleResult = (result: SingleResult, elapsedMs: number): AgentToolResult<SubagentDetails> => {
				const isError = isFailedResult(result);
				const output = getResultOutput(result, isError);
				return {
					content: [
						{
							type: "text",
							text: boundModelVisibleContent(
								isError ? `Agent ${formatResultStatus(result) || "failed"}: ${output}` : output,
							),
						},
					],
					isError,
					details: makeDetails("single")([result], elapsedMs, !isError),
					usage: aggregateNestedUsage([result.usage]),
				};
			};

			if (continuationPreparation !== undefined) {
				const preparation = continuationPreparation;
				let settlement: Promise<void> | undefined;
				return await continuationLock.run(
					preparation.parentSessionId,
					preparation.thread,
					async () => {
						let lookup;
						try {
							lookup = findLatestContinuationRecord(
								ctx.sessionManager.getBranch(),
								preparation.thread,
								preparation.parentSessionId,
							);
						} catch {
							throw continuationFailure("validation");
						}

						let continuationTarget: SdkContinuationTarget;
						if (preparation.action === "create") {
							if (lookup.kind === "current") {
								throw new Error(`Continuation thread already exists on this parent: ${preparation.thread}`);
							}
							continuationTarget = {
								action: "create",
								thread: preparation.thread,
								parentSessionId: preparation.parentSessionId,
								parentScopedDirectory: preparation.parentScopedDirectory,
							};
						} else {
							if (lookup.kind === "none") {
								throw new Error(`Continuation thread does not exist on this parent: ${preparation.thread}`);
							}
							if (lookup.kind === "foreign") {
								throw new Error(`Continuation thread belongs to a different parent: ${preparation.thread}`);
							}
							try {
								assertContinuationIdentity(lookup.record, { agent: preparation.selectedAgent, cwd: preparation.cwd });
							} catch (error: unknown) {
								if (error instanceof ContinuationIdentityError) throw error;
								throw continuationFailure("validation");
							}
							try {
								validateContinuationChildPath(lookup.record.childSessionFile, preparation.parentScopedDirectory);
							} catch {
								throw continuationFailure("validation");
							}
							continuationTarget = {
								action: "resume",
								parentScopedDirectory: preparation.parentScopedDirectory,
								record: lookup.record,
							};
						}

						const startedAt = performance.now();
						const dispatch = () =>
							runSingleAgent(
								{ defaultCwd, agents, sdkServices, runRegistry, signal },
								{
									agentName: params.agent!,
									task: params.task!,
									cwd: preparation.cwd,
									thinkingLevel: selectThinkingLevel(undefined, params.thinkingLevel),
									timeoutSeconds: selectTimeoutSeconds(undefined, params.timeoutSeconds),
									continuation: continuationTarget,
								},
								onUpdate
									? (currentResult) =>
											onUpdate({
												content: [
													{
														type: "text",
														text: boundModelVisibleContent(getCurrentOutput(currentResult) || "(running...)"),
													},
												],
												details: makeDetails("single")([currentResult], performance.now() - startedAt),
											})
									: undefined,
							);
						const result = await dispatch();
						settlement = result.settlement;
						const elapsedMs = performance.now() - startedAt;
						return finalizeSingleResult(result, elapsedMs);
					},
					() => settlement,
				);
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					throw new Error(`Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`);

				const startedAt = performance.now();
				const tasks: ParallelItemInput[] = params.tasks.map((item) => ({
					...item,
					cwd: validateRequestedCwd(item.cwd),
				}));
				const results = await runParallel({
					tasks,
					topLevelThinkingLevel: params.thinkingLevel,
					topLevelTimeoutSeconds: params.timeoutSeconds,
					defaultCwd,
					agents,
					sdkServices,
					runRegistry,
					signal,
					onUpdate: onUpdate
						? (currentResults) => {
								const running = currentResults.filter((r) => r.state === "queued" || r.state === "running").length;
								const done = currentResults.length - running;
								onUpdate({
									content: [
										{
											type: "text",
											text: `Parallel: ${done}/${currentResults.length} done, ${running} running...`,
										},
									],
									details: makeDetails("parallel")(currentResults, performance.now() - startedAt),
								});
							}
						: undefined,
				});
				const elapsedMs = performance.now() - startedAt;

				return {
					content: [
						{
							type: "text",
							text: formatParallelHandoff(results),
						},
					],
					isError: results.some(isFailedResult),
					details: makeDetails("parallel")(results, elapsedMs),
					usage: aggregateNestedUsage(results.map((item) => item.usage)),
				};
			}

			if (params.agent && params.task) {
				const startedAt = performance.now();
				const dispatch = () =>
					runSingleAgent(
						{ defaultCwd, agents, sdkServices, runRegistry, signal },
						{
							agentName: params.agent!,
							task: params.task!,
							cwd: validateRequestedCwd(params.cwd),
							thinkingLevel: selectThinkingLevel(undefined, params.thinkingLevel),
							timeoutSeconds: selectTimeoutSeconds(undefined, params.timeoutSeconds),
						},
						onUpdate
							? (currentResult) =>
									onUpdate({
										content: [
											{
												type: "text",
												text: boundModelVisibleContent(getCurrentOutput(currentResult) || "(running...)"),
											},
										],
										details: makeDetails("single")([currentResult], performance.now() - startedAt),
									})
							: undefined,
					);
				const result = await dispatch();
				const elapsedMs = performance.now() - startedAt;
				return finalizeSingleResult(result, elapsedMs);
			}

			throw new Error("Unreachable subagent dispatch mode");
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const task = t.task ?? "";
					const preview = task.length > 40 ? `${task.slice(0, 40)}...` : task;
					text += `\n  ${theme.fg("accent", t.agent ?? "…")}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, options, theme) {
			return renderAdvancedDispatchResult(result, options, theme);
		},
	});
}
