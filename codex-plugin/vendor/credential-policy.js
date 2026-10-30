/**
 * Credential locations the file tools refuse to touch.
 *
 * DSH's own filesystem layer does not fence these paths, so a tool that can
 * access any OS-readable file could hand a model the operator's API tokens and
 * private keys. The plugin's file surface is narrower than a general reader on
 * purpose: it is a repository tool, and none of its jobs need a credential file.
 *
 * The fence is on the PATH, not on one direction of access. A credential
 * location is refused as a read (a single path, a batch operation root, and every
 * child of a recursion), a write/edit/replace/remove target, or a copy/move
 * destination, including under danger-full-access. The key remains named
 * `denyCredentialReads` for compatibility: only its name is read-only.
 *
 * @module dsh-ops/credential-policy
 */
import fs from 'node:fs';
import path from 'node:path';
/** Environment variable naming extra denied paths, separated by the platform delimiter. */
export const DENY_ENV = 'DSH_OPS_DENY_READ';
/**
 * Credential files and directories, as path suffixes below the user's home.
 *
 * A suffix is matched on whole path components, case-insensitively, so
 * `~/.ssh/id_ed25519` is denied by `~/.ssh` and a file merely named
 * `ssh-notes.txt` is not.
 * @type {readonly string[]}
 */
export const CREDENTIAL_SUFFIXES = Object.freeze([
    '.ssh',
    '.aws',
    '.azure',
    '.config/gcloud',
    '.kube',
    '.docker/config.json',
    '.netrc',
    '_netrc',
    '.git-credentials',
    '.npmrc',
    '.pypirc',
    '.codex/auth.json',
    '.codex/secrets',
    '.codex/.sandbox-secrets',
    '.dsh/.credentials.yaml',
    '.dsh/.credentials.yml',
]);
/** The subset of the list that names a directory, used to skip traversals. */
const CREDENTIAL_DIR_SUFFIXES = Object.freeze([
    '.ssh',
    '.aws',
    '.azure',
    '.config/gcloud',
    '.kube',
    '.codex/secrets',
    '.codex/.sandbox-secrets',
]);
/** Components that name a private key or a credential store wherever they live. */
const CREDENTIAL_NAMES = Object.freeze([
    /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
    /(^|\/)\.codex\/auth\.json(\.[^/]*)?$/i,
    /(^|\/)[^/]*credentials[^/]*\.(json|ya?ml|ini)$/i,
    /(^|\/)service-account[^/]*\.json$/i,
    /(^|\/)\.env(\.|$)/i,
]);
/** Extra suffixes from the environment, resolved once per call so a deployment can add its own. */
function configuredSuffixes(env) {
    const raw = env?.[DENY_ENV];
    if (typeof raw !== 'string' || raw.trim() === '')
        return [];
    return raw.split(path.delimiter).map(entry => entry.trim()).filter(entry => entry !== '');
}
/**
 * The extra denied locations from the environment, as `[comparisonForm, label]` pairs.
 *
 * An absolute entry is used as written; a relative one is resolved below the home.
 * Absolute entries work without a home. Labels stay internal and are never included in refusals.
 * @param {NodeJS.ProcessEnv} env - the environment to read.
 * @param {string|undefined} resolvedHome - the home directory for relative entries.
 * @returns {Array<[string, string]>} the comparison form and the entry as written.
 */
function configuredRoots(env, resolvedHome) {
    const roots = [];
    for (const entry of configuredSuffixes(env)) {
        if (path.isAbsolute(entry)) {
            roots.push([canonical(entry), entry]);
            continue;
        }
        if (typeof resolvedHome === 'string' && resolvedHome !== '')
            roots.push([canonical(path.join(resolvedHome, entry)), entry]);
    }
    return roots;
}

/**
 * Credential locations below an explicit CODEX_HOME. These stay separate from
 * the home-relative defaults because Codex can be configured to keep its state
 * outside the user's home directory.
 * @param {NodeJS.ProcessEnv} env - the environment to read.
 * @returns {Array<[string, string]>} canonical roots and their stable labels.
 */
function codexHomeRoots(env) {
    const codexHome = env?.CODEX_HOME;
    if (typeof codexHome !== 'string' || codexHome.trim() === '' || !path.isAbsolute(codexHome))
        return [];
    return ['auth.json', 'secrets', '.sandbox-secrets'].map(name => [
        canonical(path.join(codexHome, name)),
        `$CODEX_HOME/${name}`,
    ]);
}

/**
 * Match auth.json backups below an explicit CODEX_HOME, including roots whose
 * directory is not literally named `.codex`.
 * @param {string} target - the slash-normalized canonical target.
 * @param {NodeJS.ProcessEnv} env - the environment to read.
 * @returns {boolean} whether the target is a top-level Codex auth file.
 */
function codexHomeAuthFile(target, env) {
    const codexHome = env?.CODEX_HOME;
    if (typeof codexHome !== 'string' || codexHome.trim() === '' || !path.isAbsolute(codexHome))
        return false;
    const root = canonical(codexHome);
    const prefix = `${root.toLowerCase()}/`;
    const lower = target.toLowerCase();
    if (!lower.startsWith(prefix))
        return false;
    const relative = target.slice(root.length + 1);
    return !relative.includes('/') && /^auth\.json(\.[^/]*)?$/i.test(relative);
}
/**
 * Canonicalize a path for comparison: absolute, symlink-resolved where it
 * exists, and separator-normalized. A path that cannot be resolved is compared
 * as written, so a missing target is still matched by suffix.
 * @param {string} value - the path.
 * @returns {string} the comparison form.
 */
function canonical(value) {
    let resolved = path.resolve(value);
    try {
        resolved = fs.realpathSync.native(resolved);
    }
    catch {
        // Resolve the nearest existing parent too: a missing leaf below an 8.3
        // spelling must still compare against the canonical long credential root.
        const parent = path.dirname(resolved);
        if (parent !== resolved)
            resolved = path.join(canonical(parent), path.basename(resolved));
    }
    return resolved.split(path.sep).join('/');
}
/**
 * Whether one absolute path is inside a denied credential location.
 *
 * @param {string} candidate - the absolute path to test.
 * @param {object} [options] - comparison inputs.
 * @param {string} [options.home] - the home directory to resolve suffixes against.
 * @param {NodeJS.ProcessEnv} [options.env] - the environment to read extra entries from.
 * @returns {{denied: true, matched: string}|{denied: false}} the verdict and the suffix that matched.
 */
export function credentialPath(candidate, { home, env = process.env } = {}) {
    if (typeof candidate !== 'string' || candidate === '')
        return { denied: false };
    const target = canonical(candidate);
    const roots = [];
    const resolvedHome = home ?? env?.HOME ?? env?.USERPROFILE;
    if (typeof resolvedHome === 'string' && resolvedHome !== '') {
        for (const suffix of CREDENTIAL_SUFFIXES)
            roots.push([canonical(path.join(resolvedHome, suffix)), suffix]);
    }
    roots.push(...configuredRoots(env, resolvedHome));
    roots.push(...codexHomeRoots(env));
    for (const [root, suffix] of roots) {
        const comparableTarget = target.toLowerCase();
        const comparableRoot = root.toLowerCase();
        if (comparableTarget === comparableRoot || comparableTarget.startsWith(`${comparableRoot}/`))
            return { denied: true, matched: suffix };
    }
    for (const pattern of CREDENTIAL_NAMES) {
        if (pattern.test(target))
            return { denied: true, matched: String(pattern) };
    }
    if (codexHomeAuthFile(target, env))
        return { denied: true, matched: '$CODEX_HOME/auth.json' };
    return { denied: false };
}
/**
 * The credential locations as absolute directories, for a caller that wants to
 * skip them during a traversal rather than refuse one path.
 *
 * Only the directory-shaped suffixes are returned: a file such as `.npmrc` is
 * not a root to walk around, and skipping its parent would hide the whole home
 * directory.
 * @param {object} [options] - the same inputs as {@link credentialPath}.
 * @returns {string[]} the absolute directories, deduplicated.
 */
export function credentialRoots({ home, env = process.env } = {}) {
    const resolvedHome = home ?? env?.HOME ?? env?.USERPROFILE;
    const roots = new Set();
    if (typeof resolvedHome === 'string' && resolvedHome !== '') {
        for (const suffix of CREDENTIAL_SUFFIXES)
            roots.add(canonical(path.join(resolvedHome, suffix)));
    }
    for (const [root] of configuredRoots(env, resolvedHome))
        roots.add(root);
    for (const [root] of codexHomeRoots(env))
        roots.add(root);
    return [...roots];
}
/**
 * The refusal a denied operation reports. The wording names the fence and the way
 * out, because "denied" without either invites a retry loop, and it names both
 * directions: a caller stopped from writing must not read the message as "reads
 * are fenced" (#204 P4).
 * Denied paths and matching rules are intentionally absent: either can reveal a real parent path.
 * @param {string} _candidate - ignored; retained for internal call compatibility.
 * @param {string} _matched - ignored; the refusal does not disclose the matching rule.
 * @returns {{code: string, message: string, nextAction: string}} the refusal.
 */
export function credentialRefusal(_candidate, _matched) {
    return {
        code: 'POLICY_DENIED',
        message: 'The requested path is inside a credential location; the dsh-ops file tools neither read nor write credentials: reads, writes, copy/move destinations, replace targets and removal are refused.',
        nextAction: 'Use a path inside the workspace. An operator who really needs this path can add it to '
            + `${DENY_ENV} (which only widens the list) or disable the fence with denyCredentialReads: false.`,
    };
}
