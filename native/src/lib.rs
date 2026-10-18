#![forbid(unsafe_code)]
pub use ops_protocol as contract;
use cap_std::{ambient_authority, fs::Dir};
use contract::*;
use serde_json::Value;

pub fn dispatch(request: Request) -> Result<Value> {
    if request.scope.is_empty()
        || request.scope.len() > 256
        || !std::path::Path::new(&request.root).is_absolute()
    {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "An absolute workspace root and a bounded scope identity are required",
        ));
    }
    let root = std::fs::canonicalize(&request.root)?;
    let mut request = Request {
        root: root
            .to_str()
            .ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 root"))?
            .into(),
        ..request
    };
    // File reads/searches do not create or consult the durable audit store.
    // This is important for read-only sessions and keeps observation separate
    // from mutation audit records.
    if matches!(request.tool.as_str(), "inspect_local_file" | "read_many" | "glob" | "grep" | "replace" | "write_file" | "edit_file" | "edit_many" | "diff" | "stat" | "copy" | "move" | "remove") {
        request.root_identity = String::new();
        return if matches!(request.tool.as_str(), "glob" | "grep" | "replace") {
            ops_search::dispatch(&request)
        } else {
            ops_files::dispatch(&request)
        };
    }
    let dir = Dir::open_ambient_dir(root, ambient_authority())?;
    use cap_fs_ext::MetadataExt;
    let metadata = dir.dir_metadata()?;
    request.root_identity = format!("{}:{}", metadata.dev(), metadata.ino());
    if request.read_only
        && !(request.tool == "result"
            && request.args.get("action").and_then(Value::as_str) == Some("page"))
    {
        return Err(Failure::policy(
            "read-only",
            "Read-only requests cannot mutate audit or result storage",
        ));
    }
    let store = ops_results::store::Store::open(&dir, request.read_only)?;
    match request.tool.as_str() {
        "batch" => ops_batch::run(&dir, &store, &request),
        "result" => ops_results::run(&store, &request),
        _ => Err(Failure::new("INVALID_ARGUMENT", "Unknown capability")),
    }
}
