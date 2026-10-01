/**
 * Unit tests for the pure environment resolution in `lib/resolve.js`.
 *
 * These run without a harness, which is the reason the policy lives in a
 * dependency-free module: every rule the executor applies to a spawn — and every
 * diagnostic it can raise — is checkable here, and `lib/index.js` is left as an
 * adapter small enough to read.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import {
	composePath,
	expandEnvValue,
	findManagedEnvNames,
	findUnknownConfigKeys,
	findVenv,
	formatUnknownConfigKeys,
	isUsableVenv,
	parseEnvFile,
	resolveShellEnv,
	suggestConfigKey,
} from '../lib/resolve.js'

/** Roots created by the tests, removed afterwards. */
const roots = []

/** Create a throwaway directory that the suite cleans up. */
function scratch() {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-bash-env-'))
	roots.push(dir)
	return dir
}

/** Create a directory that looks like a usable virtual environment. */
function makeVenv(root) {
	mkdirSync(join(root, 'bin'), { recursive: true })
	writeFileSync(join(root, 'bin', 'python'), '')
	return root
}

/** A configuration with every feature off but the one under test. */
function only(config = {}) {
	return { miseEnabled: false, ...config }
}

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('isUsableVenv', () => {
	it('accepts a directory with bin/python', () => {
		const root = scratch()
		makeVenv(join(root, '.venv'))
		assert.equal(isUsableVenv(join(root, '.venv')), true)
	})

	it('rejects a directory without an interpreter', () => {
		const root = scratch()
		mkdirSync(join(root, '.venv', 'bin'), { recursive: true })
		assert.equal(isUsableVenv(join(root, '.venv')), false)
	})

	it('rejects empty and missing values', () => {
		assert.equal(isUsableVenv(''), false)
		assert.equal(isUsableVenv(undefined), false)
		assert.equal(isUsableVenv(join(tmpdir(), 'dsh-bash-env-does-not-exist')), false)
	})
})

describe('findVenv', () => {
	it('finds a venv in the workdir itself', () => {
		const root = scratch()
		const project = join(root, 'project')
		makeVenv(join(project, '.venv'))
		assert.equal(findVenv({ workdir: project }), join(project, '.venv'))
	})

	it('finds a venv in a parent directory', () => {
		const root = scratch()
		makeVenv(join(root, '.venv'))
		const nested = join(root, 'src', 'deep')
		mkdirSync(nested, { recursive: true })
		assert.equal(findVenv({ workdir: nested }), join(root, '.venv'))
	})

	it('prefers the nearest venv', () => {
		const root = scratch()
		makeVenv(join(root, '.venv'))
		const project = join(root, 'project')
		makeVenv(join(project, '.venv'))
		const nested = join(project, 'pkg')
		mkdirSync(nested, { recursive: true })
		assert.equal(findVenv({ workdir: nested }), join(project, '.venv'))
	})

	it('honors the candidate-name order at one level', () => {
		const root = scratch()
		makeVenv(join(root, 'venv'))
		makeVenv(join(root, '.venv'))
		assert.equal(findVenv({ workdir: root, names: ['.venv', 'venv'] }), join(root, '.venv'))
		assert.equal(findVenv({ workdir: root, names: ['venv', '.venv'] }), join(root, 'venv'))
	})

	it('stops at maxDepth', () => {
		const root = scratch()
		makeVenv(join(root, '.venv'))
		const nested = join(root, 'a', 'b')
		mkdirSync(nested, { recursive: true })
		assert.equal(findVenv({ workdir: nested, maxDepth: 2 }), join(root, '.venv'))
		assert.equal(findVenv({ workdir: nested, maxDepth: 1 }), undefined)
	})

	it('returns undefined when nothing is found', () => {
		const root = scratch()
		assert.equal(findVenv({ workdir: root, maxDepth: 1 }), undefined)
	})

	it('never searches the stopAt directory or anything above it', () => {
		const root = scratch()
		makeVenv(join(root, '.venv'))
		const boundary = join(root, 'boundary')
		const nested = join(boundary, 'project')
		mkdirSync(nested, { recursive: true })
		assert.equal(findVenv({ workdir: nested, stopAt: undefined }), join(root, '.venv'))
		assert.equal(findVenv({ workdir: nested, stopAt: boundary }), undefined)
	})

	it('defaults the boundary to the home directory', () => {
		// A venv at the home directory is never chosen implicitly, which is why
		// `venv.fallback` exists as an explicit opt-in.
		const root = scratch()
		makeVenv(join(root, '.venv'))
		assert.equal(findVenv({ workdir: root, stopAt: root }), undefined)
	})
})

describe('composePath', () => {
	it('places prepended entries first and keeps the base order', () => {
		assert.equal(composePath(['/a', '/b'], '/c:/d'), '/a:/b:/c:/d')
	})

	it('keeps the first occurrence of a repeated entry', () => {
		assert.equal(composePath(['/b'], '/a:/b:/c'), '/b:/a:/c')
		assert.equal(composePath(['/a', '/a'], '/a:/b'), '/a:/b')
	})

	it('skips empty entries and handles a missing base', () => {
		assert.equal(composePath(['', '/a'], undefined), '/a')
		assert.equal(composePath([], ''), '')
		assert.equal(composePath([], '/only'), '/only')
	})
})

describe('expandEnvValue', () => {
	it('expands both reference forms', () => {
		const environment = { HOME: '/home/me', X: 'y' }
		assert.equal(expandEnvValue('$HOME/bin', environment), '/home/me/bin')
		assert.equal(expandEnvValue('${HOME}/bin', environment), '/home/me/bin')
		assert.equal(expandEnvValue('a${X}b', environment), 'ayb')
	})

	it('greedily reads the longest name, as a shell does', () => {
		// `$Xb` is the variable `Xb`, not `X` followed by `b`; braces are how a
		// shell — and this parser — disambiguate.
		assert.equal(expandEnvValue('a$Xb', { X: 'y' }), 'a')
		assert.equal(expandEnvValue('a${X}b', { X: 'y' }), 'ayb')
	})

	it('expands an unknown name to the empty string, like a shell', () => {
		assert.equal(expandEnvValue('/a:$NOPE:/b', {}), '/a::/b')
	})

	it('leaves a lone dollar alone', () => {
		assert.equal(expandEnvValue('cost: 5$', {}), 'cost: 5$')
	})
})

describe('parseEnvFile', () => {
	it('reads one KEY=VALUE per line, skipping blanks and comments', () => {
		const parsed = parseEnvFile('# comment\n\nA=1\n  B = two  \n')
		assert.deepEqual(parsed.values, { A: '1', B: 'two' })
		assert.deepEqual(parsed.problems, [])
	})

	it('accepts a pasted `export ` prefix', () => {
		assert.deepEqual(parseEnvFile('export A=1\n').values, { A: '1' })
	})

	it('splits on the first equals only', () => {
		assert.deepEqual(parseEnvFile('A=b=c\n').values, { A: 'b=c' })
	})

	it('expands against the base environment and earlier lines', () => {
		const parsed = parseEnvFile('CARGO=$HOME/.cargo\nPATH=$CARGO/bin:$PATH\n', { HOME: '/h', PATH: '/usr/bin' })
		assert.deepEqual(parsed.values, { CARGO: '/h/.cargo', PATH: '/h/.cargo/bin:/usr/bin' })
	})

	it('treats a single-quoted value as literal', () => {
		assert.deepEqual(parseEnvFile("A='$HOME'\nB=\"$HOME\"\n", { HOME: '/h' }).values, { A: '$HOME', B: '/h' })
	})

	it('reports a line without an equals, with its number', () => {
		const parsed = parseEnvFile('A=1\nOOPS\n')
		assert.deepEqual(parsed.values, { A: '1' })
		assert.equal(parsed.problems.length, 1)
		assert.match(parsed.problems[0], /^2: expected KEY=VALUE/)
	})

	it('reports an invalid name, with its number', () => {
		const parsed = parseEnvFile('A=1\n2BAD=x\n')
		assert.equal(parsed.problems.length, 1)
		assert.match(parsed.problems[0], /^2: "2BAD" is not a valid environment variable name/)
	})
})

describe('findManagedEnvNames', () => {
	it('flags the harness namespace, case-insensitively', () => {
		assert.deepEqual(findManagedEnvNames(['PATH', 'DSH_SESSION_ID', 'dsh_home']), ['DSH_SESSION_ID', 'dsh_home'])
	})

	it('flags nothing in an ordinary set', () => {
		assert.deepEqual(findManagedEnvNames(['CARGO_HOME', 'EDITOR']), [])
	})
})

describe('configuration key checking', () => {
	/** A stand-in for a schemastery object schema. */
	const schema = {
		dict: {
			prependPath: {},
			env: { dict: { vars: { dict: {} }, file: {} } },
			venv: { dict: { enabled: {} } },
		},
	}

	it('accepts a configuration made only of known keys', () => {
		assert.deepEqual(findUnknownConfigKeys(schema, { prependPath: [], venv: { enabled: true } }), [])
	})

	it('finds a mistyped top-level key', () => {
		const unknown = findUnknownConfigKeys(schema, { prependPath: [] })
		assert.deepEqual(unknown, [])
		assert.equal(findUnknownConfigKeys(schema, { prependpath: [] }).length, 1)
	})

	it('finds a mistyped nested key', () => {
		const unknown = findUnknownConfigKeys(schema, { venv: { enabld: true } })
		assert.equal(unknown.length, 1)
		assert.equal(unknown[0].path, '$.venv.enabld')
		assert.ok(unknown[0].candidates.includes('enabled'))
	})

	it('treats an open map as user data, not options', () => {
		const value = { env: { vars: { ANY_NAME: '1', another: '2' } } }
		assert.equal(findUnknownConfigKeys(schema, value).length, 2)
		assert.deepEqual(findUnknownConfigKeys(schema, value, { openPaths: ['$.env.vars'] }), [])
	})

	it('suggests the nearest option and stays quiet when nothing is close', () => {
		assert.equal(suggestConfigKey('falback', ['fallback', 'enabled']), 'fallback')
		assert.equal(suggestConfigKey('completely-different', ['fallback']), undefined)
	})

	it('renders findings with suggestions', () => {
		const message = formatUnknownConfigKeys([{ path: '$.venv.falback', key: 'falback', candidates: ['fallback'] }])
		assert.equal(message, 'invalid config:\n  - $.venv.falback is not a known option; did you mean "fallback"?')
	})
})

describe('resolveShellEnv', () => {
	const inherited = { PATH: '/usr/bin:/bin' }

	it('activates a workdir venv and places it before prependPath', () => {
		const root = scratch()
		const venv = makeVenv(join(root, '.venv'))
		const env = resolveShellEnv({
			workdir: root,
			inherited,
			config: only({ prependPath: ['/shims'] }),
		})
		assert.equal(env.VIRTUAL_ENV, venv)
		assert.equal(env.PATH, `${venv}/bin:/shims:/usr/bin:/bin`)
	})

	it('orders PATH as venv, prependPath, mise shims, then the base', () => {
		const root = scratch()
		const venv = makeVenv(join(root, '.venv'))
		const env = resolveShellEnv({
			workdir: root,
			inherited,
			config: { prependPath: ['/extra'], miseEnabled: true, miseShims: '/mise/shims' },
		})
		assert.equal(env.PATH, `${venv}/bin:/extra:/mise/shims:/usr/bin:/bin`)
	})

	it('disables mise auto-install by default and adds its shims', () => {
		const env = resolveShellEnv({
			workdir: scratch(),
			inherited,
			config: { miseEnabled: true, miseShims: '/mise/shims' },
		})
		assert.equal(env.MISE_AUTO_INSTALL, 'false')
		assert.equal(env.MISE_NOT_FOUND_AUTO_INSTALL, 'false')
		assert.equal(env.PATH, '/mise/shims:/usr/bin:/bin')
	})

	it('leaves mise entirely alone when disabled', () => {
		const env = resolveShellEnv({
			workdir: scratch(),
			inherited,
			config: { prependPath: ['/extra'], miseEnabled: false },
		})
		assert.equal('MISE_AUTO_INSTALL' in env, false)
		assert.equal(env.PATH, '/extra:/usr/bin:/bin')
	})

	it('leaves mise settings alone when auto-install is allowed', () => {
		const env = resolveShellEnv({
			workdir: scratch(),
			inherited,
			config: { miseEnabled: true, miseShims: '/mise/shims', miseAutoInstall: true },
		})
		assert.equal('MISE_AUTO_INSTALL' in env, false)
		assert.equal(env.PATH, '/mise/shims:/usr/bin:/bin')
	})

	it('applies inline variables, expanding them', () => {
		const env = resolveShellEnv({
			workdir: scratch(),
			inherited,
			config: only({ envVars: { CARGO_HOME: '$HOME/.cargo', EDITOR: 'nvim' } }),
		})
		assert.equal(env.CARGO_HOME, '/.cargo')
		assert.equal(env.EDITOR, 'nvim')
	})

	it('composes prepended entries over a user-supplied PATH', () => {
		const env = resolveShellEnv({
			workdir: scratch(),
			inherited,
			config: only({ prependPath: ['/first'], envVars: { PATH: '$PATH:/extra' } }),
		})
		assert.equal(env.PATH, '/first:/usr/bin:/bin:/extra')
	})

	it('applies the env file, with inline variables winning', () => {
		const env = resolveShellEnv({
			workdir: scratch(),
			inherited,
			config: only({ envVars: { B: 'inline' } }),
			envFile: { path: '/tmp/f', content: 'A=1\nB=file\n' },
		})
		assert.equal(env.A, '1')
		assert.equal(env.B, 'inline')
	})

	it('reports env-file problems with the file and line', () => {
		assert.throws(
			() => resolveShellEnv({
				workdir: scratch(),
				inherited,
				config: only({}),
				envFile: { path: '/tmp/broken', content: 'A=1\nOOPS\n' },
			}),
			(error) => /\/tmp\/broken/.test(error.message) && /2: expected KEY=VALUE/.test(error.message),
		)
	})

	it('refuses harness-managed names from any source', () => {
		assert.throws(
			() => resolveShellEnv({
				workdir: scratch(),
				inherited,
				config: only({ envVars: { DSH_SESSION_ID: 'x' } }),
			}),
			/DSH_SESSION_ID/,
		)
		assert.throws(
			() => resolveShellEnv({
				workdir: scratch(),
				inherited,
				config: only({}),
				envFile: { path: '/tmp/f', content: 'DSH_HOME=/elsewhere\n' },
			}),
			/DSH_HOME/,
		)
	})

	it('refuses an invalid inline variable name', () => {
		assert.throws(
			() => resolveShellEnv({
				workdir: scratch(),
				inherited,
				config: only({ envVars: { '2BAD': 'x' } }),
			}),
			/2BAD/,
		)
	})

	it('lets an explicit variable override the detected venv', () => {
		const root = scratch()
		makeVenv(join(root, '.venv'))
		const env = resolveShellEnv({
			workdir: root,
			inherited,
			config: only({ envVars: { VIRTUAL_ENV: '/manual' } }),
		})
		assert.equal(env.VIRTUAL_ENV, '/manual')
	})

	it('uses the fallback only when the workdir search misses', () => {
		const root = scratch()
		const fallback = makeVenv(join(root, 'global-venv'))
		const bare = join(root, 'no-venv-here')
		mkdirSync(bare, { recursive: true })
		const env = resolveShellEnv({
			workdir: bare,
			inherited,
			config: only({ venvFallback: fallback, venvMaxDepth: 0 }),
		})
		assert.equal(env.VIRTUAL_ENV, fallback)
		assert.equal(env.PATH, `${fallback}/bin:/usr/bin:/bin`)
	})

	it('prefers a project venv over the fallback', () => {
		const root = scratch()
		const fallback = makeVenv(join(root, 'global-venv'))
		const project = join(root, 'project')
		const projectVenv = makeVenv(join(project, '.venv'))
		const env = resolveShellEnv({
			workdir: project,
			inherited,
			config: only({ venvFallback: fallback }),
		})
		assert.equal(env.VIRTUAL_ENV, projectVenv)
	})

	it('ignores a fallback that is not a usable venv', () => {
		const root = scratch()
		const broken = join(root, 'broken-venv')
		mkdirSync(broken, { recursive: true })
		const env = resolveShellEnv({
			workdir: root,
			inherited,
			config: only({ venvFallback: broken, venvMaxDepth: 0 }),
		})
		assert.equal('VIRTUAL_ENV' in env, false)
		assert.equal(env.PATH, '/usr/bin:/bin')
	})

	it('skips venv handling entirely when disabled', () => {
		const root = scratch()
		makeVenv(join(root, '.venv'))
		const env = resolveShellEnv({
			workdir: root,
			inherited,
			config: only({ prependPath: ['/shims'], venvEnabled: false }),
		})
		assert.equal('VIRTUAL_ENV' in env, false)
		assert.equal(env.PATH, '/shims:/usr/bin:/bin')
	})

	it('passes the search boundary through to the walk', () => {
		const root = scratch()
		makeVenv(join(root, '.venv'))
		const boundary = join(root, 'boundary')
		const nested = join(boundary, 'project')
		mkdirSync(nested, { recursive: true })
		const blocked = resolveShellEnv({
			workdir: nested,
			inherited,
			config: only({ venvStopAt: boundary }),
		})
		assert.equal('VIRTUAL_ENV' in blocked, false)
		const allowed = resolveShellEnv({
			workdir: nested,
			inherited,
			config: only({ venvStopAt: join(root, 'nowhere') }),
		})
		assert.equal(allowed.VIRTUAL_ENV, join(root, '.venv'))
	})

	it('hands a configured startup file to bash as BASH_ENV', () => {
		const env = resolveShellEnv({
			workdir: scratch(),
			inherited,
			config: only({ bashEnv: '/home/me/.dsh/shell-env.sh' }),
		})
		assert.equal(env.BASH_ENV, '/home/me/.dsh/shell-env.sh')
	})

	it('omits BASH_ENV unless a startup file is configured', () => {
		const absent = resolveShellEnv({ workdir: scratch(), inherited, config: only({}) })
		assert.equal('BASH_ENV' in absent, false)
		const empty = resolveShellEnv({ workdir: scratch(), inherited, config: only({ bashEnv: '' }) })
		assert.equal('BASH_ENV' in empty, false)
	})

	it('lets an explicit variable win over the configured startup file', () => {
		const env = resolveShellEnv({
			workdir: scratch(),
			inherited,
			config: only({ bashEnv: '/configured.sh', envVars: { BASH_ENV: '/explicit.sh' } }),
		})
		assert.equal(env.BASH_ENV, '/explicit.sh')
	})

	it('takes the hook-env answer and skips the shims it makes unnecessary', () => {
		const root = scratch()
		const venv = makeVenv(join(root, '.venv'))
		const env = resolveShellEnv({
			workdir: root,
			inherited,
			config: { prependPath: ['/extra'], miseEnabled: true, miseShims: '/mise/shims' },
			miseEnv: { kind: 'hook-env', vars: { PATH: '/mise/go/bin:/usr/bin:/bin', JAVA_HOME: '/jdk', GOROOT: '/go' } },
		})
		assert.equal(env.DSH_MISE, 'hook-env')
		assert.equal(env.JAVA_HOME, '/jdk')
		assert.equal(env.GOROOT, '/go')
		// The venv and the configured entries still lead; the probe's PATH is the base.
		assert.equal(env.PATH, `${venv}/bin:/extra:/mise/go/bin:/usr/bin:/bin`)
		assert.ok(!env.PATH.includes('/mise/shims'), 'shims are not re-added when hook-env answered')
	})

	it('keeps the shims when the probe could not answer, and says so', () => {
		const env = resolveShellEnv({
			workdir: scratch(),
			inherited,
			config: { miseEnabled: true, miseShims: '/mise/shims' },
			miseEnv: { kind: 'shims-fallback', detail: 'mise hook-env exited with 3' },
		})
		assert.equal(env.DSH_MISE, 'shims-fallback')
		assert.equal(env.PATH, '/mise/shims:/usr/bin:/bin')
	})

	it('reports plain shims when the probe was never asked for', () => {
		const env = resolveShellEnv({
			workdir: scratch(),
			inherited,
			config: { miseEnabled: true, miseShims: '/mise/shims' },
		})
		assert.equal(env.DSH_MISE, 'shims')
	})

	it('claims no mise fact at all when mise support is off', () => {
		const env = resolveShellEnv({ workdir: scratch(), inherited, config: { miseEnabled: false } })
		assert.equal('DSH_MISE' in env, false)
	})

	it('sets no PATH when nothing is prepended and none is inherited', () => {
		const env = resolveShellEnv({ workdir: scratch(), inherited: {}, config: only({}) })
		assert.equal('PATH' in env, false)
	})
})
