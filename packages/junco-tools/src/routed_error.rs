//! A routed failure as the JavaScript error it rejects with.

use napi::bindgen_prelude::{JsObjectValue, JsValue};
use napi::{Env, Error, Result};

use crate::mux::RoutedError;

/// The own `code` of every error a Marsh policy denial rejects with.
const MARSH_POLICY_DENIED: &str = "MARSH_POLICY_DENIED";

/// `outcome`'s value unchanged, or its failure as a JavaScript error: a denial becomes an `Error`
/// with own `code` `"MARSH_POLICY_DENIED"`, any other failure a plain error with its message.
pub(crate) fn resolve<T>(env: &Env, outcome: std::result::Result<T, RoutedError>) -> Result<T> {
    match outcome {
        Ok(value) => Ok(value),
        Err(RoutedError::Other(message)) => Err(Error::from_reason(message)),
        Err(RoutedError::Denied(message)) => {
            let mut error = env.create_error(Error::from_reason(message))?;
            error.set_named_property("code", MARSH_POLICY_DENIED)?;
            Err(Error::from(error.to_unknown()))
        }
    }
}
