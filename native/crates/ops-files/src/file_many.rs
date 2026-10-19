//! Multiple read-only file observations in one process, with one aggregate byte cap.
use super::*;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadManyArgs { files: Vec<ReadRange> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadRange {
    path: String,
    #[serde(default = "one")]
    offset: usize,
    #[serde(default = "two_hundred")]
    limit: usize,
}
const NEXT_ACTION: &str = "Resume remaining files from nextIndex. Follow each file's nextOffset for more lines; for truncatedInLine use that file's hex inspection guidance.";

pub(super) fn read_many(request: &Request) -> Result<Value> {
    let args: ReadManyArgs = serde_json::from_value(request.args.clone())?;
    if args.files.is_empty() || args.files.len() > 32 {
        return Err(Failure::new("INVALID_ARGUMENT", "read_many accepts 1-32 files"));
    }
    if args.files.iter().any(|file| file.offset == 0 || file.limit == 0 || file.limit > 10_000) {
        return Err(Failure::new("INVALID_ARGUMENT", "read_many offset starts at 1 and limit is 1-10000"));
    }
    let total = args.files.len();
    // Keep the longest possible aggregate fields reserved before reading any file.
    let mut value = json!({"status":"completed","phase":"verify","changed":0,"matched":total,"failed":total,"complete":false,"truncated":false,"effectState":"none","items":[],"total":total,"nextIndex":total,"pending":total,"nextAction":NEXT_ACTION});
    let mut room = MAX_OUTPUT_BYTES.saturating_sub(output::size(&value) + 1);
    let mut items = Vec::new();
    let mut failed = 0;
    let mut complete = true;
    let mut truncated = false;
    for file in args.files {
        // Stop before touching another file when no meaningful receipt can fit.
        if room < 1024 { break; }
        let observed = request.authorize_path(Path::new(&file.path)).and_then(|()| {
            inspect_args(InspectArgs { path: file.path.clone(), offset: file.offset, limit: file.limit, encoding: utf8(), view: text() }, room.saturating_sub(1), true)
        });
        let item = match observed {
            Ok(item) => item,
            Err(error) => json!({"path":file.path,"status":"error","complete":false,"items":[],"error":error}),
        };
        let size = output::size(&item) + 1;
        if size > room { break; } // this input remains pending; never discard a receipt silently
        room -= size;
        if item.get("error").is_some() { failed += 1; }
        complete &= item["complete"] == true;
        truncated |= item["truncated"] == true;
        items.push(item);
    }
    let returned = items.len();
    complete &= returned == total;
    value["status"] = json!(if complete { "completed" } else { "partial" });
    value["complete"] = json!(complete);
    value["truncated"] = json!(truncated || returned < total);
    value["matched"] = json!(returned - failed);
    value["failed"] = json!(failed);
    value["nextIndex"] = json!(returned);
    value["pending"] = json!(total - returned);
    value["items"] = json!(items);
    if complete { value.as_object_mut().expect("result object").remove("nextAction"); }
    Ok(value)
}
