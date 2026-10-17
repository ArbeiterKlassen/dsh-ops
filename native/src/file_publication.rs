//! Platform-specific private sibling preparation. Publication and CAS stay in
//! the shared write/copy pipeline; this module never publishes a destination.
use super::*;
use cap_std::fs::{Dir, File, OpenOptions};

pub(super) fn create_sibling(
    parent: &Dir,
    temporary: &str,
    source: Option<&crate::file_path::Target>,
) -> Result<File> {
    #[cfg(target_os = "macos")]
    if let Some(source) = source {
        // Darwin ACLs are not the Linux POSIX ACL xattr. APFS cloning keeps the
        // original ACL and xattrs; unsupported filesystems must fail closed.
        let original = crate::file_path::read_file(source)?;
        rustix::fs::fclonefileat(
            &original,
            parent,
            temporary,
            rustix::fs::CloneFlags::empty(),
        )
        .map_err(|error| {
            Failure::new(
                "METADATA_UNSUPPORTED",
                format!("APFS metadata-preserving clone is required; nothing published: {error}"),
            )
        })?;
        let prepared = (|| -> Result<File> {
            let cloned = parent.open_with(
                temporary,
                OpenOptions::new().read(true).follow(FollowSymlinks::No),
            )?;
            // Mask inherited grants before writing new bytes. The caller restores
            // the captured original mode after writing, before publication.
            rustix::fs::fchmod(&cloned, rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR)
                .map_err(|error| Failure::new("ACCESS_DENIED", error))?;
            Ok(parent.open_with(
                temporary,
                OpenOptions::new()
                    .write(true)
                    .truncate(true)
                    .follow(FollowSymlinks::No),
            )?)
        })();
        if prepared.is_err() {
            let _ = parent.remove_file(temporary);
        }
        return prepared;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = source;
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(parent.open_with(temporary, &options)?)
}
