//! The application gate serializes capture and settings changes and records when Savvy is
//! relaunching or exiting, so new work is refused instead of racing the shutdown.
//!
//! Pause, resume and stop of the live meeting do not go through this gate: they take
//! `AppState::meeting_control`, so a long rescan or network operation cannot block them.

use std::sync::{Condvar, Mutex, MutexGuard};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GateState {
    Idle,
    Busy,
    Relaunching,
    Exiting,
}

#[derive(Debug)]
pub(crate) struct AppGate {
    state: Mutex<GateState>,
    changed: Condvar,
}

/// A running application operation. Dropping it returns the gate to `Idle`.
#[derive(Debug)]
pub(crate) struct AppOperation<'a> {
    gate: &'a AppGate,
}

impl AppGate {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(GateState::Idle),
            changed: Condvar::new(),
        }
    }

    fn state(&self) -> MutexGuard<'_, GateState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// Starts an operation now, or says why none can start.
    pub(crate) fn try_begin(&self) -> Result<AppOperation<'_>, String> {
        let mut state = self.state();
        match *state {
            GateState::Idle => {
                *state = GateState::Busy;
                Ok(AppOperation { gate: self })
            }
            GateState::Busy => Err("an application operation is already in progress".into()),
            GateState::Relaunching => Err("Savvy is reopening; try again after it opens".into()),
            GateState::Exiting => Err("Savvy is closing.".into()),
        }
    }

    /// Refuses new operations until `cancel_relaunch` or exit.
    pub(crate) fn begin_relaunch(&self) -> Result<(), String> {
        let mut state = self.state();
        match *state {
            GateState::Idle => {
                *state = GateState::Relaunching;
                Ok(())
            }
            GateState::Busy => Err("Wait for the current meeting operation to finish.".into()),
            GateState::Relaunching | GateState::Exiting => {
                Err("Savvy is already updating or reopening.".into())
            }
        }
    }

    pub(crate) fn cancel_relaunch(&self) {
        let mut state = self.state();
        match *state {
            GateState::Relaunching => {
                *state = GateState::Idle;
                self.changed.notify_all();
            }
            GateState::Idle | GateState::Busy | GateState::Exiting => {}
        }
    }

    /// Waits for the running operation to finish, then refuses every later one.
    pub(crate) fn begin_exit(&self) {
        let mut state = self.state();
        while let GateState::Busy = *state {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(|error| error.into_inner());
        }
        *state = GateState::Exiting;
    }

    /// Relaunch and exit stop the meeting themselves, so meeting work skips while they run.
    pub(crate) fn is_closing(&self) -> bool {
        match *self.state() {
            GateState::Idle | GateState::Busy => false,
            GateState::Relaunching | GateState::Exiting => true,
        }
    }
}

impl Drop for AppOperation<'_> {
    fn drop(&mut self) {
        let mut state = self.gate.state();
        match *state {
            GateState::Busy => {
                *state = GateState::Idle;
                self.gate.changed.notify_all();
            }
            GateState::Idle | GateState::Relaunching | GateState::Exiting => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AppGate, GateState};

    fn state(gate: &AppGate) -> GateState {
        *gate.state()
    }

    #[test]
    fn idle_to_busy_and_back_when_the_operation_drops() {
        let gate = AppGate::new();
        let operation = gate.try_begin().unwrap();
        assert_eq!(state(&gate), GateState::Busy);
        drop(operation);
        assert_eq!(state(&gate), GateState::Idle);
        assert!(!gate.is_closing());
    }

    #[test]
    fn busy_refuses_a_second_operation_and_a_relaunch() {
        let gate = AppGate::new();
        let _operation = gate.try_begin().unwrap();
        assert_eq!(
            gate.try_begin().unwrap_err(),
            "an application operation is already in progress"
        );
        assert_eq!(
            gate.begin_relaunch().unwrap_err(),
            "Wait for the current meeting operation to finish."
        );
        assert_eq!(state(&gate), GateState::Busy);
    }

    #[test]
    fn idle_to_relaunching_and_back_on_cancel() {
        let gate = AppGate::new();
        gate.begin_relaunch().unwrap();
        assert!(gate.is_closing());
        assert!(
            gate.try_begin().is_err(),
            "relaunching refuses new operations"
        );
        assert_eq!(
            gate.begin_relaunch().unwrap_err(),
            "Savvy is already updating or reopening."
        );
        gate.cancel_relaunch();
        assert_eq!(state(&gate), GateState::Idle);
        assert!(gate.try_begin().is_ok());
    }

    #[test]
    fn cancel_relaunch_only_leaves_relaunching() {
        let gate = AppGate::new();
        gate.cancel_relaunch();
        assert_eq!(state(&gate), GateState::Idle);
        let operation = gate.try_begin().unwrap();
        gate.cancel_relaunch();
        assert_eq!(state(&gate), GateState::Busy);
        drop(operation);
        gate.begin_exit();
        gate.cancel_relaunch();
        assert_eq!(state(&gate), GateState::Exiting);
    }

    #[test]
    fn exiting_is_terminal() {
        let gate = AppGate::new();
        gate.begin_exit();
        assert!(gate.is_closing());
        assert_eq!(gate.try_begin().unwrap_err(), "Savvy is closing.");
        assert!(gate.begin_relaunch().is_err());
        gate.begin_exit();
        assert_eq!(state(&gate), GateState::Exiting);
    }

    #[test]
    fn relaunching_to_exiting_when_the_user_quits_mid_update() {
        let gate = AppGate::new();
        gate.begin_relaunch().unwrap();
        gate.begin_exit();
        assert_eq!(state(&gate), GateState::Exiting);
    }

    #[test]
    fn exit_waits_for_the_running_operation() {
        let gate = std::sync::Arc::new(AppGate::new());
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let holder_gate = gate.clone();
        let holder = std::thread::spawn(move || {
            let _operation = holder_gate.try_begin().unwrap();
            held_tx.send(()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(200));
        });
        held_rx.recv().unwrap();
        assert_eq!(state(&gate), GateState::Busy);
        gate.begin_exit();
        assert_eq!(state(&gate), GateState::Exiting);
        holder.join().unwrap();
        assert_eq!(
            state(&gate),
            GateState::Exiting,
            "a finished operation must not reopen"
        );
    }
}
