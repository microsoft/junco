//! Small numeric helpers shared by the transplanted native modules.
//!
//! Adapted from Oh My Pi `crates/pi-natives/src/utils.rs` at revision
//! `7ae76f8e4daca0c8f409f61bcd514260cd522365` (see `LICENSE.oh-my-pi`).

/// Saturating cast from `u64` to `u32`, clamping at [`u32::MAX`].
pub const fn clamp_u32(value: u64) -> u32 {
	if value > u32::MAX as u64 {
		u32::MAX
	} else {
		value as u32
	}
}
