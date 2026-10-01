/**
 * dsh-bash-env — host half.
 *
 * Replaces the built-in bash executor with a subclass that resolves one extra
 * environment overlay per command from the execution's own working directory.
 * Mounting is the whole mechanism: the model-facing `bash` tool, jobs, output
 * caps, deadlines and sandboxing are untouched, because every one of them is
 * inherited from the executor this class extends.
 *
 * Why subclass the sandbox executor and not the local one: `dsh-bash-sandbox`
 * is what the shipped profile mounts, and it is what applies the session's
 * file policy. Extending `dsh-bash-local` instead would silently drop that
 * confinement, so this plugin extends the confining executor and lets it fall
 * through to the local mechanics.
 *
 * Configuration mistakes are reported from {@link BashEnvExecutor#spawnSpec}
 * rather than from the constructor. A diagnostic has to be visible to be worth
 * anything, and in a headless composition `ctx.logger` output goes nowhere; the
 * command's own error is the one channel a user reliably sees. Failing a
 * command keeps the executor mounted, so the fix — edit the config, no restart —
 * stays reachable. Only a schema type error still fails the mount, because that
 * is where the schema validator raises it.
 *
 * @module dsh-bash-env
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import z from '@deepseek-ai/schemastery'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

import { createMiseEnvResolver, DEFAULT_TIMEOUT_MS } from './mise.js'
import { findUnknownConfigKeys, formatUnknownConfigKeys, resolveShellEnv } from './resolve.js'

/** Plugin name, used by the loader's diagnostics and by the settings UI. */
const name = 'dsh-bash-env'

/** Positions whose keys are user data rather than options. */
const OPEN_CONFIG_PATHS = ['$.envVars']

/**
 * The default mise shim directory.
 *
 * `mise activate` is an interactive-shell hook and cannot work here, but the
 * shim directory can: each shim resolves the tool version for the current
 * directory when it is invoked, which is exactly the per-workdir behaviour a
 * fresh shell per command needs.
 */
const DEFAULT_MISE_SHIMS = join(homedir(), '.local/share/mise/shims')

/**
 * Plugin configuration: the built-in executor's budgets plus one key per knob.
 *
 * Every field is `.volatile()`, and that is a hard requirement rather than a
 * detail. The settings service refuses a write whose path is not volatile
 * (`Config field "x" is not volatile`), so a field declared without it renders in
 * the Web UI and then fails to save — every time, across restarts, with no
 * explanation. Volatility is also the honest description here: each value is
 * sampled when resolving a command, so changing one applies to the next command
 * without reloading the plugin.
 *
 * The shape is deliberately flat. The Web UI's settings form addresses scalar
 * fields by a single-segment path inside the entry's namespace, so a nested
 * block (`venv: { enabled }`) could not be edited from the browser at all; one
 * top-level key per setting is what makes every knob reachable from the UI.
 *
 * `LocalBashExecutor.Config.dict` is spread first so every budget field (and its
 * default) keeps its single definition upstream, and a schema change there
 * reaches this plugin without an edit. Defaults live in the schema, not in code,
 * so `dsh --dump-config-schema` shows them and the settings page can render an
 * accurate placeholder.
 */
const Config = z.object({
	...LocalBashExecutor.Config.dict,
	/** Directories placed before the rest of PATH, in order. One per line in the UI. */
	prependPath: z.array(z.string()).default([]).volatile(),
	/** A `KEY=VALUE`-per-line file, re-read on every command. */
	envFile: z.string().default('').volatile(),
	/** Inline `NAME: value` pairs, applied over the file's. */
	envVars: z.dict(z.string()).default({}).volatile(),
	/** Absolute path to a startup file bash sources before every non-interactive command. */
	bashEnv: z.string().default('').volatile(),
	/** Whether to look for a Python virtual environment at all. */
	venvEnabled: z.boolean().default(true).volatile(),
	/** Candidate directory names, tried nearest-first at each level. */
	venvNames: z.array(z.string()).default(['.venv', 'venv']).volatile(),
	/** How many levels above the workdir to search. */
	venvMaxDepth: z.number().default(3).volatile(),
	/** Directory the search never enters; the home venv is not implicit. */
	venvStopAt: z.string().default(homedir()).volatile(),
	/** Venv used when the workdir search misses; inactive while unusable. */
	venvFallback: z.string().default('').volatile(),
	/** Whether mise support applies at all. */
	miseEnabled: z.boolean().default(true).volatile(),
	/** Shim directory placed on PATH ahead of the base entries. */
	miseShims: z.string().default(DEFAULT_MISE_SHIMS).volatile(),
	/** True leaves mise's own auto-install settings alone. */
	miseAutoInstall: z.boolean().default(false).volatile(),
	/**
	 * Ask mise what a directory resolves to, instead of only putting its shims on
	 * PATH. Off by default: the answer covers a project's own `[env]` section, so a
	 * file in the repository can set variables for every command run there.
	 */
	miseHookEnv: z.boolean().default(false).volatile(),
	/** The mise executable; empty resolves `mise` through PATH. */
	miseBin: z.string().default('').volatile(),
})

/** Env-file reads, keyed by path and validated against mtime and size. */
const envFileCache = new Map()

/**
 * Read an env file, reusing the last read while the file is unchanged.
 *
 * The file is read per command rather than at mount so an edit takes effect on
 * the next command with no reload; the cache keeps that from costing a parse on
 * every spawn.
 *
 * @param path - absolute file path.
 * @returns the file's text.
 * @throws when the file cannot be read.
 */
function readEnvFile(path) {
	const stat = statSync(path)
	const cached = envFileCache.get(path)
	if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.content
	const content = readFileSync(path, 'utf8')
	envFileCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, content })
	return content
}

/**
 * Read one resolved configuration value.
 *
 * A `.volatile()` field resolves to an accessor the settings service can repoint
 * at runtime, not to a plain value — which is why the built-in executor reads
 * `this.config.timeoutMs.get()`. Reading such a field as a plain property yields
 * the accessor itself, and an array field then fails every `for…of` with
 * "object is not iterable", so every read goes through here.
 *
 * @param field - the resolved field: an accessor or a plain value.
 * @param fallback - value used when the field is absent.
 * @returns the field's current value.
 */
function configValue(field, fallback) {
	if (field === undefined || field === null) return fallback
	return typeof field.get === 'function' ? field.get() : field
}

/**
 * Snapshot every configured value as a plain object for one spawn.
 *
 * Sampled per spawn rather than once at mount, because that is what volatility
 * buys: a write from the settings page is visible to the next command.
 *
 * @param config - the resolved configuration.
 * @returns plain values under the same keys.
 */
function plainConfig(config) {
	const plain = {}
	for (const [key, value] of Object.entries(config ?? {})) plain[key] = configValue(value)
	return plain
}

/**
 * Ask mise what one directory resolves to.
 *
 * Auto-install is switched off for the probe. Without that, a project pinning a
 * version that is not installed makes mise start a download while the command
 * waits — which is exactly what happened the first time this was measured. The
 * probe also carries a timeout, because the executor resolves its environment
 * before spawning, so this delay is the command's own.
 *
 * @param bin - the mise executable, or a bare name resolved on PATH.
 * @param workdir - the directory to resolve for.
 * @param timeoutMs - bound on the probe.
 * @returns the spawn outcome; every failure mode is classified by the resolver.
 */
function runMiseHookEnv(bin, workdir, timeoutMs) {
	return spawnSync(bin, ['hook-env', '-s', 'bash', '-q', '-C', workdir], {
		timeout: timeoutMs,
		encoding: 'utf8',
		env: {
			...scrubbedParentEnv(),
			MISE_AUTO_INSTALL: 'false',
			MISE_NOT_FOUND_AUTO_INSTALL: 'false',
		},
	})
}

/**
 * Bash executor that overlays a workdir-resolved environment on every spawn.
 *
 * Registers as `ctx.shell` (inherited from {@link SandboxBashExecutor}), so the
 * built-in executor row must be disabled by the bundle patch before this mounts.
 */
const BashEnvExecutor = class BashEnvExecutor extends SandboxBashExecutor {
	static inject = ['subprocess', 'sandbox', 'sandboxPolicy']

	static Config = Config

	constructor(ctx, config) {
		super(ctx, config)
		this.bashEnvConfig = config ?? {}
		// Computed once: the configuration cannot change without the loader
		// re-instantiating this plugin, and the check is re-raised per command.
		this.configProblems = findUnknownConfigKeys(Config, this.bashEnvConfig, { openPaths: OPEN_CONFIG_PATHS })
		// `miseBin` is read through a getter so repointing it takes effect without a
		// reload; the cache inside the resolver survives either way.
		this.miseResolver = createMiseEnvResolver({
			bin: () => configValue(this.bashEnvConfig.miseBin, '') || 'mise',
			run: runMiseHookEnv,
			timeoutMs: DEFAULT_TIMEOUT_MS,
		})
	}

	/**
	 * Read and validate the configured env file for one spawn.
	 *
	 * @param config - the spawn's plain configuration.
	 * @returns the file's text and path, or `undefined` when none is configured.
	 * @throws when the file is configured but cannot be used.
	 */
	envFileForSpawn(config) {
		const path = config.envFile
		if (typeof path !== 'string' || path.length === 0) return undefined
		try {
			return { path, content: readEnvFile(path) }
		} catch (error) {
			throw new Error(`dsh-bash-env: cannot read envFile ${JSON.stringify(path)}: ${error.message}`)
		}
	}

	/**
	 * Validate the configured `BASH_ENV` file for one spawn.
	 *
	 * The check exists because bash *silently ignores* a `BASH_ENV` that does not
	 * name a readable file: the variable would look set while nothing ran, which is
	 * exactly the class of invisible failure this plugin removes everywhere else.
	 * A relative path is refused too, since bash opens the value as a filename
	 * rather than searching PATH, so it would resolve against each command's own
	 * working directory.
	 *
	 * @param config - the spawn's plain configuration.
	 * @throws when the configured path is not usable.
	 */
	assertBashEnvUsable(config) {
		const path = config.bashEnv
		if (typeof path !== 'string' || path.length === 0) return
		if (!isAbsolute(path)) throw new Error(`dsh-bash-env: bashEnv must be an absolute path, got ${JSON.stringify(path)}`)
		let stat
		try {
			stat = statSync(path)
		} catch (error) {
			throw new Error(`dsh-bash-env: cannot read bashEnv ${JSON.stringify(path)}: ${error.message}`)
		}
		if (!stat.isFile()) throw new Error(`dsh-bash-env: bashEnv ${JSON.stringify(path)} is not a file`)
	}

	/**
	 * Attach the resolved environment to one spawn.
	 *
	 * Every command reaches the subprocess through here — foreground and
	 * background, confined and full-access — so this is the single injection
	 * point, and the executor's terminal overrides and managed `DSH_*` facts
	 * stay authoritative: the overlay lands on top of them, then `spec.dshEnv`
	 * is re-applied so a configured variable can never shadow a managed fact.
	 *
	 * The inherited side has to be reconstructed rather than read from
	 * `base.env`: that layer holds only the executor's own overrides (terminal
	 * settings, managed `DSH_*` facts) and no `PATH`, because the inherited
	 * environment lives in the subprocess seam and is merged there. Composing
	 * this overlay from `base.env` alone would set `PATH` to just the prepended
	 * entries and make the spawn of `bash` itself fail with `ENOENT`.
	 *
	 * @param spec - the resolved execution spec.
	 * @param argv - the exact argv to spawn.
	 * @param stdoutMaxBytes - per-call stdout capture budget.
	 * @param signal - cancellation fused with the deadline.
	 * @returns the subprocess spawn spec with the environment overlay applied.
	 * @throws when the configuration or the env file cannot be used.
	 */
	spawnSpec(spec, argv, stdoutMaxBytes, signal) {
		if (this.configProblems.length > 0) throw new Error(formatUnknownConfigKeys(this.configProblems))
		// Volatile fields are accessors; resolve them once per spawn so a settings
		// write is visible to the very next command.
		const config = plainConfig(this.bashEnvConfig)
		this.assertBashEnvUsable(config)
		// Only consulted when asked for: the probe costs a synchronous ~20 ms on a
		// cache miss, and its answer includes a project's own `[env]` section.
		const miseEnv = config.miseEnabled === false || config.miseHookEnv !== true
			? undefined
			: this.miseResolver.resolve(spec.workdir)
		const base = super.spawnSpec(spec, argv, stdoutMaxBytes, signal)
		const overlay = resolveShellEnv({
			workdir: spec.workdir,
			// The same base the child would start from: the seam's scrubbed
			// parent environment, with this executor's overrides on top.
			inherited: { ...scrubbedParentEnv(), ...base.env },
			config,
			miseEnv,
			envFile: this.envFileForSpawn(config),
		})
		return {
			...base,
			env: {
				...base.env,
				...overlay,
				...spec.dshEnv,
			},
		}
	}
}

export { BashEnvExecutor, Config, configValue, name, plainConfig, BashEnvExecutor as default }
