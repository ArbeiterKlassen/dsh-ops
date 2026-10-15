//! Native file-operation capabilities. All paths are host-resolved absolute paths;
//! this module never invokes a shell and never follows links.
use crate::contract::{Failure, Request, Result};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use fs2::FileExt;
use regex::RegexBuilder;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::os::windows::fs::MetadataExt as WindowsMetadataExt;

const MAX_ENTRIES: usize = 100_000;
const MAX_DEPTH: usize = 128;
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
/// Ceiling for one worker response. The host collects worker stdout with
/// `maxBytes: 128 * 1024` and turns a lossy read into `OUTPUT_LIMIT` plus
/// `effectState: "unknown"`, so a response that overflows is reported to the model
/// as an operation whose effect cannot be known — for a pure read, that is both
/// false and useless. Staying under the host cap is what keeps a read honest.
/// The budget is spent on the *serialized* items rather than the payload, because
/// escaping is the multiplier: one NUL byte costs six as `\u0000`, which is how a
/// 32 MiB file once produced 200 MB of stdout.
const MAX_OUTPUT_BYTES: usize = 96 * 1024;
/// Non-item fields of the envelope, counted against the same ceiling.
const ENVELOPE_OVERHEAD: usize = 512;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InspectArgs {
    path: String,
    #[serde(default = "one")]
    offset: usize,
    #[serde(default = "two_hundred")]
    limit: usize,
    #[serde(default = "utf8")]
    encoding: String,
    #[serde(default = "text")]
    view: String,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct GlobArgs {
    path: String,
    pattern: Vec<String>,
    #[serde(default)]
    output_mode: String,
    #[serde(default)]
    sort: String,
    #[serde(default)]
    offset: usize,
    #[serde(default = "one_hundred")]
    limit: usize,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct GrepArgs {
    path: String,
    pattern: String,
    #[serde(default)]
    glob: Vec<String>,
    #[serde(default)]
    output_mode: String,
    #[serde(default)]
    case_insensitive: bool,
    #[serde(default = "yes")]
    line_numbers: bool,
    #[serde(default)]
    before_context: usize,
    #[serde(default)]
    after_context: usize,
    #[serde(default)]
    multiline: bool,
    #[serde(default)]
    offset: usize,
    #[serde(default = "one_hundred")]
    limit: usize,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReplaceArgs {
    path: String,
    pattern: String,
    replacement: String,
    #[serde(default)]
    glob: Vec<String>,
    #[serde(default = "one_hundred")]
    max_replacements: usize,
    #[serde(default)]
    dry_run: bool,
}
fn one() -> usize { 1 }
fn two_hundred() -> usize { 200 }
fn one_hundred() -> usize { 100 }
fn yes() -> bool { true }
fn utf8() -> String { "utf-8".into() }
fn text() -> String { "text".into() }

pub fn dispatch(request: &Request) -> Result<Value> {
    match request.tool.as_str() {
        "inspect_local_file" => inspect(request),
        "glob" => glob(request),
        "grep" => grep(request),
        "replace" => replace(request),
        _ => Err(Failure::new("INVALID_ARGUMENT", "Unknown file capability")),
    }
}

fn target(raw: &str, _allow_missing: bool) -> Result<PathBuf> {
    Ok(crate::file_path::checked(raw)?.display)
}
fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}
fn hidden(path: &Path, root: &Path) -> bool {
    path.strip_prefix(root).ok().into_iter().flat_map(|p| p.components()).any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
}
fn host_link_or_reparse(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else { return true };
    if metadata.file_type().is_symlink() { return true; }
    #[cfg(windows)]
    if metadata.file_attributes() & 0x400 != 0 { return true; }
    false
}
struct WalkResult {
    files: Vec<PathBuf>,
    truncated: bool,
}

fn walk(root: &Path) -> Result<WalkResult> {
    let target = crate::file_path::checked(root.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?)?;
    let directory = target.parent.open_dir_nofollow(&target.name)?;
    let mut files = Vec::new();
    let mut truncated = false;
    visit_dir(root, root, directory, 0, &mut files, &mut truncated)?;
    Ok(WalkResult { files, truncated })
}
fn visit_dir(root: &Path, display: &Path, directory: cap_std::fs::Dir, depth: usize, output: &mut Vec<PathBuf>, truncated: &mut bool) -> Result<()> {
    if depth > MAX_DEPTH || output.len() >= MAX_ENTRIES {
        *truncated = true;
        return Ok(());
    }
    let mut names = Vec::new();
    // A directory can change while it is being read. A broken child directory
    // is skipped, while failure to enumerate the requested root remains visible.
    let entries = match directory.entries() {
        Ok(entries) => entries,
        Err(error) if depth == 0 => return Err(error.into()),
        Err(_) => return Ok(()),
    };
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.file_name().into_string() else { continue };
        names.push(name);
    }
    names.sort();
    for name in names {
        if crate::file_path::validate_name(&name).is_err() || name == ".git" { continue; }
        let metadata = match directory.symlink_metadata(&name) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if crate::file_path::link(&metadata) { continue; }
        let child = display.join(&name);
        if host_link_or_reparse(&child) { continue; }
        if hidden(&child, root) || matches!(name.as_str(), ".git" | ".dsh-ops" | "node_modules" | "target" | ".venv") { continue; }
        if metadata.is_file() {
            if output.len() >= MAX_ENTRIES { *truncated = true; return Ok(()); }
            output.push(child);
            continue;
        }
        if metadata.is_dir() {
            let Ok(child_dir) = directory.open_dir_nofollow(&name) else { continue };
            visit_dir(root, &child, child_dir, depth + 1, output, truncated)?;
            if *truncated && output.len() >= MAX_ENTRIES { return Ok(()); }
        }
    }
    Ok(())
}
fn positive_patterns(patterns: &[String]) -> impl Iterator<Item = &String> { patterns.iter().filter(|p| !p.starts_with('!')) }
fn matches_any(root: &Path, file: &Path, patterns: &[String]) -> bool {
    let name = relative_display(root, file);
    let positives: Vec<_> = positive_patterns(patterns).collect();
    let included = positives.is_empty() || positives.iter().any(|p| glob_match(p, &name));
    let excluded = patterns.iter().filter_map(|p| p.strip_prefix('!')).any(|p| glob_match(p, &name));
    included && !excluded
}
fn files_for(path: &str, patterns: &[String]) -> Result<WalkResult> {
    let root = target(path, false)?;
    if root.is_file() {
        return Ok(WalkResult { files: vec![root.clone()], truncated: false });
    }
    let walked = walk(&root)?;
    Ok(WalkResult {
        files: walked.files.into_iter()
            .filter(|f| matches_any(&root, f, patterns))
            .collect(),
        truncated: walked.truncated,
    })
}
fn glob_match(pattern: &str, value: &str) -> bool {
    let p: Vec<_> = pattern.trim_start_matches("./").split('/').collect();
    let v: Vec<_> = value.split('/').collect();
    glob_segments(&p, &v)
}
fn glob_segments(p: &[&str], v: &[&str]) -> bool {
    if p.is_empty() { return v.is_empty(); }
    if p[0] == "**" { return glob_segments(&p[1..], v) || (!v.is_empty() && glob_segments(p, &v[1..])); }
    !v.is_empty() && segment_match(p[0], v[0]) && glob_segments(&p[1..], &v[1..])
}
fn segment_match(pattern: &str, value: &str) -> bool {
    let (mut pi, mut vi, mut star, mut mark) = (0usize, 0usize, None, 0usize);
    let p = pattern.as_bytes(); let v = value.as_bytes();
    while vi < v.len() {
        if pi < p.len() && (p[pi] == b'?' || p[pi].eq_ignore_ascii_case(&v[vi])) { pi += 1; vi += 1; }
        else if pi < p.len() && p[pi] == b'*' { star = Some(pi); pi += 1; mark = vi; }
        else if let Some(s) = star { pi = s + 1; mark += 1; vi = mark; }
        else { return false; }
    }
    while pi < p.len() && p[pi] == b'*' { pi += 1; }
    pi == p.len()
}
fn hash_file(path: &Path) -> Result<String> {
    let bytes = read_bytes(path)?;
    Ok(format!("{:x}", Sha256::digest(&bytes)))
}
fn read_bytes(path: &Path) -> Result<Vec<u8>> {
    let raw = path.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?;
    let target = crate::file_path::checked(raw)?;
    let mut file = crate::file_path::read_file(&target)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES { return Err(Failure::new("OUTPUT_LIMIT", "File exceeds the bounded read budget")); }
    Ok(bytes)
}
fn modified(path: &Path) -> u64 { fs::symlink_metadata(path).ok().map_or(0, |m| m.len()) }
/// What one character costs in serde_json's encoding.
fn encoded_cost(character: char) -> usize {
    match character {
        '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
        c if (c as u32) < 0x20 => 6,
        c => c.len_utf8(),
    }
}
/// The longest prefix of `text` whose encoding fits `budget` bytes, cut on a
/// character boundary so the result is still valid UTF-8.
fn truncate_to_encoded(text: &str, budget: usize) -> (String, bool) {
    let mut kept = String::new(); let mut used = 0usize;
    for character in text.chars() { let cost = encoded_cost(character); if used + cost > budget { return (kept, true); } used += cost; kept.push(character); }
    (kept, false)
}
/// `offset` is how many units were skipped, counted from zero the way `glob` and
/// `grep` count their own `offset`. `next_base` is the value a caller must pass
/// back to resume, which is its own paging base rather than the skipped count:
/// `inspect` declares a 1-based `offset` (like its hex rows), so deriving the
/// next page from the skipped count re-read the last returned line on every page.
fn result(items: Vec<Value>, total: usize, offset: usize, next_base: usize, matched: usize, truncated: bool) -> Value {
    // Spend the response budget on the serialized items. Returning more than the
    // host will collect is not a bigger answer, it is a failed read: the host
    // truncates stdout, reports OUTPUT_LIMIT and declares the effect unknown, so
    // the caller loses the content and is told something may have changed.
    let budget = MAX_OUTPUT_BYTES.saturating_sub(ENVELOPE_OVERHEAD);
    let mut kept: Vec<Value> = Vec::new(); let mut used = 0usize; let mut stopped = false;
    for item in items {
        let size = serde_json::to_string(&item).map_or(0, |encoded| encoded.len()) + 1;
        if used + size <= budget { used += size; kept.push(item); continue; }
        // This item does not fit whole. Keep a bounded prefix of its text rather
        // than returning nothing at all, so a file holding one long line still
        // answers with its beginning; every remaining item is omitted and counted
        // as such. Reading past the cut is the hex view's job, which pages by
        // 16-byte rows.
        let whole = item.get("text").and_then(Value::as_str);
        let room = budget.saturating_sub(used).saturating_sub(96);
        let prefix = whole.map(|text| truncate_to_encoded(text, room));
        if let Some((text, cut)) = prefix {
            if !text.is_empty() {
                let mut trimmed = item.clone();
                trimmed["text"] = Value::String(text);
                trimmed["bytesTotal"] = json!(whole.map_or(0, |text| text.len()));
                trimmed["truncatedInLine"] = json!(cut);
                kept.push(trimmed);
            }
        }
        stopped = true;
        break;
    }
    let returned = kept.len(); let cut = truncated || stopped;
    json!({"status":"completed","phase":"verify","changed":0,"matched":matched,"skipped":offset,"failed":0,"complete":!cut && offset + returned >= total,"truncated":cut,"omitted":total.saturating_sub(offset + returned),"items":kept,"total":total,"nextOffset":next_base + returned})
}

fn inspect(request: &Request) -> Result<Value> {
    let args: InspectArgs = serde_json::from_value(request.args.clone())?;
    if args.limit == 0 || args.limit > 10_000 || !args.encoding.eq_ignore_ascii_case("utf-8") { return Err(Failure::new("INVALID_ARGUMENT", "inspect supports UTF-8 and a bounded limit")); }
    let path = target(&args.path, false)?;
    if !path.is_file() { return Err(Failure::new("INVALID_ARGUMENT", "path is a directory; use ops_glob or ops_grep")); }
    let bytes = read_bytes(&path)?;
    if bytes.len() as u64 > MAX_FILE_BYTES { return Err(Failure::new("OUTPUT_LIMIT", "file exceeds the inspect size budget")); }
    if args.view == "hex" {
        // `offset` means the same thing in both views: the 1-based unit to start
        // from — line N for text, 16-byte row N for hex. It used to count rows
        // from zero here while the text branch counted lines from one, so the
        // declared default of 1 skipped the first row, and the declared
        // `minimum: 1` left no way to ask for it back: any file of at most 16
        // bytes read back as an empty string. In this view `skipped` and the item
        // `offset` are byte counts, not row counts.
        let start = args.offset.saturating_sub(1).saturating_mul(16).min(bytes.len()); let end = (start + args.limit * 16).min(bytes.len());
        let text = bytes[start..end].iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ");
        return Ok(json!({"status":"completed","phase":"verify","changed":0,"matched":1,"skipped":start,"failed":0,"complete":end == bytes.len(),"omitted":bytes.len().saturating_sub(end),"bytesTotal":bytes.len(),"items":[{"path":path,"view":"hex","offset":start,"text":text}]}));
    }
    if args.view != "text" { return Err(Failure::new("INVALID_ARGUMENT", "view must be text or hex")); }
    let text = String::from_utf8(bytes).map_err(|_| Failure::new("INVALID_ARGUMENT", "file is not valid UTF-8"))?;
    let lines: Vec<_> = text.lines().enumerate().skip(args.offset.saturating_sub(1)).take(args.limit).map(|(i, line)| json!({"path":path,"line":i+1,"text":line})).collect();
    Ok(result(lines, text.lines().count(), args.offset.saturating_sub(1), args.offset, text.lines().count(), false))
}
fn glob(request: &Request) -> Result<Value> {
    let args: GlobArgs = serde_json::from_value(request.args.clone())?;
    if args.pattern.is_empty() || args.pattern.iter().all(|p| p.starts_with('!')) { return Err(Failure::new("INVALID_ARGUMENT", "pattern requires a positive glob")); }
    let root = target(&args.path, false)?; if !root.is_dir() { return Err(Failure::new("INVALID_ARGUMENT", "glob path must be a directory")); }
    let walked = walk(&root)?;
    let mut files: Vec<_> = walked.files.into_iter().filter(|f| matches_any(&root, f, &args.pattern)).collect();
    if args.sort == "modified" { files.sort_by_key(|f| std::cmp::Reverse(modified(f))); } else if !args.sort.is_empty() && args.sort != "path" { return Err(Failure::new("INVALID_ARGUMENT", "sort must be path or modified")); }
    let output_mode = if args.output_mode.is_empty() { "paths" } else { args.output_mode.as_str() };
    if output_mode != "paths" && output_mode != "details" { return Err(Failure::new("INVALID_ARGUMENT", "outputMode must be paths or details")); }
    let total = files.len(); let selected: Vec<_> = files.into_iter().skip(args.offset).take(args.limit).map(|f| if output_mode == "paths" { json!(f) } else { let modified_at = modified(&f); json!({"path":f,"bytes":fs::symlink_metadata(&f).map(|m|m.len()).unwrap_or(0),"modified":modified_at}) }).collect();
    Ok(result(selected, total, args.offset, args.offset, total, walked.truncated))
}
fn grep(request: &Request) -> Result<Value> {
    let args: GrepArgs = serde_json::from_value(request.args.clone())?;
    if args.pattern.is_empty() || args.limit == 0 || args.limit > 10_000 { return Err(Failure::new("INVALID_ARGUMENT", "pattern and bounded limit are required")); }
    if args.before_context > 32 || args.after_context > 32 { return Err(Failure::new("INVALID_ARGUMENT", "context is limited to 32 lines")); }
    let regex = RegexBuilder::new(&args.pattern).case_insensitive(args.case_insensitive).multi_line(args.multiline).build().map_err(|e| Failure::new("INVALID_ARGUMENT", e))?;
    let walked = files_for(&args.path, &args.glob)?; let mut matches = Vec::new(); let mut file_count = 0; let mut match_count = 0;
    for file in walked.files { let bytes = match read_bytes(&file) { Ok(bytes) => bytes, Err(_) => continue }; if bytes.len() as u64 > MAX_FILE_BYTES { continue; } let text = match String::from_utf8(bytes) { Ok(v) => v, Err(_) => continue }; let lines: Vec<_> = text.lines().collect(); let mut line_hits = Vec::new(); for (i, line) in lines.iter().enumerate() { if regex.is_match(line) { line_hits.push(i); } } if line_hits.is_empty() { continue; } file_count += 1; match_count += line_hits.len();
        match args.output_mode.as_str() { "files_with_matches" => matches.push(json!({"path":file})), "count" => matches.push(json!({"path":file,"count":line_hits.len()})), _ => { for i in line_hits { let start=i.saturating_sub(args.before_context); let end=(i+args.after_context+1).min(lines.len()); matches.push(json!({"path":file,"line":if args.line_numbers {i+1} else {0},"text":lines[start..end].join("\n")})); } } }
        if args.output_mode != "summary" && matches.len() >= args.offset + args.limit { break; }
    }
    if args.output_mode == "summary" { return Ok(json!({"status":"completed","phase":"verify","changed":0,"matched":match_count,"skipped":0,"failed":0,"complete":!walked.truncated,"truncated":walked.truncated,"omitted":0,"files":file_count,"matches":match_count})); }
    let total=matches.len(); Ok(result(matches.into_iter().skip(args.offset).take(args.limit).collect(), total, args.offset, args.offset, match_count, walked.truncated))
}
fn replace(request: &Request) -> Result<Value> {
    if request.read_only { return Err(Failure::new("POLICY_DENIED", "replace is unavailable in read-only mode")); }
    let args: ReplaceArgs = serde_json::from_value(request.args.clone())?;
    if args.pattern.is_empty() || args.max_replacements == 0 || args.max_replacements > 100_000 { return Err(Failure::new("INVALID_ARGUMENT", "pattern and maxReplacements are required")); }
    let walked = files_for(&args.path, &args.glob)?; let mut plans = Vec::new(); let mut total = 0usize;
    for file in walked.files { let bytes=read_bytes(&file)?; let text=String::from_utf8(bytes.clone()).map_err(|_| Failure::new("INVALID_ARGUMENT", "replace only supports UTF-8 files"))?; let count=text.match_indices(&args.pattern).count(); if count>0 { total += count; plans.push((file, bytes, text, count)); } }
    if total > args.max_replacements { return Err(Failure::new("OUTPUT_LIMIT", "maxReplacements exceeded; no files were changed")); }
    let mut items=Vec::new(); for (file, original, text, count) in plans { let revision=hash_file(&file)?; let next=text.replace(&args.pattern,&args.replacement); items.push(json!({"path":file,"replacements":count,"revision":revision,"bytesBefore":original.len(),"bytesAfter":next.len()})); }
    if args.dry_run { return Ok(json!({"status":"completed","phase":"observe","changed":0,"matched":total,"skipped":0,"failed":0,"complete":true,"omitted":0,"dryRun":true,"items":items})); }
    let mut changed=0usize; for item in &items { let file=PathBuf::from(item["path"].as_str().unwrap_or(""));
        // Trusted transport owns this allowlist. Re-check every selected file,
        // not only the initial search root, immediately before publication.
        if let Some(roots) = &request.write_roots {
            let canonical = std::fs::canonicalize(&file)?;
            if !roots.iter().any(|root| std::fs::canonicalize(root).is_ok_and(|r| canonical.starts_with(r))) {
                return Err(Failure::new("POLICY_DENIED", "User authorized workspace writes only; target is outside DSH writable roots. Ask the user to select full access; do not retry or bypass."));
            }
        }
        // Hold the update lock across the check, the read and the publish, so a
        // peer cannot slip in between them and lose our write, or make us lose
        // its. The guard is named, not `_`, so it lives to the end of this pass.
        let _update = lock_for_update(&file)?;
        let expected=item["revision"].as_str().unwrap_or(""); if hash_file(&file)? != expected { return Err(Failure::new("REVISION_CONFLICT", "file changed between observe and execute")); } let bytes=read_bytes(&file)?; let text=String::from_utf8(bytes).map_err(|_| Failure::new("INVALID_ARGUMENT", "replace only supports UTF-8 files"))?; let next=text.replace(&args.pattern,&args.replacement); atomic_write(&file,next.as_bytes())?; changed += item["replacements"].as_u64().unwrap_or(0) as usize; }
    Ok(json!({"status":"completed","phase":"verify","changed":changed,"matched":total,"skipped":0,"failed":0,"complete":true,"omitted":0,"items":items}))
}
/// Take the target's exclusive update lock and return the handle that owns it.
///
/// Keeping that handle alive across the revision check, the read and the publish
/// is what makes the check mean anything. Without it the check is check-then-act:
/// two callers can both observe the same pre-image, both pass it and both report a
/// change, while only the last rename survives — a lost update reported as two
/// successes.
///
/// The lock is advisory and scoped to the handle, the way `store.rs` locks its
/// workspace store. A writer that never takes it is still caught by the revision
/// check, only later. Failing instead of waiting is deliberate: a blocked worker
/// gets killed by the host, whereas a caller told nothing changed can retry.
fn lock_for_update(file: &Path) -> Result<std::fs::File> {
    let raw = file.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?;
    let target = crate::file_path::checked(raw)?;
    let lock = crate::file_path::read_file(&target)?.into_std();
    FileExt::try_lock_exclusive(&lock).map_err(|_| Failure::new("REVISION_CONFLICT", "another writer is updating this file; nothing was changed, retry"))?;
    Ok(lock)
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let raw = path.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?;
    let checked = crate::file_path::checked(raw)?;
    let parent = checked.parent;
    let name = checked.name;
    let temporary = format!(".{name}.dsh-ops-{}", uuid::Uuid::new_v4());
    let mut options = cap_std::fs::OpenOptions::new();
    options.write(true).create_new(true).follow(FollowSymlinks::No);
    let mut file = parent.open_with(&temporary, &options).map_err(|e| Failure::new("ACCESS_DENIED", format!("Atomic replacement create: {e}")))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    // Publication stays handle-relative and does not traverse links.
    let publish = parent.rename(&temporary, &parent, &name);
    if let Err(error) = publish {
        let _ = parent.remove_file(&temporary);
        return Err(Failure::new("ACCESS_DENIED", format!("Atomic replacement publish: {error}")));
    }
    #[cfg(unix)]
    crate::sync_directory(&parent)?;
    Ok(())
}
