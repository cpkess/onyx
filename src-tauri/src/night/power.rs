//! macOS power / idle / CPU sampling for Night Shift "smart" gating.
//!
//! All checks are cheap, read-only shellouts to system tools. They are called at
//! the coarse (~60s) scheduler tick and between jobs in the processor — never in
//! a tight loop.

use std::process::Command;

/// True when the Mac is running on AC (wall) power rather than the battery.
pub fn on_ac_power() -> bool {
    // `pmset -g ps` prints e.g. "Now drawing from 'AC Power'".
    match Command::new("pmset").args(["-g", "ps"]).output() {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout);
            s.contains("AC Power")
        }
        // If pmset is unavailable we conservatively report "not on AC" so smart
        // mode won't run on an unknown power state.
        Err(_) => false,
    }
}

/// Seconds since the last HID (keyboard/mouse) input, i.e. system idle time.
pub fn system_idle_secs() -> f64 {
    // `ioreg -c IOHIDSystem` exposes `HIDIdleTime` in nanoseconds.
    match Command::new("ioreg").args(["-c", "IOHIDSystem"]).output() {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout);
            for line in s.lines() {
                if let Some(pos) = line.find("HIDIdleTime") {
                    if let Some(eq) = line[pos..].find('=') {
                        let v = line[pos + eq + 1..].trim();
                        if let Ok(ns) = v.parse::<u64>() {
                            return ns as f64 / 1_000_000_000.0;
                        }
                    }
                }
            }
            0.0
        }
        Err(_) => 0.0,
    }
}

/// Approximate system-wide CPU utilization as a percentage (0–100), normalized
/// by the logical CPU count. Coarse but cheap.
pub fn cpu_busy_percent() -> f64 {
    let ncpu = num_cpus();
    match Command::new("ps").args(["-A", "-o", "%cpu="]).output() {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout);
            let total: f64 = s
                .lines()
                .filter_map(|l| l.trim().parse::<f64>().ok())
                .sum();
            if ncpu > 0.0 {
                (total / ncpu).min(100.0)
            } else {
                total
            }
        }
        Err(_) => 0.0,
    }
}

fn num_cpus() -> f64 {
    Command::new("sysctl")
        .args(["-n", "hw.logicalcpu"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<f64>().ok())
        .unwrap_or(1.0)
}

/// Current local hour (0–23), via `date +%H`.
pub fn local_hour() -> u32 {
    Command::new("date")
        .arg("+%H")
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<u32>().ok())
        .unwrap_or(0)
}

/// Is `hour` within the [start, end) window? Handles overnight wrap (e.g. 23→3).
pub fn in_window(hour: u32, start: u32, end: u32) -> bool {
    if start == end {
        true // a zero-width window means "always" for our purposes
    } else if start < end {
        hour >= start && hour < end
    } else {
        // Wraps past midnight, e.g. 23..3.
        hour >= start || hour < end
    }
}
