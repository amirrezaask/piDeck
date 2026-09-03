use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const SECRET_KEY_PARTS: &[&str] = &[
    "token",
    "secret",
    "password",
    "authorization",
    "cookie",
    "privatekey",
];

const MAX_DIAGNOSTIC_FIELDS: usize = 32;
const MAX_ENUM_BYTES: usize = 64;
const MAX_ALIAS_BYTES: usize = 32;

/// Values accepted by the content-free diagnostic event boundary. Arbitrary
/// strings and maps are intentionally absent: terminal text cannot become a
/// metric or trace field by accident.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "kebab-case")]
pub enum DiagnosticValue {
    Counter(u64),
    Gauge(i64),
    DurationMicros(u64),
    Boolean(bool),
    Enum(String),
    BundleAlias(String),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DiagnosticEvent {
    pub kind: String,
    pub fields: BTreeMap<String, DiagnosticValue>,
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum DiagnosticError {
    #[error("unknown diagnostic event or field")]
    UnknownField,
    #[error("diagnostic event exceeds its field bound")]
    TooManyFields,
    #[error("diagnostic enum or alias exceeds its byte bound")]
    ValueTooLong,
}

/// Validate a typed event against an explicit allowlist supplied by its owner.
/// Callers keep IDs out of metrics; bundle-only aliases are randomized locally.
pub fn validate_diagnostic_event(
    event: &DiagnosticEvent,
    allowed_kinds: &[&str],
    allowed_fields: &[&str],
) -> Result<(), DiagnosticError> {
    if !allowed_kinds.contains(&event.kind.as_str()) {
        return Err(DiagnosticError::UnknownField);
    }
    if event.fields.len() > MAX_DIAGNOSTIC_FIELDS {
        return Err(DiagnosticError::TooManyFields);
    }
    let allowed = allowed_fields.iter().copied().collect::<HashSet<_>>();
    for (name, value) in &event.fields {
        if !allowed.contains(name.as_str()) {
            return Err(DiagnosticError::UnknownField);
        }
        let within_bound = match value {
            DiagnosticValue::Enum(value) => value.len() <= MAX_ENUM_BYTES,
            DiagnosticValue::BundleAlias(value) => value.len() <= MAX_ALIAS_BYTES,
            _ => true,
        };
        if !within_bound {
            return Err(DiagnosticError::ValueTooLong);
        }
    }
    Ok(())
}

/// Recursively redact diagnostic values by key and by known secret value.
/// This remains a final defense for legacy diagnostic shapes; new events must
/// pass through [`validate_diagnostic_event`] and its allowlist first.
pub fn redact_diagnostics(value: &Value, known_secrets: &[&str]) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
                    let value = if SECRET_KEY_PARTS
                        .iter()
                        .any(|part| normalized.contains(part))
                    {
                        Value::String("[redacted]".to_owned())
                    } else {
                        redact_diagnostics(value, known_secrets)
                    };
                    (key.clone(), value)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| redact_diagnostics(item, known_secrets))
                .collect(),
        ),
        Value::String(text) => {
            let mut redacted = text.clone();
            for secret in known_secrets.iter().filter(|secret| !secret.is_empty()) {
                redacted = redacted.replace(secret, "[redacted]");
            }
            Value::String(redacted)
        }
        value => value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn hides_secret_keys_and_known_token_strings() {
        let value = json!({
            "authToken": "secret-value",
            "nested": { "password": "hunter2" },
            "message": "failed with secret-value",
        });
        let redacted = redact_diagnostics(&value, &["secret-value"]);
        assert_eq!(redacted["authToken"], "[redacted]");
        assert_eq!(redacted["nested"]["password"], "[redacted]");
        assert_eq!(redacted["message"], "failed with [redacted]");
    }

    #[test]
    fn diagnostic_bundle_shape_does_not_echo_host_token() {
        let bundle = json!({
            "config": { "host": "127.0.0.1", "token": "host-secret" },
            "health": { "status": "healthy" },
        });
        let encoded = redact_diagnostics(&bundle, &["host-secret"]).to_string();
        assert!(!encoded.contains("host-secret"));
        assert!(encoded.contains("[redacted]"));
    }

    #[test]
    fn typed_diagnostics_reject_unknown_and_unbounded_values() {
        let mut fields = BTreeMap::new();
        fields.insert(
            "terminal.queue_bytes".to_owned(),
            DiagnosticValue::Gauge(42),
        );
        let event = DiagnosticEvent {
            kind: "terminal.queue".to_owned(),
            fields,
        };
        assert_eq!(
            validate_diagnostic_event(&event, &["terminal.queue"], &["terminal.queue_bytes"]),
            Ok(())
        );

        let mut unknown = event.clone();
        unknown.fields.insert(
            "terminal.output".to_owned(),
            DiagnosticValue::Enum("canary terminal text".to_owned()),
        );
        assert_eq!(
            validate_diagnostic_event(&unknown, &["terminal.queue"], &["terminal.queue_bytes"]),
            Err(DiagnosticError::UnknownField)
        );

        let mut oversized = event;
        oversized.fields.insert(
            "terminal.phase".to_owned(),
            DiagnosticValue::Enum("x".repeat(MAX_ENUM_BYTES + 1)),
        );
        assert_eq!(
            validate_diagnostic_event(
                &oversized,
                &["terminal.queue"],
                &["terminal.queue_bytes", "terminal.phase"]
            ),
            Err(DiagnosticError::ValueTooLong)
        );
    }
}
