#![forbid(unsafe_code)]
use ops_protocol as contract;
use ops_files::paths;
#[cfg(unix)]
use ops_files::sync_directory;
pub mod store;
mod results;
pub use results::{run, referenced_items};
