//! Platform-specific private sibling preparation. Publication and CAS stay in
//! the shared write/copy pipeline; this module never publishes a destination.
use super::*;
use cap_std::fs::{Dir, File, OpenOptions};

pub(super) fn check_revision(bytes: Option<&[u8]>, expected: &str) -> Result<()> {
    if expected != "absent" && !(expected.len() == 64 && expected.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))) {
        return Err(Failure::new("INVALID_ARGUMENT", "expectedRevision must be absent or lowercase SHA-256"));
    }
    let actual = bytes.map(|bytes| format!("{:x}", Sha256::digest(bytes))).unwrap_or_else(|| "absent".into());
    if actual != expected { return Err(Failure::new("REVISION_CONFLICT", "Revision differs; inspect before preparing a new request")); }
    Ok(())
}

pub(super) fn authorize_write(request: &Request, raw: &str) -> Result<PathBuf> {
    if request.read_only { return Err(Failure::policy("read-only", "User authorization is read-only")); }
    let checked = crate::file_path::checked_leaf(raw, true)?;
    request.authorize_path(&checked.display)?;
    if let Some(roots) = &request.write_roots {
        let parent = fs::canonicalize(checked.display.parent().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "No parent"))?)?;
        let candidate = parent.join(&checked.name);
        if !roots.iter().any(|root| fs::canonicalize(root).is_ok_and(|root| candidate.starts_with(root))) {
            return Err(Failure::policy("write-roots", "Target is outside authorized write roots"));
        }
    }
    Ok(checked.display)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revision_cas_never_treats_absent_as_a_wildcard() {
        check_revision(None, "absent").unwrap();
        assert_eq!(check_revision(Some(b"old"), "absent").unwrap_err().code, "REVISION_CONFLICT");
        let hash = format!("{:x}", Sha256::digest(b"old"));
        check_revision(Some(b"old"), &hash).unwrap();
        assert_eq!(check_revision(None, &hash).unwrap_err().code, "REVISION_CONFLICT");
        assert_eq!(check_revision(Some(b"new"), &hash).unwrap_err().code, "REVISION_CONFLICT");
        assert_eq!(check_revision(Some(b"old"), &hash.to_uppercase()).unwrap_err().code, "INVALID_ARGUMENT");
    }
}


pub(super) fn create_sibling(
    parent: &Dir,
    temporary: &str,
    source: Option<&crate::file_path::Target>,
) -> Result<File> {
    #[cfg(windows)]
    {
        let _ = source;
        let parent = parent.try_clone()?.into_std_file();
        dsh_ops_windows_metadata::create_private(&parent, temporary)
            .map(File::from_std)
            .map_err(metadata_error)
    }
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
                .map_err(|error| Failure::new("METADATA_UNSUPPORTED", error))?;
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
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = source;
    #[cfg(not(windows))]
    let mut options = OpenOptions::new();
    #[cfg(not(windows))]
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(not(windows))]
    {
        Ok(parent.open_with(temporary, &options)?)
    }
}

#[cfg(windows)]
fn metadata_error(error: std::io::Error) -> Failure {
    // The source was opened separately: failures inside capture/restore prove
    // metadata cannot be guaranteed, not that the DSH selector denied a write.
    Failure::new("METADATA_UNSUPPORTED", error)
}
#[cfg(windows)]
pub(super) struct Preserved(dsh_ops_windows_metadata::Metadata);
#[cfg(windows)]
impl Preserved {
    pub fn capture(source: &crate::file_path::Target, replacing: bool) -> Result<Self> {
        let file = crate::file_path::read_file(source)?.into_std();
        let metadata =
            dsh_ops_windows_metadata::Metadata::capture(&file).map_err(metadata_error)?;
        if replacing && metadata.readonly() {
            return Err(Failure::new(
                "ACCESS_DENIED",
                "Readonly files cannot be overwritten",
            ));
        }
        Ok(Self(metadata))
    }
    pub fn restore(&self, file: &File) -> Result<(Value, Vec<String>)> {
        self.0
            .restore(&file.try_clone()?.into_std())
            .map_err(metadata_error)?;
        Ok((
            json!({"owner":true,"group":true,"dacl":true,"attributes":true}),
            vec![],
        ))
    }
    pub fn verify(&self, parent: &Dir, name: &str) -> Result<()> {
        let verification = (|| -> Result<()> {
            let file = parent
                .open_with(
                    name,
                    OpenOptions::new().read(true).follow(FollowSymlinks::No),
                )?
                .into_std();
            self.0.verify(&file).map_err(metadata_error)
        })();
        verification.map_err(|mut failure| {
            failure.phase = "publish".into();
            failure.effect_state = "applied".into();
            failure.next_action =
                "The file is already published. Inspect metadata; do not blindly retry.".into();
            failure
        })
    }
}

/// Remove our exact staging link while its DELETE-capable handle is still owned.
/// Never change permissions: a copy may already share this inode with its target.
pub(super) fn discard_sibling(parent: &Dir, name: &str, file: File) -> Result<()> {
    #[cfg(windows)]
    let removed = dsh_ops_windows_metadata::discard(&file.into_std());
    #[cfg(not(windows))]
    drop(file);
    #[cfg(windows)]
    if removed.is_ok() { return Ok(()); }
    parent.remove_file(name).map_err(|error| {
        let mut failure = Failure::new("CLEANUP_FAILED", format!("Could not remove staging sibling {name}: {error}"));
        failure.phase = "cleanup".into();
        failure.effect_state = "unknown".into();
        failure.next_action = "Inspect the staging sibling and target before retrying; unpublished bytes may remain.".into();
        failure
    })
}
