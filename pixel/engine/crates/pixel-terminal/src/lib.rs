mod backend;
mod hosted;
mod presenter;
// Android has no arboard backend; the terminal still pastes text and file paths.
#[cfg(not(target_os = "android"))]
mod system_clipboard;
mod terminal;

pub use backend::{HostOptions, Renderer, StreamOptions, TerminalBackend, TerminalOptions};
pub use pixel_kitty::{Wrapper, kitty_transmit};
pub use terminal::{Retarget, SessionEnv, WindowSize};
