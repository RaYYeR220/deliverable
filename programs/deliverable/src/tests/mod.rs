//! In-crate tests. The program's crate-type is `cdylib` only, so there is no
//! rlib for an external `tests/` directory to link against.
//!
//! Everything here runs against real mainnet account dumps in
//! `tests/fixtures/`, captured with `scripts/fixtures.ts`. There is no mock
//! oracle and no mock mint anywhere in this build: the failure modes we are
//! defending against only exist in the real accounts.

mod adjustment_test;
mod gate_test;
mod harness;
mod oracle_test;
mod scaled_ui_test;
mod security_test;
mod series_test;
mod settle_test;
mod venue;
mod write_test;
