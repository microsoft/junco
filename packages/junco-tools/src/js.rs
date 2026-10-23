//! Borrowing JavaScript strings at the N-API boundary.
//!
//! Node-API never hands out a pointer into a JS string's backing store: every
//! accessor writes code units into a caller-owned buffer. The copy is
//! unavoidable, the *allocation* is not — [`utf16`] and [`utf8`] read into a
//! fixed per-thread scratch arena and hand back a guard that derefs to the
//! borrowed text, releasing its range on drop. Text that fits the arena costs
//! zero allocations; longer text spills to one owned `Vec`. Several guards can
//! be live at once (diff pairs, colour palettes) — each owns a disjoint range.
//!
//! [`utf16`] is the default: it is the JS string's own encoding, so it is the
//! only accessor that never transcodes. [`utf8`] exists for algorithms that are
//! byte- or `str`-shaped (terminal escape parsing, syntect, paths).

use std::{
    cell::{Cell, UnsafeCell},
    ops::{Deref, Range},
    ptr::{self, NonNull},
    slice, str,
};

use napi::{
    Error, JsString, JsValue, Result, Status,
    bindgen_prelude::{ToNapiValue, TypeName},
    sys,
};

/// Scratch bytes per thread. Only the JS thread reaches this module (N-API
/// handles are not `Send`), so the footprint is effectively process-global.
const SCRATCH_LEN: usize = 64 * 1024;

/// Fixed-size bump arena backing [`Utf16`]/[`Utf8`] guards.
///
/// The base address is stable for the thread's lifetime (the array never
/// grows), so guards may hold raw pointers into it. Soundness rests on range
/// discipline, not a borrow flag: every committed range is disjoint, new reads
/// only touch bytes past `offset`, and no reference to the whole array is ever
/// formed — all access goes through raw pointers into a caller's own range.
struct Arena {
    /// Stored as `u16` units purely for the 2-alignment UTF-16 fills need;
    /// UTF-8 fills reinterpret the same bytes at alignment 1.
    buf: UnsafeCell<[u16; SCRATCH_LEN / 2]>,
    /// Bytes handed out. Fills bump it; drops roll it back (see
    /// [`Self::release`]).
    offset: Cell<usize>,
    /// Live scratch-backed guards. Hitting zero resets `offset`, so a non-LIFO
    /// drop order leaks at most until the last guard goes away.
    live: Cell<usize>,
}

thread_local! {
    static ARENA: Arena = const {
        Arena {
            buf:    UnsafeCell::new([0; SCRATCH_LEN / 2]),
            offset: Cell::new(0),
            live:   Cell::new(0),
        }
    };
}

impl Arena {
    const fn base(&self) -> *mut u8 {
        self.buf.get().cast()
    }

    /// Free tail aligned to `align` (a power of two): byte offset and length.
    const fn tail(&self, align: usize) -> (usize, usize) {
        let start = (self.offset.get() + align - 1) & !(align - 1);
        (start, SCRATCH_LEN.saturating_sub(start))
    }

    /// Record `start..start + len` as owned by a new guard.
    fn commit(&self, start: usize, len: usize) {
        self.offset.set(start + len);
        self.live.set(self.live.get() + 1);
    }

    /// Return `start..end`. The topmost range rolls the bump pointer back
    /// (LIFO drops recycle immediately); otherwise the bytes are stranded
    /// until `live` reaches zero and the whole arena resets.
    fn release(&self, start: usize, end: usize) {
        let live = self.live.get() - 1;
        self.live.set(live);
        if live == 0 {
            self.offset.set(0);
        } else if self.offset.get() == end {
            self.offset.set(start);
        }
    }
}

/// Text read from a JS string: borrowed from the thread's scratch arena when
/// it fits, spilled to one owned `Vec` when it does not.
enum TextRepr<T> {
    /// Range inside [`ARENA`]; `Drop` releases it. `NonNull` keeps this
    /// variant `!Send`, so the pointer can never outlive its thread's TLS.
    Scratch { ptr: NonNull<T>, len: usize },
    /// Heap spill for text longer than the arena's free tail.
    Owned(Vec<T>),
}

impl<T> TextRepr<T> {
    #[inline]
    fn as_slice(&self) -> &[T] {
        match self {
            // SAFETY: the constructor committed `ptr..ptr + len` to this guard;
            // the arena never moves and no other guard overlaps the range.
            Self::Scratch { ptr, len } => unsafe { slice::from_raw_parts(ptr.as_ptr(), *len) },
            Self::Owned(vec) => vec,
        }
    }
}

impl<T> Drop for TextRepr<T> {
    fn drop(&mut self) {
        if let Self::Scratch { ptr, len } = *self {
            ARENA.with(|arena| {
                let start = ptr.as_ptr().addr() - arena.base().addr();
                arena.release(start, start + len * size_of::<T>());
            });
        }
    }
}

/// Borrowed UTF-16 code units of a JS string, backed by the scratch arena.
///
/// Unlike `JsString::into_utf16`, the view excludes the NUL terminator
/// Node-API appends, so `&*guard` is exactly the string's code units.
pub struct Utf16(TextRepr<u16>);

impl Deref for Utf16 {
    type Target = [u16];

    #[inline]
    fn deref(&self) -> &[u16] {
        self.0.as_slice()
    }
}

/// Borrowed UTF-8 bytes of a JS string, backed by the scratch arena.
pub struct Utf8(TextRepr<u8>);

impl Deref for Utf8 {
    type Target = str;

    #[inline]
    fn deref(&self) -> &str {
        // SAFETY: utf8 validates the bytes before constructing Utf8.
        unsafe { str::from_utf8_unchecked(self.0.as_slice()) }
    }
}

/// Borrow `value` as UTF-16 code units using the thread's scratch arena.
///
/// The happy path is a single N-API call into the arena's free tail; text
/// that does not fit is measured and read into an owned spill buffer.
#[inline]
pub fn utf16(value: JsString<'_>) -> Result<Utf16> {
    let raw = value.value();
    ARENA.with(|arena| {
        let (start, avail_bytes) = arena.tail(2);
        let avail = avail_bytes / 2;
        if avail >= 2 {
            // SAFETY: `start..start + avail_bytes` is past every committed range,
            // and the base is 2-aligned with `start` aligned up.
            let ptr = unsafe { arena.base().add(start) }.cast::<u16>();
            let mut written = 0;
            // SAFETY: `raw` is a JS string owned by the live callback; Node-API
            // writes at most `avail - 1` units plus a NUL into the free tail.
            let status = unsafe {
                sys::napi_get_value_string_utf16(raw.env, raw.value, ptr, avail, &mut written)
            };
            napi::check_status!(status, "Failed to read JavaScript string")?;
            if written < avail - 1 {
                arena.commit(start, written * 2);
                return Ok(Utf16(TextRepr::Scratch {
                    ptr: NonNull::new(ptr).unwrap(),
                    len: written,
                }));
            }
        }

        let mut len = 0;
        // SAFETY: a null buffer asks Node-API for the code-unit length only.
        let status = unsafe {
            sys::napi_get_value_string_utf16(raw.env, raw.value, ptr::null_mut(), 0, &mut len)
        };
        napi::check_status!(status, "Failed to measure JavaScript string")?;
        let mut buf: Vec<u16> = Vec::with_capacity(len + 1);
        let mut written = 0;
        // SAFETY: `buf` holds the measured length plus the NUL slot.
        let status = unsafe {
            sys::napi_get_value_string_utf16(
                raw.env,
                raw.value,
                buf.as_mut_ptr(),
                len + 1,
                &mut written,
            )
        };
        napi::check_status!(status, "Failed to read JavaScript string")?;
        // SAFETY: Node-API initialised `written` units.
        unsafe { buf.set_len(written) };
        Ok(Utf16(TextRepr::Owned(buf)))
    })
}

/// Borrow `value` as UTF-8 using the thread's scratch arena.
///
/// Same shape as [`utf16`], plus UTF-8 validation before the guard exists.
#[inline]
pub fn utf8(value: JsString<'_>) -> Result<Utf8> {
    let raw = value.value();
    ARENA.with(|arena| {
        let (start, avail) = arena.tail(1);
        if avail >= 2 {
            // SAFETY: `start..start + avail` is past every committed range.
            let ptr = unsafe { arena.base().add(start) };
            let mut written = 0;
            // SAFETY: `raw` is a JS string owned by the live callback; Node-API
            // writes at most `avail - 1` bytes plus a NUL into the free tail.
            let status = unsafe {
                sys::napi_get_value_string_utf8(raw.env, raw.value, ptr.cast(), avail, &mut written)
            };
            napi::check_status!(status, "Failed to read JavaScript string")?;
            if written < avail - 1 {
                // SAFETY: Node-API initialised `written` bytes at `ptr`.
                let bytes = unsafe { slice::from_raw_parts(ptr, written) };
                if let Err(error) = str::from_utf8(bytes) {
                    return Err(Error::new(Status::InvalidArg, error.to_string()));
                }
                arena.commit(start, written);
                return Ok(Utf8(TextRepr::Scratch {
                    ptr: NonNull::new(ptr).unwrap(),
                    len: written,
                }));
            }
        }

        let mut len = 0;
        // SAFETY: a null buffer asks Node-API for the byte length only.
        let status = unsafe {
            sys::napi_get_value_string_utf8(raw.env, raw.value, ptr::null_mut(), 0, &mut len)
        };
        napi::check_status!(status, "Failed to measure JavaScript string")?;
        let mut buf: Vec<u8> = Vec::with_capacity(len + 1);
        let mut written = 0;
        // SAFETY: `buf` holds the measured length plus the NUL slot.
        let status = unsafe {
            sys::napi_get_value_string_utf8(
                raw.env,
                raw.value,
                buf.as_mut_ptr().cast(),
                len + 1,
                &mut written,
            )
        };
        napi::check_status!(status, "Failed to read JavaScript string")?;
        // SAFETY: Node-API initialised `written` bytes.
        unsafe { buf.set_len(written) };
        if let Err(error) = str::from_utf8(&buf) {
            return Err(Error::new(Status::InvalidArg, error.to_string()));
        }
        Ok(Utf8(TextRepr::Owned(buf)))
    })
}

/// Append `value`'s UTF-16 code units to `out` and return their span.
///
/// For batches: one growing buffer holds every element, so an array costs a
/// single allocation instead of one per string, and the spans can then be
/// counted in parallel while the reads themselves stay on the JS thread —
/// Node-API handles are not `Send`.
pub fn utf16_append(value: JsString<'_>, out: &mut Vec<u16>) -> Result<Range<usize>> {
    let raw = value.value();
    let start = out.len();

    let mut len = 0;
    // SAFETY: `raw` is a JS string owned by the live callback; a null buffer
    // asks Node-API for the code-unit length only.
    let status = unsafe {
        sys::napi_get_value_string_utf16(raw.env, raw.value, ptr::null_mut(), 0, &mut len)
    };
    napi::check_status!(status, "Failed to measure JavaScript string")?;

    out.resize(start + len + 1, 0);
    let mut written = 0;
    // SAFETY: same string, and the tail from `start` holds the measured length
    // plus the NUL slot Node-API writes.
    let status = unsafe {
        sys::napi_get_value_string_utf16(
            raw.env,
            raw.value,
            out[start..].as_mut_ptr(),
            len + 1,
            &mut written,
        )
    };
    napi::check_status!(status, "Failed to read JavaScript string")?;
    out.truncate(start + written);
    Ok(start..out.len())
}

/// Owned UTF-16 text crossing the N-API boundary as a JavaScript string.
///
/// Junco pins napi 3.9.0, whose `napi::bindgen_prelude::Utf16String` keeps its
/// `Vec<u16>` private and only implements `From<String>`. Native code that
/// already holds code units — the entire point of `pi-diff`'s UTF-16 path —
/// could otherwise only reach that type through a lossy UTF-8 round trip,
/// which replaces unpaired surrogates with U+FFFD. This newtype preserves the
/// code units verbatim and skips the transcode. The name intentionally matches
/// napi's so `napi-derive-backend`'s TypeScript mapping still emits `string`.
pub struct Utf16String(Vec<u16>);

impl From<Vec<u16>> for Utf16String {
    fn from(units: Vec<u16>) -> Self {
        Self(units)
    }
}

impl Deref for Utf16String {
    type Target = [u16];

    fn deref(&self) -> &[u16] {
        &self.0
    }
}

impl TypeName for Utf16String {
    fn type_name() -> &'static str {
        "String(utf16)"
    }

    fn value_type() -> napi::ValueType {
        napi::ValueType::String
    }
}

impl ToNapiValue for Utf16String {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        let mut out = ptr::null_mut();
        // SAFETY: `env` is the live callback environment and the slice is
        // valid for the length passed alongside it.
        let status = unsafe {
            sys::napi_create_string_utf16(env, val.0.as_ptr(), val.0.len() as isize, &mut out)
        };
        napi::check_status!(status, "Failed to create JavaScript string")?;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_arena(test: impl FnOnce(&Arena)) {
        ARENA.with(test);
    }

    /// Live guards own disjoint ranges; overlap would alias the derefs (UB).
    #[test]
    fn commits_never_overlap_live_ranges() {
        with_arena(|a| {
            let (s1, _) = a.tail(1);
            a.commit(s1, 100);
            let (s2, _) = a.tail(2);
            assert!(s2 >= s1 + 100);
            a.commit(s2, 50);
            let (s3, _) = a.tail(1);
            assert!(s3 >= s2 + 50);
            a.release(s2, s2 + 50);
            a.release(s1, s1 + 100);
        });
    }

    /// LIFO drops recycle immediately; the next fill reuses the range.
    #[test]
    fn lifo_release_rolls_back() {
        with_arena(|a| {
            a.commit(0, 100);
            a.commit(100, 50);
            a.release(100, 150);
            assert_eq!(a.tail(1).0, 100);
            a.release(0, 100);
            assert_eq!(a.tail(1).0, 0);
        });
    }

    /// Non-LIFO drops strand bytes only until the last guard goes away.
    #[test]
    fn arena_resets_when_last_guard_drops() {
        with_arena(|a| {
            a.commit(0, 100);
            a.commit(100, 50);
            a.release(0, 100);
            assert_eq!(
                a.tail(1).0,
                150,
                "inner range stays stranded while a guard is live"
            );
            a.release(100, 150);
            assert_eq!(a.tail(1).0, 0);
        });
    }

    /// A utf16 fill after an odd utf8 commit must get a 2-aligned range.
    #[test]
    fn utf16_tail_is_aligned() {
        with_arena(|a| {
            a.commit(0, 7);
            let (start, len) = a.tail(2);
            assert_eq!(start, 8);
            assert_eq!(len, SCRATCH_LEN - 8);
            a.release(0, 7);
        });
    }
}
