//! One manager at a time.
//!
//! KoiPage keeps running in the tray after its window is closed, so launching it
//! again — from the Start menu, the desktop shortcut or a second double-click —
//! would otherwise start a second manager. Two managers share one database file
//! and one bundled-tool directory, and each owns its own tray icon: confusing at
//! best, corrupting at worst.
//!
//! The rule enforced here: **at most one manager process exists**. A second
//! launch never builds a full app; it brings the running manager to the front and
//! exits silently.
//!
//! Ownership is a named kernel mutex, not a process scan. A scan cannot decide a
//! cold start: two processes launched at the same moment both see "no manager
//! yet" and both come up, which is exactly the bug this module exists to prevent.
//! A mutex is atomic, and the kernel releases it when the owner dies, so a crash
//! never leaves the app locked out.
//!
//! Both names include a hash of the executable path, so an installed copy, a
//! portable copy and a dev build are *different* managers and never block each
//! other.

use std::path::Path;

/// Decide whether this process is *the* manager, activating the incumbent when
/// it is not.
pub fn acquire() -> Role {
    #[cfg(windows)]
    {
        windows_guard::acquire()
    }
    #[cfg(not(windows))]
    {
        Role::Primary
    }
}

/// Start listening for wake-ups sent by later launches of *this* executable.
///
/// Must be called once the app is ready; the listener runs on its own thread and
/// restores the window whenever a re-launch asks for it.
pub fn listen_for_activation(app: tauri::AppHandle) {
    #[cfg(windows)]
    {
        windows_guard::listen(app);
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

/// What a launching copy of the app should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// This process owns the manager; keep going.
    Primary,
    /// Another manager is alive and has been activated; exit now.
    Duplicate,
}

/// Name of a kernel object belonging to the executable at `image`.
///
/// The hash keeps unrelated copies apart; the `Local\` prefix keeps the objects
/// inside the user's session, so another logged-in user never collides with this
/// one.
#[cfg(windows)]
fn object_name(image: &Path, object: &str) -> Vec<u16> {
    // FNV-1a: deterministic across builds, unlike `DefaultHasher`, so a rebuilt
    // binary still recognises (or yields to) the manager started by the build
    // before it.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in image.to_string_lossy().to_lowercase().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("Local\\KoiPage-{object}-{hash:016x}\0")
        .encode_utf16()
        .collect()
}

#[cfg(windows)]
mod windows_guard {
    use std::path::Path;

    use tauri::Manager;
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Threading::{
        CreateEventW, CreateMutexW, EVENT_MODIFY_STATE, OpenEventW, SetEvent, WaitForSingleObject,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow;

    use super::{Role, object_name};

    /// Keeps the owning mutex handle open for the life of the process.
    ///
    /// The mutex *is* the claim: the kernel drops it when the last handle closes,
    /// which happens when this process exits (or crashes), so ownership never
    /// outlives the manager.
    static OWNERSHIP: std::sync::Mutex<Option<usize>> = std::sync::Mutex::new(None);

    /// Own the manager, or wake the process that already does.
    pub fn acquire() -> Role {
        let Ok(image) = std::env::current_exe() else {
            // Without our own path there is nothing to key ownership on; never
            // block the user from starting the app.
            return Role::Primary;
        };

        let mutex = object_name(&image, "Single");
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, mutex.as_ptr()) };
        if handle.is_null() {
            // Creation failed (out of handles, or a hostile session). Fail open:
            // a missing guard is better than an app that will not start.
            eprintln!(
                "[instance] could not create the ownership mutex (error {})",
                unsafe { GetLastError() }
            );
            return Role::Primary;
        }

        // `CreateMutexW` reports "already existed" through the last-error slot,
        // and only immediately after the call.
        let existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        if !existed {
            if let Ok(mut slot) = OWNERSHIP.lock() {
                *slot = Some(handle as usize);
            }
            return Role::Primary;
        }

        // Someone else owns the manager. Let go of our handle first: we must not
        // look like a second owner.
        unsafe { CloseHandle(handle) };
        wake_owner(&image);
        Role::Duplicate
    }

    /// Ask the running manager to show itself.
    ///
    /// Only a signal works here. The window may be hidden to the tray, and a
    /// window hidden with `SW_HIDE` can only be re-shown by the process that owns
    /// it — so the incumbent restores itself when it sees this event.
    fn wake_owner(image: &Path) {
        // Windows only lets a process raise itself while it may take the
        // foreground; a re-launch counts as user intent for exactly that.
        let _ = unsafe { AllowSetForegroundWindow(u32::MAX) };

        let name = object_name(image, "Wake");
        let event = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr()) };
        if event.is_null() {
            // The owner has not created its listener yet: it is still starting
            // up, and will show its window on its own. Nothing left to do.
            return;
        }
        unsafe { SetEvent(event) };
        unsafe { CloseHandle(event) };
    }

    /// Stay reachable: restore this manager's window whenever a later launch of
    /// the same executable signals the wake event.
    pub fn listen(app: tauri::AppHandle) {
        let Ok(image) = std::env::current_exe() else {
            return;
        };
        let name = object_name(&image, "Wake");

        // Auto-reset (no `EVENT_MANUAL_RESET`): one signal wakes exactly one wait.
        let event = unsafe { CreateEventW(std::ptr::null(), 0, 0, name.as_ptr()) };
        if event.is_null() {
            eprintln!(
                "[instance] could not create the wake event (error {})",
                unsafe { GetLastError() }
            );
            return;
        }

        // The handle is a raw pointer; wrap it so the listener thread may own it.
        // It lives for the whole process, so it is never closed.
        struct Wake(usize);
        unsafe impl Send for Wake {}

        let wake = Wake(event as usize);
        std::thread::spawn(move || {
            let event = wake.0 as HANDLE;
            loop {
                let state = unsafe { WaitForSingleObject(event, u32::MAX) };
                if state != WAIT_OBJECT_0 {
                    // Not a wake-up (abandoned / failed wait): retry shortly.
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    continue;
                }

                // Check the OS state, not the API's cached one: the window can
                // report itself visible while the window manager has not mapped
                // it yet, so retry until it is genuinely on screen.
                for _ in 0..10 {
                    crate::commands::window::restore_main_window(&app);
                    if crate::commands::window::is_main_window_visible(&app) == Some(true) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(60));
                }

                // Windows only hands the foreground to a process that recently
                // received input; the launcher called `AllowSetForegroundWindow`
                // for us, so retrying briefly is enough to land the focus.
                for _ in 0..20 {
                    match app.get_webview_window("main") {
                        Some(window) if !window.is_focused().unwrap_or(false) => {
                            let _ = window.set_focus();
                        }
                        _ => break,
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }
        });
    }
}
