/**
 * Unit tests for the mise integration.
 *
 * `hook-env` is an internal interface, so nothing here depends on a real mise:
 * the probe is injected, which also makes the interesting cases — a timeout, a
 * non-zero exit, output with nothing usable in it — reachable in milliseconds
 * instead of seconds.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { createMiseEnvResolver, miseConfigFingerprint, parseHookEnv } from '../lib/mise.js'

/** Roots created by the tests, removed afterwards. */
const roots = []

/** Create a throwaway directory that the suite cleans up. */
function scratch() {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-bash-env-mise-'))
	roots.push(dir)
	return dir
}

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('parseHookEnv', () => {
	it('reads single-quoted values, which is how paths arrive', () => {
		const vars = parseHookEnv("export JAVA_HOME='/opt/java home'\n")
		assert.deepEqual(vars, { JAVA_HOME: '/opt/java home' })
	})

	it('keeps the last assignment, which is the one a shell would keep', () => {
		// mise emits a PATH restoring the incoming value and then the real one.
		const vars = parseHookEnv("export PATH='/usr/bin'\nexport PATH='/mise/bin:/usr/bin'\n")
		assert.equal(vars.PATH, '/mise/bin:/usr/bin')
	})

	it('drops mise session state', () => {
		const vars = parseHookEnv('export __MISE_DIFF=eAHq\nexport __MISE_SESSION=eAHq\nexport GOROOT=/go\n')
		assert.deepEqual(vars, { GOROOT: '/go' })
	})

	it('ignores anything that is not an export line', () => {
		const vars = parseHookEnv('mise: warning\n\nexport GOBIN=/go/bin\necho hi\n')
		assert.deepEqual(vars, { GOBIN: '/go/bin' })
	})

	it('unescapes an embedded single quote the POSIX way', () => {
		// The shell escaping for a literal quote inside a single-quoted value.
		assert.deepEqual(parseHookEnv("export M='/a'\\''b'\n"), { M: "/a'b" })
	})

	it('returns nothing for empty output', () => {
		assert.deepEqual(parseHookEnv(''), {})
		assert.deepEqual(parseHookEnv(undefined), {})
	})
})

describe('miseConfigFingerprint', () => {
	it('is stable while nothing changes and moves when a config is edited', () => {
		const root = scratch()
		const first = miseConfigFingerprint(root, { home: root })
		assert.equal(miseConfigFingerprint(root, { home: root }), first)
		writeFileSync(join(root, '.tool-versions'), 'nodejs 22.18.0\n')
		const second = miseConfigFingerprint(root, { home: root })
		assert.notEqual(second, first)
		writeFileSync(join(root, '.tool-versions'), 'nodejs 24.15.0\n')
		assert.notEqual(miseConfigFingerprint(root, { home: root }), second)
	})

	it('notices a config that appears in a parent directory', () => {
		const root = scratch()
		const nested = join(root, 'a', 'b')
		mkdirSync(nested, { recursive: true })
		const before = miseConfigFingerprint(nested, { home: root })
		writeFileSync(join(root, 'mise.toml'), '[tools]\nnode = "latest"\n')
		assert.notEqual(miseConfigFingerprint(nested, { home: root }), before)
	})

	it('always covers the global config, even for a directory outside home', () => {
		// This is the gap that made the cache look correct while it was not: an
		// upward walk from a directory outside home never reaches the global config,
		// yet mise reads it for every directory.
		const home = scratch()
		const outside = scratch()
		mkdirSync(join(home, '.config', 'mise'), { recursive: true })
		writeFileSync(join(home, '.config', 'mise', 'config.toml'), '[tools]\n')
		const first = miseConfigFingerprint(outside, { home })
		assert.match(first, /config\.toml/)
		writeFileSync(join(home, '.config', 'mise', 'config.toml'), '[tools]\nnode = "22"\n')
		assert.notEqual(miseConfigFingerprint(outside, { home }), first)
	})

	it('never walks above the home directory', () => {
		// `home` is the boundary, so a config above it is invisible by design.
		const parent = scratch()
		writeFileSync(join(parent, 'mise.toml'), '[tools]\n')
		const home = join(parent, 'home')
		mkdirSync(home, { recursive: true })
		assert.equal(miseConfigFingerprint(home, { home }), '')
	})
})

describe('createMiseEnvResolver', () => {
	/** A probe that records how often it ran. */
	function countingProbe(result) {
		const calls = []
		return {
			calls,
			run: (bin, workdir, timeoutMs) => {
				calls.push({ bin, workdir, timeoutMs })
				return result
			},
		}
	}

	it('returns the parsed variables on success', () => {
		const probe = countingProbe({ status: 0, stdout: 'export JAVA_HOME=/jdk\nexport PATH=/mise/bin\n' })
		const resolver = createMiseEnvResolver({ bin: 'mise', run: probe.run, fingerprint: () => 'stable' })
		const result = resolver.resolve('/tmp')
		assert.equal(result.kind, 'hook-env')
		assert.equal(result.vars.JAVA_HOME, '/jdk')
		assert.equal(probe.calls.length, 1)
		assert.equal(probe.calls[0].bin, 'mise')
	})

	it('falls back on a non-zero exit, a start failure and empty output', () => {
		const cases = [
			{ status: 2, stdout: '' },
			{ status: 0, stdout: '', error: new Error('ENOENT') },
			{ status: 0, stdout: 'not an export\n' },
		]
		for (const outcome of cases) {
			const probe = countingProbe(outcome)
			const resolver = createMiseEnvResolver({ bin: 'mise', run: probe.run, fingerprint: () => 'stable' })
			const result = resolver.resolve('/tmp')
			assert.equal(result.kind, 'shims-fallback', `expected fallback for ${JSON.stringify(outcome.status)}`)
			assert.equal(typeof result.detail, 'string')
		}
	})

	it('falls back when the probe throws', () => {
		const resolver = createMiseEnvResolver({
			bin: 'mise',
			run: () => {
				throw new Error('spawn failed')
			},
			fingerprint: () => 'stable',
		})
		const result = resolver.resolve('/tmp')
		assert.equal(result.kind, 'shims-fallback')
		assert.match(result.detail, /spawn failed/)
	})

	it('probes once per directory while the configuration is unchanged', () => {
		const probe = countingProbe({ status: 0, stdout: 'export GOROOT=/go\n' })
		const resolver = createMiseEnvResolver({ bin: 'mise', run: probe.run, fingerprint: () => 'stable' })
		resolver.resolve('/tmp')
		resolver.resolve('/tmp')
		resolver.resolve('/tmp')
		assert.equal(probe.calls.length, 1)
	})

	it('probes again when the configuration fingerprint moves', () => {
		const probe = countingProbe({ status: 0, stdout: 'export GOROOT=/go\n' })
		let stamp = 'a'
		const resolver = createMiseEnvResolver({ bin: 'mise', run: probe.run, fingerprint: () => stamp })
		resolver.resolve('/tmp')
		stamp = 'b'
		resolver.resolve('/tmp')
		assert.equal(probe.calls.length, 2)
	})

	it('probes again once the cached answer expires', () => {
		const probe = countingProbe({ status: 0, stdout: 'export GOROOT=/go\n' })
		let time = 0
		const resolver = createMiseEnvResolver({
			bin: 'mise',
			run: probe.run,
			fingerprint: () => 'stable',
			ttlMs: 1000,
			now: () => time,
		})
		resolver.resolve('/tmp')
		time = 999
		resolver.resolve('/tmp')
		assert.equal(probe.calls.length, 1, 'still inside the TTL')
		time = 1001
		resolver.resolve('/tmp')
		assert.equal(probe.calls.length, 2, 'expired')
	})

	it('probes each directory separately and bounds how many stay cached', () => {
		const probe = countingProbe({ status: 0, stdout: 'export GOROOT=/go\n' })
		const resolver = createMiseEnvResolver({ bin: 'mise', run: probe.run, fingerprint: () => 'stable', maxEntries: 2 })
		resolver.resolve('/one')
		resolver.resolve('/two')
		resolver.resolve('/three')
		assert.equal(probe.calls.length, 3)
		// `/one` was the coldest and the cap is two, so it is probed again — and that
		// re-probe makes it the newest, evicting `/two` instead.
		resolver.resolve('/one')
		assert.equal(probe.calls.length, 4)
		// The two most recent are cached: neither of these probes.
		resolver.resolve('/one')
		resolver.resolve('/three')
		assert.equal(probe.calls.length, 4)
		// `/two` went out with the cap, so it costs a probe again.
		resolver.resolve('/two')
		assert.equal(probe.calls.length, 5)
	})
})
