use ghostty_vt_sys as ffi;

use crate::{AbiViolation, GhosttyError, Operation};

pub(crate) trait SizedFfi: Default {
    fn set_size(&mut self, size: usize);
}

macro_rules! sized_ffi {
    ($($type:ty),+ $(,)?) => {
        $(
            impl SizedFfi for $type {
                fn set_size(&mut self, size: usize) {
                    self.size = size;
                }
            }
        )+
    };
}

sized_ffi!(
    ffi::Style,
    ffi::GridRef,
    ffi::RenderStateRowSelection,
    ffi::RenderStateColors,
    ffi::FormatterScreenExtra,
    ffi::FormatterTerminalExtra,
    ffi::FormatterTerminalOptions,
);

/// Initializes only public structs whose checked header documents the
/// `GHOSTTY_INIT_SIZED` all-zero-plus-size contract.
pub(crate) fn sized<T: SizedFfi>() -> T {
    let mut value = T::default();
    value.set_size(std::mem::size_of::<T>());
    value
}

pub(crate) fn ffi_result(
    result: ffi::Result::Type,
    operation: Operation,
) -> Result<(), GhosttyError> {
    match result {
        ffi::Result::SUCCESS => Ok(()),
        ffi::Result::OUT_OF_MEMORY => Err(GhosttyError::OutOfMemory { operation }),
        ffi::Result::INVALID_VALUE => Err(GhosttyError::NativeInvalidValue { operation }),
        ffi::Result::OUT_OF_SPACE => Err(GhosttyError::OutOfSpace {
            operation,
            required: 0,
            limit: 0,
        }),
        ffi::Result::NO_VALUE => Err(GhosttyError::NoValue { operation }),
        unknown => Err(GhosttyError::AbiViolation {
            operation,
            violation: AbiViolation::UnknownResult(unknown),
        }),
    }
}

pub(crate) fn abi_violation(operation: Operation, violation: AbiViolation) -> GhosttyError {
    GhosttyError::AbiViolation {
        operation,
        violation,
    }
}
