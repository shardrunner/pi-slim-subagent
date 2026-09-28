import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test(
	"published tarball loads through Pi without workspace files or agent configuration",
	{ timeout: 30_000 },
	async () => {
		const scratch = mkdtempSync(join(tmpdir(), "subagent-package-"));
		const previousDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(scratch, "empty-agent-dir");
		try {
			const packed = JSON.parse(
				execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], {
					cwd: import.meta.dirname,
					encoding: "utf8",
					timeout: 20_000,
				}),
			);
			const artifact = Object.values(packed)[0] as { filename: string; files: Array<{ path: string }> };
			const files = artifact.files.map((file) => file.path);
			assert.ok(files.includes("index.ts"));
			assert.ok(files.includes("LICENSE"));
			assert.ok(files.includes("README.md"));
			assert.ok(files.includes("examples/agents/code-reviewer.md"));
			assert.ok(files.every((file) => !/\.test\.ts$|dotdropbak|sdk-smoke|node_modules|^\.env|^docs\/ai\//.test(file)));
			execFileSync("tar", ["-xzf", join(scratch, artifact.filename), "-C", scratch], { timeout: 10_000 });
			const pkg = join(scratch, "package");
			const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
			assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
			const loader = new DefaultResourceLoader({
				cwd: scratch,
				agentDir: process.env.PI_CODING_AGENT_DIR,
				settingsManager: SettingsManager.inMemory({}),
				additionalExtensionPaths: [join(pkg, manifest.pi.extensions[0])],
				noSkills: true,
				noThemes: true,
				noPromptTemplates: true,
			});
			await loader.reload();
			const loaded = loader.getExtensions();
			assert.deepEqual(loaded.errors, []);
			assert.equal(loaded.extensions.length, 1);
			assert.deepEqual([...loaded.extensions[0].tools.keys()].sort(), [
				"load_subagents",
				"subagent",
				"subagent_advanced",
			]);
			assert.deepEqual([...loaded.extensions[0].commands.keys()].sort(), ["agents", "implement-review"]);
		} finally {
			if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousDir;
			rmSync(scratch, { recursive: true, force: true });
		}
	},
);
