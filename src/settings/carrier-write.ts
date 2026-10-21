/** The neutral matcher update stays valid if interrupted before the bundle switch. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { prepareCarrier, profileContext } from './carrier-plan.js'
import type { CarrierHost, CarrierLocation, CarrierPlan } from './carrier-plan.js'
async function text(file: string): Promise<string | undefined> {
  try { return await fs.readFile(file, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
export async function applyCarrier(host: CarrierHost, reviewed: CarrierPlan): Promise<string> {
  const manifestPath = path.join(reviewed.location.dir, 'package.json')
  return host.atomic.withFileLock(manifestPath, async () => {
    const plan = prepareCarrier(host, reviewed.location)
    if (!isDeepStrictEqual(plan, reviewed)) throw new Error('Profile changed after the preview; review a fresh plan.')
    const backup = await fs.mkdtemp(path.join(plan.location.dir, '.dsh-ops-settings-backup-'))
    for (const file of plan.files) if (file.before !== undefined) await fs.writeFile(path.join(backup, path.basename(file.path)), file.before, { flag: 'wx', mode: 0o600 })
    await fs.writeFile(path.join(backup, 'recovery.json'), JSON.stringify({ files: plan.files.map(file => ({ name: path.basename(file.path), existed: file.before !== undefined })), order: 'Restore package.json before cordis.patch.yml while DSH is stopped.' }, null, 2), { flag: 'wx', mode: 0o600 })
    const written: typeof plan.files = []
    try {
      for (const file of plan.files) {
        if (await text(file.path) !== file.before) throw new Error('A profile file changed during migration.')
        if (file.after === file.before) continue
        written.push(file)
        await host.atomic.writeFileAtomic(file.path, file.after, { mode: file.mode })
      }
      const after = host.boot.composeEntries([host.boot.readProfilePatches('dsh', profileContext(plan.location))])
      if (!isDeepStrictEqual(after, plan.afterRows)) throw new Error('Saved profile composition did not match the reviewed plan.')
      return backup
    } catch (error) {
      const failures: string[] = []
      for (const file of written.reverse()) try {
        const current = await text(file.path)
        if (current === file.before) continue
        if (current !== file.after) throw new Error('A concurrent edit prevents automatic restoration.')
        if (file.before === undefined) await fs.unlink(file.path)
        else await host.atomic.writeFileAtomic(file.path, file.before, { mode: file.mode })
      } catch { failures.push(path.basename(file.path)) }
      throw new Error(`Settings migration failed: ${error instanceof Error ? error.message : String(error)} Backup: ${backup}.${failures.length ? ` Restore manually: ${failures.join(', ')}.` : ' Previous profile restored.'}`)
    }
  })
}
export async function carrierPreview(host: CarrierHost, location: CarrierLocation): Promise<CarrierPlan> {
  return host.atomic.withFileLock(path.join(location.dir, 'package.json'), async () => prepareCarrier(host, location))
}
