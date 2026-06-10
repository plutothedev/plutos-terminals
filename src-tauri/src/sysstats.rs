// (C)
//! System stats (CPU / memory / disk) for the MobaXterm-style status bar,
//! polled ~every 2.5s. Extracted from the commands.rs grab-bag. Named `sysstats`
//! (not `sysinfo`) so the module does not shadow the `sysinfo` crate it uses.

use std::sync::{Mutex, OnceLock};

use serde::Serialize;

// ── System stats for the MobaXterm-style status bar ──────────────────
// A persistent System so CPU usage is a real delta between polls (a freshly
// constructed System reads ~0%). The frontend polls this every couple seconds.

#[derive(Serialize)]
pub struct SystemStats {
    pub cpu: f32,           // overall CPU usage, 0..100
    pub mem_used: u64,      // bytes
    pub mem_total: u64,     // bytes
    pub disk_used_pct: f32, // root / primary disk used %
}

static SYS: OnceLock<Mutex<sysinfo::System>> = OnceLock::new();
// The OS mount table is enumerated once at startup; each poll then re-stats the
// already-known disks in place. Rebuilding `Disks::new_with_refreshed_list()`
// every 2.5s re-walked the mount table (steady-state wasted syscalls, and a
// stale network mount stalls the whole status bar on the OS stat timeout).
static DISKS: OnceLock<Mutex<sysinfo::Disks>> = OnceLock::new();

#[tauri::command]
pub fn system_stats() -> SystemStats {
    let sys_mutex = SYS.get_or_init(|| Mutex::new(sysinfo::System::new_all()));
    let (cpu, mem_used, mem_total) = match sys_mutex.lock() {
        Ok(mut sys) => {
            sys.refresh_cpu_usage();
            sys.refresh_memory();
            (
                sys.global_cpu_usage(),
                sys.used_memory(),
                sys.total_memory(),
            )
        }
        Err(_) => (0.0, 0, 0),
    };

    let pct = |total: u64, avail: u64| -> f32 {
        if total == 0 {
            0.0
        } else {
            (total.saturating_sub(avail) as f64 / total as f64 * 100.0) as f32
        }
    };

    // Disk: the volume holding the user's home directory (longest mount-point
    // prefix match), else fall back to the first disk. The old root-only
    // (`mount_point == "/"`) match never hit on Windows — there is no "/"
    // mount, so the status bar showed whichever disk happened to enumerate
    // first (often a recovery/secondary volume), not the system drive. The
    // prefix match also picks a separate /home mount on unix. Reuse the cached
    // Disks handle and refresh space figures in place rather than
    // re-enumerating the mount table on every poll.
    let disks_mutex = DISKS.get_or_init(|| Mutex::new(sysinfo::Disks::new_with_refreshed_list()));
    let disk_used_pct = match disks_mutex.lock() {
        Ok(mut disks) => {
            disks.refresh(true);
            let home = crate::commands::local_home();
            let mut best: Option<&sysinfo::Disk> = None;
            for d in disks.list() {
                if home.starts_with(d.mount_point()) {
                    let better = best.map_or(true, |b| {
                        d.mount_point().as_os_str().len() > b.mount_point().as_os_str().len()
                    });
                    if better {
                        best = Some(d);
                    }
                }
            }
            let mut p = best
                .map(|d| pct(d.total_space(), d.available_space()))
                .unwrap_or(0.0);
            if p == 0.0 {
                if let Some(d) = disks.list().first() {
                    p = pct(d.total_space(), d.available_space());
                }
            }
            p
        }
        Err(_) => 0.0,
    };

    SystemStats {
        cpu,
        mem_used,
        mem_total,
        disk_used_pct,
    }
}
