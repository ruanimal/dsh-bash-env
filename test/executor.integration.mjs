/**
 * Integration test: mount the real executor composition and run real commands.
 *
 * The unit tests cover the policy; this covers the wiring the policy cannot
 * reach — that the plugin mounts as `ctx.shell` (no duplicate registrant), that
 * its Config validates, and that the environment it resolves actually reaches a
 * spawned `bash -c`, including a nested shell.
 *
 * It mounts the same services the shipped profile composes and uses
 * `danger-full-access` so the run does not depend on bwrap being usable.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SandboxLocal from '@deepseek-ai/dsh-sandbox-local'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'

import BashEnvExecutor, { Config, configValue, plainConfig } from '../lib/index.js'

/** Roots created by this suite, removed afterwards. */
const roots = []

/** Contexts mounted by this suite, disposed afterwards. */
const contexts = []

/** Create a throwaway directory that the suite cleans up. */
function scratch() {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-bash-env-it-'))
	roots.push(dir)
	return dir
}

/**
 * Write an executable stand-in for `mise`, so the integration path can be tested
 * without mise installed and without waiting on the real one.
 * @param body - the script body.
 * @returns the script's absolute path.
 */
function makeStubMise(body) {
	const file = join(scratch(), 'mise')
	writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
	return file
}

/** Create a directory that looks like a usable virtual environment. */
function makeVenv(root) {
	mkdirSync(join(root, 'bin'), { recursive: true })
	// Both names, executable, so `command -v python3` inside the shell exercises
	// the PATH ordering this suite is about rather than falling through to the
	// system interpreter.
	for (const name of ['python', 'python3']) {
		const file = join(root, 'bin', name)
		writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
	}
	return root
}

/** A configuration with mise out of the way, for tests about something else. */
function only(config = {}) {
	return { miseEnabled: false, ...config }
}

/**
 * Mount the executor composition.
 *
 * @param options - mount settings.
 * @param options.config - plugin configuration under test.
 * @returns the mounted root context.
 */
async function mount({ config }) {
	const root = new Context()
	contexts.push(root)
	await root.plugin(SubprocessLocal)
	await root.plugin(SandboxLocal)
	// `sandboxPolicy` injects `sessionProjections`, so the registry has to exist
	// before it can mount. The rest of the projection stack is irrelevant here.
	await root.plugin(SessionProjections)
	await root.plugin(SandboxPolicy, {
		mode: 'danger-full-access',
		workspaceRoot: process.cwd(),
	})
	await root.plugin(BashEnvExecutor, config)
	return root
}

/**
 * Run one command through the mounted executor.
 *
 * @param root - the mounted context.
 * @param command - shell source to run.
 * @param workdir - directory the shell starts in.
 * @returns the foreground result.
 */
async function run(root, command, workdir) {
	const spec = root.shell.resolve({ command, workdir })
	const execution = await root.shell.execute(spec)
	return execution.result()
}

after(async () => {
	for (const root of contexts) await root.fiber.dispose()
	for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

describe('mounted executor', () => {
	it('registers as ctx.shell', async () => {
		const root = await mount({ config: {} })
		assert.equal(typeof root.shell.resolve, 'function')
		assert.equal(typeof root.shell.execute, 'function')
	})

	it('applies prependPath to a spawned command, ahead of the inherited PATH', async () => {
		const extra = scratch()
		const root = await mount({ config: only({ prependPath: [extra] }) })
		const result = await run(root, 'printf %s "$PATH"', process.cwd())
		assert.equal(result.exitCode, 0)
		const parts = result.stdout.text.trim().split(':')
		assert.equal(parts[0], extra)
		assert.ok(parts.length > 1, 'the inherited PATH is still present')
		assert.equal(new Set(parts).size, parts.length, 'PATH has no duplicates')
	})

	it('activates a workdir venv and exports it to the command', async () => {
		const workspace = scratch()
		const venv = makeVenv(join(workspace, '.venv'))
		const root = await mount({ config: only({ prependPath: ['/shims'] }) })
		const result = await run(
			root,
			'printf "VE=%s\\nPY=%s\\n" "$VIRTUAL_ENV" "$(command -v python3 || true)"',
			workspace,
		)
		assert.equal(result.exitCode, 0)
		assert.match(result.stdout.text, new RegExp(`VE=${venv}\\b`))
		assert.match(result.stdout.text, new RegExp(`PY=${venv}/bin/python3\\b`))
	})

	it('places the venv ahead of prependPath and the mise shims', async () => {
		const workspace = scratch()
		const venv = makeVenv(join(workspace, '.venv'))
		const root = await mount({
			config: { prependPath: ['/extra'], miseEnabled: true, miseShims: '/mise/shims' },
		})
		const result = await run(root, 'printf %s "$PATH"', workspace)
		assert.equal(result.stdout.text.split(':').slice(0, 3).join(':'), `${venv}/bin:/extra:/mise/shims`)
	})

	it('disables mise auto-install by default', async () => {
		const root = await mount({ config: {} })
		const result = await run(
			root,
			'printf "%s/%s" "$MISE_AUTO_INSTALL" "$MISE_NOT_FOUND_AUTO_INSTALL"',
			process.cwd(),
		)
		assert.equal(result.stdout.text, 'false/false')
	})

	it('carries inline env.vars into the command', async () => {
		const root = await mount({
			config: only({ envVars: { CARGO_HOME: '/cargo', EDITOR: 'nvim' } }),
		})
		const result = await run(root, 'printf "%s/%s" "$CARGO_HOME" "$EDITOR"', process.cwd())
		assert.equal(result.stdout.text, '/cargo/nvim')
	})

	it('reads env.file per command, so an edit applies without a reload', async () => {
		const file = join(scratch(), 'shell.env')
		writeFileSync(file, 'MARKER=first\n')
		const root = await mount({ config: only({ envFile: file }) })
		assert.equal((await run(root, 'printf %s "$MARKER"', process.cwd())).stdout.text, 'first')

		writeFileSync(file, 'MARKER=second\n')
		assert.equal((await run(root, 'printf %s "$MARKER"', process.cwd())).stdout.text, 'second')
	})

	it('lets inline env.vars win over the file', async () => {
		const file = join(scratch(), 'shell.env')
		writeFileSync(file, 'MARKER=file\n')
		const root = await mount({ config: only({ envFile: file, envVars: { MARKER: 'inline' } }) })
		assert.equal((await run(root, 'printf %s "$MARKER"', process.cwd())).stdout.text, 'inline')
	})

	it('passes the environment on to a nested shell', async () => {
		const workspace = scratch()
		const venv = makeVenv(join(workspace, '.venv'))
		const root = await mount({ config: only({}) })
		const result = await run(
			root,
			'bash -c \'printf "%s|%s" "$VIRTUAL_ENV" "$MISE_AUTO_INSTALL"\'',
			workspace,
		)
		assert.equal(result.stdout.text, `${venv}|false`)
	})

	it('sources a configured BASH_ENV before every command', async () => {
		const file = join(scratch(), 'startup.sh')
		writeFileSync(file, '# no output of its own\nexport RC_VAR=from-rc\nrc_func() { printf from-func; }\n')
		const root = await mount({ config: only({ bashEnv: file }) })
		const result = await run(root, 'printf "%s|" "$RC_VAR"; rc_func', process.cwd())
		assert.equal(result.exitCode, 0)
		assert.equal(result.stdout.text, 'from-rc|from-func')
		// bash sources BASH_ENV in nested shells too, which is what makes it
		// usable for tooling that shells out again.
		const nested = await run(root, 'bash -c \'printf "%s" "$RC_VAR"\'', process.cwd())
		assert.equal(nested.stdout.text, 'from-rc')
	})

	it('reports a missing startup file instead of letting bash ignore it', async () => {
		// bash ignores an unreadable BASH_ENV in silence, so the plugin has to be
		// the one that says so.
		const root = await mount({ config: only({ bashEnv: join(scratch(), 'absent.sh') }) })
		await assert.rejects(
			() => run(root, 'printf ok', process.cwd()),
			(error) => /cannot read bashEnv/.test(error.message),
		)
	})

	it('refuses a relative startup path', async () => {
		const root = await mount({ config: only({ bashEnv: 'startup.sh' }) })
		await assert.rejects(
			() => run(root, 'printf ok', process.cwd()),
			(error) => /must be an absolute path/.test(error.message),
		)
	})

	it('takes JAVA_HOME from a hook-env probe when asked', async () => {
		const bin = makeStubMise("printf \"export JAVA_HOME=/stub/jdk\\nexport PATH='/stub/bin:%s'\\n\" \"$PATH\"")
		const root = await mount({ config: { venvEnabled: false, miseHookEnv: true, miseBin: bin, miseShims: '/shims' } })
		const result = await run(root, 'printf "%s|%s" "$JAVA_HOME" "$DSH_MISE"', process.cwd())
		assert.equal(result.stdout.text, '/stub/jdk|hook-env')
		// The probe's paths already carry the tools, so the shims stay out of PATH.
		const path = result.stdout.text.length > 0 ? (await run(root, 'printf %s "$PATH"', process.cwd())).stdout.text : ''
		assert.ok(path.split(':').includes('/stub/bin'), 'the probe PATH is the base')
		assert.ok(!path.split(':').includes('/shims'), 'shims are not added alongside hook-env')
	})

	it('falls back to shims when the probe fails, and names the fallback', async () => {
		const bin = makeStubMise('exit 3')
		const root = await mount({ config: { venvEnabled: false, miseHookEnv: true, miseBin: bin, miseShims: '/shims' } })
		const result = await run(root, 'printf "%s|%s" "$DSH_MISE" "$(printf %s "$PATH" | cut -d: -f1)"', process.cwd())
		assert.equal(result.stdout.text, 'shims-fallback|/shims')
	})

	it('probes mise once per directory, then reuses the answer', async () => {
		const calls = join(scratch(), 'calls')
		const bin = makeStubMise(`printf 'x' >> ${JSON.stringify(calls)}\nprintf "export JAVA_HOME=/stub/jdk\\n"`)
		const root = await mount({ config: { venvEnabled: false, miseHookEnv: true, miseBin: bin, miseShims: '/shims' } })
		await run(root, 'true', process.cwd())
		await run(root, 'true', process.cwd())
		await run(root, 'true', process.cwd())
		const count = readFileSync(calls, 'utf8').length
		assert.equal(count, 1, 'three commands in one directory cost one probe')
	})

	it('keeps managed DSH_* facts authoritative over configuration', async () => {
		const root = await mount({ config: only({ prependPath: [] }) })
		const spec = root.shell.resolve({ command: 'printf %s "$DSH_SHELL"', workdir: process.cwd() })
		// A managed fact the shell-env registry would inject for a real tool call.
		const execution = await root.shell.execute({ ...spec, dshEnv: { DSH_SHELL: 'managed' } })
		const result = await execution.result()
		assert.equal(result.stdout.text, 'managed')
	})
})

describe('configuration surface', () => {
	it('marks every field volatile, which is what makes it writable at all', () => {
		// The settings service refuses any path that is not volatile
		// (`Config field "x" is not volatile`). A field declared without it renders in
		// the Web UI and then fails to save on every attempt, across restarts, with no
		// explanation — so this guard is worth more than it looks.
		const notVolatile = Object.entries(Config.dict)
			.filter(([, schema]) => schema?.meta?.volatile !== true)
			.map(([key]) => key)
		assert.deepEqual(notVolatile, [], 'every config field must be marked volatile')
	})

	it('exposes the knobs the settings page edits', () => {
		const expected = ['prependPath', 'envFile', 'envVars', 'bashEnv', 'venvEnabled', 'venvNames', 'venvMaxDepth', 'venvStopAt', 'venvFallback', 'miseEnabled', 'miseShims', 'miseAutoInstall']
		for (const key of expected) assert.ok(Object.hasOwn(Config.dict, key), `Config declares ${key}`)
	})

	it('reads a volatile field through its accessor', () => {
		// The loader resolves a `.volatile()` field to an accessor, not a value.
		// Reading one as a plain property hands the resolver an object where it
		// expects an array, and every command then fails with "object is not
		// iterable" — which is exactly what happened before `plainConfig` existed.
		assert.deepEqual(configValue({ get: () => ['/a'] }), ['/a'])
		assert.equal(configValue({ get: () => false }), false)
		assert.equal(configValue(undefined, 'fallback'), 'fallback')
		assert.equal(configValue('plain'), 'plain')

		const config = plainConfig({
			prependPath: { get: () => ['/extra'] },
			miseEnabled: { get: () => false },
			venvEnabled: { get: () => false },
			envVars: { get: () => ({ MARKER: 'from-accessor' }) },
		})
		assert.deepEqual(config.prependPath, ['/extra'])
		assert.equal(config.miseEnabled, false)
		assert.ok(!('miseShims' in config))
	})
})

describe('configuration diagnostics', () => {
	it('fails the command, not the mount, on an unknown key', async () => {
		const root = await mount({ config: { venvFalback: '/x', miseEnabled: false } })
		// The executor is still mounted: only a type error aborts the mount.
		assert.equal(typeof root.shell.execute, 'function')
		await assert.rejects(
			() => run(root, 'printf ok', process.cwd()),
			(error) => /is not a known option/.test(error.message) && /did you mean "venvFallback"/.test(error.message),
		)
	})

	it('fails the command with the file and line on an unusable env file', async () => {
		const file = join(scratch(), 'broken.env')
		writeFileSync(file, 'A=1\nOOPS\n')
		const root = await mount({ config: only({ envFile: file }) })
		await assert.rejects(
			() => run(root, 'printf ok', process.cwd()),
			(error) => error.message.includes(file) && /2: expected KEY=VALUE/.test(error.message),
		)
	})

	it('fails the command when a configured env file is missing', async () => {
		const root = await mount({ config: only({ envFile: join(scratch(), 'absent.env') }) })
		await assert.rejects(
			() => run(root, 'printf ok', process.cwd()),
			(error) => /cannot read envFile/.test(error.message),
		)
	})
})
