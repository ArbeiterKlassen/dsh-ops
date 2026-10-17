//! Platform-specific sibling preparation and, on Darwin, publication. The shared
//! write/copy pipeline owns the CAS: `create_sibling` only prepares a private
//! sibling, while `publish_clone` publishes a copy directly, because Darwin cannot
//! stage one — see it for why.
use super::*;
use cap_std::fs::{Dir, File, OpenOptions};

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
    #[cfg(not(windows))]
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

/// Darwin: clone `source` straight to its destination name — the clone *is* the
/// publication, because a Darwin copy cannot be staged at all.
///
/// A Darwin extended ACL is a property of the inode, and an ACE that denies
/// `delete` cannot be worked around: `unlink` and `rename` both authorize
/// `KAUTH_VNODE_DELETE` on the file itself (xnu, `vn_authorize_renamex_with_paths`:
/// *"must have delete rights to remove the old name even in the simple case of
/// fdvp == tdvp"*), so a staged clone carrying the source's ACL can never be
/// removed again — the observed failure was `CLEANUP_FAILED` / `EACCES` on the
/// staging sibling. `clonefile` needs only read-data on the source and add-file on
/// the destination directory, and it refuses an existing destination, so cloning to
/// the final name is both the atomic no-clobber publication and the only way to
/// carry the ACL. `CLONE_ACL` is what makes it carry that ACL: without it a clone
/// merely inherits the *destination directory's* ACLs (`clonefile(2)`).
///
/// The caller measures the published bytes against the pre-image it verified, since
/// the clone holds whatever the source held at clone time.
#[cfg(target_os = "macos")]
pub(super) fn publish_clone(
    parent: &Dir,
    name: &str,
    source: &crate::file_path::Target,
) -> Result<File> {
    // rustix 1.1 spells `CLONE_NOFOLLOW` and `CLONE_NOOWNERCOPY` only; this value
    // comes from Apple's `<sys/clonefile.h>` (`CLONE_ACL 0x0004`) and is passed
    // through unchanged. A host that rejects it fails closed rather than
    // publishing a copy without the ACL.
    const CLONE_ACL: u32 = 0x0004;
    let original = crate::file_path::read_file(source)?;
    rustix::fs::fclonefileat(
        &original,
        parent,
        name,
        rustix::fs::CloneFlags::from_bits_retain(CLONE_ACL),
    )
    .map_err(|error| match error {
        // `clonefile` is the no-clobber step: an existing destination is a
        // conflict, never something to replace.
        rustix::io::Errno::EXIST => {
            Failure::new("REVISION_CONFLICT", "Destination exists; no clobber is permitted")
        }
        error => Failure::new(
            "METADATA_UNSUPPORTED",
            format!("APFS metadata-preserving clone is required; nothing published: {error}"),
        ),
    })?;
    parent
        .open_with(
            name,
            OpenOptions::new().read(true).follow(FollowSymlinks::No),
        )
        .map_err(|error| {
            // The clone is already at the destination name: report an effect.
            let mut failure = Failure::from(error);
            failure.phase = "publish".into();
            failure.effect_state = "applied".into();
            failure.next_action =
                "The destination names a clone that could not be reopened. Inspect it; do not repeat the copy."
                    .into();
            failure
        })
}

#[cfg(windows)]
fn metadata_error(error: std::io::Error) -> Failure {
    if error.kind() == std::io::ErrorKind::Unsupported {
        Failure::new("METADATA_UNSUPPORTED", error)
    } else {
        error.into()
    }
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
