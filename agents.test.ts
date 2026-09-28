import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { discoverAgents, loadAgentsFromDir } from "./agents.ts";

function definition(name: string): string {
	return `---\nname: ${name}\ndescription: ${name} agent\n---\nPrompt.`;
}

test("loadAgentsFromDir skips invalid definitions and duplicate names with source warnings", () => {
	const root = mkdtempSync(join(tmpdir(), "subagent-agent-discovery-"));
	try {
		const validPath = join(root, "a-valid.md");
		const invalidPath = join(root, "b-invalid.md");
		const duplicatePath = join(root, "c-duplicate.md");
		writeFileSync(validPath, definition("same"));
		writeFileSync(invalidPath, "---\nname: broken\n---\n");
		writeFileSync(duplicatePath, definition("same"));

		const warnings: string[] = [];
		const agents = loadAgentsFromDir(root, "project", (warning) => warnings.push(warning));

		assert.deepEqual(
			agents.map((agent) => agent.filePath),
			[validPath],
		);
		assert.equal(warnings.length, 2);
		assert.ok(warnings[0].includes(invalidPath));
		assert.ok(warnings[1].includes(invalidPath) === false);
		assert.ok(warnings[1].includes(validPath));
		assert.ok(warnings[1].includes(duplicatePath));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("discoverAgents warns per selected scope and does not parse project agents for user scope", () => {
	const root = mkdtempSync(join(tmpdir(), "subagent-agent-scopes-"));
	const userDir = join(root, "user");
	const projectDir = join(root, "project");
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		mkdirSync(join(userDir, "agents"), { recursive: true });
		mkdirSync(join(projectDir, CONFIG_DIR_NAME, "agents"), { recursive: true });
		const userValidPath = join(userDir, "agents", "user.md");
		const userInvalidPath = join(userDir, "agents", "broken.md");
		const projectValidPath = join(projectDir, CONFIG_DIR_NAME, "agents", "project.md");
		const projectInvalidPath = join(projectDir, CONFIG_DIR_NAME, "agents", "broken.md");
		writeFileSync(userValidPath, definition("user-agent"));
		writeFileSync(userInvalidPath, "---\nname: broken\n---\n");
		writeFileSync(projectValidPath, definition("project-agent"));
		writeFileSync(projectInvalidPath, "---\nname: broken\n---\n");
		process.env.PI_CODING_AGENT_DIR = userDir;

		const userOnly = discoverAgents(projectDir, "user");
		assert.deepEqual(
			userOnly.agents.map((agent) => agent.name),
			["user-agent"],
		);
		assert.ok(userOnly.warnings.some((warning) => warning.includes(userInvalidPath)));
		assert.ok(userOnly.warnings.every((warning) => !warning.includes(projectInvalidPath)));

		const projectOnly = discoverAgents(projectDir, "project");
		assert.deepEqual(
			projectOnly.agents.map((agent) => agent.name),
			["project-agent"],
		);
		assert.ok(projectOnly.warnings.some((warning) => warning.includes(projectInvalidPath)));
		assert.ok(projectOnly.warnings.every((warning) => !warning.includes(userInvalidPath)));

		const both = discoverAgents(projectDir, "both");
		assert.deepEqual(
			both.agents.map((agent) => agent.name),
			["user-agent", "project-agent"],
		);
		assert.ok(both.warnings.some((warning) => warning.includes(userInvalidPath)));
		assert.ok(both.warnings.some((warning) => warning.includes(projectInvalidPath)));
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});
