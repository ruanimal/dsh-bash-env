/**
 * dsh-bash-env — mise integration.
 *
 * The shim directory answers "which executable", which covers most of what a
 * toolchain needs. It cannot answer "which JAVA_HOME", because that is not a
 * file to run but a variable a build tool reads. `mise hook-env` does answer it:
 * it prints the variables mise resolves for one directory, including the derived
 * ones (`JAVA_HOME`, `GOROOT`, `GOBIN`) and any `[env]` section.
 *
 * It is not free — a measured ~20 ms per call, against ~30 ms for a single shim
 * invocation — so it runs once per directory and is cached against a fingerprint
 * of the mise configuration that applies there. That trade is the reason this
 * module exists rather than a one-line `spawnSync` in the executor: a command
 * that calls three tools pays 90 ms through shims and nothing here.
 *
 * Two properties drive the design:
 *
 * - `hook-env` is documented as an internal hook, so nothing here is trusted to
 *   stay stable. An unparsable line is ignored, an empty result is a failure,
 *   and every failure falls back to shims rather than failing a command.
 * - The probe is synchronous, because the executor resolves its environment in
 *   the synchronous part of a spawn. The timeout is therefore a hard bound on
 *   how long one uncached command can be delayed.
 *
 * @module dsh-bash-env/mise
 */

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** The names mise reads, from the directory itself up to the home directory. */
const CONFIG_NAMES = ['mise.toml', '.mise.toml', 'mise.local.toml', '.tool-versions']

/**
 * The global configuration, relative to the home directory.
 *
 * It applies to every directory mise resolves for, including ones outside home
 * that the upward walk never reaches — so it is fingerprinted separately rather
 * than being one more name in the walk.
 */
const GLOBAL_CONFIG_NAMES = ['.config/mise/config.toml']

/** `export NAME=VALUE`, the only line shape `hook-env` emits. */
const EXPORT_LINE = /^export ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

/** Variables mise uses to keep session state; they mean nothing in a fresh shell. */
const INTERNAL_PREFIX = '__MISE_'

/** How long one probe may take before it is treated as a failure. */
export const DEFAULT_TIMEOUT_MS = 3000

/** How long a cached resolution stays usable even when nothing changed. */
export const DEFAULT_TTL_MS = 5 * 60 * 1000

/** How many directories keep a cached resolution. */
export const DEFAULT_MAX_ENTRIES = 64

/**
 * Strip one layer of shell quoting from an exported value.
 *
 * `hook-env` single-quotes anything with a space or a colon in it, and escapes an
 * embedded quote the way a POSIX shell does.
 *
 * @param text - the raw text after the `=`.
 * @returns the value the shell would have produced.
 */
function unquote(text) {
	if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/'\\''/g, "'")
	if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replace(/\\(["\\$`])/g, '$1')
	return text
}

/**
 * Read the environment `mise hook-env` printed.
 *
 * The same name can appear more than once — mise emits a first `PATH` that
 * restores the incoming value and a later one with its tool directories in front
 * — and the shell semantics that matter are "the last assignment wins", so that
 * is what this does. Internal session variables are dropped: they exist to let a
 * long-lived shell change directory incrementally, which a fresh shell per
 * command is not.
 *
 * @param output - the command's standard output.
 * @returns the variables it would have exported.
 */
export function parseHookEnv(output) {
	const vars = {}
	for (const line of String(output ?? '').split('\n')) {
		const match = EXPORT_LINE.exec(line.trim())
		if (match === null) continue
		const [, name, raw] = match
		if (name.startsWith(INTERNAL_PREFIX)) continue
		vars[name] = unquote(raw)
	}
	return vars
}

/**
 * Describe the mise configuration that applies to one directory.
 *
 * A resolution is only reusable while the files it was derived from are
 * unchanged, so the fingerprint is every applicable config file's path, mtime and
 * size. Paths are included because a file appearing or disappearing changes the
 * result just as surely as an edit does.
 *
 * The walk stops at the home directory: mise reads no local config above it. The
 * global configuration is *not* part of that walk — it applies to directories
 * outside home too, where an upward walk would never reach it — so it is always
 * fingerprinted, and a change there invalidates every cached directory.
 *
 * @param workdir - the directory a command will run in.
 * @param options - fingerprint settings.
 * @param options.home - directory the walk stops at, and where globals live.
 * @param options.names - local config file names to stat at each level.
 * @param options.globalNames - config file names under the home directory.
 * @returns a string that changes whenever the applicable configuration changes.
 */
export function miseConfigFingerprint(workdir, options = {}) {
	const home = resolve(options.home ?? homedir())
	const names = options.names ?? CONFIG_NAMES
	const globalNames = options.globalNames ?? GLOBAL_CONFIG_NAMES
	const candidates = new Set()
	let dir = resolve(workdir)
	for (;;) {
		for (const name of names) candidates.add(join(dir, name))
		if (dir === home || dir === dirname(dir)) break
		dir = dirname(dir)
	}
	for (const name of globalNames) candidates.add(join(home, name))
	const parts = []
	for (const path of [...candidates].sort()) {
		let stat
		try {
			stat = statSync(path)
		} catch {
			continue
		}
		parts.push(`${path}:${stat.mtimeMs}:${stat.size}`)
	}
	return parts.join('|')
}

/**
 * Build a per-directory resolver that probes `mise hook-env` at most once per
 * configuration state.
 *
 * @param options - resolver settings.
 * @param options.bin - the mise executable, or a bare name to resolve on PATH.
 * @param options.run - performs one probe; injected so tests never need mise.
 * @param options.timeoutMs - bound on one probe.
 * @param options.ttlMs - how long a cached resolution stays usable.
 * @param options.maxEntries - how many directories stay cached.
 * @param options.now - clock, for tests.
 * @param options.fingerprint - configuration fingerprint, for tests.
 * @returns an object whose `resolve(workdir)` yields the result for that directory.
 */
export function createMiseEnvResolver(options) {
	const { bin, run } = options
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
	const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
	const now = options.now ?? (() => Date.now())
	const fingerprint = options.fingerprint ?? miseConfigFingerprint
	/** Keyed by canonical directory, oldest first so the cap drops the coldest. */
	const cache = new Map()

	/**
	 * Run one probe and classify it.
	 *
	 * Every failure mode — a missing binary, a non-zero exit, a timeout, output
	 * with nothing usable in it — is the same outcome, because they all mean the
	 * same thing to the caller: fall back to shims.
	 *
	 * @param workdir - the directory to resolve for.
	 * @returns a result of kind `hook-env` with its variables, or `shims-fallback`.
	 */
	function probe(workdir) {
		let outcome
		try {
			outcome = run(typeof bin === 'function' ? bin() : bin, workdir, timeoutMs)
		} catch (error) {
			return { kind: 'shims-fallback', detail: `mise could not be started: ${String(error?.message ?? error)}` }
		}
		if (outcome === undefined || outcome === null) return { kind: 'shims-fallback', detail: 'mise produced no result' }
		if (outcome.error !== undefined && outcome.error !== null) {
			return { kind: 'shims-fallback', detail: `mise could not be started: ${String(outcome.error.message ?? outcome.error)}` }
		}
		if (outcome.status !== 0) return { kind: 'shims-fallback', detail: `mise hook-env exited with ${String(outcome.status)}` }
		const vars = parseHookEnv(outcome.stdout)
		if (Object.keys(vars).length === 0) return { kind: 'shims-fallback', detail: 'mise hook-env exported nothing' }
		return { kind: 'hook-env', vars }
	}

	return {
		/**
		 * Resolve the mise environment for one directory, reusing the last answer
		 * while the configuration behind it is unchanged.
		 *
		 * @param workdir - the directory a command will run in.
		 * @returns the cached or freshly probed result.
		 */
		resolve(workdir) {
			const key = resolve(workdir)
			// A fingerprint that cannot be read must not disable the feature: a
			// constant stamp degrades to the TTL, which is still bounded.
			let stamp = 'unfingerprintable'
			try {
				stamp = fingerprint(key)
			} catch {}
			const cached = cache.get(key)
			if (cached !== undefined && cached.stamp === stamp && now() - cached.at < ttlMs) {
				cache.delete(key)
				cache.set(key, cached)
				return cached.result
			}
			const result = probe(key)
			cache.delete(key)
			cache.set(key, { stamp, at: now(), result })
			while (cache.size > maxEntries) cache.delete(cache.keys().next().value)
			return result
		},
	}
}
