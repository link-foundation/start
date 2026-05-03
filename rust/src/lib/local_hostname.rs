use std::ffi::OsString;

pub(crate) fn get() -> Result<OsString, std::io::Error> {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        let result = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut i8, buf.len()) };
        if result == 0 {
            let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            Ok(OsString::from(
                String::from_utf8_lossy(&buf[..len]).to_string(),
            ))
        } else {
            Ok(OsString::from("unknown"))
        }
    }
    #[cfg(not(unix))]
    {
        Ok(OsString::from("unknown"))
    }
}
