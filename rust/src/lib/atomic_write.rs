//! Save a complete replacement before modifying the durable database.
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

pub fn atomic_write(path: &Path, contents: &[u8]) -> io::Result<()> {
    write_with(path, |file| file.write_all(contents))
}

fn write_with(path: &Path, writer: impl FnOnce(&mut File) -> io::Result<()>) -> io::Result<()> {
    let temporary = path.with_file_name(format!(
        "{}.{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        writer(&mut file)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        File::open(path.parent().unwrap_or_else(|| Path::new(".")))?.sync_all()?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_disk_full_write_preserves_reservation_and_removes_temporary_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("executions.lino");
        atomic_write(&path, b"durable launch reservation").unwrap();
        let result = write_with(&path, |file| {
            file.write_all(b"partial")?;
            Err(io::Error::new(io::ErrorKind::StorageFull, "ENOSPC"))
        });
        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "durable launch reservation"
        );
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        atomic_write(&path, b"complete replacement").unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "complete replacement");
    }
}
