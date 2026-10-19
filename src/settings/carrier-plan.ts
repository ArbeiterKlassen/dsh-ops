/** Offline planning against the host's actual persistent profile composition. */
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type * as Boot from '@deepseek-ai/dsh-app-boot'
import type * as Yaml from 'yaml'
import type * as Atomic from '@deepseek-ai/dsh-atomic-write'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { COMPONENTS } from '../components/defaults.js'

export const CLIENT_BUNDLE = 'dsh-ops/lib/profiles/client'
export interface CarrierHost { boot: typeof Boot; yaml: typeof Yaml; atomic: typeof Atomic }
export interface CarrierLocation { dir: string; home: string; installAnchor: string }
export interface FileChange { path: string; before?: string; after: string; mode: number }
export interface CarrierPlan { files: FileChange[]; changedQualifiers: number; beforeRows: EntryOptions[]; afterRows: EntryOptions[]; location: CarrierLocation }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object in the profile manifest.')
  return value as Record<string, unknown>
}
function read(file: string, optional = false): { text?: string; mode: number } {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error(`Expected a regular profile file at most 1 MiB: ${file}`)
    return { text: fs.readFileSync(file, 'utf8'), mode: stat.mode & 0o777 }
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return { mode: 0o600 }
    throw error
  }
}
const flatten = (rows: EntryOptions[]): EntryOptions[] => rows.flatMap(row => [row, ...row.group && Array.isArray(row.config) ? flatten(row.config as EntryOptions[]) : []])
export function profileContext(location: CarrierLocation): Boot.ProfileContext {
  return { ...location, name: path.basename(location.dir), cwd: location.dir, patchPath: path.join(location.dir, 'cordis.patch.yml'), startedBundles: [], overlays: [], telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED }
}
export function prepareCarrier(host: CarrierHost, location: CarrierLocation): CarrierPlan {
  for (const value of Object.values(location)) if (!path.isAbsolute(value)) throw new Error('Profile directory, DSH home and host anchor must be absolute paths.')
  const directoryStat = fs.lstatSync(location.dir)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Use a physical profile directory, not a symbolic link.')
  const manifestPath = path.join(location.dir, 'package.json'), patchPath = path.join(location.dir, 'cordis.patch.yml')
  const manifestFile = read(manifestPath), patchFile = read(patchPath, true)
  const manifest = object(JSON.parse(manifestFile.text!)), dsh = object(manifest.dsh), profile = object(dsh.profile)
  const bundles = profile.bundles
  if (!Array.isArray(bundles) || bundles.some(name => typeof name !== 'string')) throw new Error('Profile bundles must be a string array.')
  if (bundles.filter(name => name === 'dsh-ops').length !== 1 || bundles.includes(CLIENT_BUNDLE)) throw new Error('Select exactly one default dsh-ops bundle before this one-time migration.')
  const context = profileContext(location), loaded = host.boot.loadProfileDirectory('dsh', location.dir, location.installAnchor)
  if (loaded.skippedBundles.length) throw new Error('Resolve skipped profile bundles before enabling custom settings.')
  // Equal values today do not erase a saved override's intent when defaults change later.
  const external = host.boot.readProfilePatches('dsh', context, { ...loaded, patches: [],
    layers: loaded.layers.filter(layer => layer.packageName !== 'dsh-ops') })
  if (external.some(patch => !patch.insert && patch.id === 'dsh-ops-file' && patch.name === 'dsh-ops/file')) throw new Error('External name-qualified file overrides require manual review; nothing was written.')
  const original = host.boot.composeEntries([host.boot.readProfilePatches('dsh', context, loaded)])
  const own = flatten(original).filter(row => row.id?.startsWith('dsh-ops-'))
  if (own.length !== 7 || COMPONENTS.some(name => own.filter(row => row.id === `dsh-ops-${name}` && row.name === `dsh-ops/${name}`).length !== 1)) throw new Error('Expected the seven unique legacy-named OPS rows; custom insertions or shadowing require manual review.')
  const document = host.yaml.parseDocument(patchFile.text ?? '[]\n', { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (document.errors.length || !host.yaml.isSeq(document.contents)) throw new Error('Profile patch must be a valid YAML sequence.')
  let changedQualifiers = 0
  for (const node of document.contents.items) {
    if (host.yaml.isMap(node) && node.get('id', true)?.toJSON() === 'dsh-ops-file' && !node.has('insert') && node.get('name', true)?.toJSON() === 'dsh-ops/file') {
      node.delete('name'); changedQualifiers++
    }
  }
  const patchAfter = changedQualifiers ? String(document) : patchFile.text ?? '[]\n'
  const parsed = host.yaml.parseDocument(patchAfter, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }] }).toJS() as PatchOptions[]
  const neutral = { ...loaded, patches: parsed }
  if (!isDeepStrictEqual(host.boot.composeEntries([host.boot.readProfilePatches('dsh', context, neutral)]), original)) throw new Error('Removing a file-row matcher would change effective configuration; nothing was written.')
  const parent = loaded.layers.find(layer => layer.packageName === 'dsh-ops')!
  const directory = host.boot.resolveBundleDir('dsh', CLIENT_BUNDLE, location.installAnchor, location.dir)
  if (fs.realpathSync(directory) !== fs.realpathSync(path.join(parent.packageDir, 'lib/profiles/client'))) throw new Error('The optional layer must belong to the selected OPS installation.')
  const patch = path.join(directory, 'cordis.patch.yml')
  const alternate = { packageName: CLIENT_BUNDLE, packageDir: directory, patchPaths: [patch], patches: host.boot.loadOverlayPatches('dsh', patch) }
  const candidate = { ...neutral, layers: loaded.layers.map(layer => layer === parent ? alternate : layer) }
  const afterRows = host.boot.composeEntries([host.boot.readProfilePatches('dsh', context, candidate)])
  const expected = structuredClone(original)
  flatten(expected).find(row => row.id === 'dsh-ops-file')!.name = 'dsh-ops'
  if (!isDeepStrictEqual(afterRows, expected)) throw new Error('The optional layer or a higher-priority patch changes more than the carrier name; nothing was written.')
  profile.bundles = bundles.map(name => name === 'dsh-ops' ? CLIENT_BUNDLE : name)
  return { location, changedQualifiers, beforeRows: original, afterRows,
    files: [...(patchFile.text === undefined ? [] : [{ path: patchPath, before: patchFile.text, after: patchAfter, mode: patchFile.mode }]),
      { path: manifestPath, before: manifestFile.text, after: JSON.stringify(manifest, null, 2) + '\n', mode: manifestFile.mode }] }
}
