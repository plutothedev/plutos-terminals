// PTY output coalescing — the fix for one-emit-per-4KB-read (plan:
// docs/superpowers/plans/2026-08-12-P1-pty-hot-path.md, T1).
//
// Pure state machine; the reader thread and the global flusher both drive it
// under a single per-session Mutex, and EMIT HAPPENS UNDER THAT SAME LOCK
// (invariant 1) so extraction order and channel order are the same thing.
//
// Flush conditions:
//   - leading edge: pending empty AND >= max_age since last emit -> the chunk
//     goes out immediately (keystroke echo keeps today's latency; xterm's
//     first-write-after-input fast path stays effective)
//   - size: pending crosses max_bytes
//   - age: oldest pending byte is >= max_age old (the flusher's tick)
//   - take: unconditional, for exit paths (tail before pty-exit://)
//
// On emit failure the caller pushes the string back via retain_front — order
// is preserved because nothing can append while the caller holds the lock.

use std::time::{Duration, Instant};

pub struct Coalescer {
    pending: String,
    first_pending_at: Option<Instant>,
    last_emit_at: Instant,
    max_bytes: usize,
    max_age: Duration,
    /// Hard ceiling on `pending`. Retain-on-Err means sustained emit failure
    /// plus a flooding pane would otherwise grow the buffer without bound
    /// (review CRITICAL on the T1 commit); past the cap the buffer is dropped
    /// whole — never a silent partial truncation — and the loss is counted so
    /// the wiring can surface a marker line. Same drop-and-notify shape as the
    /// SSH outbound cap.
    pending_cap: usize,
    dropped: u64,
}

impl Coalescer {
    pub fn new(max_bytes: usize, max_age: Duration, pending_cap: usize, now: Instant) -> Self {
        Self {
            pending: String::new(),
            first_pending_at: None,
            // Backdate so the very first output of a fresh session leading-edges
            // (shell banner paints immediately instead of waiting one tick).
            last_emit_at: now.checked_sub(max_age).unwrap_or(now),
            max_bytes,
            max_age,
            pending_cap,
            dropped: 0,
        }
    }

    /// Reader-side entry. Returns a string the caller must emit (still holding
    /// the lock) — either the leading-edge chunk or the size-flushed buffer.
    pub fn push(&mut self, s: &str, now: Instant) -> Option<String> {
        if self.pending.is_empty() && now.duration_since(self.last_emit_at) >= self.max_age {
            self.last_emit_at = now;
            return Some(s.to_string());
        }
        self.pending.push_str(s);
        self.enforce_cap();
        if self.first_pending_at.is_none() && !self.pending.is_empty() {
            self.first_pending_at = Some(now);
        }
        if self.pending.len() >= self.max_bytes {
            return Some(self.flush(now));
        }
        None
    }

    /// Flusher-side entry. Returns the buffer when the oldest pending byte has
    /// aged past max_age.
    pub fn tick(&mut self, now: Instant) -> Option<String> {
        match self.first_pending_at {
            Some(t) if now.duration_since(t) >= self.max_age => Some(self.flush(now)),
            _ => None,
        }
    }

    /// Unconditional drain for exit paths.
    pub fn take(&mut self, now: Instant) -> Option<String> {
        if self.pending.is_empty() {
            None
        } else {
            Some(self.flush(now))
        }
    }

    /// Emit failed — put the string back at the FRONT so order is preserved.
    /// Under invariant 1 (extract+emit+retain all under one lock) pending is
    /// always empty here; the nonempty prepend branch is defensive against a
    /// future caller that releases the lock between extract and retain, and
    /// is pinned by retain_front_prepends_when_pending_nonempty.
    pub fn retain_front(&mut self, s: String, now: Instant) {
        if self.pending.is_empty() {
            self.pending = s;
        } else {
            self.pending.insert_str(0, &s);
        }
        self.enforce_cap();
        if self.first_pending_at.is_none() && !self.pending.is_empty() {
            self.first_pending_at = Some(now.checked_sub(self.max_age).unwrap_or(now));
        }
    }

    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    /// Bytes discarded by the cap since the last call. The wiring surfaces a
    /// marker line when this returns nonzero.
    pub fn take_dropped(&mut self) -> u64 {
        std::mem::take(&mut self.dropped)
    }

    /// The drop-marker emit itself failed — put the count back so the notice
    /// survives until the sink is healthy enough to actually deliver it.
    pub fn restore_dropped(&mut self, d: u64) {
        self.dropped += d;
    }

    fn enforce_cap(&mut self) {
        if self.pending.len() > self.pending_cap {
            self.dropped += self.pending.len() as u64;
            self.pending.clear();
            self.pending.shrink_to_fit();
            self.first_pending_at = None;
        }
    }

    fn flush(&mut self, now: Instant) -> String {
        self.last_emit_at = now;
        self.first_pending_at = None;
        std::mem::take(&mut self.pending)
    }
}

#[cfg(test)]
mod coalesce_tests {
    use super::*;

    const KB64: usize = 64 * 1024;
    const AGE: Duration = Duration::from_millis(8);
    const CAP: usize = 4 * KB64;

    fn c(now: Instant) -> Coalescer {
        Coalescer::new(KB64, AGE, CAP, now)
    }

    #[test]
    fn first_push_after_construction_leading_edges() {
        let t0 = Instant::now();
        let mut co = c(t0);
        assert_eq!(co.push("hello", t0).as_deref(), Some("hello"));
        assert!(!co.has_pending());
    }

    #[test]
    fn leading_edge_fires_when_idle_past_max_age() {
        let t0 = Instant::now();
        let mut co = c(t0);
        co.push("a", t0); // leading edge, emitted
        // Second push right after: coalesces (last emit too recent).
        assert_eq!(co.push("b", t0 + Duration::from_millis(1)), None);
        assert!(co.has_pending());
    }

    #[test]
    fn rapid_pushes_coalesce_until_size_threshold() {
        let t0 = Instant::now();
        let mut co = c(t0);
        co.push("x", t0); // leading edge
        let t1 = t0 + Duration::from_millis(1);
        let chunk = "y".repeat(KB64 / 2);
        assert_eq!(co.push(&chunk, t1), None);
        // Crossing the boundary flushes everything accumulated, in order.
        let out = co.push(&chunk, t1).expect("size flush");
        assert_eq!(out.len(), KB64);
        assert!(out.starts_with('y') && out.ends_with('y'));
        assert!(!co.has_pending());
    }

    #[test]
    fn exact_boundary_flushes() {
        let t0 = Instant::now();
        let mut co = c(t0);
        co.push("x", t0); // leading edge out of the way
        let t1 = t0 + Duration::from_millis(1);
        let exact = "z".repeat(KB64);
        let out = co.push(&exact, t1).expect("exact-boundary flush");
        assert_eq!(out.len(), KB64);
    }

    #[test]
    fn tick_flushes_after_max_age_and_not_before() {
        let t0 = Instant::now();
        let mut co = c(t0);
        co.push("x", t0); // leading edge
        let t1 = t0 + Duration::from_millis(1);
        co.push("abc", t1);
        assert_eq!(co.tick(t1 + Duration::from_millis(3)), None); // 4ms old: hold
        assert_eq!(co.tick(t1 + AGE).as_deref(), Some("abc"));
        assert!(!co.has_pending());
    }

    #[test]
    fn take_drains_remainder_and_empty_take_is_none() {
        let t0 = Instant::now();
        let mut co = c(t0);
        co.push("x", t0);
        let t1 = t0 + Duration::from_millis(1);
        co.push("tail", t1);
        assert_eq!(co.take(t1).as_deref(), Some("tail"));
        assert_eq!(co.take(t1), None);
    }

    #[test]
    fn ordering_concat_equals_input_sequence() {
        let t0 = Instant::now();
        let mut co = c(t0);
        let mut emitted = String::new();
        let mut now = t0;
        for (i, s) in ["one ", "two ", "three ", "four "].iter().enumerate() {
            now = t0 + Duration::from_millis(i as u64);
            if let Some(out) = co.push(s, now) {
                emitted.push_str(&out);
            }
        }
        if let Some(out) = co.take(now) {
            emitted.push_str(&out);
        }
        assert_eq!(emitted, "one two three four ");
    }

    #[test]
    fn retain_front_preserves_order_and_blocks_leading_edge() {
        let t0 = Instant::now();
        let mut co = c(t0);
        let out = co.push("first", t0).expect("leading edge");
        // Emit failed: put it back.
        co.retain_front(out, t0);
        assert!(co.has_pending());
        // A new push must APPEND (no leading edge while pending is nonempty)...
        let much_later = t0 + Duration::from_secs(1);
        assert_eq!(co.push("second", much_later), None);
        // ...and the retained data is old enough that the next tick flushes
        // everything, in original order.
        let out = co.tick(much_later).expect("retry flush");
        assert_eq!(out, "firstsecond");
    }

    #[test]
    fn retain_after_size_flush_failure_retries_in_order() {
        let t0 = Instant::now();
        let mut co = c(t0);
        co.push("x", t0); // leading edge
        let t1 = t0 + Duration::from_millis(1);
        let big = "b".repeat(KB64);
        let flushed = co.push(&big, t1).expect("size flush");
        co.retain_front(flushed, t1);
        // The retained buffer already sits at the size threshold, so the very
        // next push re-crosses it and the retry flush happens RIGHT THERE —
        // the earliest opportunity — with order preserved.
        let out = co
            .push("after", t1 + Duration::from_millis(1))
            .expect("size-flush retry on next push");
        assert_eq!(out.len(), KB64 + "after".len());
        assert!(out.starts_with('b') && out.ends_with("after"));
        assert!(!co.has_pending());
    }

    #[test]
    fn sustained_emit_failure_is_capped_never_unbounded() {
        // Review CRITICAL on the T1 commit: flood + every emit failing grew
        // pending without bound. The cap must clear the buffer (whole-drop,
        // counted), keeping worst-case memory bounded.
        let t0 = Instant::now();
        let mut co = c(t0);
        co.push("x", t0); // leading edge
        let t1 = t0 + Duration::from_millis(1);
        let chunk = "c".repeat(KB64);
        let mut max_seen = 0usize;
        for i in 0..40u64 {
            let now = t1 + Duration::from_millis(i);
            if let Some(out) = co.push(&chunk, now) {
                max_seen = max_seen.max(out.len());
                co.retain_front(out, now); // emit failed every time
            }
        }
        assert!(co.take_dropped() > 0, "cap must have fired");
        let remaining = co
            .take(t1 + Duration::from_secs(1))
            .map(|s| s.len())
            .unwrap_or(0);
        assert!(remaining <= CAP + KB64, "remaining bounded: {remaining}");
        assert!(max_seen <= CAP + KB64, "single flush bounded: {max_seen}");
    }

    #[test]
    fn cap_drop_is_whole_buffer_and_counted() {
        let t0 = Instant::now();
        let mut co = c(t0);
        co.push("x", t0);
        let t1 = t0 + Duration::from_millis(1);
        let big = "b".repeat(CAP + 1);
        co.retain_front(big, t1);
        assert!(!co.has_pending(), "over-cap retain drops the whole buffer");
        assert_eq!(co.take_dropped(), (CAP + 1) as u64);
        assert_eq!(co.take_dropped(), 0, "counter swaps to zero");
    }

    #[test]
    fn retain_front_prepends_when_pending_nonempty() {
        // Defensive branch: unreachable under invariant 1, but if a future
        // caller ever retains after releasing the lock, order must still hold.
        let t0 = Instant::now();
        let mut co = c(t0);
        co.push("x", t0); // leading edge
        let t1 = t0 + Duration::from_millis(1);
        co.push("newer", t1); // coalesces
        co.retain_front("older".into(), t1);
        let out = co.tick(t1 + AGE).expect("aged flush");
        assert_eq!(out, "oldernewer");
    }
}
