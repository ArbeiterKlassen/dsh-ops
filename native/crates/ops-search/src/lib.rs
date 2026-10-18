//! File search orchestration over the shared no-follow file primitives.
#![forbid(unsafe_code)]
use ops_protocol::{Failure, Request, Result};
use ops_files::{file_path, target, relative_display, read_bytes, result, lock_and_read_for_update, atomic_write, MAX_OUTPUT_BYTES};
use ops_files as publication;
use cap_fs_ext::DirExt;
use regex::RegexBuilder;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::{Path, PathBuf}};
#[cfg(windows)]
use std::os::windows::fs::MetadataExt as WindowsMetadataExt;
const MAX_ENTRIES: usize = 100_000;
const MAX_DEPTH: usize = 128;
fn one_hundred() -> usize { 100 }
fn yes() -> bool { true }

pub fn dispatch(request: &Request) -> Result<Value> {
    if let Some(raw) = request.args.get("path").and_then(Value::as_str) { request.authorize_path(Path::new(raw))?; }
    match request.tool.as_str() {
        "glob" => glob(request),
        "grep" => grep(request),
        "replace" => replace(request),
        _ => Err(Failure::new("INVALID_ARGUMENT", "Unknown search capability")),
    }.map_err(|mut error| { error.message = format!("{}: {}", request.tool, error.message); error })
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

fn walk(root: &Path, request: &Request) -> Result<WalkResult> {
    request.authorize_path(root)?;
    let target = crate::file_path::checked(root.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?)?;
    let directory = target.parent.open_dir_nofollow(&target.name)?;
    let mut files = Vec::new();
    let mut truncated = false;
    visit_dir(root, root, directory, 0, request, &mut files, &mut truncated)?;
    Ok(WalkResult { files, truncated })
}
fn visit_dir(root: &Path, display: &Path, directory: cap_std::fs::Dir, depth: usize, request: &Request, output: &mut Vec<PathBuf>, truncated: &mut bool) -> Result<()> {
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
        // A denied root is skipped by identity, not by name: the host names the
        // credential locations and the worker stays out of them entirely, so a
        // traversal cannot even report a private key below one.
        if request.denies_path(&child) { continue; }
        if hidden(&child, root) || matches!(name.as_str(), ".git" | ".dsh-ops" | "node_modules" | "target" | ".venv") { continue; }
        if metadata.is_file() {
            if output.len() >= MAX_ENTRIES { *truncated = true; return Ok(()); }
            output.push(child);
            continue;
        }
        if metadata.is_dir() {
            let Ok(child_dir) = directory.open_dir_nofollow(&name) else { continue };
            visit_dir(root, &child, child_dir, depth + 1, request, output, truncated)?;
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
fn files_for(path: &str, patterns: &[String], request: &Request) -> Result<WalkResult> {
    let root = target(path, false)?;
    request.authorize_path(&root)?;
    if root.is_file() {
        return Ok(WalkResult { files: vec![root.clone()], truncated: false });
    }
    let walked = walk(&root, request)?;
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
/// Modification time of `metadata` in whole milliseconds since the Unix epoch,
/// or `None` when the platform will not report one.
///
/// This is the file tools' one definition of a timestamp quantity: `ops_stat`'s
/// `modifiedMs` and `ops_glob`'s `modified` describe the same instant the same
/// way, so the two cannot drift into different units. Milliseconds since the
/// epoch carry no timezone, and they are what `stat -c %Y` reports as whole
/// seconds — the same instant, at the resolution a single-second field loses.
fn modified_ms(metadata: &fs::Metadata) -> Option<u128> {
    metadata.modified().ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|time| time.as_millis())
}
/// Last modification time of one path, in milliseconds since the Unix epoch.
///
/// `symlink_metadata`, not `metadata`: this module never follows links, and a
/// link, junction or reparse entry is refused before it can become a candidate
/// (`host_link_or_reparse`, `file_path::link`), so no `ops_glob` item is a link
/// and "the link or its target" cannot arise in a result. Probing the entry
/// itself keeps the timestamp probe consistent with every other path probe
/// here; a caller that needs the target of a link asks `ops_stat`, which opens
/// the file and reports the opened inode's time.
///
/// This used to return `symlink_metadata(..).len()` — the byte count — so
/// `details.modified` was a second copy of `details.bytes` and
/// `sort: "modified"` ordered by file size and never by time (#236, reproduced
/// in #204 P2). `None`, not `0`, is the honest answer for a time the
/// filesystem cannot report or one that predates the epoch; `ops_stat` reports
/// the same `null` there, so both tools answer "unknown" the same way.
fn modified(path: &Path) -> Option<u128> { fs::symlink_metadata(path).ok().as_ref().and_then(modified_ms) }
/// Order candidates for `sort: "modified"`: newest first, an unreadable time
/// last, equal times in the walk's path order.
///
/// `Reverse` keeps the direction the size-based key already produced
/// (descending), so this fix changes the key, not the ordering contract. The
/// sort is stable (`sort_by_key`), so equal timestamps — a coarse clock, a copy
/// that preserves a timestamp, two writes inside one second — keep the path
/// order the walk produced instead of reshuffling between identical calls.
/// `Reverse(None)` sorts last because `None` is below every `Some`.
fn sort_by_modified(files: &mut [PathBuf]) { files.sort_by_key(|file| std::cmp::Reverse(modified(file))); }
/// One `details` item: the path, its on-disk size, and its modification time as
/// an epoch-millisecond number (`null` when unreadable). The size is a size and
/// the time is a time; neither stands in for the other.
fn details(file: &Path) -> Value {
    json!({"path":file,"bytes":fs::symlink_metadata(file).map(|metadata| metadata.len()).unwrap_or(0),"modified":modified(file)})
}
fn glob(request: &Request) -> Result<Value> {
    let args: GlobArgs = serde_json::from_value(request.args.clone())?;
    if args.limit == 0 || args.limit > 10_000 { return Err(Failure::new("INVALID_ARGUMENT", "glob limit is 1-10000")); }
    if args.pattern.is_empty() || args.pattern.iter().all(|p| p.starts_with('!')) { return Err(Failure::new("INVALID_ARGUMENT", "pattern requires a positive glob")); }
    let root = target(&args.path, false)?; if !root.is_dir() { return Err(Failure::new("INVALID_ARGUMENT", "glob path must be a directory")); }
    let walked = walk(&root, request)?;
    let mut files: Vec<_> = walked.files.into_iter().filter(|f| matches_any(&root, f, &args.pattern)).collect();
    // `sort` is optional: empty keeps the walk's path order, which is what `path`
    // asks for explicitly. The whole candidate list is ordered before paging, so a
    // page boundary always falls in the same sequence a full listing would produce.
    if args.sort == "modified" { sort_by_modified(&mut files); } else if !args.sort.is_empty() && args.sort != "path" { return Err(Failure::new("INVALID_ARGUMENT", "sort must be path or modified")); }
    let output_mode = if args.output_mode.is_empty() { "paths" } else { args.output_mode.as_str() };
    if output_mode != "paths" && output_mode != "details" { return Err(Failure::new("INVALID_ARGUMENT", "outputMode must be paths or details")); }
    let total = files.len(); let selected: Vec<_> = files.into_iter().skip(args.offset).take(args.limit).map(|f| if output_mode == "paths" { json!(f) } else { details(&f) }).collect();
    Ok(result(selected, total, args.offset, args.offset, total, walked.truncated))
}
fn grep(request: &Request) -> Result<Value> {
    let args: GrepArgs = serde_json::from_value(request.args.clone())?;
    if args.pattern.is_empty() || args.limit == 0 || args.limit > 10_000 { return Err(Failure::new("INVALID_ARGUMENT", "pattern and bounded limit are required")); }
    if args.before_context > 32 || args.after_context > 32 { return Err(Failure::new("INVALID_ARGUMENT", "context is limited to 32 lines")); }
    let regex = RegexBuilder::new(&args.pattern).case_insensitive(args.case_insensitive).multi_line(args.multiline).build().map_err(|e| Failure::new("INVALID_ARGUMENT", e))?;
    if !matches!(args.output_mode.as_str(), "" | "content" | "files_with_matches" | "count" | "summary") { return Err(Failure::new("INVALID_ARGUMENT", "invalid grep outputMode")); }
    let walked = files_for(&args.path, &args.glob, request)?; let mut matches = Vec::new(); let mut file_count = 0; let mut match_count = 0;
    let mut failed = 0usize; let mut skipped_files = 0usize;
    // Which modes answer with an item per match (`content`) and which with an item per file. Declared
    // once here because both the per-file loop and the envelope's `total` have to agree on it.
    let content_mode = !matches!(args.output_mode.as_str(), "files_with_matches" | "count" | "summary");
    let page = args.offset.saturating_add(args.limit);
    for file in walked.files {
        let bytes = match read_bytes(&file) {
            Ok(bytes) => bytes,
            Err(error) if error.code == "OUTPUT_LIMIT" => { skipped_files += 1; continue; }
            Err(_) => { failed += 1; continue; }
        };
        let text = match String::from_utf8(bytes) { Ok(v) => v, Err(_) => { skipped_files += 1; continue; } }; let lines: Vec<_> = text.lines().collect();
        // Line by line by default. With `multiline` the pattern is matched against
        // the whole file, so a pattern containing `\n` can match across lines
        // instead of never matching at all — which is what the flag's name promises
        // and what it did not do. `^` and `$` still resolve per line, because the
        // builder keeps `multi_line` on in both modes.
        //
        // Each hit is reduced to the span of lines it covers, so one reporting path
        // serves both modes: a cross-line match is reported at the line where it
        // starts, with its context lines around it.
        // Matches are counted in one pass and materialized in a second, page-bounded one. Counting a
        // match costs no allocation, while joining its lines into a `text` item costs the lines
        // themselves — and the previous shape built one item per match in the file *before* `limit`
        // was consulted, so a 32 KiB line matched by `pattern: "a"` copied that line 32 768 times and
        // the worker died under a memory cap instead of returning its first item. Reported by
        // @Haoming9527 in review of #81.
        let mut hits = 0usize;
        let mut spans: Vec<(usize, usize)> = Vec::new();
        if args.multiline {
            let starts: Vec<usize> = text.match_indices('\n').map(|(at, _)| at + 1).collect();
            // Clamped, so a match can never be attributed to a line the file does
            // not have: the offset-to-line map is only meaningful for offsets inside
            // the text.
            let line_of = |offset: usize| starts.partition_point(|start| *start <= offset).min(lines.len().saturating_sub(1));
            for found in regex.find_iter(&text) {
                // Matching the whole file at once adds one zero-width match at the
                // position after a final newline — the one place `$` and `^` already
                // matched at the end of the last real line. Reporting it invented
                // line N+1 with empty text, so `$` answered six times for a
                // five-line file. A file with no trailing newline keeps its last
                // match, because there the end of the file is the end of a line.
                if found.start() >= text.len() && text.ends_with('\n') { continue; }
                hits += 1;
                // Only what the page can still hold is materialized, so the peak is the page and not
                // the file's match count. `hits` above stays exact: `matched` reports every match.
                let ordinal = match_count + hits - 1;
                if content_mode && ordinal >= args.offset && ordinal < page { spans.push((line_of(found.start()), line_of(found.end().saturating_sub(1).max(found.start())))); }
            }
        } else {
            for (index, line) in lines.iter().enumerate() {
                if !regex.is_match(line) { continue; }
                hits += 1;
                let ordinal = match_count + hits - 1;
                if content_mode && ordinal >= args.offset && ordinal < page { spans.push((index, index)); }
            }
        }
        if hits == 0 { continue; } file_count += 1; match_count += hits;
        let in_page = file_count > args.offset && file_count <= page;
        match args.output_mode.as_str() { "files_with_matches" if in_page => matches.push(json!({"path":file})), "count" if in_page => matches.push(json!({"path":file,"count":hits})), "files_with_matches" | "count" | "summary" => {} , _ => { for (first, last) in spans { let start=first.saturating_sub(args.before_context); let end=(last+args.after_context+1).min(lines.len()); matches.push(json!({"path":file,"line":if args.line_numbers {first+1} else {0},"text":lines[start..end].join("\n")})); } } }
        // Keep counting through every candidate; only materialize the requested
        // window. A page-full prefix must never masquerade as the global total.
    }
    let incomplete = walked.truncated || failed > 0;
    if args.output_mode == "summary" { return Ok(json!({"status":"completed","phase":"verify","changed":0,"matched":match_count,"skipped":0,"failed":failed,"skippedFiles":skipped_files,"complete":!incomplete,"truncated":incomplete,"omitted":0,"files":file_count,"matches":match_count})); }
    // `total` is the number of items a full materialization would have produced: one per match in the
    // content modes, one per file otherwise. It is the match count in the first case because the page
    // bound above only limits what was *built*, never what was counted.
    let total = if content_mode { match_count } else { file_count };
    let mut output = result(matches, total, args.offset, args.offset, match_count, incomplete);
    output["failed"] = json!(failed);
    output["skippedFiles"] = json!(skipped_files);
    Ok(output)
}
fn replace(request: &Request) -> Result<Value> {
    if request.read_only { return Err(Failure::policy("read-only", "replace is unavailable in read-only mode")); }
    let args: ReplaceArgs = serde_json::from_value(request.args.clone())?;
    if args.pattern.is_empty() || args.max_replacements == 0 || args.max_replacements > 100_000 { return Err(Failure::new("INVALID_ARGUMENT", "pattern and maxReplacements are required")); }
    let walked = files_for(&args.path, &args.glob, request)?; let mut plans = Vec::new(); let mut total = 0usize; let mut binary: Vec<PathBuf> = Vec::new();
    // A directory that holds one binary file (an icon, an archive) is a normal repository, not a
    // malformed request: the binary is reported as skipped and the text files around it are still
    // edited. Failing the whole call on the first non-UTF-8 byte made a routine directory edit
    // impossible, and the error named no file, so the caller could not even narrow the request.
    let mut update_guards = Vec::new();
    for file in walked.files {
        // Serialize observation as well as publication. On APFS an open racing
        // an unlink/rename can fail ENOENT on the superseded vnode even though
        // the directory name always has a complete version. Do not retry or
        // relabel ENOENT: avoid the race between cooperating writers instead.
        let (guard, bytes) = if args.dry_run { (None, read_bytes(&file)?) }
            else { let (guard, bytes) = lock_and_read_for_update(&file)?; (Some(guard), bytes) };
        match String::from_utf8(bytes.clone()) {
            Ok(text) => {
                let count = text.match_indices(&args.pattern).count();
                if count > 0 { total += count; plans.push((file, bytes, text, count)); update_guards.push(guard); }
            }
            Err(_) => binary.push(file),
        }
    }
    let skipped = binary.len();
    let skipped_paths: Vec<Value> = binary.iter().take(8).map(|file| json!(relative_display(&request.root_path(), file))).collect();
    if total > args.max_replacements { return Err(Failure::new("OUTPUT_LIMIT", format!("{total} matches exceed maxReplacements ({}); no file was changed. maxReplacements is a ceiling, not a truncation: raise it to {total} or more and retry.", args.max_replacements))); }
    let mut items=Vec::new(); for (file, original, text, count) in plans { let revision=format!("{:x}", Sha256::digest(&original)); let next=text.replace(&args.pattern,&args.replacement); items.push(json!({"path":file,"replacements":count,"revision":revision,"revisionAfter":format!("{:x}", Sha256::digest(next.as_bytes())),"bytesBefore":original.len(),"bytesAfter":next.len(),"lineCountBefore":text.lines().count(),"lineCount":next.lines().count()})); }
    if serde_json::to_vec(&items)?.len() > MAX_OUTPUT_BYTES / 2 { return Err(Failure::new("OUTPUT_LIMIT", "Replacement receipts exceed the bounded output budget; narrow path/glob. No files changed.")); }
    if args.dry_run { return Ok(json!({"status":"completed","phase":"observe","changed":0,"matched":total,"skipped":skipped,"failed":0,"complete":true,"omitted":0,"dryRun":true,"items":items,"skippedPaths":skipped_paths})); }
    for item in &items { publication::authorize_write(request, item["path"].as_str().unwrap_or(""))?; }
    let mut changed=0usize; for item in &mut items {
        let applied = (|| -> Result<()> { let file=PathBuf::from(item["path"].as_str().unwrap_or(""));
        publication::authorize_write(request, file.to_str().unwrap_or(""))?;
        // Observation guards above remain owned until every publication settles.
        let bytes = read_bytes(&file)?;
        // The revision is checked against the bytes the lock returned, so the check
        // and the write cannot be separated by another open — see the lock for why.
        let expected=item["revision"].as_str().unwrap_or(""); publication::check_revision(Some(&bytes), expected)?;
        let text=String::from_utf8(bytes).map_err(|_| Failure::new("INVALID_ARGUMENT", "replace only supports UTF-8 files"))?; let next=text.replace(&args.pattern,&args.replacement);
        // Report what the replacement kept. The fields are additive, so a caller
        // that ignores them sees exactly the envelope it saw before.
        if let Some((metadata,warnings))=atomic_write(&file,next.as_bytes())? { item["metadata"]=metadata; if !warnings.is_empty() { item["metadataWarnings"]=json!(warnings); } }
        Ok(()) })();
        if let Err(mut error) = applied {
            if changed > 0 { error.effect_state = "applied".into(); error.next_action = "Earlier files were already replaced. Inspect postconditions; do not repeat the batch blindly.".into(); }
            return Err(error);
        }
        changed += item["replacements"].as_u64().unwrap_or(0) as usize; }
    let count = items.len();
    let mut output = result(items, count, 0, 0, total, walked.truncated);
    output["changed"] = json!(changed); output["skipped"] = json!(skipped);
    // Do not let optional skipped path names defeat the serialized receipt budget.
    output["skippedPaths"] = if serde_json::to_vec(&output)?.len() < MAX_OUTPUT_BYTES / 2 { json!(skipped_paths) } else { json!([]) };
    Ok(output)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    /// One private fixture directory under the canonical ambient temp root.
    ///
    /// The no-follow traversal refuses linked ancestry, and `TMPDIR` sits behind
    /// one on Darwin, so the ambient root is resolved before anything is created —
    /// the reason `single::tests::copy_changed_source_is_not_published` does the
    /// same.
    struct Fixture { root: PathBuf }
    impl Fixture {
        fn new(tag: &str) -> Self {
            let root = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("dsh-ops-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            Self { root }
        }
        /// Write one fixture file and stamp it with `modified_ms` since the epoch.
        fn file(&self, name: &str, bytes: &[u8], modified_ms: u64) -> PathBuf {
            let path = self.root.join(name);
            std::fs::write(&path, bytes).unwrap();
            let stamp = UNIX_EPOCH + Duration::from_millis(modified_ms);
            std::fs::OpenOptions::new().write(true).open(&path).unwrap()
                .set_times(fs::FileTimes::new().set_accessed(stamp).set_modified(stamp)).unwrap();
            path
        }
        /// The sidecar `lock_and_read_for_update` creates for `name`.
        fn sidecar(&self, name: &str) -> PathBuf {
            self.root.join(format!(".dsh-ops-update-{:x}.lock", Sha256::digest(name.to_lowercase().as_bytes())))
        }
        fn names(files: &[PathBuf]) -> Vec<String> {
            files.iter().map(|file| file.file_name().unwrap().to_string_lossy().into_owned()).collect()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); }
    }

    /// #236: `modified` was `metadata.len()`, so every `details` item reported
    /// `modified == bytes` and `sort: "modified"` ordered by size. The fixtures
    /// are inverted on purpose — the larger file is the older one — so a
    /// size-based key reverses them.
    #[test]
    fn modified_is_epoch_milliseconds_and_ordering_ignores_size() {
        let fixture = Fixture::new("glob-modified");
        let old_big = fixture.file("a-old-big.txt", &[b'x'; 8192], 1_600_000_000_000);
        let new_small = fixture.file("z-new-small.txt", b"tiny", 1_600_000_120_000);
        let (old, new) = (modified(&old_big).expect("mtime"), modified(&new_small).expect("mtime"));
        assert!(old > 1_000_000_000_000, "modified must be epoch milliseconds, got {old}");
        assert_ne!(old, 8192, "modified must not be the byte count");
        // A filesystem may keep coarser than a millisecond; one second of slack
        // covers that without accepting a different quantity or unit.
        for (path, expected) in [(&old_big, 1_600_000_000_000_i128), (&new_small, 1_600_000_120_000_i128)] {
            let actual = modified(path).unwrap() as i128;
            assert!((actual - expected).abs() <= 1_000, "{}: expected {expected} ms ±1s, got {actual}", path.display());
        }
        assert!(new > old, "the newer file must carry the larger timestamp");
        assert_eq!(modified(&fixture.root.join("absent.txt")), None, "an unreadable time is null, not zero");
        assert_eq!(details(&old_big)["bytes"], json!(8192));

        let mut files = vec![new_small, old_big];
        sort_by_modified(&mut files);
        assert_eq!(Fixture::names(&files), ["z-new-small.txt", "a-old-big.txt"], "newest first, independent of size");
    }

    /// Equal timestamps must not reshuffle, so two identical calls page the same
    /// way: the sort is stable and the walk's path order decides the tie.
    #[test]
    fn equal_timestamps_keep_the_candidate_order() {
        let fixture = Fixture::new("glob-modified-tie");
        let first = fixture.file("a.txt", b"a", 1_600_000_000_000);
        let second = fixture.file("b.txt", b"bb", 1_600_000_000_000);
        let third = fixture.file("c.txt", b"ccc", 1_600_000_000_000);
        assert_eq!(modified(&first), modified(&second), "the fixture must produce equal timestamps");
        let mut files = vec![second, first, third];
        sort_by_modified(&mut files);
        assert_eq!(Fixture::names(&files), ["b.txt", "a.txt", "c.txt"], "ties keep their relative order");
    }

    /// #240 P5, declared behavior: the update lock creates the persistent hidden
    /// sidecar before the target is read, so a refusal after the lock already
    /// left it behind; it is one empty file per target name and is reused, never
    /// accumulated, and a later successful write keeps using the same inode.
    #[test]
    fn the_update_lock_sidecar_is_created_once_and_reused() {
        let fixture = Fixture::new("update-lock");
        let target = fixture.file("notes.txt", b"one", 1_600_000_000_000);
        let sidecar = fixture.sidecar("notes.txt");
        assert!(!sidecar.exists(), "no sidecar before the first update attempt");
        drop(lock_and_read_for_update(&target).unwrap());
        assert!(sidecar.is_file(), "the lock is a persistent sibling, not the target");
        assert_eq!(fs::metadata(&sidecar).unwrap().len(), 0, "the sidecar carries no payload");
        drop(lock_and_read_for_update(&target).unwrap());
        // A refused read is the shape #240 reports: the sidecar is already there
        // when the target itself cannot be read; a stale-revision write refuses the
        // same way, after the same lock.
        let missing = fixture.root.join("missing.txt");
        assert_eq!(lock_and_read_for_update(&missing).unwrap_err().code, "NOT_FOUND");
        assert!(fixture.sidecar("missing.txt").is_file(), "a refused operation still leaves the declared sidecar");
        assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 3, "one target and two sidecars, never more");
    }
}
