#!/usr/bin/env node
/**
 * Link the host packages this plugin imports into its own `node_modules`.
 *
 * Why this is required: a profile plugin installed with `link:` keeps its real
 * path outside the profile tree, and dsh's loader resolves a linked plugin's
 * bare imports from that real path's own ancestor `node_modules` directories
 * (see `routeLinked` in `@deepseek-ai/dsh-app-boot`). Nothing on the way up from
 * `~/projects/...` contains `@deepseek-ai/*`, so without these links the plugin
 * fails to import with `ERR_MODULE_NOT_FOUND`.
 *
 * The links point at the profile tree's shared copies, which dsh itself symlinks
 * to the installation. Resolution therefore lands on the same real files the
 * host uses, so the service classes stay identical — a private copy of
 * `@deepseek-ai/cordis` or of an executor base class would break `ctx.shell`.
 *
 * Run it after cloning, after moving $DSH_HOME, and after an app update that
 * rebuilds the shared layer.
 *
 * Usage: node scripts/link-host.mjs
 */

import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Packages provided by the host and imported by this plugin. */
const HOST_PACKAGES = [
	'@deepseek-ai/cordis',
	'@deepseek-ai/schemastery',
	'@deepseek-ai/dsh-subprocess',
	'@deepseek-ai/dsh-session-projection',
	'@deepseek-ai/dsh-bash-local',
	'@deepseek-ai/dsh-bash-sandbox',
	'@deepseek-ai/dsh-sandbox-local',
	'@deepseek-ai/dsh-sandbox-policy',
	'@deepseek-ai/dsh-subprocess-local',
]

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const sharedLayer = join(dshHome, 'profiles', 'node_modules')

if (!existsSync(sharedLayer)) {
	process.stderr.write(`link-host: ${sharedLayer} does not exist; start the harness once so it installs its shared layer\n`)
	process.exit(1)
}

const missing = []
for (const name of HOST_PACKAGES) {
	const source = join(sharedLayer, name)
	if (!existsSync(source)) {
		missing.push(name)
		continue
	}
	const target = join(packageRoot, 'node_modules', name)
	mkdirSync(dirname(target), { recursive: true })
	// Recreated every run: a link is cheap, and this keeps the script correct
	// whether the previous link was absolute, relative, or stale.
	rmSync(target, { recursive: true, force: true })
	// A relative link keeps the plugin directory movable as a whole.
	symlinkSync(relative(dirname(target), source), target, 'dir')
}

const linked = HOST_PACKAGES.length - missing.length
process.stdout.write(`link-host: ${linked}/${HOST_PACKAGES.length} host package(s) linked from ${sharedLayer}\n`)
if (missing.length > 0) {
	process.stderr.write(`link-host: not present in the shared layer: ${missing.join(', ')}\n`)
	process.exit(1)
}
