/**
 * dsh-bash-env — pure environment resolution.
 *
 * Everything in this module is a plain function over plain data: no cordis, no
 * service context, no process state. File contents arrive as strings, so the
 * policy and every diagnostic it can raise are unit-testable without a harness.
 *
 * The rules implement "compute from the workdir": `bash -c` starts in the
 * spec's working directory and dsh starts a fresh shell for every call, so
 * anything that is a pure function of that directory (which venv applies, which
 * PATH entries to add) belongs here rather than in a shell startup file.
 *
 * @module dsh-bash-env/resolve
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** POSIX PATH separator; this executor is gated to non-Windows hosts. */
const PATH_SEPARATOR = ':'

/** Directory names searched for a virtual environment, nearest-first. */
const DEFAULT_VENV_NAMES = ['.venv', 'venv']

/** How many directory levels above the workdir are searched for a venv. */
const DEFAULT_VENV_MAX_DEPTH = 3

/** Environment-variable names an env file may define. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Namespace the harness manages; configuration must not claim it. */
const MANAGED_ENV_PREFIX = 'DSH_'

/** `$NAME` and `${NAME}` references, the two forms a shell accepts. */
const EXPANSION = /\$(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/g

/** How far a typo may be from a real option and still get a suggestion. */
const SUGGESTION_DISTANCE = 2

/**
 * Whether one directory is a usable virtual environment.
 *
 * The interpreter is the acceptance test rather than `pyvenv.cfg`: a directory
 * that has the config but no interpreter cannot run anything, and a directory
 * that has the interpreter is usable regardless of which tool created it.
 *
 * @param root - candidate virtual-environment root.
 * @returns true when `<root>/bin/python` exists.
 */
export function isUsableVenv(root) {
	return typeof root === 'string' && root.length > 0 && existsSync(join(root, 'bin', 'python'))
}

/**
 * Find the nearest usable virtual environment at or above a working directory.
 *
 * The search starts at `workdir` itself, so a venv created inside it wins over
 * one in a parent. Two bounds keep the walk from picking up an unrelated
 * environment: `maxDepth` limits how far it ascends, and `stopAt` names a
 * directory that is not searched at all.
 *
 * `stopAt` defaults to the home directory so a venv that happens to live at
 * `~/.venv` is never chosen implicitly — for a workspace anywhere under the
 * home tree, `maxDepth` alone would reach it and silently activate a global
 * environment for every project. A home-level venv has to be asked for, through
 * `venv.fallback`, which keeps that decision visible in the configuration.
 *
 * @param options - search settings.
 * @param options.workdir - directory the shell will start in.
 * @param options.names - candidate directory names, tried in order per level.
 * @param options.maxDepth - maximum number of parent levels to ascend.
 * @param options.stopAt - absolute directory that is never searched.
 * @returns the absolute venv root, or `undefined` when none is found.
 */
export function findVenv({
	workdir,
	names = DEFAULT_VENV_NAMES,
	maxDepth = DEFAULT_VENV_MAX_DEPTH,
	stopAt = homedir(),
}) {
	const boundary = typeof stopAt === 'string' && stopAt.length > 0 ? resolve(stopAt) : undefined
	let dir = resolve(workdir)
	for (let depth = 0; depth <= maxDepth; depth += 1) {
		if (dir === boundary) break
		for (const name of names) {
			const candidate = join(dir, name)
			if (isUsableVenv(candidate)) return candidate
		}
		const parent = dirname(dir)
		// At the filesystem root `dirname` returns the same path; stop instead of
		// looping, so a workdir with no ancestors terminates.
		if (parent === dir) break
		dir = parent
	}
	return undefined
}

/**
 * Build a PATH value from prepended entries over a base value.
 *
 * First occurrence wins, which is what makes the overlay idempotent: entries
 * already present in the base keep their original position instead of being
 * duplicated, so a nested shell re-resolving the same environment cannot grow
 * the value.
 *
 * @param prepend - entries to place first, in order.
 * @param base - the PATH the child would otherwise receive.
 * @returns the composed PATH.
 */
export function composePath(prepend, base) {
	const seen = new Set()
	const parts = []
	const candidates = [...prepend, ...String(base ?? '').split(PATH_SEPARATOR)]
	for (const candidate of candidates) {
		if (typeof candidate !== 'string' || candidate.length === 0) continue
		if (seen.has(candidate)) continue
		seen.add(candidate)
		parts.push(candidate)
	}
	return parts.join(PATH_SEPARATOR)
}

/**
 * Expand `$NAME` and `${NAME}` references against an environment.
 *
 * An unknown name expands to the empty string, matching shell behaviour, so a
 * line like `PATH=$PATH:$HOME/bin` works whether or not the referenced variable
 * happens to be set.
 *
 * @param value - raw value text.
 * @param environment - values to expand against.
 * @returns the expanded value.
 */
export function expandEnvValue(value, environment = {}) {
	return String(value).replace(EXPANSION, (_match, reference) => {
		const name = reference.startsWith('{') ? reference.slice(1, -1) : reference
		return environment[name] ?? ''
	})
}

/**
 * Read one `=`: the value is everything after the first one.
 *
 * Single quotes make a value literal, double quotes and bare text both expand —
 * the same distinction a shell makes, so a value containing `$` has an escape
 * hatch.
 *
 * @param raw - the text after the first `=`, already trimmed.
 * @param environment - values to expand against.
 * @returns the resolved value.
 */
function parseEnvValue(raw, environment) {
	if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1)
	if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return expandEnvValue(raw.slice(1, -1), environment)
	return expandEnvValue(raw, environment)
}

/**
 * Parse one `KEY=VALUE` per line, the format a hand-edited environment file uses.
 *
 * Blank lines and `#` comments are skipped; a leading `export ` is accepted so a
 * line can be pasted from a shell startup file unchanged. Values expand against
 * the supplied environment plus the entries parsed so far, so a later line can
 * reference an earlier one exactly as a shell would.
 *
 * Problems are returned rather than thrown so the caller decides how loudly to
 * report them; each one is prefixed with its line number.
 *
 * @param content - the file's text.
 * @param environment - the environment values expand against.
 * @returns the parsed values and one message per unusable line.
 */
export function parseEnvFile(content, environment = {}) {
	const values = {}
	const problems = []
	const lines = String(content).split(/\r?\n/)
	for (const [index, raw] of lines.entries()) {
		const line = index + 1
		const trimmed = raw.trim()
		if (trimmed.length === 0 || trimmed.startsWith('#')) continue
		const body = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed
		const equals = body.indexOf('=')
		if (equals === -1) {
			problems.push(`${line}: expected KEY=VALUE, got ${JSON.stringify(trimmed)}`)
			continue
		}
		const name = body.slice(0, equals).trim()
		if (!ENV_NAME.test(name)) {
			problems.push(`${line}: ${JSON.stringify(name)} is not a valid environment variable name`)
			continue
		}
		values[name] = parseEnvValue(body.slice(equals + 1).trim(), { ...environment, ...values })
	}
	return { values, problems }
}

/**
 * Environment names that would shadow a harness-managed fact.
 *
 * @param names - candidate names.
 * @returns the offending names, in input order.
 */
export function findManagedEnvNames(names) {
	return [...names].filter((name) => String(name).toUpperCase().startsWith(MANAGED_ENV_PREFIX))
}

/**
 * Levenshtein distance, two rows at a time.
 *
 * @param left - first string.
 * @param right - second string.
 * @returns the edit distance.
 */
function editDistance(left, right) {
	const previous = Array.from({ length: right.length + 1 }, (_value, index) => index)
	for (let i = 1; i <= left.length; i += 1) {
		let diagonal = previous[0]
		previous[0] = i
		for (let j = 1; j <= right.length; j += 1) {
			const carried = previous[j]
			const substitute = diagonal + (left[i - 1] === right[j - 1] ? 0 : 1)
			previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, substitute)
			diagonal = carried
		}
	}
	return previous[right.length]
}

/**
 * The closest known option to a mistyped one, when it is close enough to help.
 *
 * @param name - the name the user wrote.
 * @param candidates - the options that exist at that position.
 * @returns the suggestion, or `undefined` when nothing is near enough.
 */
export function suggestConfigKey(name, candidates) {
	let best
	let bestDistance = SUGGESTION_DISTANCE + 1
	for (const candidate of candidates) {
		const distance = editDistance(String(name).toLowerCase(), String(candidate).toLowerCase())
		if (distance < bestDistance) {
			best = candidate
			bestDistance = distance
		}
	}
	return bestDistance <= SUGGESTION_DISTANCE ? best : undefined
}

/**
 * Collect configuration keys the schema does not define, at any depth.
 *
 * Unknown keys are otherwise invisible: the schema validator ignores them, so a
 * mistyped option looks applied while doing nothing. Deriving the known keys
 * from the live schema keeps this check from drifting away from the options the
 * plugin actually reads.
 *
 * `openPaths` names positions that legitimately accept arbitrary keys (a
 * user-defined variable map, for example), where every key is a value rather
 * than an option.
 *
 * @param schema - the schemastery schema for the value.
 * @param value - the resolved configuration.
 * @param options - check settings.
 * @param options.openPaths - dotted `$.a.b` paths whose keys are free-form.
 * @returns one entry per unknown key, with the candidates at that position.
 */
export function findUnknownConfigKeys(schema, value, options = {}) {
	const open = new Set(options.openPaths ?? [])
	const walk = (current, node, path) => {
		if (open.has(path)) return []
		const dict = current?.dict
		if (dict === undefined || node === null || typeof node !== 'object' || Array.isArray(node)) return []
		const unknown = []
		for (const [key, child] of Object.entries(node)) {
			const childPath = `${path}.${key}`
			if (!Object.hasOwn(dict, key)) {
				unknown.push({ path: childPath, key, candidates: Object.keys(dict) })
				continue
			}
			unknown.push(...walk(dict[key], child, childPath))
		}
		return unknown
	}
	return walk(schema, value, '$')
}

/**
 * Render unknown-key findings as one message in the schema validator's idiom.
 *
 * @param unknown - findings from {@link findUnknownConfigKeys}.
 * @returns the formatted message.
 */
export function formatUnknownConfigKeys(unknown) {
	const lines = unknown.map((finding) => {
		const suggestion = suggestConfigKey(finding.key, finding.candidates)
		return `  - ${finding.path} is not a known option${suggestion === undefined ? '' : `; did you mean "${suggestion}"?`}`
	})
	return `invalid config:\n${lines.join('\n')}`
}

/**
 * Resolve the environment overlay for one shell execution.
 *
 * Configuration is flat — one top-level key per knob — because the Web UI's
 * settings form addresses scalar fields by a single-segment path, so a nested
 * block could not be edited from the browser at all.
 *
 * Ordering is the contract. `PATH` is built as:
 *
 *     <venv>/bin : prependPath... : <mise shims> : the base PATH
 *
 * A detected venv precedes every configured entry, so an activated venv wins
 * over a version manager that also ships a `python`/`python3` shim; getting this
 * backwards produces the silent failure this plugin exists to prevent —
 * `VIRTUAL_ENV` pointing at one environment while the resolved interpreter comes
 * from another.
 *
 * `envVars` and `envFile` are applied last, so an explicit variable always wins
 * over a value a feature supplied. A user-supplied `PATH` becomes the base the
 * prepended entries are composed over rather than replacing them.
 *
 * `bashEnv` is handed to bash as `BASH_ENV`, which bash sources before running
 * the command. Because that happens after this overlay is applied, the file can
 * override anything set here — the intended semantics for a startup file, and
 * the reason it is worth keeping small.
 *
 * @param options - resolution inputs.
 * @param options.workdir - directory the shell will start in.
 * @param options.inherited - the environment the child would otherwise receive.
 * @param options.config - the plugin's resolved configuration.
 * @param options.config.prependPath - directories to place before the base PATH.
 * @param options.config.envVars - inline variables, applied over the file's.
 * @param options.config.envFile - path the variables came from, for diagnostics.
 * @param options.config.venvEnabled - whether to search for a venv at all.
 * @param options.config.venvNames - candidate directory names.
 * @param options.config.venvMaxDepth - how far above the workdir to search.
 * @param options.config.venvStopAt - directory the search never enters.
 * @param options.config.venvFallback - venv used when the workdir search misses.
 * @param options.config.miseEnabled - whether mise support applies at all.
 * @param options.config.miseShims - shim directory placed on PATH.
 * @param options.config.miseAutoInstall - true leaves mise's auto-install settings alone.
 * @param options.config.bashEnv - absolute path sourced by every non-interactive shell.
 * @param options.envFile - the env file's text and path, already read.
 * @param options.miseEnv - the mise resolution for this workdir, when hook-env is enabled.
 * @returns the environment entries to overlay on the child environment.
 * @throws when the env file has an unusable line or claims a managed name.
 */
export function resolveShellEnv({ workdir, inherited = {}, config = {}, envFile, miseEnv }) {
	const env = {}
	const prepend = []
	/** The PATH the prepended entries are composed over. */
	let basePath = inherited.PATH

	if (config.venvEnabled !== false) {
		const found = findVenv({
			workdir,
			names: config.venvNames ?? DEFAULT_VENV_NAMES,
			maxDepth: config.venvMaxDepth ?? DEFAULT_VENV_MAX_DEPTH,
			stopAt: config.venvStopAt ?? homedir(),
		})
		const fallback = typeof config.venvFallback === 'string' && config.venvFallback.length > 0
			? config.venvFallback
			: undefined
		const venv = found ?? (fallback !== undefined && isUsableVenv(fallback) ? fallback : undefined)
		if (venv !== undefined) {
			env.VIRTUAL_ENV = venv
			prepend.push(join(venv, 'bin'))
		}
	}

	for (const dir of config.prependPath ?? []) {
		if (typeof dir === 'string' && dir.length > 0) prepend.push(dir)
	}

	// A startup file for every non-interactive shell. This is the only mechanism
	// that can define shell *functions* — aliases do not expand in a non-interactive
	// shell at all — so it stays a deliberate opt-in rather than something the
	// plugin supplies. It is sourced after the environment above is assembled, so
	// the file has the last word on PATH and on anything else it exports.
	if (typeof config.bashEnv === 'string' && config.bashEnv.length > 0) env.BASH_ENV = config.bashEnv

	if (config.miseEnabled !== false) {
		const hook = miseEnv?.kind === 'hook-env' ? miseEnv.vars : undefined
		if (hook !== undefined) {
			// `hook-env` answers what shims cannot — JAVA_HOME, GOROOT, GOBIN and any
			// `[env]` section — for one directory, once, and its PATH already carries
			// the resolved tool directories. Prepending the shims as well would put the
			// per-invocation cost back that this just removed.
			env.DSH_MISE = 'hook-env'
			for (const [key, value] of Object.entries(hook)) if (key !== 'PATH') env[key] = value
			basePath = hook.PATH ?? inherited.PATH
		} else {
			// Shims — or the fallback when hook-env was asked for and could not answer.
			env.DSH_MISE = miseEnv === undefined ? 'shims' : 'shims-fallback'
			const shims = typeof config.miseShims === 'string' && config.miseShims.length > 0 ? config.miseShims : undefined
			if (shims !== undefined) prepend.push(shims)
		}
		// A bare `node -v` inside a project that pins an uninstalled tool version
		// otherwise starts a silent mise download and can hang the command until the
		// tool timeout. Opting out by default keeps that a deliberate act; an explicit
		// variable still wins, because these land before the user's.
		if (config.miseAutoInstall !== true) {
			env.MISE_AUTO_INSTALL = 'false'
			env.MISE_NOT_FOUND_AUTO_INSTALL = 'false'
		}
	}

	const fileValues = {}
	if (envFile !== undefined) {
		const parsed = parseEnvFile(envFile.content, inherited)
		if (parsed.problems.length > 0) {
			throw new Error(`dsh-bash-env: ${envFile.path} has ${parsed.problems.length} unusable line(s):\n${parsed.problems.map((problem) => `  - ${problem}`).join('\n')}`)
		}
		Object.assign(fileValues, parsed.values)
	}
	const inlineValues = {}
	for (const [name, value] of Object.entries(config.envVars ?? {})) {
		inlineValues[name] = expandEnvValue(value, { ...inherited, ...fileValues, ...inlineValues })
	}

	const userEnv = { ...fileValues, ...inlineValues }
	const invalid = Object.keys(inlineValues).filter((key) => !ENV_NAME.test(key))
	if (invalid.length > 0) {
		throw new Error(`dsh-bash-env: envVars has invalid name(s): ${invalid.join(', ')}`)
	}
	const managed = findManagedEnvNames(Object.keys(userEnv))
	if (managed.length > 0) {
		throw new Error(`dsh-bash-env: env must not define harness-managed names: ${managed.join(', ')}`)
	}
	Object.assign(env, userEnv)

	const path = composePath(prepend, userEnv.PATH ?? basePath)
	if (path.length > 0) env.PATH = path

	return env
}
