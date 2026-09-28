import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, keyHint, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { formatResultStatus, formatTimingFooter, isFailedResult, type SingleResult } from "./sdk-orchestration-core.ts";
import type { SubagentDetails, SubagentResultDetails } from "./index.ts";
const COLLAPSED_ITEM_COUNT = 10;

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, never> };

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatElapsedMs(milliseconds: number): string {
	return `tool elapsed:${(Math.max(0, milliseconds) / 1000).toFixed(1)}s`;
}

function formatProgressValue(value: string): string {
	return value;
}

function formatToolProgress(
	progress: NonNullable<SingleResult["progress"]>,
	themeFg: (color: ThemeColor, text: string) => string,
): string {
	const status =
		progress.type === "tool_execution_start"
			? "started"
			: progress.type === "tool_execution_end"
				? progress.isError
					? "failed"
					: "completed"
				: "running";
	const value = progress.partialResult ?? progress.result;
	const detail = value === undefined ? "" : `: ${formatProgressValue(value).slice(0, 160)}`;
	return themeFg("muted", `tool ${progress.toolName ?? "unknown"} ${status}`) + themeFg("dim", detail);
}

function formatResultProgress(
	result: Pick<SingleResult, "progress">,
	themeFg: (color: ThemeColor, text: string) => string,
): string | undefined {
	return result.progress ? formatToolProgress(result.progress, themeFg) : undefined;
}

function getDisplayItems(result: SubagentResultDetails): DisplayItem[] {
	if (result.trace && result.trace.length > 0) {
		return result.trace.map((text): DisplayItem => ({ type: "text", text }));
	}
	return result.toolCalls.map((name): DisplayItem => ({ type: "toolCall", name, args: {} }));
}

export function renderCompactDispatchResult(
	result: AgentToolResult<SubagentDetails>,
	expanded: boolean,
	isPartial: boolean,
	theme: {
		fg(color: ThemeColor, text: string): string;
		bold(text: string): string;
	},
): Text | Container {
	const details = result.details;
	const firstContent = result.content[0];
	const output = firstContent?.type === "text" ? firstContent.text : "";
	if (!details || details.results.length !== 1) return new Text(output || "(no output)", 0, 0);

	const dispatch = details.results[0];
	const failed = !isPartial && isFailedResult(dispatch);
	const icon = isPartial ? theme.fg("warning", "⏳") : failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const status = formatResultStatus(dispatch);
	const header = `${icon} ${theme.fg("toolTitle", theme.bold(dispatch.agent))}${
		failed && status ? ` ${theme.fg("error", `[${status}]`)}` : ""
	}`;
	const usage = [formatUsageStats(dispatch.usage, dispatch.model), formatTimingFooter(dispatch.timing)]
		.filter(Boolean)
		.join(" ");

	if (!expanded) {
		const lines = output.split("\n");
		const preview = lines.slice(0, 10).join("\n");
		const boundedPreview = preview.length > 1200 ? `${preview.slice(0, 1200)}…` : preview;
		let text = header;
		if (boundedPreview) text += `\n${theme.fg("toolOutput", boundedPreview)}`;
		if (lines.length > 10 || preview.length > 1200)
			text += `\n${theme.fg("muted", keyHint("app.tools.expand", "to expand"))}`;
		if (usage) text += `\n${theme.fg("dim", usage)}`;
		return new Text(text, 0, 0);
	}

	const container = new Container();
	container.addChild(new Text(header, 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
	container.addChild(new Text(theme.fg("dim", dispatch.task), 0, 0));
	if (output) {
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(output.trim(), 0, 0, getMarkdownTheme()));
	}
	if (usage) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", usage), 0, 0));
	}
	return container;
}

export function renderAdvancedDispatchResult(
	result: AgentToolResult<unknown>,
	{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Text | Container {
	const details = result.details as SubagentDetails | undefined;
	if (!details || details.results.length === 0) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
	}

	const mdTheme = getMarkdownTheme();
	const firstContent = result.content[0];
	const modelVisibleOutput = firstContent?.type === "text" ? firstContent.text : "";

	const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
		const toShow = limit ? items.slice(-limit) : items;
		const skipped = limit && items.length > limit ? items.length - limit : 0;
		let text = "";
		if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
		for (const item of toShow) {
			if (item.type === "text") {
				const linePreview = item.text.split("\n").slice(0, 3).join("\n");
				const preview = expanded ? item.text : linePreview.length > 240 ? `${linePreview.slice(0, 240)}…` : linePreview;
				text += `${theme.fg("toolOutput", preview)}\n`;
			} else {
				text += `${theme.fg("muted", "→ ") + theme.fg("accent", item.name)}\n`;
			}
		}
		return text.trimEnd();
	};

	const addDisplayItems = (container: Container, items: DisplayItem[]) => {
		for (const item of items) {
			if (item.type === "text") {
				container.addChild(new Text(theme.fg("toolOutput", item.text), 0, 0));
			} else {
				container.addChild(new Text(theme.fg("muted", "→ ") + theme.fg("accent", item.name), 0, 0));
			}
		}
	};

	const formatUsageFooter = (r: Pick<SingleResult, "usage" | "model" | "timing">): string =>
		[formatUsageStats(r.usage, r.model), formatTimingFooter(r.timing)].filter(Boolean).join(" ");

	if (details.mode === "single" && details.results.length === 1) {
		const r = details.results[0];
		const isError = isFailedResult(r);
		const icon = isPartial ? theme.fg("warning", "⏳") : isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const displayItems: DisplayItem[] = [
			...getDisplayItems(r),
			...(!expanded && modelVisibleOutput ? [{ type: "text" as const, text: modelVisibleOutput }] : []),
		];
		const finalOutput = modelVisibleOutput;
		const status = formatResultStatus(r);
		const continuationLabel =
			details.continuation === undefined
				? ""
				: theme.fg("muted", ` [continuation ${details.continuation.action}:${details.continuation.thread}]`);

		if (expanded) {
			const container = new Container();
			let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}${continuationLabel}`;
			if (isError && status) header += ` ${theme.fg("error", `[${status}]`)}`;
			container.addChild(new Text(header, 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
			container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Activity and output ───"), 0, 0));
			if (displayItems.length === 0 && !finalOutput) {
				container.addChild(new Text(theme.fg("muted", "(no activity or output)"), 0, 0));
			} else {
				addDisplayItems(container, displayItems);
				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}
			}
			const progressText = formatResultProgress(r, theme.fg.bind(theme));
			if (progressText) container.addChild(new Text(progressText, 0, 0));
			const usageStr = formatUsageFooter(r);
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
			}
			return container;
		}

		let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}${continuationLabel}`;
		if (isError && status) text += ` ${theme.fg("error", `[${status}]`)}`;
		if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
		else {
			text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
			if (displayItems.length > COLLAPSED_ITEM_COUNT)
				text += `\n${theme.fg("muted", keyHint("app.tools.expand", "to expand"))}`;
		}
		const progressText = formatResultProgress(r, theme.fg.bind(theme));
		if (progressText) text += `\n${progressText}`;
		const usageStr = formatUsageFooter(r);
		if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
		return new Text(text, 0, 0);
	}

	const aggregateUsage = (results: Array<Pick<SingleResult, "usage">>) => {
		const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
		for (const r of results) {
			total.input += r.usage.input;
			total.output += r.usage.output;
			total.cacheRead += r.usage.cacheRead;
			total.cacheWrite += r.usage.cacheWrite;
			total.cost += r.usage.cost;
			total.contextTokens += r.usage.contextTokens;
			total.turns += r.usage.turns;
		}
		return total;
	};

	if (details.mode === "parallel") {
		const running = details.results.filter((r) => r.state === "queued" || r.state === "running").length;
		const successCount = details.results.filter(
			(r) => r.state !== "queued" && r.state !== "running" && !isFailedResult(r),
		).length;
		const failCount = details.results.filter(
			(r) => r.state !== "queued" && r.state !== "running" && isFailedResult(r),
		).length;
		const isRunning = running > 0;
		const icon = isRunning
			? theme.fg("warning", "⏳")
			: failCount > 0
				? theme.fg("warning", "◐")
				: theme.fg("success", "✓");
		const status = isRunning
			? `${successCount + failCount}/${details.results.length} done, ${running} running`
			: `${successCount}/${details.results.length} tasks`;

		if (expanded && !isRunning) {
			const container = new Container();
			container.addChild(
				new Text(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, 0, 0),
			);

			for (const r of details.results) {
				const rIcon =
					r.state === "running" || r.state === "queued"
						? theme.fg("warning", "⏳")
						: isFailedResult(r)
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
				const rStatus = formatResultStatus(r);
				const displayItems = getDisplayItems(r);

				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}${
							rStatus ? ` ${theme.fg("error", `[${rStatus}]`)}` : ""
						}`,
						0,
						0,
					),
				);
				container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
				addDisplayItems(container, displayItems);

				const progressText = formatResultProgress(r, theme.fg.bind(theme));
				if (progressText) container.addChild(new Text(progressText, 0, 0));

				const taskUsage = formatUsageFooter(r);
				if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
			}

			if (modelVisibleOutput) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Result ───"), 0, 0));
				container.addChild(new Markdown(modelVisibleOutput.trim(), 0, 0, mdTheme));
			}
			const usageStr = formatUsageStats(aggregateUsage(details.results));
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
			}
			if (details.elapsedMs !== undefined)
				container.addChild(new Text(theme.fg("dim", formatElapsedMs(details.elapsedMs)), 0, 0));
			return container;
		}

		// Collapsed view (or still running)
		let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
		for (const r of details.results) {
			const rIcon =
				r.state === "queued" || r.state === "running"
					? theme.fg("warning", "⏳")
					: isFailedResult(r)
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");
			const rStatus = formatResultStatus(r);
			const displayItems = getDisplayItems(r);
			text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}${
				r.state !== "queued" && r.state !== "running" && rStatus ? ` ${theme.fg("error", `[${rStatus}]`)}` : ""
			}`;
			if (displayItems.length === 0)
				text += `\n${theme.fg("muted", r.state === "queued" || r.state === "running" ? "(running...)" : "(no retained trace)")}`;
			else text += `\n${renderDisplayItems(displayItems, 5)}`;
			const progressText = formatResultProgress(r, theme.fg.bind(theme));
			if (progressText) text += `\n${progressText}`;
			if (r.state !== "queued" && r.state !== "running") {
				const taskUsage = formatUsageFooter(r);
				if (taskUsage) text += `\n${theme.fg("dim", taskUsage)}`;
			}
		}
		if (!isRunning) {
			const usageStr = formatUsageStats(aggregateUsage(details.results));
			if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
			if (details.elapsedMs !== undefined) text += `\n${theme.fg("dim", formatElapsedMs(details.elapsedMs))}`;
		}
		if (!expanded) text += `\n${theme.fg("muted", keyHint("app.tools.expand", "to expand"))}`;
		return new Text(text, 0, 0);
	}

	const text = result.content[0];
	return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
}
