//! Track a single launch independently of the launcher's own lifetime.
use std::io;
use std::process::{Child, Command, ExitStatus};

pub(super) struct TrackedChild {
    child: Child,
    #[cfg(windows)]
    job: windows::ProcessJob,
    #[cfg(windows)]
    reported_handoff: bool,
}

impl TrackedChild {
    pub fn spawn(command: &mut Command) -> io::Result<Self> {
        #[cfg(windows)]
        {
            use std::os::windows::{io::AsRawHandle, process::CommandExt};
            use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
            let job = windows::ProcessJob::new()?;
            // Assign before the first instruction: a fast launcher cannot spawn
            // its game and exit before the operating system starts tracking it.
            command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
            let mut child = command.spawn()?;
            let setup = job
                .assign(child.as_raw_handle())
                .and_then(|_| windows::resume_initial_thread(child.id()));
            if let Err(error) = setup {
                let _ = job.terminate();
                let _ = child.kill();
                let _ = child.wait();
                return Err(io::Error::new(
                    error.kind(),
                    format!("无法建立游戏进程监视：{error}"),
                ));
            }
            return Ok(Self {
                child,
                job,
                reported_handoff: false,
            });
        }
        #[cfg(not(windows))]
        Ok(Self {
            child: command.spawn()?,
        })
    }
    pub fn id(&self) -> u32 {
        self.child.id()
    }
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let status = self.child.try_wait()?;
        #[cfg(windows)]
        {
            let active = self.job.active_processes()?;
            if active > 0 {
                if status.is_some() && !self.reported_handoff {
                    crate::logging::record(
                        "INFO",
                        "launcher",
                        &format!(
                            "启动器已退出，继续监视游戏进程 root_pid={} active_processes={active}",
                            self.id()
                        ),
                    );
                    self.reported_handoff = true;
                }
                return Ok(None);
            }
        }
        Ok(status)
    }
    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(status);
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    pub fn kill(&mut self) -> io::Result<()> {
        #[cfg(windows)]
        {
            self.job.terminate()
        }
        #[cfg(not(windows))]
        self.child.kill()
    }
}

#[cfg(windows)]
mod windows {
    use std::{
        io,
        mem::size_of,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First,
                Thread32Next,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
                JobObjectBasicAccountingInformation, QueryInformationJobObject, TerminateJobObject,
            },
            Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };

    pub(super) struct ProcessJob(OwnedHandle);
    impl ProcessJob {
        pub fn new() -> io::Result<Self> {
            // No KILL_ON_JOB_CLOSE: quitting the manager must leave the user's
            // game running. Handles are not inheritable and the job is unnamed.
            let handle = unsafe { CreateJobObjectW(null(), null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            Ok(Self(unsafe { OwnedHandle::from_raw_handle(handle) }))
        }
        pub fn assign(&self, process: RawHandle) -> io::Result<()> {
            if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), process) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
        pub fn active_processes(&self) -> io::Result<u32> {
            let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            if unsafe {
                QueryInformationJobObject(
                    self.0.as_raw_handle(),
                    JobObjectBasicAccountingInformation,
                    (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    null_mut(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(info.ActiveProcesses)
        }
        pub fn terminate(&self) -> io::Result<()> {
            if unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }

    /// std's Child owns the process handle. Find the initial thread while the
    /// new process is still suspended, then resume it after job assignment.
    pub(super) fn resume_initial_thread(pid: u32) -> io::Result<()> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
        let mut entry = THREADENTRY32 {
            dwSize: size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
        while found != 0 {
            if entry.th32OwnerProcessID == pid {
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if thread.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
                if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                    return Err(io::Error::last_os_error());
                }
                return Ok(());
            }
            entry.dwSize = size_of::<THREADENTRY32>() as u32;
            found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
        }
        Err(io::Error::new(
            io::ErrorKind::NotFound,
            "找不到游戏启动线程",
        ))
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};

    fn fixture_exe() -> &'static PathBuf {
        static EXE: OnceLock<PathBuf> = OnceLock::new();
        EXE.get_or_init(|| {
            let dir =
                std::env::temp_dir().join(format!("koipage-chain-fixture-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let exe = dir.join("汉化 launcher fixture.exe");
            let output = Command::new("rustc")
                .arg(
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("src/launcher/test-fixtures/process-chain.rs"),
                )
                .args(["--edition=2024", "-o"])
                .arg(&exe)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            exe
        })
    }

    struct Fixture {
        dir: PathBuf,
    }
    impl Fixture {
        fn new(name: &str) -> Self {
            let dir = fixture_exe().parent().unwrap().join(name);
            std::fs::create_dir(&dir).unwrap();
            Self { dir }
        }
        fn command(&self) -> Command {
            let mut command = Command::new(fixture_exe());
            command
                .arg("launcher")
                .arg(&self.dir)
                .creation_flags(0x0800_0000);
            command
        }
        fn wait_until(&self, mut condition: impl FnMut() -> bool) {
            let deadline = Instant::now() + Duration::from_secs(6);
            while !condition() {
                assert!(
                    Instant::now() < deadline,
                    "fixture condition timed out: {}",
                    self.dir.display()
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::write(self.dir.join("finish"), "done");
        }
    }

    #[test]
    fn self_exiting_launcher_keeps_tracking_its_game_grandchild() {
        let fixture = Fixture::new("natural-exit");
        let mut tracked = TrackedChild::spawn(&mut fixture.command()).unwrap();
        fixture.wait_until(|| {
            tracked.child.try_wait().unwrap().is_some() && fixture.dir.join("game-ready").is_file()
        });
        let alive_after_launcher_exit = tracked.try_wait().unwrap().is_none();
        std::fs::write(fixture.dir.join("finish"), "done").unwrap();
        fixture.wait_until(|| tracked.try_wait().unwrap().is_some());
        assert!(
            alive_after_launcher_exit,
            "the game is still alive after both bootstrap executables exit"
        );
    }

    #[test]
    fn stopping_after_launcher_exit_terminates_the_game_without_stopping_another_launch() {
        let fixture = Fixture::new("manual-stop");
        let other = Fixture::new("unrelated-game");
        let mut unrelated = Command::new(fixture_exe())
            .arg("game")
            .arg(&other.dir)
            .creation_flags(0x0800_0000)
            .spawn()
            .unwrap();
        let mut tracked = TrackedChild::spawn(&mut fixture.command()).unwrap();
        fixture.wait_until(|| {
            tracked.child.try_wait().unwrap().is_some() && fixture.dir.join("game-ready").is_file()
        });
        other.wait_until(|| other.dir.join("game-ready").is_file());
        let pid: u32 = std::fs::read_to_string(fixture.dir.join("game-ready"))
            .unwrap()
            .parse()
            .unwrap();
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
        };
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        assert!(!handle.is_null());
        let game = unsafe { OwnedHandle::from_raw_handle(handle) };
        tracked.kill().unwrap();
        tracked.wait().unwrap();
        let game_exited =
            unsafe { WaitForSingleObject(game.as_raw_handle(), 1000) } == WAIT_OBJECT_0;
        let other_still_running = unrelated.try_wait().unwrap().is_none();
        std::fs::write(other.dir.join("finish"), "done").unwrap();
        unrelated.wait().unwrap();
        assert!(
            game_exited,
            "the game must be stopped even though its original launcher is gone"
        );
        assert!(
            other_still_running,
            "another game session must not be terminated"
        );
    }

    #[test]
    fn closing_the_tracker_does_not_kill_the_game() {
        let fixture = Fixture::new("manager-close");
        let mut tracked = TrackedChild::spawn(&mut fixture.command()).unwrap();
        fixture.wait_until(|| {
            tracked.child.try_wait().unwrap().is_some() && fixture.dir.join("game-ready").is_file()
        });
        drop(tracked);
        // The game acknowledges this signal only after the manager's tracker
        // and job handle have been closed.
        std::fs::write(fixture.dir.join("finish"), "done").unwrap();
        fixture.wait_until(|| fixture.dir.join("game-ended").is_file());
    }
}
