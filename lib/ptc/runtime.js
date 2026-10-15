/** Runtime discovery is installation-relative; explicit selections never silently fall back. */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const PLATFORMS = Object.freeze(['win32-x64', 'linux-x64'])
export function workerName(platform = process.platform) { return platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker' }
/**
 * Read a JSON file, or name it.
 *
 * A missing receipt used to surface as a raw `ENOENT` out of `readFileSync`: it named
 * a path, but never said that the staged runtime was incomplete, which is the one
 * thing a caller has to know to fix it.
 */
function readJson(file, what) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (error) { throw new Error(`Native worker ${what} at ${file} could not be read: ${error.message}`) }
  try { return JSON.parse(text) } catch (error) { throw new Error(`Native worker ${what} at ${file} is not valid JSON: ${error.message}`) }
}
export function resolveWorker(config = {}, { packageRoot = PACKAGE_ROOT, env = process.env, platform = process.platform, arch = process.arch } = {}) {
  if (!PLATFORMS.includes(`${platform}-${arch}`)) throw new Error(`dsh-ops 0.3.0 supports Windows x64 and Linux x64 only; unsupported runtime target ${platform}-${arch}.`)
  const explicit = config.binaryPath ?? env.DSH_OPS_WORKER_BIN
  const candidates = explicit !== undefined ? [explicit] : [
    path.join(packageRoot, 'runtime', `${platform}-${arch}`, workerName(platform)),
    path.join(packageRoot, 'native', 'target', 'release', workerName(platform)),
  ]
  const skipped = []
  for (const file of candidates) {
    if (!path.isAbsolute(file)) throw new Error('Native worker selection must be an absolute path.')
    let stat
    try { stat = fs.statSync(file) } catch (error) {
      // Only "no such file" is an ordinary miss for a candidate list. A directory the
      // process may not traverse, or a symlink that dangles, is a real condition that
      // an "unavailable" message would hide behind the same words.
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw new Error(`Native worker candidate ${file} could not be inspected: ${error.message}`)
      skipped.push(`${file} (absent)`); continue
    }
    if (!stat.isFile()) { skipped.push(`${file} (not a regular file)`); continue }
    // Windows has no execute bit, so this is POSIX-only. Without it, a worker copied
    // over without its mode was accepted here and failed later as a bare `EACCES`
    // from `spawn`, which reads as a sandbox problem rather than a missing `chmod`
    // (report L12).
    if (platform !== 'win32' && (stat.mode & 0o111) === 0) {
      throw new Error(`Native worker ${file} is not executable (mode ${(stat.mode & 0o7777).toString(8).padStart(4, '0')}). Run chmod +x on it, or re-stage it with npm run build:ptc; dsh-ops never changes permissions on its own.`)
    }
    if (file.includes(`${path.sep}runtime${path.sep}`)) {
      const receipt = readJson(path.join(path.dirname(file), 'provenance.json'), 'provenance receipt')
      const version = readJson(path.join(packageRoot, 'package.json'), 'package manifest').version
      if (receipt.target !== `${platform}-${arch}` || receipt.version !== version || receipt.executable !== workerName(platform)
        || receipt.sha256 !== createHash('sha256').update(fs.readFileSync(file)).digest('hex')) throw new Error('Native worker provenance mismatch.')
    }
    return file
  }
  throw new Error(`Native worker unavailable for ${platform}-${arch}. Tried:\n${skipped.map(entry => `  ${entry}`).join('\n')}\nInstall a runtime-bearing dsh-ops package, or run npm run build:ptc in the source checkout. No ACL repair, shell fallback or automatic download is performed.`)
}
