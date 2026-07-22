#!/usr/bin/env node
import { dirname, isAbsolute, join, resolve } from "node:path";
import { access, chmod, copyFile, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { Command } from "commander";
import * as p from "@clack/prompts";
import yaml from "js-yaml";
import { z } from "zod";
import { execFileSync, execSync } from "node:child_process";
import fsExtra from "fs-extra";
//#region src/lib/config.ts
const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;
const safeName = z.string().min(1).refine((v) => SAFE_NAME_RE.test(v) && v !== "." && v !== "..", { message: "Only [A-Za-z0-9._-] characters allowed, cannot be . or .." });
const safeRelativeFolder = z.string().min(1).refine((value) => {
	if (isAbsolute(value) || value.includes("\0")) return false;
	const segments = value.split(/[\\/]/).filter((s) => s.length > 0);
	if (segments.length === 0) return false;
	return segments.every((seg) => seg !== ".." && seg !== "." && /^\.?[A-Za-z0-9._-]+$/.test(seg));
}, { message: "Must be a relative path using only [A-Za-z0-9._-]" });
const toolConfigSchema = z.object({
	name: safeName.refine((v) => !v.includes("--"), { message: "Must not contain '--' (reserved for tool-prefix routing)" }),
	folder: safeRelativeFolder
});
const sourceConfigSchema = z.object({
	name: safeName,
	source: z.string().min(1).refine((v) => !v.startsWith("-"), { message: "Must not start with '-'" }),
	branch: z.string().refine((v) => /^[A-Za-z0-9._/-]+$/.test(v) && !v.startsWith("-"), { message: "Must match [A-Za-z0-9._/-] and not start with '-'" }).optional()
});
const bridgeConfigSchema = z.object({
	version: z.string().optional(),
	domains: z.array(safeName).min(1, "'domains' must be a non-empty array"),
	tools: z.array(toolConfigSchema).min(1, "'tools' must be a non-empty array"),
	sources: z.array(sourceConfigSchema).min(1, "'sources' must be a non-empty array")
}).superRefine((data, ctx) => {
	const toolNames = /* @__PURE__ */ new Set();
	const toolFolders = /* @__PURE__ */ new Set();
	data.tools.forEach((t, i) => {
		if (toolNames.has(t.name)) ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: `Duplicate tool name: '${t.name}'`,
			path: [
				"tools",
				i,
				"name"
			]
		});
		toolNames.add(t.name);
		if (toolFolders.has(t.folder)) ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: `Duplicate tool folder: '${t.folder}'`,
			path: [
				"tools",
				i,
				"folder"
			]
		});
		toolFolders.add(t.folder);
	});
	const sourceNames = /* @__PURE__ */ new Set();
	data.sources.forEach((s, i) => {
		if (sourceNames.has(s.name)) ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: `Duplicate source name: '${s.name}'`,
			path: [
				"sources",
				i,
				"name"
			]
		});
		sourceNames.add(s.name);
		const isRemote = s.source.startsWith("https://") || s.source.startsWith("http://") || s.source.startsWith("file://") || /^[\w.-]+@[\w.-]+:/.test(s.source);
		if (s.branch && !isRemote) ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "'branch' is only valid for remote sources",
			path: [
				"sources",
				i,
				"branch"
			]
		});
		if (!isRemote && !isAbsolute(s.source)) ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Local source paths must be absolute",
			path: [
				"sources",
				i,
				"source"
			]
		});
	});
});
const BRIDGE_DIR = ".agent-bridge";
const CONFIG_FILENAME = "config.yml";
function detectSourceType(source) {
	if (source.startsWith("https://") || source.startsWith("http://") || source.startsWith("file://")) return "git-https";
	if (/^[\w.-]+@[\w.-]+:/.test(source)) return "git-ssh";
	return "local";
}
function isRemoteSource(source) {
	const type = detectSourceType(source);
	return type === "git-https" || type === "git-ssh";
}
function bridgeDir(repoRoot) {
	return join(repoRoot, BRIDGE_DIR);
}
function configPath(repoRoot) {
	return join(repoRoot, BRIDGE_DIR, CONFIG_FILENAME);
}
function sourceDir(repoRoot, sourceName) {
	return join(repoRoot, BRIDGE_DIR, sourceName);
}
async function configExists(repoRoot) {
	try {
		await access(configPath(repoRoot));
		return true;
	} catch {
		return false;
	}
}
async function loadConfig(repoRoot) {
	const raw = await readFile(configPath(repoRoot), "utf-8");
	const data = yaml.load(raw);
	const result = bridgeConfigSchema.safeParse(data);
	if (!result.success) {
		const errors = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
		throw new Error(`Invalid config: ${errors.join("; ")}`);
	}
	return result.data;
}
async function saveConfig(repoRoot, config) {
	await mkdir(bridgeDir(repoRoot), { recursive: true });
	const content = yaml.dump(config, {
		lineWidth: -1,
		noRefs: true
	});
	await writeFile(configPath(repoRoot), content, "utf-8");
}
//#endregion
//#region src/lib/git.ts
function findRepoRoot() {
	try {
		return execSync("git rev-parse --show-toplevel", {
			encoding: "utf-8",
			stdio: "pipe"
		}).trim();
	} catch {
		return process.cwd();
	}
}
/**
* Check if a directory is inside a Git repository.
*/
function isInGitRepo(cwd) {
	try {
		execSync("git rev-parse --is-inside-work-tree", {
			encoding: "utf-8",
			stdio: "pipe",
			cwd
		});
		return true;
	} catch {
		return false;
	}
}
/**
* Get the path to the .git/hooks directory.
*/
function getGitHooksDir(repoRoot) {
	return join(repoRoot, ".git", "hooks");
}
/**
* The hook names that Agent Bridge will install.
*/
const AGENT_BRIDGE_HOOKS = ["post-checkout", "post-merge"];
/**
* Marker comment to identify Agent Bridge hooks.
*/
const HOOK_MARKER = "# agent-bridge-hook";
/**
* Generate the hook script content.
* Runs update and sync in the background, logging to `.agent-bridge/hook.log`
* (trimmed to the last ~200 lines) so failures are diagnosable.
*/
function generateHookScript() {
	return `#!/bin/sh
${HOOK_MARKER}
# This hook was installed by Agent Bridge.
# It runs 'agent-bridge update && agent-bridge sync' in the background
# to keep your AI agent configurations up to date.

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
LOG_DIR="\${REPO_ROOT:-.}/.agent-bridge"
LOG_FILE="\${LOG_DIR}/hook.log"

mkdir -p "\$LOG_DIR" 2>/dev/null

(
  # Wait a moment for git to finish
  sleep 1

  {
    echo "--- $(date '+%Y-%m-%dT%H:%M:%S%z') agent-bridge hook ---"
    if command -v agent-bridge >/dev/null 2>&1; then
      agent-bridge update && agent-bridge sync
    elif command -v npx >/dev/null 2>&1; then
      npx @sofatutor/agent-bridge update && npx @sofatutor/agent-bridge sync
    else
      echo "agent-bridge not found (install globally or ensure npx is available)"
    fi
  } >>"\$LOG_FILE" 2>&1

  # Keep the log from growing without bound.
  if [ -f "\$LOG_FILE" ]; then
    tail -n 200 "\$LOG_FILE" >"\$LOG_FILE.tmp" && mv "\$LOG_FILE.tmp" "\$LOG_FILE"
  fi
) </dev/null >/dev/null 2>&1 &
`;
}
/**
* Check if a hook file contains the Agent Bridge marker.
*/
async function hasAgentBridgeHook(hookPath) {
	try {
		return (await readFile(hookPath, "utf-8")).includes(HOOK_MARKER);
	} catch {
		return false;
	}
}
/**
* Check if a hook file exists.
*/
async function hookExists(hookPath) {
	try {
		await access(hookPath);
		return true;
	} catch {
		return false;
	}
}
/**
* Install Agent Bridge git hooks in the repository.
* 
* @param repoRoot - The root of the git repository
* @param force - If true, overwrite existing hooks that don't have the marker
* @returns Result with installed, skipped, and errored hooks
*/
async function installGitHooks(repoRoot, force = false) {
	const result = {
		installed: [],
		skipped: [],
		errors: []
	};
	if (!isInGitRepo(repoRoot)) {
		for (const hook of AGENT_BRIDGE_HOOKS) result.errors.push({
			hook,
			error: "Not a git repository"
		});
		return result;
	}
	const hooksDir = getGitHooksDir(repoRoot);
	try {
		await mkdir(hooksDir, { recursive: true });
	} catch (err) {
		for (const hook of AGENT_BRIDGE_HOOKS) result.errors.push({
			hook,
			error: `Failed to create hooks directory: ${err}`
		});
		return result;
	}
	const hookContent = generateHookScript();
	for (const hookName of AGENT_BRIDGE_HOOKS) {
		const hookPath = join(hooksDir, hookName);
		try {
			if (await hookExists(hookPath)) if (await hasAgentBridgeHook(hookPath)) {
				await writeFile(hookPath, hookContent, "utf-8");
				await chmod(hookPath, 493);
				result.installed.push(hookName);
			} else if (force) {
				await writeFile(hookPath, hookContent, "utf-8");
				await chmod(hookPath, 493);
				result.installed.push(hookName);
			} else result.skipped.push(hookName);
			else {
				await writeFile(hookPath, hookContent, "utf-8");
				await chmod(hookPath, 493);
				result.installed.push(hookName);
			}
		} catch (err) {
			result.errors.push({
				hook: hookName,
				error: String(err)
			});
		}
	}
	return result;
}
/**
* Remove Agent Bridge git hooks from the repository.
* Only removes hooks that have the Agent Bridge marker.
*/
async function removeGitHooks(repoRoot) {
	const removed = [];
	if (!isInGitRepo(repoRoot)) return removed;
	const hooksDir = getGitHooksDir(repoRoot);
	for (const hookName of AGENT_BRIDGE_HOOKS) {
		const hookPath = join(hooksDir, hookName);
		try {
			if (await hasAgentBridgeHook(hookPath)) {
				const { unlink } = await import("node:fs/promises");
				await unlink(hookPath);
				removed.push(hookName);
			}
		} catch {}
	}
	return removed;
}
//#endregion
//#region src/lib/fs.ts
const { pathExists, remove, outputFile, readFile: fsReadFile, ensureDir } = fsExtra;
/** Name of the marker file placed inside every synced feature folder. */
const MARKER_FILENAME = ".agentbridge";
async function dirExists(p) {
	try {
		return (await stat(p)).isDirectory();
	} catch {
		return false;
	}
}
async function fileExists(p) {
	return pathExists(p);
}
async function listFilesRecursive(dir) {
	const files = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		if (entry.name === ".agentbridge") continue;
		if (entry.isDirectory()) {
			const subFiles = await listFilesRecursive(join(dir, entry.name));
			files.push(...subFiles.map((f) => join(entry.name, f)));
		} else if (entry.isFile()) files.push(entry.name);
	}
	return files;
}
/**
* Copy all files from `srcDir` into `destDir`, preserving nested structure.
* Overwrites existing files. Creates directories as needed.
*/
async function copyDirContents(srcDir, destDir) {
	const files = await listFilesRecursive(srcDir);
	for (const relFile of files) {
		const srcFile = join(srcDir, relFile);
		const destFile = join(destDir, relFile);
		await ensureDir(dirname(destFile));
		await copyFile(srcFile, destFile);
	}
}
/**
* Remove a directory and all its contents.
*/
async function removeDir(dir) {
	await remove(dir);
}
/**
* Remove a single file.
*/
async function removeFile(filePath) {
	await remove(filePath);
}
/**
* Read the manifest file in a directory. Returns list of managed entries.
* Entries ending with '/' are folders, others are files.
*/
async function readManifest(dir) {
	const manifestPath = join(dir, MARKER_FILENAME);
	try {
		return (await fsReadFile(manifestPath, "utf-8")).split("\n").filter((line) => line.trim().length > 0);
	} catch {
		return [];
	}
}
/**
* Check if an entry in the manifest is a folder (ends with /).
*/
function isManifestFolder(entry) {
	return entry.endsWith("/");
}
/**
* Get the base name from a manifest entry (strips trailing / for folders).
*/
function manifestEntryName(entry) {
	return entry.endsWith("/") ? entry.slice(0, -1) : entry;
}
/**
* Write a manifest file listing managed entries.
*/
async function writeManifest(dir, entries) {
	await outputFile(join(dir, MARKER_FILENAME), entries.length > 0 ? entries.join("\n") + "\n" : "");
}
/**
* Add an entry to the manifest. Creates manifest if it doesn't exist.
* Use trailing '/' for folders.
*/
async function addToManifest(dir, entry) {
	const existing = await readManifest(dir);
	if (!existing.includes(entry)) {
		existing.push(entry);
		await writeManifest(dir, existing);
	}
}
/**
* Remove an entry from the manifest.
* Deletes the manifest file entirely if it becomes empty.
*/
async function removeFromManifest(dir, entry) {
	const existing = await readManifest(dir);
	const updated = existing.filter((e) => e !== entry);
	if (updated.length !== existing.length) if (updated.length === 0) await remove(join(dir, MARKER_FILENAME));
	else await writeManifest(dir, updated);
}
//#endregion
//#region src/lib/sources.ts
/**
* Marker file written inside every directory Agent Bridge manages under
* `.agent-bridge/`. Used to gate destructive cleanup so we never delete
* user-placed content.
*/
const SOURCE_MARKER = ".agent-bridge-managed";
function git(args, cwd) {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: "pipe"
	}).trim();
}
/**
* Branch names must not contain shell metacharacters or leading dashes
* (which could be mistaken for git flags). Conservative but safe.
*/
function assertSafeBranch(branch, sourceName) {
	if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-")) throw new Error(`Source '${sourceName}': invalid branch name '${branch}'. Branch must match [A-Za-z0-9._/-]+ and not start with '-'.`);
}
/**
* Reject source URLs that begin with '-' to prevent them being interpreted
* as CLI flags by git.
*/
function assertSafeSourceUrl(source, sourceName) {
	if (source.startsWith("-")) throw new Error(`Source '${sourceName}': URL must not start with '-' (got '${source}').`);
}
async function writeSourceMarker(dest) {
	await writeFile(join(dest, SOURCE_MARKER), "This directory is managed by agent-bridge. Do not edit manually.\n", "utf-8");
}
async function hasSourceMarker(dir) {
	try {
		await access(join(dir, SOURCE_MARKER));
		return true;
	} catch {
		return false;
	}
}
async function cloneSource(repoRoot, source) {
	assertSafeSourceUrl(source.source, source.name);
	if (source.branch) assertSafeBranch(source.branch, source.name);
	const dest = sourceDir(repoRoot, source.name);
	await mkdir(bridgeDir(repoRoot), { recursive: true });
	const args = [
		"clone",
		"--depth",
		"1"
	];
	if (source.branch) args.push("--single-branch", "--branch", source.branch);
	args.push("--", source.source, dest);
	execFileSync("git", args, { stdio: "pipe" });
	await writeSourceMarker(dest);
}
async function fetchSource(repoRoot, source) {
	assertSafeSourceUrl(source.source, source.name);
	if (source.branch) assertSafeBranch(source.branch, source.name);
	const dest = sourceDir(repoRoot, source.name);
	git([
		"fetch",
		"--prune",
		"origin"
	], dest);
	if (source.branch) {
		if (git([
			"rev-parse",
			"--abbrev-ref",
			"HEAD"
		], dest) !== source.branch) {
			try {
				git([
					"fetch",
					"--depth",
					"1",
					"origin",
					source.branch
				], dest);
			} catch {}
			git(["checkout", source.branch], dest);
		}
	}
	try {
		git(["pull", "--ff-only"], dest);
	} catch {}
	await writeSourceMarker(dest);
}
function resolveLocalSource(repoRoot, source) {
	const raw = source.source;
	if (isAbsolute(raw)) return raw;
	return resolve(repoRoot, raw);
}
function resolveSourcePath(repoRoot, source) {
	if (isRemoteSource(source.source)) return sourceDir(repoRoot, source.name);
	return resolveLocalSource(repoRoot, source);
}
async function syncSource(repoRoot, source) {
	if (!isRemoteSource(source.source)) {
		const resolved = resolveLocalSource(repoRoot, source);
		if (!await dirExists(resolved)) return {
			name: source.name,
			action: "local",
			error: `Local source path does not exist: ${resolved}\n  Update the path in .agent-bridge/config.yml or run "agent-bridge init" to reconfigure.`
		};
		return {
			name: source.name,
			action: "local"
		};
	}
	if (await dirExists(sourceDir(repoRoot, source.name))) try {
		await fetchSource(repoRoot, source);
		return {
			name: source.name,
			action: "updated"
		};
	} catch (err) {
		return {
			name: source.name,
			action: "updated",
			error: err instanceof Error ? err.message : String(err)
		};
	}
	try {
		await cloneSource(repoRoot, source);
		return {
			name: source.name,
			action: "cloned"
		};
	} catch (err) {
		return {
			name: source.name,
			action: "cloned",
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
async function syncAllSources(repoRoot, config) {
	await ensureBridgeGitignore(repoRoot);
	return Promise.all(config.sources.map((source) => syncSource(repoRoot, source)));
}
/**
* Write a `.gitignore` inside `.agent-bridge/` that ignores cloned source
* directories (which are nested git repos) while keeping `config.yml` tracked.
* Without this, git sees the nested repos as gitlinks/submodules and creates
* phantom dirty-state changes.
*/
async function ensureBridgeGitignore(repoRoot) {
	const bridge = bridgeDir(repoRoot);
	await mkdir(bridge, { recursive: true });
	await writeFile(join(bridge, ".gitignore"), [
		"# Ignore cloned sources",
		"*",
		"!config.yml",
		"!.gitignore"
	].join("\n") + "\n", "utf-8");
}
/**
* Remove cloned source directories under `.agent-bridge/` that are no longer
* referenced in config. Only directories carrying the Agent Bridge marker
* file are eligible for deletion — user-placed content is always preserved.
*
* For backwards compatibility with clones created before the marker existed,
* directories containing a `.git` folder are also treated as stale.
*/
async function removeStaleSourceDirs(repoRoot, config) {
	const bridge = bridgeDir(repoRoot);
	if (!await dirExists(bridge)) return [];
	const entries = await readdir(bridge, { withFileTypes: true });
	const configuredNames = new Set(config.sources.filter((s) => isRemoteSource(s.source)).map((s) => s.name));
	const removed = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (configuredNames.has(entry.name)) continue;
		const candidate = join(bridge, entry.name);
		if (await hasSourceMarker(candidate) || await dirExists(join(candidate, ".git"))) {
			await rm(candidate, {
				recursive: true,
				force: true
			});
			removed.push(entry.name);
		}
	}
	return removed;
}
//#endregion
//#region src/lib/version.ts
const VERSION = "0.10.0";
//#endregion
//#region src/commands/init.ts
const WELL_KNOWN_TOOLS = [
	{
		value: {
			name: "vscode",
			folder: ".github"
		},
		label: "VS Code (.github/)"
	},
	{
		value: {
			name: "cursor",
			folder: ".cursor"
		},
		label: "Cursor (.cursor/)"
	},
	{
		value: {
			name: "claude",
			folder: ".claude"
		},
		label: "Claude (.claude/)"
	},
	{
		value: {
			name: "pi",
			folder: ".pi"
		},
		label: "Pi (.pi/)"
	}
];
const WELL_KNOWN_TOOL_MAP = Object.fromEntries(WELL_KNOWN_TOOLS.map((t) => [t.value.name, t.value]));
const CUSTOM_TOOL_SENTINEL = {
	name: "__custom__",
	folder: "__custom__"
};
const DEFAULT_DOMAINS = [
	"backend",
	"frontend",
	"shared"
];
/**
* Derive a short source name from a URL or local path.
*
* Examples:
*   https://github.com/org/repo.git  → repo
*   git@github.com:org/repo.git      → repo
*   file:///tmp/bare.git             → bare
*   /path/to/my-folder               → my-folder
*/
function deriveSourceName(source) {
	let segment = source;
	const sshMatch = segment.match(/^[\w.-]+@[\w.-]+:(.+)$/);
	if (sshMatch) segment = sshMatch[1];
	try {
		segment = new URL(segment).pathname;
	} catch {}
	return (segment.replace(/\/+$/, "").split("/").pop() ?? segment).replace(/\.git$/, "") || "source";
}
/**
* Parse a comma-separated `--tools` argument into ToolConfig[].
* Accepts well-known names (cursor, vscode, claude) or `name:folder` pairs.
*/
function parseToolsArg(input) {
	return input.split(",").map((t) => {
		const trimmed = t.trim();
		if (!trimmed) throw new Error("Empty tool name in --tools");
		if (WELL_KNOWN_TOOL_MAP[trimmed]) return WELL_KNOWN_TOOL_MAP[trimmed];
		const colonIdx = trimmed.indexOf(":");
		if (colonIdx > 0) return {
			name: trimmed.slice(0, colonIdx),
			folder: trimmed.slice(colonIdx + 1)
		};
		throw new Error(`Unknown tool "${trimmed}". Use a known name (${Object.keys(WELL_KNOWN_TOOL_MAP).join(", ")}) or name:folder format.`);
	});
}
/**
* Parse a single `--source` argument into a SourceConfig.
* Supports `#branch` suffix for remote sources.
*/
function parseSourceArg(input, repoRoot) {
	let source = input.trim();
	let branch;
	const hashIdx = source.lastIndexOf("#");
	if (hashIdx > 0) {
		branch = source.slice(hashIdx + 1);
		source = source.slice(0, hashIdx);
	}
	if (!source) throw new Error("Empty source in --source");
	const entry = {
		name: deriveSourceName(source),
		source
	};
	if (!isRemoteSource(entry.source)) entry.source = resolve(repoRoot, entry.source);
	if (branch) entry.branch = branch;
	return entry;
}
async function initCommand(cwd, opts) {
	const repoRoot = cwd ?? findRepoRoot();
	const hasToolsArg = !!opts?.tools;
	const hasSourceArg = !!(opts?.source && opts.source.length > 0);
	if (hasToolsArg !== hasSourceArg) {
		p.log.error("Both --tools and --source are required for non-interactive init.");
		process.exit(1);
	}
	if (hasToolsArg && hasSourceArg) {
		const domains = opts.domains ? opts.domains.split(",").map((d) => d.trim()).filter(Boolean) : [...DEFAULT_DOMAINS];
		const tools = parseToolsArg(opts.tools);
		const sources = opts.source.map((s) => parseSourceArg(s, repoRoot));
		const seen = /* @__PURE__ */ new Set();
		for (const s of sources) {
			if (seen.has(s.name)) throw new Error(`Duplicate source name "${s.name}" derived from --source arguments`);
			seen.add(s.name);
		}
		const config = {
			version: VERSION,
			domains,
			tools,
			sources
		};
		await saveConfig(repoRoot, config);
		await ensureBridgeGitignore(repoRoot);
		p.log.success("Saved .agent-bridge/config.yml");
		const spinner = p.spinner();
		spinner.start("Fetching remote sources…");
		const fetchErrors = (await syncAllSources(repoRoot, config)).filter((r) => r.error);
		if (fetchErrors.length > 0) {
			spinner.stop("Some sources failed");
			for (const err of fetchErrors) p.log.error(`${err.name}: ${err.error}`);
		} else spinner.stop("All sources ready");
		if (opts.hooks && isInGitRepo(repoRoot)) {
			const hookResult = await installGitHooks(repoRoot, opts.force === true);
			if (hookResult.installed.length > 0) p.log.success(`Installed git hooks: ${hookResult.installed.join(", ")}`);
			if (hookResult.skipped.length > 0) p.log.warn(`Skipped hooks: ${hookResult.skipped.join(", ")}`);
			if (hookResult.errors.length > 0) for (const e of hookResult.errors) p.log.error(`Hook ${e.hook}: ${e.error}`);
		}
		p.outro("Done! Run `agent-bridge sync` to sync features.");
		return;
	}
	p.intro("Welcome to Agent Bridge — Project Setup");
	if (await configExists(repoRoot)) {
		const existing = await loadConfig(repoRoot);
		p.log.info(`Config already exists with ${existing.sources?.length ?? 0} source(s). Re-running will overwrite.`);
	}
	const domainsInput = await p.text({
		message: "Domains (comma-separated)",
		placeholder: DEFAULT_DOMAINS.join(", "),
		defaultValue: DEFAULT_DOMAINS.join(", "),
		validate: (v) => {
			if (!v.trim()) return "At least one domain is required";
		}
	});
	if (p.isCancel(domainsInput)) {
		p.cancel("Setup cancelled.");
		process.exit(1);
	}
	const domains = domainsInput.split(",").map((d) => d.trim()).filter(Boolean);
	const selectedTools = await p.multiselect({
		message: "Which tools (IDEs) should receive Agent Bridge files?",
		options: [...WELL_KNOWN_TOOLS, {
			value: CUSTOM_TOOL_SENTINEL,
			label: "Other (add custom tool)"
		}],
		required: true
	});
	if (p.isCancel(selectedTools)) {
		p.cancel("Setup cancelled.");
		process.exit(1);
	}
	const tools = selectedTools.filter((t) => t.name !== "__custom__");
	if (selectedTools.some((t) => t.name === "__custom__")) {
		let addingCustom = true;
		while (addingCustom) {
			const name = await p.text({
				message: "Custom tool name (used for <tool>-- prefix matching)",
				placeholder: "windsurf",
				defaultValue: "",
				validate: (v) => {
					if (!v.trim()) return "Tool name cannot be empty";
					if (tools.some((t) => t.name === v.trim())) return "Tool name already used";
				}
			});
			if (p.isCancel(name)) break;
			const folder = await p.text({
				message: `Target folder for "${name}"`,
				placeholder: `.${name}`,
				defaultValue: "",
				validate: (v) => {
					if (!v.trim()) return "Folder cannot be empty";
					if (tools.some((t) => t.folder === v.trim())) return "Folder already used by another tool";
				}
			});
			if (p.isCancel(folder)) break;
			tools.push({
				name: name.trim(),
				folder: folder.trim()
			});
			const addMore = await p.confirm({
				message: "Add another custom tool?",
				initialValue: false
			});
			if (p.isCancel(addMore) || !addMore) addingCustom = false;
		}
		if (tools.length === 0) {
			p.cancel("At least one tool is required.");
			process.exit(1);
		}
	}
	const sources = [];
	const addSource = async () => {
		const source = await p.text({
			message: "Source URL or local path",
			placeholder: "https://github.com/org/repo.git",
			defaultValue: "",
			validate: (v) => {
				if (!v.trim()) return "Source URL/path cannot be empty";
				const derived = deriveSourceName(v.trim());
				if (sources.some((s) => s.name === derived)) return `Source name "${derived}" (derived from URL) already used`;
			}
		});
		if (p.isCancel(source)) return false;
		const entry = {
			name: deriveSourceName(source.trim()),
			source: source.trim()
		};
		if (!isRemoteSource(entry.source)) entry.source = resolve(repoRoot, entry.source);
		if (isRemoteSource(entry.source)) {
			const branch = await p.text({
				message: "Branch (leave empty for remote default)",
				placeholder: "main",
				defaultValue: ""
			});
			if (p.isCancel(branch)) return false;
			if (branch.trim()) entry.branch = branch.trim();
		}
		sources.push(entry);
		return true;
	};
	p.log.info("Add at least one source.");
	let addingSource = true;
	while (addingSource) {
		if (!await addSource()) {
			if (sources.length === 0) {
				p.cancel("At least one source is required.");
				process.exit(1);
			}
			break;
		}
		const addMore = await p.confirm({
			message: "Add another source?",
			initialValue: false
		});
		if (p.isCancel(addMore) || !addMore) addingSource = false;
	}
	const config = {
		version: VERSION,
		domains,
		tools,
		sources
	};
	await saveConfig(repoRoot, config);
	await ensureBridgeGitignore(repoRoot);
	p.log.success("Saved .agent-bridge/config.yml");
	const s = p.spinner();
	s.start("Fetching remote sources…");
	const errors = (await syncAllSources(repoRoot, config)).filter((r) => r.error);
	if (errors.length > 0) {
		s.stop("Some sources failed");
		for (const err of errors) p.log.error(`${err.name}: ${err.error}`);
	} else s.stop("All sources ready");
	if (isInGitRepo(repoRoot)) {
		const installHooks = await p.confirm({
			message: "Install git hooks to auto-sync on checkout/merge?",
			initialValue: false
		});
		if (!p.isCancel(installHooks) && installHooks) {
			const hookResult = await installGitHooks(repoRoot, opts?.force === true);
			if (hookResult.installed.length > 0) p.log.success(`Installed git hooks: ${hookResult.installed.join(", ")}`);
			if (hookResult.skipped.length > 0) {
				p.log.warn(`Skipped hooks (existing non-Agent-Bridge hooks): ${hookResult.skipped.join(", ")}`);
				p.log.info("Re-run `agent-bridge init --force` to overwrite, or integrate manually.");
			}
			if (hookResult.errors.length > 0) for (const err of hookResult.errors) p.log.error(`Hook ${err.hook}: ${err.error}`);
		}
	}
	p.outro("Done! Run `agent-bridge sync` to sync features.");
}
//#endregion
//#region src/lib/migrations/index.ts
const migrations = [];
/** Parse "1.2.3" or "1.2.3-beta.1" into [major, minor, patch]. */
function parseSemver(version) {
	const parts = version.replace(/^v/, "").split("-")[0].split(".").map(Number);
	return [
		parts[0] ?? 0,
		parts[1] ?? 0,
		parts[2] ?? 0
	];
}
/** Returns -1 | 0 | 1 comparing a to b (ignores prerelease). */
function compareSemver(a, b) {
	const [aMaj, aMin, aPat] = parseSemver(a);
	const [bMaj, bMin, bPat] = parseSemver(b);
	if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1;
	if (aMin !== bMin) return aMin < bMin ? -1 : 1;
	if (aPat !== bPat) return aPat < bPat ? -1 : 1;
	return 0;
}
/**
* Find migrations that should run when upgrading from `fromVersion` to
* `toVersion`. Returns them sorted in ascending version order.
*/
function pendingMigrations(fromVersion, toVersion) {
	return migrations.filter((m) => compareSemver(m.version, fromVersion) > 0 && compareSemver(m.version, toVersion) <= 0).sort((a, b) => compareSemver(a.version, b.version));
}
/**
* Run all pending migrations between the config's version and the
* currently installed VERSION. Updates and saves the config afterwards.
*
* Returns null if no migration was needed.
*/
async function runMigrations(repoRoot) {
	let config = await loadConfig(repoRoot);
	const configVersion = config.version ?? "0.0.0";
	const cmp = compareSemver(configVersion, VERSION);
	if (cmp === 0) return null;
	if (cmp > 0) return null;
	const pending = pendingMigrations(configVersion, VERSION);
	const applied = [];
	for (const migration of pending) {
		config = await migration.migrate(repoRoot, config);
		applied.push(migration.version);
	}
	config = {
		...config,
		version: VERSION
	};
	await saveConfig(repoRoot, config);
	return {
		fromVersion: configVersion,
		toVersion: VERSION,
		applied
	};
}
//#endregion
//#region src/lib/manifest.ts
const TOOL_PREFIX_SEPARATOR = "--";
function parseToolPrefix(name) {
	const idx = name.indexOf(TOOL_PREFIX_SEPARATOR);
	if (idx > 0) return {
		toolPrefix: name.substring(0, idx),
		baseName: name.substring(idx + 2)
	};
	return { baseName: name };
}
function featureMatchesTool(feature, toolName) {
	if (!feature.toolPrefix) return true;
	return feature.toolPrefix === toolName;
}
function featureName(feature) {
	if (feature.toolPrefix) return parseToolPrefix(feature.name).baseName;
	return feature.name;
}
/**
* Discover all feature types across all sources and domains.
*/
async function discoverFeatureTypes(repoRoot, config) {
	const types = /* @__PURE__ */ new Set();
	for (const source of config.sources) {
		const srcPath = resolveSourcePath(repoRoot, source);
		for (const domain of config.domains) {
			const domainDir = join(srcPath, domain);
			if (!await dirExists(domainDir)) continue;
			const entries = await readdir(domainDir, { withFileTypes: true });
			for (const entry of entries) if (entry.isDirectory()) types.add(entry.name);
		}
	}
	return [...types].sort();
}
/**
* Scan all features across sources × domains × feature types.
*
* Structure: `<source-path>/<domain>/<feature-type>/<feature>/` (folder-based)
*         or `<source-path>/<domain>/<feature-type>/<feature.ext>` (file-based)
*/
async function scanFeatures(repoRoot, config, featureTypes) {
	const features = [];
	for (const source of config.sources) {
		const srcPath = resolveSourcePath(repoRoot, source);
		for (const domain of config.domains) for (const ft of featureTypes) {
			const { toolPrefix: typeToolPrefix, baseName: baseType } = parseToolPrefix(ft);
			const ftDir = join(srcPath, domain, ft);
			if (!await dirExists(ftDir)) continue;
			const entries = await readdir(ftDir, { withFileTypes: true });
			for (const entry of entries) {
				const isFile = entry.isFile();
				const isDir = entry.isDirectory();
				if (!isFile && !isDir) continue;
				const { toolPrefix: itemToolPrefix } = parseToolPrefix(entry.name);
				const toolPrefix = itemToolPrefix ?? typeToolPrefix;
				features.push({
					name: entry.name,
					type: ft,
					displayType: baseType,
					source: source.name,
					domain,
					absolutePath: join(ftDir, entry.name),
					toolPrefix,
					isFile
				});
			}
		}
	}
	return features;
}
function detectDuplicates(features) {
	const byKey = /* @__PURE__ */ new Map();
	for (const f of features) {
		const linkName = featureName(f);
		const key = `${f.displayType}/${linkName}`;
		const group = byKey.get(key) ?? [];
		group.push(f);
		byKey.set(key, group);
	}
	const conflicts = [];
	for (const [, group] of byKey) if (group.length > 1) conflicts.push({
		name: featureName(group[0]),
		type: group[0].type,
		paths: group.map((f) => f.absolutePath)
	});
	return conflicts;
}
/**
* Well-known root files that live at the domain root and should be synced to the
* workspace root. When a source contains `<domain>/AGENTS.md` (etc.), Agent Bridge
* copies it to the project root.
*/
const ROOT_FILES = [
	"AGENTS.md",
	"CLAUDE.md",
	"SYSTEM.md"
];
/**
* Scan all sources × domains for well-known root files.
* Returns one entry per found file.
*/
async function scanRootFiles(repoRoot, config) {
	const found = [];
	for (const source of config.sources) {
		const srcPath = resolveSourcePath(repoRoot, source);
		for (const domain of config.domains) for (const fileName of ROOT_FILES) {
			const filePath = join(srcPath, domain, fileName);
			if (await fileExists(filePath)) found.push({
				fileName,
				source: source.name,
				domain,
				absolutePath: filePath
			});
		}
	}
	return found;
}
/**
* Detect duplicate root files (same filename provided by multiple sources/domains).
*/
function detectRootFileDuplicates(rootFiles) {
	const byName = /* @__PURE__ */ new Map();
	for (const rf of rootFiles) {
		const group = byName.get(rf.fileName) ?? [];
		group.push(rf);
		byName.set(rf.fileName, group);
	}
	const duplicates = [];
	for (const [fileName, group] of byName) if (group.length > 1) duplicates.push({
		fileName,
		paths: group.map((rf) => rf.absolutePath)
	});
	return duplicates;
}
/**
* Scan all sources × domains for tool-prefixed flat files at the domain level.
* A file named `cursor--settings.json` targets the tool "cursor" with
* destination filename "settings.json".
*/
async function scanToolRootEntries(repoRoot, config) {
	const entries = [];
	const toolNames = new Set(config.tools.map((t) => t.name));
	for (const source of config.sources) {
		const srcPath = resolveSourcePath(repoRoot, source);
		for (const domain of config.domains) {
			const domainDir = join(srcPath, domain);
			if (!await dirExists(domainDir)) continue;
			const domainEntries = await readdir(domainDir, { withFileTypes: true });
			for (const entry of domainEntries) {
				if (!entry.isFile()) continue;
				const { toolPrefix, baseName } = parseToolPrefix(entry.name);
				if (!toolPrefix || !toolNames.has(toolPrefix)) continue;
				entries.push({
					toolName: toolPrefix,
					name: baseName,
					source: source.name,
					domain,
					absolutePath: join(domainDir, entry.name)
				});
			}
		}
	}
	return entries;
}
/**
* Detect duplicate tool root entries (same tool + name from multiple sources/domains).
*/
function detectToolRootDuplicates(entries) {
	const byKey = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		const key = `${entry.toolName}/${entry.name}`;
		const group = byKey.get(key) ?? [];
		group.push(entry);
		byKey.set(key, group);
	}
	const duplicates = [];
	for (const [, group] of byKey) if (group.length > 1) duplicates.push({
		toolName: group[0].toolName,
		name: group[0].name,
		paths: group.map((e) => e.absolutePath)
	});
	return duplicates;
}
//#endregion
//#region src/lib/sync.ts
/**
* Compute the destination path for a feature inside a tool's folder.
* For folder-based features: returns the folder path.
* For file-based features: returns the file path.
*/
function featureDestPath(repoRoot, toolFolder, featureType, featureName) {
	return join(repoRoot, toolFolder, featureType, featureName);
}
/**
* Check whether a folder-based feature destination conflicts with existing user content.
* Returns `true` when the folder exists and is not tracked in the manifest.
*/
async function checkFolderConflict(featureTypeDir, folderName) {
	if (!await dirExists(join(featureTypeDir, folderName))) return false;
	return !(await readManifest(featureTypeDir)).includes(folderName + "/");
}
/**
* Check whether a file-based feature destination conflicts with existing user content.
* Returns `true` when the file exists and is not tracked in the manifest.
*/
async function checkFileConflict(featureTypeDir, fileName) {
	if (!await fileExists(join(featureTypeDir, fileName))) return false;
	return !(await readManifest(featureTypeDir)).includes(fileName);
}
/**
* Check whether a feature destination conflicts with existing user content.
* Handles both folder-based and file-based features.
*/
async function checkPathConflict(featureTypeDir, featureName, isFile) {
	if (isFile) return checkFileConflict(featureTypeDir, featureName);
	else return checkFolderConflict(featureTypeDir, featureName);
}
/**
* Sync a folder-based feature: clear destination, copy files, add to manifest.
*/
async function syncFolderFeature(sourcePath, featureTypeDir, folderName) {
	const destPath = join(featureTypeDir, folderName);
	const existed = await dirExists(destPath);
	if (existed) await removeDir(destPath);
	await mkdir(destPath, { recursive: true });
	await copyDirContents(sourcePath, destPath);
	await addToManifest(featureTypeDir, folderName + "/");
	return existed ? "updated" : "created";
}
/**
* Sync a file-based feature: copy file, add to manifest.
*/
async function syncFileFeature(sourcePath, featureTypeDir, fileName) {
	const destPath = join(featureTypeDir, fileName);
	const existed = await fileExists(destPath);
	await mkdir(featureTypeDir, { recursive: true });
	await copyFile(sourcePath, destPath);
	await addToManifest(featureTypeDir, fileName);
	return existed ? "updated" : "created";
}
async function removeEmptyParents(dirPath, stopAt) {
	let current = dirPath;
	while (current !== stopAt && current.startsWith(stopAt)) try {
		if ((await readdir(current)).length > 0) break;
		await rmdir(current);
		current = dirname(current);
	} catch {
		break;
	}
}
/**
* Recursively collect all managed entries (files and folders) from manifests.
* Scans for .agentbridge files and reads their contents.
*/
async function collectManagedEntries(dir) {
	if (!await dirExists(dir)) return [];
	const result = [];
	const entries = await readdir(dir, { withFileTypes: true });
	const manifestEntries = await readManifest(dir);
	for (const entry of manifestEntries) {
		const isFolder = isManifestFolder(entry);
		const name = manifestEntryName(entry);
		result.push({
			path: join(dir, name),
			manifestDir: dir,
			manifestEntry: entry,
			isFolder
		});
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (entry.name === ".agentbridge") continue;
		const sub = await collectManagedEntries(join(dir, entry.name));
		result.push(...sub);
	}
	return result;
}
async function reconcileFeatures(repoRoot, config, features) {
	let added = 0;
	let updated = 0;
	let removed = 0;
	const errors = [];
	const expectedFeatures = /* @__PURE__ */ new Map();
	for (const tool of config.tools) for (const feature of features) {
		if (!featureMatchesTool(feature, tool.name)) continue;
		const name = featureName(feature);
		const featureTypeDir = join(repoRoot, tool.folder, feature.displayType);
		const destPath = join(featureTypeDir, name);
		const manifestEntry = feature.isFile ? name : name + "/";
		expectedFeatures.set(destPath, {
			sourcePath: feature.absolutePath,
			featureTypeDir,
			name,
			manifestEntry,
			isFile: feature.isFile
		});
	}
	for (const tool of config.tools) {
		const toolDir = join(repoRoot, tool.folder);
		const managedEntries = await collectManagedEntries(toolDir);
		for (const entry of managedEntries) {
			if (expectedFeatures.has(entry.path)) continue;
			try {
				if (entry.isFolder) await removeDir(entry.path);
				else await removeFile(entry.path);
				await removeFromManifest(entry.manifestDir, entry.manifestEntry);
				await removeEmptyParents(entry.manifestDir, toolDir);
				removed++;
			} catch (err) {
				errors.push({
					path: entry.path,
					error: err instanceof Error ? err.message : String(err)
				});
			}
		}
	}
	for (const [destPath, expected] of expectedFeatures) try {
		const result = expected.isFile ? await syncFileFeature(expected.sourcePath, expected.featureTypeDir, expected.name) : await syncFolderFeature(expected.sourcePath, expected.featureTypeDir, expected.name);
		if (result === "created") added++;
		else if (result === "updated") updated++;
	} catch (err) {
		errors.push({
			path: destPath,
			error: err instanceof Error ? err.message : String(err)
		});
	}
	return {
		added,
		updated,
		removed,
		errors
	};
}
const ROOT_FILE_MARKER = "<!-- Managed by Agent Bridge -->";
/**
* Check if a root file at `destPath` is managed by Agent Bridge.
* A file is managed if it starts with the marker comment.
*/
async function isRootFileManaged(destPath) {
	if (!await fileExists(destPath)) return false;
	return (await readFile(destPath, "utf-8")).startsWith(ROOT_FILE_MARKER);
}
/**
* Sync root files: copy source root files to the workspace root, and clean up
* managed root files that are no longer provided by any source.
*/
async function syncRootFiles(repoRoot, rootFiles) {
	const synced = [];
	const removed = [];
	const errors = [];
	const expected = /* @__PURE__ */ new Map();
	for (const rf of rootFiles) expected.set(rf.fileName, rf);
	for (const [fileName, rf] of expected) {
		const destPath = join(repoRoot, fileName);
		try {
			if (await fileExists(destPath)) {
				if (!await isRootFileManaged(destPath)) continue;
			}
			const sourceContent = await readFile(rf.absolutePath, "utf-8");
			const managedContent = ROOT_FILE_MARKER + "\n" + sourceContent;
			await mkdir(dirname(destPath), { recursive: true });
			await writeFile(destPath, managedContent, "utf-8");
			synced.push(fileName);
		} catch (err) {
			errors.push({
				path: destPath,
				error: err instanceof Error ? err.message : String(err)
			});
		}
	}
	for (const fileName of ROOT_FILES) {
		if (expected.has(fileName)) continue;
		const destPath = join(repoRoot, fileName);
		try {
			if (await isRootFileManaged(destPath)) {
				await removeFile(destPath);
				removed.push(fileName);
			}
		} catch (err) {
			errors.push({
				path: destPath,
				error: err instanceof Error ? err.message : String(err)
			});
		}
	}
	return {
		synced,
		removed,
		errors
	};
}
/**
* Reconcile tool root entries: sync expected entries and remove orphans.
* Tool-prefixed flat files (e.g. `cursor--settings.json`) are copied directly
* into the tool's root folder (e.g. `.cursor/settings.json`).
*/
async function reconcileToolRootEntries(repoRoot, config, entries) {
	let added = 0;
	let updated = 0;
	let removed = 0;
	const errors = [];
	const toolFolders = /* @__PURE__ */ new Map();
	for (const tool of config.tools) toolFolders.set(tool.name, tool.folder);
	const expectedEntries = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		const folder = toolFolders.get(entry.toolName);
		if (!folder) continue;
		const toolDir = join(repoRoot, folder);
		const destPath = join(toolDir, entry.name);
		expectedEntries.set(destPath, {
			sourcePath: entry.absolutePath,
			name: entry.name,
			toolDir
		});
	}
	for (const tool of config.tools) {
		const toolDir = join(repoRoot, tool.folder);
		const manifest = await readManifest(toolDir);
		for (const manifestEntry of manifest) {
			const isFolder = isManifestFolder(manifestEntry);
			const destPath = join(toolDir, manifestEntryName(manifestEntry));
			if (expectedEntries.has(destPath)) continue;
			try {
				if (isFolder) await removeDir(destPath);
				else await removeFile(destPath);
				await removeFromManifest(toolDir, manifestEntry);
				removed++;
			} catch (err) {
				errors.push({
					path: destPath,
					error: err instanceof Error ? err.message : String(err)
				});
			}
		}
	}
	for (const [, expected] of expectedEntries) try {
		const result = await syncFileFeature(expected.sourcePath, expected.toolDir, expected.name);
		if (result === "created") added++;
		else if (result === "updated") updated++;
	} catch (err) {
		errors.push({
			path: join(expected.toolDir, expected.name),
			error: err instanceof Error ? err.message : String(err)
		});
	}
	return {
		added,
		updated,
		removed,
		errors
	};
}
//#endregion
//#region src/commands/sync.ts
async function syncCommand(cwd, _opts) {
	const repoRoot = cwd ?? findRepoRoot();
	p.intro("Agent Bridge Sync");
	const s = p.spinner();
	s.start("Loading configuration…");
	const config = await loadConfig(repoRoot);
	const migrationResult = await runMigrations(repoRoot);
	if (migrationResult) p.log.info(`Config upgraded ${migrationResult.fromVersion} → ${migrationResult.toVersion}` + (migrationResult.applied.length > 0 ? ` (${migrationResult.applied.length} migration(s))` : ""));
	s.stop("Configuration valid");
	s.start("Syncing sources…");
	const sourceResults = await syncAllSources(repoRoot, config);
	const sourceErrors = sourceResults.filter((r) => r.error);
	if (sourceErrors.length > 0) {
		s.stop("Some sources failed");
		for (const err of sourceErrors) p.log.error(`${err.name}: ${err.error}`);
		process.exit(1);
	}
	const staleRemoved = await removeStaleSourceDirs(repoRoot, config);
	if (staleRemoved.length > 0) for (const name of staleRemoved) p.log.info(`Removed stale source: ${name}`);
	for (const r of sourceResults) if (r.action !== "local") p.log.info(`${r.name}: ${r.action}`);
	s.stop("Sources synced");
	s.start("Discovering features…");
	const features = await scanFeatures(repoRoot, config, await discoverFeatureTypes(repoRoot, config));
	const rootFiles = await scanRootFiles(repoRoot, config);
	const toolRootEntries = await scanToolRootEntries(repoRoot, config);
	const duplicates = detectDuplicates(features);
	if (duplicates.length > 0) {
		s.stop("Duplicate features detected");
		for (const dup of duplicates) p.log.error(`Duplicate "${dup.name}" (${dup.type}): ${dup.paths.join(", ")}`);
		process.exit(1);
	}
	const rootDuplicates = detectRootFileDuplicates(rootFiles);
	if (rootDuplicates.length > 0) {
		s.stop("Duplicate root files detected");
		for (const dup of rootDuplicates) p.log.error(`Duplicate "${dup.fileName}": ${dup.paths.join(", ")}`);
		process.exit(1);
	}
	const toolRootDuplicates = detectToolRootDuplicates(toolRootEntries);
	if (toolRootDuplicates.length > 0) {
		s.stop("Duplicate tool root entries detected");
		for (const dup of toolRootDuplicates) p.log.error(`Duplicate "${dup.name}" for tool "${dup.toolName}": ${dup.paths.join(", ")}`);
		process.exit(1);
	}
	s.stop(`${features.length} features found${rootFiles.length > 0 ? `, ${rootFiles.length} root file(s)` : ""}${toolRootEntries.length > 0 ? `, ${toolRootEntries.length} tool root entr${toolRootEntries.length === 1 ? "y" : "ies"}` : ""}`);
	s.start("Checking for path conflicts…");
	const conflicts = [];
	for (const tool of config.tools) for (const feature of features) {
		if (!featureMatchesTool(feature, tool.name)) continue;
		const linkName = featureName(feature);
		const featureTypeDir = join(repoRoot, tool.folder, feature.displayType);
		const dest = featureDestPath(repoRoot, tool.folder, feature.displayType, linkName);
		if (await checkPathConflict(featureTypeDir, linkName, feature.isFile)) conflicts.push(dest);
	}
	if (conflicts.length > 0) {
		s.stop("Path conflicts detected");
		for (const c of conflicts) p.log.error(`Conflict: "${c}" exists as a real file or directory`);
		p.log.info("Remove or rename the conflicting paths, then re-run sync.");
		process.exit(1);
	}
	s.stop("No path conflicts");
	s.start("Reconciling features…");
	const result = await reconcileFeatures(repoRoot, config, features);
	s.stop("Features reconciled");
	p.log.info(`Added: ${result.added}  Updated: ${result.updated}  Removed: ${result.removed}`);
	if (result.errors.length > 0) {
		for (const err of result.errors) p.log.error(`${err.path}: ${err.error}`);
		p.outro(`Sync completed with ${result.errors.length} error(s).`);
		process.exit(1);
	}
	if (rootFiles.length > 0) {
		s.start("Syncing root files…");
		const rootResult = await syncRootFiles(repoRoot, rootFiles);
		for (const name of rootResult.synced) p.log.info(`Root file synced: ${name}`);
		for (const name of rootResult.removed) p.log.info(`Root file removed: ${name}`);
		for (const err of rootResult.errors) p.log.error(`${err.path}: ${err.error}`);
		s.stop("Root files synced");
	} else {
		const rootResult = await syncRootFiles(repoRoot, []);
		for (const name of rootResult.removed) p.log.info(`Root file removed: ${name}`);
	}
	s.start("Syncing tool root entries…");
	const toolRootResult = await reconcileToolRootEntries(repoRoot, config, toolRootEntries);
	if (toolRootResult.added > 0 || toolRootResult.updated > 0 || toolRootResult.removed > 0) p.log.info(`Tool root: Added: ${toolRootResult.added}  Updated: ${toolRootResult.updated}  Removed: ${toolRootResult.removed}`);
	if (toolRootResult.errors.length > 0) {
		for (const err of toolRootResult.errors) p.log.error(`${err.path}: ${err.error}`);
		s.stop("Tool root entries synced with errors");
		p.outro(`Sync completed with ${toolRootResult.errors.length} error(s).`);
		process.exit(1);
	}
	s.stop("Tool root entries synced");
	p.outro("Sync complete.");
}
//#endregion
//#region src/commands/update.ts
async function updateCommand(cwd, _opts) {
	const repoRoot = cwd ?? findRepoRoot();
	p.intro("Agent Bridge — Update Sources");
	const config = await loadConfig(repoRoot);
	const migrationResult = await runMigrations(repoRoot);
	if (migrationResult) p.log.info(`Config upgraded ${migrationResult.fromVersion} → ${migrationResult.toVersion}` + (migrationResult.applied.length > 0 ? ` (${migrationResult.applied.length} migration(s))` : ""));
	const s = p.spinner();
	s.start("Updating all remote sources…");
	const results = await syncAllSources(repoRoot, config);
	s.stop("Update complete");
	for (const r of results) if (r.error) p.log.error(`${r.name}: ${r.error}`);
	else p.log.info(`${r.name}: ${r.action}`);
	const errors = results.filter((r) => r.error);
	if (errors.length > 0) p.outro(`Done with ${errors.length} error(s).`);
	else p.outro("All sources up to date.");
}
//#endregion
//#region src/commands/opt-out.ts
function summarizeTools(config) {
	return config.tools.map((t) => t.name).join(", ");
}
async function optOutCommand(cwd, opts) {
	const repoRoot = cwd ?? findRepoRoot();
	p.intro("Agent Bridge Opt-out");
	const hasConfig = await configExists(repoRoot);
	let config;
	if (hasConfig) config = await loadConfig(repoRoot);
	if (!opts?.force) {
		const toolSummary = config ? summarizeTools(config) : "unknown (no config found)";
		const confirmed = await p.confirm({
			message: `This will remove Agent Bridge managed files for tools: ${toolSummary}, delete Agent Bridge git hooks, and delete .agent-bridge/. Continue?`,
			initialValue: false
		});
		if (p.isCancel(confirmed) || !confirmed) {
			p.cancel("Opt-out cancelled.");
			return;
		}
	}
	const s = p.spinner();
	let featureErrors = 0;
	let toolRootErrors = 0;
	if (config) {
		s.start("Removing synced Agent Bridge files…");
		const featureResult = await reconcileFeatures(repoRoot, config, []);
		const toolRootResult = await reconcileToolRootEntries(repoRoot, config, []);
		featureErrors = featureResult.errors.length;
		toolRootErrors = toolRootResult.errors.length;
		s.stop("Synced files removed");
		p.log.info(`Features removed: ${featureResult.removed} (errors: ${featureErrors})`);
		p.log.info(`Tool-root files removed: ${toolRootResult.removed} (errors: ${toolRootErrors})`);
		p.log.info("Root files are not removed by opt-out (manifest-only cleanup).");
		for (const err of featureResult.errors) p.log.error(`${err.path}: ${err.error}`);
		for (const err of toolRootResult.errors) p.log.error(`${err.path}: ${err.error}`);
	} else p.log.warn("No .agent-bridge/config.yml found. Skipping synced file cleanup.");
	s.start("Removing Agent Bridge git hooks…");
	const removedHooks = isInGitRepo(repoRoot) ? await removeGitHooks(repoRoot) : [];
	s.stop("Hooks cleanup complete");
	if (removedHooks.length > 0) p.log.info(`Removed hooks: ${removedHooks.join(", ")}`);
	else if (isInGitRepo(repoRoot)) p.log.info("No Agent Bridge hooks found.");
	else p.log.info("Not a git repository; hook cleanup skipped.");
	s.start("Removing .agent-bridge directory…");
	const bridgePath = bridgeDir(repoRoot);
	if (await dirExists(bridgePath)) {
		await removeDir(bridgePath);
		s.stop(".agent-bridge removed");
	} else s.stop(".agent-bridge not found");
	const totalErrors = featureErrors + toolRootErrors;
	if (totalErrors > 0) {
		p.outro(`Opt-out completed with ${totalErrors} cleanup error(s).`);
		process.exit(1);
	}
	p.outro("Opt-out complete. Agent Bridge is removed from this repository.");
}
//#endregion
//#region src/index.ts
async function assertCwdExists(cwd) {
	try {
		if (!(await stat(cwd)).isDirectory()) throw new Error(`--cwd path is not a directory: ${cwd}`);
	} catch (err) {
		if (err.code === "ENOENT") throw new Error(`--cwd path does not exist: ${cwd}`);
		throw err;
	}
}
async function withCwdValidation(action) {
	return async (opts) => {
		if (opts.cwd) {
			opts.cwd = resolve(opts.cwd);
			await assertCwdExists(opts.cwd);
		}
		await action(opts.cwd, opts);
	};
}
function collect(value, previous) {
	previous.push(value);
	return previous;
}
const program = new Command().name("agent-bridge").description("Manage AI tool configurations from multiple sources").version(VERSION, "-v, --version");
program.command("init").description("Initialize Agent Bridge (creates .agent-bridge/config.yml)").option("--cwd <path>", "Override the working directory").option("--force", "Overwrite existing non-Agent-Bridge git hooks").option("--domains <list>", "Comma-separated domain list (default: backend,frontend,shared)").option("--tools <list>", "Comma-separated tool names (cursor,vscode,claude) or name:folder pairs").option("-s, --source <url>", "Source URL or path (repeatable, append #branch for branch)", collect, []).option("--hooks", "Auto-install git hooks without prompting").action(await withCwdValidation(initCommand));
program.command("sync").description("Fetch sources, discover features, and sync files").option("--cwd <path>", "Override the working directory").action(await withCwdValidation(syncCommand));
program.command("update").description("Fetch latest changes for all remote sources").option("--cwd <path>", "Override the working directory").action(await withCwdValidation(updateCommand));
program.command("opt-out").description("Remove Agent Bridge hooks, synced files, and .agent-bridge state").option("--cwd <path>", "Override the working directory").option("--force", "Skip confirmation prompt").action(await withCwdValidation(optOutCommand));
program.parse();
//#endregion
export {};

//# sourceMappingURL=index.mjs.map