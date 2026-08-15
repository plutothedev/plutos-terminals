// (C)
//! System stats (CPU / memory / disk) for the MobaXterm-style status bar,
//! polled ~every 2.5s. Extracted from the commands.rs grab-bag. Named `sysstats`
//! (not `sysinfo`) so the module does not shadow the `sysinfo` crate it uses.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

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
// Last good disk-used%, served whenever a refresh is already in flight (or the
// mutex is poisoned). A stalled network mount / sleeping external / locked
// volume makes `Disks::refresh(true)` hang on the OS stat call while holding
// the DISKS lock (audit C1). Before this, every OTHER poller — every window's
// loop AND the phone companion — blocked on `DISKS.lock()` forever (promise
// never resolved, status bar wedged, one leaked blocking-pool thread per
// caller). Now callers `try_lock`: at most the ONE thread actively inside a
// stalled refresh is stuck; everyone else fast-returns this cached value, so
// disk% merely freezes at last-good while the rest of the bar keeps updating.
static LAST_DISK_PCT: OnceLock<Mutex<f32>> = OnceLock::new();

fn last_disk_pct() -> f32 {
    // Plain lock (poison-recovering): the critical section is a single f32
    // read/write that can never hang, so try_lock here would only ever lose a
    // nanosecond race and spuriously serve 0.0 (review LOW) — the exact wrong
    // value this cache exists to avoid. Only DISKS itself needs try_lock.
    let g = LAST_DISK_PCT
        .get_or_init(|| Mutex::new(0.0))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *g
}

fn store_disk_pct(v: f32) {
    let mut g = LAST_DISK_PCT
        .get_or_init(|| Mutex::new(0.0))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *g = v;
}

/// Async wrapper (P2-T5): the body stats the disk. `system_stats_sync` now
/// `try_lock`s the disk mutex so it can never BLOCK, but the one thread that
/// wins the lock can still stall inside `refresh(true)` on a dead mount — so
/// bound even that caller with a timeout and serve cached stats on expiry.
#[tauri::command]
pub async fn system_stats() -> SystemStats {
    let cached = || SystemStats {
        cpu: 0.0,
        mem_used: 0,
        mem_total: 0,
        disk_used_pct: last_disk_pct(),
    };
    match tokio::time::timeout(
        Duration::from_secs(2),
        tauri::async_runtime::spawn_blocking(system_stats_sync),
    )
    .await
    {
        Ok(Ok(stats)) => stats,
        // timeout (dead mount refresh) or join error → last-good, never wedge
        _ => cached(),
    }
}

pub fn system_stats_sync() -> SystemStats {
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
    // try_lock, NEVER blocking-lock: if another caller is mid-refresh (possibly
    // stalled on a dead mount), serve the last-good value instead of queueing
    // behind it (audit C1).
    let disks_mutex = DISKS.get_or_init(|| Mutex::new(sysinfo::Disks::new_with_refreshed_list()));
    let disk_used_pct = match disks_mutex.try_lock() {
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
            store_disk_pct(p);
            p
        }
        // contended (someone refreshing) or poisoned → last-good, no block
        Err(_) => last_disk_pct(),
    };

    SystemStats {
        cpu,
        mem_used,
        mem_total,
        disk_used_pct,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use std::time::Instant;

    // Serialize these tests: they both touch the global DISKS lock, and the
    // whole point of one is to HOLD it — running concurrently would make the
    // other flaky.
    static TEST_GUARD: StdMutex<()> = StdMutex::new(());

    fn guard() -> std::sync::MutexGuard<'static, ()> {
        TEST_GUARD.lock().unwrap_or_else(|p| p.into_inner())
    }

    #[test]
    fn stats_are_in_range_and_prompt() {
        let _g = guard();
        let s = system_stats_sync();
        assert!((0.0..=100.0).contains(&s.disk_used_pct), "disk pct out of range: {}", s.disk_used_pct);
        assert!((0.0..=100.0).contains(&s.cpu), "cpu out of range: {}", s.cpu);
    }

    #[test]
    fn a_held_disk_lock_does_not_block_the_caller() {
        let _g = guard();
        // Warm the one-time inits (System::new_all + Disks enumeration) so the
        // timed call measures only the contended-disk path, not first-run cost.
        let _ = system_stats_sync();
        // Seed a known last-good value, then hold the DISKS lock to simulate a
        // stalled refresh mid-flight.
        store_disk_pct(42.0);
        let disks = DISKS.get_or_init(|| Mutex::new(sysinfo::Disks::new_with_refreshed_list()));
        let held = disks.lock().unwrap_or_else(|p| p.into_inner());

        let start = Instant::now();
        let s = system_stats_sync(); // must NOT block behind `held`
        let elapsed = start.elapsed();

        drop(held);
        assert!(
            elapsed < Duration::from_millis(500),
            "system_stats_sync blocked on a held DISKS lock ({elapsed:?})"
        );
        assert_eq!(s.disk_used_pct, 42.0, "should have served the cached last-good pct");
    }
}
