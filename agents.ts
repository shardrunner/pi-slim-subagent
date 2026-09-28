/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function getConfiguredThinkingLevel(model?: string): ThinkingLevel | undefined {
	const suffix = model?.slice(model.lastIndexOf(":") + 1);
	return suffix && THINKING_LEVELS.has(suffix as ThinkingLevel) ? (suffix as ThinkingLevel) : undefined;
}

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinkingLevel?: ThinkingLevel;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	warnings: string[];
}

export type AgentWarningCallback = (warning: string) => void;

const BUILTIN_TOOLS = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);

export function parseAgentDefinition(content: string, filePath: string, source: "user" | "project"): AgentConfig {
	try {
		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
		const text = (key: string, required: boolean, maxBytes: number): string | undefined => {
			const value = frontmatter[key];
			if (value === undefined && !required) return undefined;
			if (
				typeof value !== "string" ||
				!value.trim() ||
				Buffer.byteLength(value) > maxBytes ||
				/[\u0000-\u001f\u007f]/u.test(value)
			) {
				throw new Error(`${key} must be a non-empty string of at most ${maxBytes} bytes without control characters`);
			}
			return value.trim();
		};
		const name = text("name", true, 64)!;
		if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) throw new Error("name must be an ASCII identifier");
		const description = text("description", true, 512)!;
		const model = text("model", false, 256);
		let tools: string[] | undefined;
		if (Object.hasOwn(frontmatter, "tools")) {
			const value = frontmatter.tools;
			const items =
				typeof value === "string"
					? value
							.split(",")
							.map((t) => t.trim())
							.filter(Boolean)
					: value;
			if (!Array.isArray(items) || !items.every((t) => typeof t === "string" && BUILTIN_TOOLS.has(t))) {
				throw new Error(
					`tools must be a comma-separated string or array of built-in tool names: ${[...BUILTIN_TOOLS].join(", ")}`,
				);
			}
			tools = [...new Set(items)];
		}
		return {
			name,
			description,
			model,
			tools,
			thinkingLevel: getConfiguredThinkingLevel(model),
			systemPrompt: body,
			source,
			filePath,
		};
	} catch (error) {
		throw new Error(`Invalid agent definition ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function loadAgentsFromDir(
	dir: string,
	source: "user" | "project",
	onWarning?: AgentWarningCallback,
): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	const entries = fs
		.readdirSync(dir, { withFileTypes: true })
		.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
	const names = new Map<string, string>();

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch (error) {
			onWarning?.(
				`Unable to read agent definition ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}

		let agent: AgentConfig;
		try {
			agent = parseAgentDefinition(content, filePath, source);
		} catch (error) {
			onWarning?.(error instanceof Error ? error.message : String(error));
			continue;
		}

		const firstPath = names.get(agent.name);
		if (firstPath) {
			onWarning?.(`Duplicate agent name "${agent.name}" at ${filePath}; keeping first definition at ${firstPath}`);
			continue;
		}
		names.set(agent.name, filePath);
		agents.push(agent);
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverUserAgents(onWarning?: AgentWarningCallback): AgentConfig[] {
	return loadAgentsFromDir(path.join(getAgentDir(), "agents"), "user", onWarning).sort((left, right) =>
		left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
	);
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const warnings: string[] = [];
	const onWarning: AgentWarningCallback = (warning) => warnings.push(warning);

	const userAgents = scope === "project" ? [] : discoverUserAgents(onWarning);
	const projectAgents =
		scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project", onWarning);

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir, warnings };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
