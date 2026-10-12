#![forbid(unsafe_code)]
mod batch;
pub mod contract;
mod paths;
mod results;
mod store;
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
    // Normalize once; persistent jobs bind both this root identity and the calling scope.
    let mut request = Request {
        root: root
            .to_str()
            .ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 root"))?
            .into(),
        ..request
    };
    let dir = Dir::open_ambient_dir(root, ambient_authority())?;
    use cap_fs_ext::MetadataExt;
    let metadata = dir.dir_metadata()?;
    request.root_identity = format!("{}:{}", metadata.dev(), metadata.ino());
    let store = store::Store::open(&dir)?;
    match request.tool.as_str() {
        "batch" => batch::run(&dir, &store, &request),
        "result" => results::run(&store, &request),
        _ => Err(Failure::new("INVALID_ARGUMENT", "Unknown capability")),
    }
}
