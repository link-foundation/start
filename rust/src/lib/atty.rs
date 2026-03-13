// Stub for atty crate functionality
pub enum Stream {
    Stdin,
    Stdout,
}

pub fn is(_stream: Stream) -> bool {
    // Simple check using isatty
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        match _stream {
            Stream::Stdin => unsafe { libc::isatty(std::io::stdin().as_raw_fd()) != 0 },
            Stream::Stdout => unsafe { libc::isatty(std::io::stdout().as_raw_fd()) != 0 },
        }
    }
    #[cfg(not(unix))]
    {
        false
    }
}
