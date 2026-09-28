/**
 * Explicitly loaded SDK smoke and benchmark harness.
 *
 * This file is intentionally not index.ts: Pi only auto-discovers
 * extensions/subagent/index.ts for this directory. Load this harness explicitly
 * with --extension when running a smoke or benchmark command.
 *
 * The harness uses the in-process SDK runner. It does not spawn Pi, persist
 * child sessions, or write project files. Timeout and cancellation tasks use
 * bash only in the system temporary directory so their sleep can be aborted.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { DEFAULT_TIMEOUT_SECONDS } from "./sdk-runner-core.ts";
import { createChildResourceLoader, createSdkRunnerServices, type SdkRunnerServices } from "./sdk-runner.ts";
import {
	getCurrentOutput,
	isFailedResult,
	runParallel,
	runSingleAgent,
	type SingleResult,
} from "./sdk-orchestration-core.ts";

export const SMOKE_AGENT_NAME = "sdk-smoke";
export const DEFAULT_SMOKE_TIMEOUT_SECONDS = DEFAULT_TIMEOUT_SECONDS;
export const DEFAULT_TIMEOUT_SMOKE_SECONDS = 0.2;
export const DEFAULT_CANCELLATION_DELAY_MS = 100;
export const DEFAULT_BENCHMARK_REPETITIONS = 3;

const TIMEOUT_TASK =
	'Run "sleep 5" in the shell before replying with exactly "timeout smoke complete". Do not modify any files.';
const CANCELLATION_TASK =
	'Run "sleep 20" in the shell before replying with exactly "cancellation smoke complete". Do not modify any files.';

export interface SmokeOptions {
	cwd?: string;
	scratchCwd?: string;
	model?: string;
	timeoutSeconds?: number;
	cancellationDelayMs?: number;
	repetitions?: number;
}

export interface SmokeMetrics {
	setupMs: number;
	ttftMs: number | null;
	completionMs: number | null;
	totalMs: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	contextTokens: number;
	turns: number;
}

export interface ProcessRecord {
	pid: number;
	ppid: number;
	args: string[];
	command: string;
	rssMb: number | null;
}

export interface ProcessEvidence {
	rootPid: number;
	rootRssBeforeMb: number | null;
	rootRssAfterMb: number | null;
	before: ProcessRecord[];
	during: ProcessRecord[];
	after: ProcessRecord[];
}

export interface ChildResourceEvidence {
	extensionCount: number;
	skillCount: number;
	contextFileCount: number;
	contextFiles: string[];
	toolNames: string[];
	subagentToolPresent: boolean;
	sessionFile: string | null;
}

export interface SmokeResultSummary {
	agent: string;
	task: string;
	output: string;
	exitCode: number;
	stopReason?: string;
	timedOut: boolean;
	aborted: boolean;
	model?: string;
	metrics: SmokeMetrics;
}

export interface SmokeReport {
	command: "single" | "parallel" | "timeout" | "cancel" | "resources" | "suite";
	ok: boolean;
	serviceInitMs?: number;
	resources?: ChildResourceEvidence;
	results?: SmokeResultSummary[];
	process: ProcessEvidence;
	error?: string;
	reports?: SmokeReport[];
}

export interface BenchmarkReport {
	command: "benchmark";
	ok: boolean;
	repetitions: number;
	serviceInitMs?: number;
	resources?: ChildResourceEvidence;
	samples: SmokeResultSummary[];
	median?: SmokeMetrics;
	process: ProcessEvidence;
	error?: string;
}

export type SmokeCommandResult = SmokeReport | BenchmarkReport;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parsePositiveInteger(value: number | undefined, fallback: number, name: string): number {
	const selected = value ?? fallback;
	if (!Number.isInteger(selected) || selected < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return selected;
}

function smokeModel(options: SmokeOptions): string {
	const model = options.model ?? process.env.PI_SUBAGENT_SMOKE_MODEL;
	if (!model) throw new Error("Set PI_SUBAGENT_SMOKE_MODEL to an authenticated provider/model before live smoke tests");
	return model;
}

function smokeCwd(options: SmokeOptions): string {
	return options.cwd ?? process.cwd();
}

function scratchCwd(options: SmokeOptions): string {
	return options.scratchCwd ?? os.tmpdir();
}

async function createSmokeAgent(options: SmokeOptions, tools: string[]): Promise<AgentConfig> {
	return {
		name: SMOKE_AGENT_NAME,
		description: "Explicit live SDK smoke test",
		source: "user",
		filePath: new URL(import.meta.url).pathname,
		model: smokeModel(options),
		tools,
		systemPrompt:
			"This is a controlled SDK smoke test. Keep responses concise. Do not modify files. Follow the exact task wording.",
	};
}

function metricsForResult(result: SingleResult): SmokeMetrics {
	return {
		setupMs: result.timing.setupMs,
		ttftMs: result.timing.firstTextDeltaMs ?? null,
		completionMs: result.timing.completionMs ?? null,
		totalMs: result.timing.totalMs,
		inputTokens: result.usage.input,
		outputTokens: result.usage.output,
		cacheReadTokens: result.usage.cacheRead,
		cacheWriteTokens: result.usage.cacheWrite,
		contextTokens: result.usage.contextTokens,
		turns: result.usage.turns,
	};
}

export function reportMetrics(result: SingleResult): SmokeMetrics {
	return metricsForResult(result);
}

function summarizeResult(result: SingleResult): SmokeResultSummary {
	const output = getCurrentOutput(result);
	return {
		agent: result.agent,
		task: result.task,
		output: isFailedResult(result) ? result.errorMessage || output || "(no output)" : output || "(no output)",
		exitCode: result.exitCode,
		...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
		timedOut: result.timedOut,
		aborted: result.aborted,
		...(result.model === undefined ? {} : { model: result.model }),
		metrics: metricsForResult(result),
	};
}

function uniqueRecords(records: readonly ProcessRecord[]): ProcessRecord[] {
	const unique = new Map<string, ProcessRecord>();
	for (const record of records) unique.set(`${record.pid}:${record.command}`, record);
	return [...unique.values()].sort((left, right) => left.pid - right.pid);
}

function readProcRecord(pid: number): ProcessRecord | undefined {
	try {
		const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
		const parentMatch = status.match(/^PPid:\s+(\d+)$/m);
		if (!parentMatch) return undefined;
		const rssMatch = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
		const args = fs.readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0");
		if (args.at(-1) === "") args.pop();
		if (args.length === 0 || args.every((arg) => arg === "")) return undefined;
		return {
			pid,
			ppid: Number(parentMatch[1]),
			args,
			command: args.join(" "),
			rssMb: rssMatch ? Number(rssMatch[1]) / 1024 : null,
		};
	} catch {
		// Processes can exit between the /proc directory scan and these reads.
		return undefined;
	}
}

function descendantProcesses(rootPid: number): ProcessRecord[] {
	if (process.platform !== "linux") {
		throw new Error("SDK smoke process checks require Linux /proc support");
	}

	const records = new Map<number, ProcessRecord>();
	for (const entry of fs.readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		const record = readProcRecord(Number(entry));
		if (record) records.set(record.pid, record);
	}

	const children = new Map<number, number[]>();
	for (const record of records.values()) {
		const siblings = children.get(record.ppid) ?? [];
		siblings.push(record.pid);
		children.set(record.ppid, siblings);
	}

	const descendants: ProcessRecord[] = [];
	const pending = [...(children.get(rootPid) ?? [])];
	const visited = new Set<number>();
	while (pending.length > 0) {
		const pid = pending.shift();
		if (pid === undefined || visited.has(pid)) continue;
		visited.add(pid);
		const record = records.get(pid);
		if (!record) continue;
		descendants.push(record);
		pending.push(...(children.get(pid) ?? []));
	}
	return descendants;
}

const SUPPORTED_PI_EXECUTABLE_NAMES = new Set(["pi", "pi.exe"]);
const SUPPORTED_NODE_OR_BUN_NAMES = new Set(["node", "node.exe", "nodejs", "nodejs.exe", "bun", "bun.exe"]);
const SUPPORTED_PI_CLI_ENTRY_NAMES = new Set(["cli.js", "cli.mjs", "cli.cjs", "pi.js", "pi.mjs", "pi.cjs", "pi.ts"]);
// These are exact components from the supported Pi package/install layouts.
const VERIFIED_PI_PATH_COMPONENTS = new Set(["pi", "github-earendil-works-pi", "@earendil-works", "pi-coding-agent"]);

function isPiBinary(argument: string): boolean {
	return SUPPORTED_PI_EXECUTABLE_NAMES.has(path.basename(argument).toLowerCase());
}

function isNodeOrBun(argument: string): boolean {
	return SUPPORTED_NODE_OR_BUN_NAMES.has(path.basename(argument).toLowerCase());
}

function isPiEntry(argument: string): boolean {
	const normalized = argument.replaceAll("\\", "/").toLowerCase();
	const entryName = path.posix.basename(normalized);
	if (!SUPPORTED_PI_CLI_ENTRY_NAMES.has(entryName)) return false;
	const components = normalized.split("/").filter(Boolean);
	return components.includes("dist") && components.some((component) => VERIFIED_PI_PATH_COMPONENTS.has(component));
}

function hasPiJsonModeFlags(args: readonly string[]): boolean {
	return (
		(args.some((arg, index) => arg === "--mode" && args[index + 1] === "json") || args.includes("--mode=json")) &&
		args.includes("-p") &&
		args.includes("--no-session")
	);
}

/** Detect forbidden Pi JSON print-mode argv without flattening argument boundaries. */
export function isForbiddenPiJsonModeArgv(argv: readonly string[]): boolean {
	if (argv.length === 0) return false;
	if (isPiBinary(argv[0])) return hasPiJsonModeFlags(argv.slice(1));
	if (!isNodeOrBun(argv[0])) return false;
	const entryIndex = argv.findIndex((argument, index) => index > 0 && isPiEntry(argument));
	return entryIndex > 0 && hasPiJsonModeFlags(argv.slice(entryIndex + 1));
}

function readRootRssMb(rootPid: number): number | null {
	return readProcRecord(rootPid)?.rssMb ?? null;
}

/** Return forbidden Pi JSON-mode descendants of the supplied process. */
export function inspectForbiddenPiChildren(rootPid = process.pid): ProcessRecord[] {
	return descendantProcesses(rootPid).filter((record) => isForbiddenPiJsonModeArgv(record.args));
}

interface ProcessSample {
	rootRssMb: number | null;
	forbidden: ProcessRecord[];
}

function processSample(rootPid: number): ProcessSample {
	return {
		rootRssMb: readRootRssMb(rootPid),
		forbidden: inspectForbiddenPiChildren(rootPid),
	};
}

interface Observed<T> {
	value?: T;
	error?: string;
	process: ProcessEvidence;
}

async function observe<T>(action: () => Promise<T>): Promise<Observed<T>> {
	const rootPid = process.pid;
	const before = processSample(rootPid);
	const during = new Map<string, ProcessRecord>();
	const sampleDuring = () => {
		for (const record of processSample(rootPid).forbidden) during.set(`${record.pid}:${record.command}`, record);
	};
	const monitor = setInterval(sampleDuring, 25);
	(monitor as { unref?: () => void }).unref?.();

	let value: T | undefined;
	let error: string | undefined;
	try {
		value = await action();
	} catch (caught: unknown) {
		error = errorText(caught);
	} finally {
		clearInterval(monitor);
		sampleDuring();
	}
	const after = processSample(rootPid);

	return {
		value,
		...(error === undefined ? {} : { error }),
		process: {
			rootPid,
			rootRssBeforeMb: before.rootRssMb,
			rootRssAfterMb: after.rootRssMb,
			before: before.forbidden,
			during: uniqueRecords([...during.values()]),
			after: after.forbidden,
		},
	};
}

function resourcesAreIsolated(resources: ChildResourceEvidence | undefined): boolean {
	return (
		resources !== undefined &&
		resources.extensionCount === 0 &&
		resources.skillCount === 0 &&
		!resources.subagentToolPresent &&
		resources.sessionFile === null
	);
}

/** Inspect the same fresh child loader/session policy used by the live smoke tasks. */
export async function inspectChildResources(options: SmokeOptions = {}): Promise<ChildResourceEvidence> {
	const { createAgentSession, getAgentDir, SessionManager, SettingsManager } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const { services } = await createServices();
	const cwd = smokeCwd(options);
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const loader = await createChildResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		agentSystemPrompt: "",
	});
	await loader.reload();

	const skills = loader.getSkills().skills;
	const contextFiles = loader.getAgentsFiles().agentsFiles;
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime: services.modelRuntime,
		tools: [],
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager,
	});
	try {
		const toolNames = session.agent.state.tools.map((tool) => tool.name);
		return {
			extensionCount: loader.getExtensions().extensions.length,
			skillCount: skills.length,
			contextFileCount: contextFiles.length,
			contextFiles: contextFiles.map((file) => file.path),
			toolNames,
			subagentToolPresent: toolNames.includes("subagent"),
			sessionFile: session.sessionFile ?? null,
		};
	} finally {
		await session.dispose();
	}
}

async function observeSmoke<T>(action: () => Promise<T>): Promise<{ observed: Observed<T> }> {
	return { observed: await observe(action) };
}

/** Run only the deterministic child-resource and process-policy check. */
export async function runResourceCheck(options: SmokeOptions = {}): Promise<SmokeReport> {
	const observed = await observe(() => inspectChildResources(options));
	return {
		command: "resources",
		ok: observed.error === undefined && resourcesAreIsolated(observed.value) && observed.process.during.length === 0,
		...(observed.value === undefined ? {} : { resources: observed.value }),
		process: observed.process,
		...(observed.error === undefined ? {} : { error: observed.error }),
	};
}

function contextFor(agent: AgentConfig, services: SdkRunnerServices, cwd: string, signal?: AbortSignal) {
	return {
		defaultCwd: cwd,
		agents: [agent],
		sdkServices: services,
		signal,
	};
}

async function runSingle(
	options: SmokeOptions,
	services: SdkRunnerServices,
	task: string,
	requestCwd: string,
	tools: string[],
	timeoutSeconds: number,
	signal?: AbortSignal,
): Promise<SingleResult> {
	const agent = await createSmokeAgent(options, tools);
	return runSingleAgent(contextFor(agent, services, requestCwd, signal), {
		agentName: SMOKE_AGENT_NAME,
		task,
		cwd: requestCwd,
		timeoutSeconds,
	});
}

async function createServices(): Promise<{ services: SdkRunnerServices; serviceInitMs: number }> {
	const startedAt = performance.now();
	const services = await createSdkRunnerServices();
	return { services, serviceInitMs: Math.max(0, performance.now() - startedAt) };
}

function baseReport(
	command: SmokeReport["command"],
	observed: Observed<SingleResult | SingleResult[]>,
	serviceInitMs: number | undefined,
	results: readonly SingleResult[],
	isExpected: (results: readonly SingleResult[]) => boolean = (items) =>
		items.length > 0 && items.every((result) => !isFailedResult(result)),
): SmokeReport {
	return {
		command,
		ok:
			observed.error === undefined &&
			observed.value !== undefined &&
			isExpected(results) &&
			observed.process.during.length === 0,
		...(serviceInitMs === undefined ? {} : { serviceInitMs }),
		results: results.map(summarizeResult),
		process: observed.process,
		...(observed.error === undefined ? {} : { error: observed.error }),
	};
}

export async function runSingleHi(options: SmokeOptions = {}): Promise<SmokeReport> {
	let serviceInitMs: number | undefined;
	const { observed } = await observeSmoke(async () => {
		const runtime = await createServices();
		serviceInitMs = runtime.serviceInitMs;
		return runSingle(
			options,
			runtime.services,
			"hi",
			smokeCwd(options),
			[],
			options.timeoutSeconds ?? DEFAULT_SMOKE_TIMEOUT_SECONDS,
		);
	});
	const result = observed.value && !Array.isArray(observed.value) ? observed.value : undefined;
	return baseReport("single", observed, serviceInitMs, result ? [result] : []);
}

export async function runParallelHi(options: SmokeOptions = {}): Promise<SmokeReport> {
	let serviceInitMs: number | undefined;
	const { observed } = await observeSmoke(async () => {
		const runtime = await createServices();
		serviceInitMs = runtime.serviceInitMs;
		const agent = await createSmokeAgent(options, []);
		return runParallel({
			tasks: [
				{ agent: SMOKE_AGENT_NAME, task: "hi" },
				{ agent: SMOKE_AGENT_NAME, task: "hi" },
				{ agent: SMOKE_AGENT_NAME, task: "hi" },
			],
			topLevelTimeoutSeconds: options.timeoutSeconds ?? DEFAULT_SMOKE_TIMEOUT_SECONDS,
			defaultCwd: smokeCwd(options),
			agents: [agent],
			sdkServices: runtime.services,
		});
	});
	const results = observed.value && Array.isArray(observed.value) ? observed.value : [];
	return baseReport("parallel", observed, serviceInitMs, results);
}

export async function runTimeoutSmoke(options: SmokeOptions = {}): Promise<SmokeReport> {
	let serviceInitMs: number | undefined;
	const { observed } = await observeSmoke(async () => {
		const runtime = await createServices();
		serviceInitMs = runtime.serviceInitMs;
		const first = await runSingle(
			options,
			runtime.services,
			TIMEOUT_TASK,
			scratchCwd(options),
			["bash"],
			options.timeoutSeconds ?? DEFAULT_TIMEOUT_SMOKE_SECONDS,
		);
		const followUp = await runSingle(
			options,
			runtime.services,
			"hi",
			smokeCwd(options),
			[],
			DEFAULT_SMOKE_TIMEOUT_SECONDS,
		);
		return [first, followUp];
	});
	const results = observed.value && Array.isArray(observed.value) ? observed.value : [];
	return baseReport(
		"timeout",
		observed,
		serviceInitMs,
		results,
		(items) => items.length === 2 && items[0].timedOut && !items[0].aborted && !isFailedResult(items[1]),
	);
}

export async function runCancellationSmoke(options: SmokeOptions = {}): Promise<SmokeReport> {
	let serviceInitMs: number | undefined;
	const { observed } = await observeSmoke(async () => {
		const runtime = await createServices();
		serviceInitMs = runtime.serviceInitMs;
		const controller = new AbortController();
		const abortTimer = setTimeout(
			() => controller.abort(),
			options.cancellationDelayMs ?? DEFAULT_CANCELLATION_DELAY_MS,
		);
		let first: SingleResult;
		try {
			first = await runSingle(
				options,
				runtime.services,
				CANCELLATION_TASK,
				scratchCwd(options),
				["bash"],
				DEFAULT_SMOKE_TIMEOUT_SECONDS,
				controller.signal,
			);
		} finally {
			clearTimeout(abortTimer);
		}
		const followUp = await runSingle(
			options,
			runtime.services,
			"hi",
			smokeCwd(options),
			[],
			DEFAULT_SMOKE_TIMEOUT_SECONDS,
		);
		return [first, followUp];
	});
	const results = observed.value && Array.isArray(observed.value) ? observed.value : [];
	return baseReport(
		"cancel",
		observed,
		serviceInitMs,
		results,
		(items) => items.length === 2 && items[0].aborted && !items[0].timedOut && !isFailedResult(items[1]),
	);
}

export async function runSmokeSuite(options: SmokeOptions = {}): Promise<SmokeReport> {
	const reports = [
		await runSingleHi(options),
		await runParallelHi(options),
		await runTimeoutSmoke(options),
		await runCancellationSmoke(options),
	];
	return {
		command: "suite",
		ok: reports.every((report) => report.ok),
		process: {
			rootPid: process.pid,
			rootRssBeforeMb: null,
			rootRssAfterMb: null,
			before: reports.flatMap((report) => report.process.before),
			during: uniqueRecords(reports.flatMap((report) => report.process.during)),
			after: reports.flatMap((report) => report.process.after),
		},
		reports,
	};
}

function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function medianMetrics(results: readonly SingleResult[]): SmokeMetrics {
	const metrics = results.map(metricsForResult);
	const medianOrZero = (values: number[]) => median(values) ?? 0;
	const optionalMedian = (values: Array<number | null>): number | null =>
		median(values.filter((value): value is number => value !== null));
	return {
		setupMs: medianOrZero(metrics.map((metric) => metric.setupMs)),
		ttftMs: optionalMedian(metrics.map((metric) => metric.ttftMs)),
		completionMs: optionalMedian(metrics.map((metric) => metric.completionMs)),
		totalMs: medianOrZero(metrics.map((metric) => metric.totalMs)),
		inputTokens: medianOrZero(metrics.map((metric) => metric.inputTokens)),
		outputTokens: medianOrZero(metrics.map((metric) => metric.outputTokens)),
		cacheReadTokens: medianOrZero(metrics.map((metric) => metric.cacheReadTokens)),
		cacheWriteTokens: medianOrZero(metrics.map((metric) => metric.cacheWriteTokens)),
		contextTokens: medianOrZero(metrics.map((metric) => metric.contextTokens)),
		turns: medianOrZero(metrics.map((metric) => metric.turns)),
	};
}

function benchmarkRepetitions(options: SmokeOptions): number {
	const fromEnvironment = process.env.PI_SUBAGENT_SMOKE_REPETITIONS;
	const configured = options.repetitions ?? (fromEnvironment === undefined ? undefined : Number(fromEnvironment));
	return parsePositiveInteger(configured, DEFAULT_BENCHMARK_REPETITIONS, "repetitions");
}

export async function runBenchmark(options: SmokeOptions = {}): Promise<BenchmarkReport> {
	const repetitions = benchmarkRepetitions(options);
	let serviceInitMs: number | undefined;
	const { observed } = await observeSmoke(async () => {
		const runtime = await createServices();
		serviceInitMs = runtime.serviceInitMs;
		const samples: SingleResult[] = [];
		for (let index = 0; index < repetitions; index++) {
			samples.push(
				await runSingle(
					options,
					runtime.services,
					"hi",
					smokeCwd(options),
					[],
					options.timeoutSeconds ?? DEFAULT_SMOKE_TIMEOUT_SECONDS,
				),
			);
		}
		return samples;
	});
	const results = observed.value && Array.isArray(observed.value) ? observed.value : [];
	const report: BenchmarkReport = {
		command: "benchmark",
		ok:
			observed.error === undefined &&
			results.length === repetitions &&
			results.every((result) => !isFailedResult(result)) &&
			observed.process.during.length === 0,
		repetitions,
		...(serviceInitMs === undefined ? {} : { serviceInitMs }),
		samples: results.map(summarizeResult),
		...(results.length === 0 ? {} : { median: medianMetrics(results) }),
		process: observed.process,
		...(observed.error === undefined ? {} : { error: observed.error }),
	};
	return report;
}

export async function runSmokeCommand(command: string, options: SmokeOptions = {}): Promise<SmokeCommandResult> {
	switch (command) {
		case "single":
			return runSingleHi(options);
		case "parallel":
			return runParallelHi(options);
		case "timeout":
			return runTimeoutSmoke(options);
		case "cancel":
		case "cancellation":
			return runCancellationSmoke(options);
		case "resources":
			return runResourceCheck(options);
		case "suite":
			return runSmokeSuite(options);
		case "benchmark":
			return runBenchmark(options);
		default:
			throw new Error(
				`Unknown SDK smoke command "${command}"; use single, parallel, timeout, cancel, resources, suite, or benchmark`,
			);
	}
}

export default function registerSdkSmokeCommands(pi: ExtensionAPI): void {
	pi.registerCommand("sdk-smoke", {
		description: "Run explicit in-process SDK smoke or benchmark commands",
		handler: async (args) => {
			const [command = "suite", repetitionText] = args.trim().split(/\s+/).filter(Boolean);
			const repetitions = repetitionText === undefined ? undefined : Number(repetitionText);
			try {
				const report = await runSmokeCommand(command, {
					...(repetitions === undefined ? {} : { repetitions }),
				});
				process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
				if (!report.ok) process.exitCode = 1;
			} catch (error: unknown) {
				process.exitCode = 1;
				process.stdout.write(`${JSON.stringify({ command, ok: false, error: errorText(error) })}\n`);
			}
		},
	});
}
