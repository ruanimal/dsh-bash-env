/**
 * Client-half smoke test.
 *
 * The browser half cannot be rendered here: the shell's primitives import React
 * and CSS modules, neither of which resolves outside the browser bundle. What is
 * checkable without a DOM is still worth checking, because these are the
 * failures that would otherwise appear only as a silently missing settings
 * section:
 *
 *   1. the bundle registers under the package id the client module system looks
 *      up;
 *   2. `apply` registers its dictionary, binds the **profile entry id** the Host
 *      composes, and registers into the `settings.section` slot — the dedicated
 *      bucket, not a row of General;
 *   3. the card's control list matches the dictionary, so no label renders as a
 *      raw key.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(packageDir, 'lib/client.js'), 'utf8')

/** A minimal element shape, enough to walk the tree the card builds. */
function element(type, props) {
	return { __element: true, type, props: props ?? {} }
}

/**
 * Evaluate the bundle against stubbed globals and return its factory result.
 *
 * @param overrides - stub replacements, keyed by required module name.
 * @returns the bundle's exports.
 */
function loadBundle(overrides) {
	let definition
	const window = {
		__ModuleLoader__: {
			load: (loaded) => {
				definition = loaded
			},
		},
	}
	// eslint-disable-next-line no-new-func -- the bundle is a browser script, not a module
	new Function('window', source)(window)
	assert.ok(definition, 'the bundle registered itself with the module loader')
	// Function components are invoked the way a renderer would, so the tree the
	// assertions walk is the one the card actually builds — including the copy a
	// nested component reads from the dictionary. Shell-provided components are
	// strings in these stubs and simply become element nodes.
	const jsxRuntime = {
		Fragment: Symbol('Fragment'),
		jsx: (type, props) => (typeof type === 'function' ? type(props) : element(type, props)),
		jsxs: (type, props) => (typeof type === 'function' ? type(props) : element(type, props)),
	}
	const require = (name) => {
		if (Object.hasOwn(overrides, name)) return overrides[name]
		if (name === 'react/jsx-runtime') return jsxRuntime
		if (name === '@deepseek-ai/dsh-client-ui-primitives') {
			return {
				SettingsFormModel: FakeFormModel,
				SettingsForm: 'SettingsForm',
				SettingsValueField: 'SettingsValueField',
				settingsNumberField: (field) => ({ field, format: String, parse: (text) => ({ kind: 'set', value: Number(text) }) }),
				settingsTextField: (field) => ({ field, format: String, parse: (text) => ({ kind: 'set', value: text }) }),
			}
		}
		throw new Error(`unexpected require(${JSON.stringify(name)})`)
	}
	return { id: definition.id, exports: definition.factory(require) }
}

/** Collect every string in an element tree, in render order. */
function collectStrings(node, out = []) {
	if (typeof node === 'string') out.push(node)
	else if (Array.isArray(node)) for (const item of node) collectStrings(item, out)
	else if (node !== null && typeof node === 'object' && node.__element === true) collectStrings(node.props.children, out)
	return out
}

/** A stand-in for the shell's `SettingsFormModel`, recording what it was given. */
/** Every model this suite constructed, in order, so a test can reach its scope. */
const models = []

class FakeFormModel {
	constructor(scope, specs) {
		this.scope = scope
		models.push(this)
		this.specs = specs
		this.edits = []
		this.resets = []
	}
	bind(project) {
		this.project = project
		return { get: () => project() }
	}
	shell() {
		return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
	}
	field(name) {
		return { text: `value-of-${name}`, overridden: false, invalid: false }
	}
	actions() {
		return {
			edit: (field, text) => this.edits.push([field, text]),
			resetField: (field) => this.resets.push(field),
			save: () => {},
			discard: () => {},
		}
	}
	dispose() {
		this.disposed = true
	}
}

/**
 * Build the browser plugin context `apply` expects.
 *
 * @returns the fake context plus the records it filled in.
 */
function makeContext(options = {}) {
	const scopes = []
	const registered = []
	const dictionaries = []
	const served = []
	const effects = []
	const ctx = {
		locale: {
			bind: () => (key) => key,
			register: (ns, bundle) => dictionaries.push([ns, bundle]),
		},
		slots: {
			register: (options, component) => registered.push([options, component]),
		},
		configForms: {
			get: (id) => {
				const scope = {
					id,
					spec: { namespace: id },
					subscribe: () => () => {},
					getSnapshot: () => options.scopeSnapshot ?? ({ status: 'ready', writable: true, value: {}, user: {}, revision: 1 }),
					mutate: options.scopeMutate ?? (async () => true),
				}
				scopes.push(scope)
				return scope
			},
			whileServed: (ids, callback) => {
				served.push(ids)
				callback(new Set(ids))
			},
		},
		effect: (fn) => {
			effects.push(fn())
		},
	}
	if (options.remoteMutate !== undefined) {
		ctx.remote = { settings: { mutate: options.remoteMutate } }
	}
	return { ctx, registered, dictionaries, served, effects, scopes }
}

/** The most recently constructed controller's wrapped scope. */
function lastScope() {
	return models.at(-1).scope
}

/** Read the bundle's own dictionary out of a fresh `apply`. */
function exportsLocale(exports) {
	const seen = []
	const ctx = {
		locale: { bind: () => (key) => key, register: (ns, bundle) => seen.push(bundle) },
		slots: { register: () => {} },
		configForms: { get: () => ({}), whileServed: (_ids, callback) => callback(new Set()) },
		effect: (fn) => {
			fn()
		},
	}
	exports.apply(ctx)
	return { ...seen[0].en, ...seen[0].zh }
}

describe('client bundle', () => {
	it('registers under the package id', () => {
		const { id } = loadBundle({})
		assert.equal(id, 'dsh-bash-env')
	})

	it('registers its dictionary, its form, and a dedicated settings section', () => {
		const { exports } = loadBundle({
			'@deepseek-ai/dsh-client-ui-primitives': { SettingsFormModel: FakeFormModel, SettingsForm: 'SettingsForm', SettingsValueField: 'SettingsValueField', settingsNumberField: (field) => ({ field, format: String, parse: (text) => ({ kind: 'set', value: Number(text) }) }), settingsTextField: (field) => ({ field, format: String, parse: (text) => ({ kind: 'set', value: text }) }) },
		})
		const { ctx, registered, dictionaries, served } = makeContext()
		exports.apply(ctx)

		assert.deepEqual(dictionaries.map(([ns]) => ns), ['settings.bashEnv'])
		const [, bundle] = dictionaries[0]
		assert.equal(typeof bundle.zh.title, 'string')
		assert.equal(typeof bundle.en.title, 'string')

		// The dedicated bucket, not `settings.general.item`.
		assert.equal(registered.length, 1)
		const [options] = registered[0]
		assert.equal(options.name, 'settings.section')
		assert.equal(options.id, 'bash-env')
		assert.equal(options.order, 12)
		assert.equal(options.locale, 'settings.bashEnv')
		assert.equal(typeof options.label, 'function')

		// Bound to the profile entry the Host composes, and gated on it being served.
		assert.deepEqual(served, [['bash-env']])
	})

	it('binds every control the schema exposes, and no unknown one', () => {
		const { exports } = loadBundle({
			'@deepseek-ai/dsh-client-ui-primitives': { SettingsFormModel: FakeFormModel, SettingsForm: 'SettingsForm', SettingsValueField: 'SettingsValueField', settingsNumberField: (field) => ({ field }), settingsTextField: (field) => ({ field }) },
		})
		assert.deepEqual(exports.FIELD_SPECS.map((spec) => spec.field), [
			'timeoutMs',
			'maxOutputBytes',
			'prependPath',
			'envFile',
			'envVars',
			'bashEnv',
			'venvEnabled',
			'venvNames',
			'venvMaxDepth',
			'venvStopAt',
			'venvFallback',
			'miseEnabled',
			'miseShims',
			'miseAutoInstall',
		])
	})

	it('asks the dictionary for every label it renders', () => {
		const { exports } = loadBundle({})
		const { ctx, registered } = makeContext()
		exports.apply(ctx)
		const [options, component] = registered[0]
		const keys = []
		const t = (key) => {
			keys.push(key)
			return key
		}
		const face = options.inject()
		const tree = component({
			t,
			view: 'full',
			useBashEnvCard: (select) => select(face.hooks.bashEnvCard.get()),
			...face,
		})
		assert.equal(tree.type, 'SettingsForm')
		for (const key of ['timeoutMs', 'maxOutputBytes', 'prependPath', 'envFile', 'envVars', 'bashEnv', 'venvEnabled', 'venvNames', 'venvMaxDepth', 'venvStopAt', 'venvFallback', 'miseEnabled', 'miseShims', 'miseAutoInstall']) {
			assert.ok(keys.includes(key), `the card renders a control for ${key}`)
		}
		for (const key of ['introTitle', 'introLead', 'introOrderLabel', 'introWhenLabel', 'introErrorsLabel', 'introScope', 'introShellCardNote', 'groupBudgets', 'groupBudgetsNote', 'groupPath', 'groupVenv', 'groupMise']) {
			assert.ok(keys.includes(key), `the card renders the ${key} heading`)
		}
		// Both dictionaries carry that copy, so no label renders as a raw key.
		const dictionary = exportsLocale(exports)
		for (const key of keys) assert.ok(Object.hasOwn(dictionary, key), `the dictionary defines ${key}`)
	})

	it('tolerates a boolean handed back as text', () => {
		const { exports } = loadBundle({})
		const spec = exports.FIELD_SPECS.find((entry) => entry.field === 'venvEnabled')
		// The Host may report the stored value as a string; formatting that as `''`
		// would show an enabled option as unchecked and make a redundant write.
		assert.equal(spec.format('true'), 'true')
		assert.equal(spec.format('false'), 'false')
		assert.equal(spec.format(true), 'true')
		assert.equal(spec.format(undefined), '')
	})

	it('unwraps a volatile reader so no control renders empty', () => {
		const { exports } = loadBundle({})
		// A reader instead of a value: every `typeof` check fails on it, so a form
		// that does not unwrap shows an empty box (and an unchecked checkbox) for a
		// value that is configured — which is how a save ends up clearing it.
		assert.equal(exports.unwrapField({ get: () => true }), true)
		assert.deepEqual(exports.unwrapField({ get: () => ['/a'] }), ['/a'])
		assert.equal(exports.unwrapField('plain'), 'plain')
		assert.equal(exports.unwrapField(undefined), undefined)
		assert.deepEqual(exports.unwrapRecord({ a: { get: () => ['/x'] }, b: 2 }), { a: ['/x'], b: 2 })
		assert.equal(exports.unwrapRecord(undefined), undefined)
	})

	it('unwraps the snapshot the form model reads through', () => {
		const { exports } = loadBundle({})
		const { ctx, registered } = makeContext({
			scopeSnapshot: {
				status: 'ready',
				writable: true,
				revision: 1,
				value: { miseEnabled: { get: () => true }, prependPath: { get: () => ['/a'] } },
				user: { miseEnabled: { get: () => true } },
			},
		})
		exports.apply(ctx)
		assert.ok(registered.length === 1)
		const snapshot = lastScope().getSnapshot()
		assert.equal(snapshot.miseEnabled, undefined, 'the snapshot itself is untouched')
		assert.equal(snapshot.value.miseEnabled, true)
		assert.deepEqual(snapshot.value.prependPath, ['/a'])
		assert.equal(snapshot.user.miseEnabled, true)
	})

	it('explains a stale revision and reports the replay as a save', async () => {
		const { exports } = loadBundle({})
		const { ctx, registered } = makeContext({
			scopeMutate: async () => false,
			remoteMutate: async () => ({ ok: true }),
		})
		exports.apply(ctx)
		const [options] = registered[0]
		const face = options.inject()
		await lastScope().mutate([{ op: 'set', path: ['miseEnabled'], value: false }], 1)
		assert.equal(face.hooks.bashEnvCard.get().failure.kind, 'stale')
	})

	it('shows the Host reason when the write is refused again', async () => {
		const { exports } = loadBundle({})
		const { ctx, registered } = makeContext({
			scopeMutate: async () => false,
			remoteMutate: async () => ({ ok: false, error: { code: 'settings/rejected', message: 'miseEnabled must be a boolean' } }),
		})
		exports.apply(ctx)
		const [options, component] = registered[0]
		const face = options.inject()
		const landed = await lastScope().mutate([{ op: 'set', path: ['miseEnabled'], value: false }], 1)
		assert.equal(landed, false)
		const failure = face.hooks.bashEnvCard.get().failure
		assert.equal(failure.kind, 'reason')
		assert.equal(failure.code, 'settings/rejected')
		assert.match(failure.message, /must be a boolean/)
		const tree = component({
			t: (key) => key,
			view: 'full',
			useBashEnvCard: (select) => select(face.hooks.bashEnvCard.get()),
			...face,
		})
		assert.ok(collectStrings(tree).includes('failureReasonLabel'), 'the card renders the reason line')
	})

	it('renders the fallback notice when the reason cannot be read', async () => {
		const { exports } = loadBundle({})
		// No `ctx.remote` at all: the reason is unreadable, so the card falls back
		// to naming the two usual causes.
		const { ctx, registered } = makeContext({ scopeMutate: async () => false })
		exports.apply(ctx)
		const [options, component] = registered[0]
		const face = options.inject()
		await lastScope().mutate([{ op: 'set', path: ['miseEnabled'], value: false }], 1)
		assert.equal(face.hooks.bashEnvCard.get().failure.kind, 'unknown')
		const tree = component({
			t: (key) => key,
			view: 'full',
			useBashEnvCard: (select) => select(face.hooks.bashEnvCard.get()),
			...face,
		})
		assert.ok(collectStrings(tree).includes('failureUnknown'))
	})

	it('converts each control between its text draft and its schema value', () => {
		const { exports } = loadBundle({
			'@deepseek-ai/dsh-client-ui-primitives': { SettingsFormModel: FakeFormModel, SettingsForm: 'SettingsForm', SettingsValueField: 'SettingsValueField', settingsNumberField: (field) => ({ field }), settingsTextField: (field) => ({ field }) },
		})
		const spec = (field) => exports.FIELD_SPECS.find((entry) => entry.field === field)

		// A list is one directory per line, and blank lines are not entries.
		assert.equal(spec('prependPath').format(['/a', '/b']), '/a\n/b')
		assert.deepEqual(spec('prependPath').parse('/a\n\n  /b  \n'), { kind: 'set', value: ['/a', '/b'] })
		assert.deepEqual(spec('prependPath').parse('   '), { kind: 'clear' })

		// A map round-trips, and one bad line invalidates the whole draft rather
		// than writing the good half and dropping the rest.
		assert.equal(spec('envVars').format({ A: '1', B: 'x=y' }), 'A=1\nB=x=y')
		assert.deepEqual(spec('envVars').parse('# c\nA=1\nB=$HOME'), { kind: 'set', value: { A: '1', B: '$HOME' } })
		assert.equal(spec('envVars').parse('A=1\nOOPS'), undefined)
		assert.equal(spec('envVars').parse('2BAD=1'), undefined)

		// A boolean is staged as the text the form stores.
		assert.equal(spec('venvEnabled').format(true), 'true')
		assert.equal(spec('venvEnabled').format(false), 'false')
		assert.deepEqual(spec('venvEnabled').parse(' TRUE '), { kind: 'set', value: true })
		assert.deepEqual(spec('venvEnabled').parse('false'), { kind: 'set', value: false })
		assert.equal(spec('venvEnabled').parse('yes'), undefined)
	})
})
