/** Generate the opt-in layer from canonical defaults; only the file specifier differs. */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parse, stringify } from 'yaml'
export function buildClientProfile(root) {
  const patches = parse(readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8'))
  const rows = patches.flatMap(patch => patch.insert ?? [])
  const files = rows.filter(row => row.id === 'dsh-ops-file')
  if (rows.length !== 7 || files.length !== 1 || files[0].name !== 'dsh-ops/file') throw new Error('Cannot derive the optional settings profile from this bundle layout.')
  files[0].name = 'dsh-ops'
  writeFileSync(path.join(root, 'lib/profiles/client/cordis.patch.yml'), '# Generated from the canonical bundle; do not edit.\n' + stringify(patches))
}
