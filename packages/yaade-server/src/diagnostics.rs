use serde_json::Value;

const SECRET_KEY_PARTS: &[&str] = &[
    "token",
    "secret",
    "password",
    "authorization",
    "cookie",
    "privatekey",
];

/// Recursively redact diagnostic values by key and by known secret value.
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
}
