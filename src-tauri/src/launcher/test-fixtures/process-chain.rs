//! A real executable launcher chain: launcher -> bridge -> game.
//! Both bootstrap processes exit immediately; only the game waits for `finish`.
use std::{
    env, fs,
    process::Command,
    time::{Duration, Instant},
};
fn main() {
    let args: Vec<_> = env::args_os().collect();
    let directory = std::path::PathBuf::from(&args[2]);
    match args[1].to_str().unwrap() {
        "launcher" | "bridge" => {
            let next = if args[1] == "launcher" {
                "bridge"
            } else {
                "game"
            };
            let mut command = Command::new(env::current_exe().unwrap());
            command.arg(next).arg(directory);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x0800_0000);
            }
            command.spawn().unwrap();
        }
        "game" => {
            fs::write(directory.join("game-ready"), std::process::id().to_string()).unwrap();
            let deadline = Instant::now() + Duration::from_secs(15);
            while !directory.join("finish").exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            fs::write(directory.join("game-ended"), "done").unwrap();
        }
        _ => panic!("unknown fixture mode"),
    }
}
