use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::signature::{ED25519, UnparsedPublicKey};
use rusqlite::{OptionalExtension as _, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    model::now_iso,
    store::{StateStore, StoreError},
};

const PAIRING_TTL: Duration = Duration::from_secs(5 * 60);
const CHALLENGE_TTL: Duration = Duration::from_secs(60);
const SESSION_TTL: Duration = Duration::from_secs(15 * 60);
const FAILURE_WINDOW: Duration = Duration::from_secs(60);
const FAILURE_LIMIT: usize = 8;
const MAX_CHALLENGES: usize = 1_024;
const MAX_SESSIONS: usize = 4_096;
const MAX_FAILURE_KEYS: usize = 4_096;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceScope {
    Observe,
    Control,
    Admin,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub id: String,
    pub name: String,
    pub algorithm: String,
    pub scopes: Vec<DeviceScope>,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub revoked_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairDevice {
    pub code: String,
    pub device_id: Option<String>,
    pub name: String,
    pub public_key: Value,
    #[serde(default = "default_algorithm")]
    pub algorithm: String,
    pub scopes: Option<Vec<DeviceScope>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticateDevice {
    pub device_id: String,
    pub nonce: String,
    pub signature: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpiringCode {
    pub code: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Challenge {
    pub nonce: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSessionResult {
    pub token: String,
    pub expires_at: String,
    pub device: PairedDevice,
}

#[derive(Clone, Debug)]
pub struct DeviceSession {
    pub device_id: String,
    pub scopes: Vec<DeviceScope>,
}

#[derive(Debug, Error)]
pub enum DeviceAuthError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("too many authentication attempts")]
    RateLimited,
    #[error("{0}")]
    Storage(String),
}

impl From<StoreError> for DeviceAuthError {
    fn from(error: StoreError) -> Self {
        Self::Storage(error.to_string())
    }
}

#[derive(Clone)]
struct PendingChallenge {
    device_id: String,
    expires_at: Instant,
}

#[derive(Clone)]
struct Session {
    device_id: String,
    scopes: Vec<DeviceScope>,
    expires_at: Instant,
}

#[derive(Default)]
struct Ephemeral {
    challenges: HashMap<String, PendingChallenge>,
    challenge_order: VecDeque<String>,
    sessions: HashMap<String, Session>,
    session_order: VecDeque<String>,
    failures: HashMap<String, VecDeque<Instant>>,
    failure_order: VecDeque<String>,
}

impl Ephemeral {
    fn evict_challenges(&mut self) {
        while self.challenges.len() > MAX_CHALLENGES {
            if let Some(oldest) = self.challenge_order.pop_front() {
                self.challenges.remove(&oldest);
            } else {
                break;
            }
        }
    }

    fn evict_sessions(&mut self) {
        while self.sessions.len() > MAX_SESSIONS {
            if let Some(oldest) = self.session_order.pop_front() {
                self.sessions.remove(&oldest);
            } else {
                break;
            }
        }
    }
}

pub struct DeviceAuthService {
    store: Arc<StateStore>,
    ephemeral: Mutex<Ephemeral>,
}

impl DeviceAuthService {
    pub fn new(store: Arc<StateStore>) -> Result<Self, DeviceAuthError> {
        store.with_connection(|db| {
            db.execute_batch(
                "CREATE TABLE IF NOT EXISTS devices(
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               public_key TEXT NOT NULL,
               algorithm TEXT NOT NULL,
               scopes_json TEXT NOT NULL,
               created_at TEXT NOT NULL,
               last_used_at TEXT,
               revoked_at TEXT
             );
             CREATE TABLE IF NOT EXISTS pairing_codes(
               id TEXT PRIMARY KEY,
               code_hash TEXT NOT NULL,
               expires_at TEXT NOT NULL,
               used_at TEXT
             );
             CREATE TABLE IF NOT EXISTS audit_events(
               id TEXT PRIMARY KEY,
               occurred_at TEXT NOT NULL,
               device_id TEXT,
               action TEXT NOT NULL,
               resource_type TEXT,
               resource_id TEXT,
               details_json TEXT NOT NULL
             );",
            )
        })?;
        Ok(Self {
            store,
            ephemeral: Mutex::new(Ephemeral::default()),
        })
    }

    pub fn create_pairing_code(&self) -> Result<ExpiringCode, DeviceAuthError> {
        let code = hex_upper(&random_bytes::<5>()?);
        let expires_at = timestamp_after(PAIRING_TTL);
        let code_hash = sha256_hex(&code);
        let stored_expires_at = expires_at.clone();
        self.store.with_connection(move |db| {
            db.execute(
                "INSERT INTO pairing_codes(id,code_hash,expires_at) VALUES(?,?,?)",
                params![Uuid::new_v4().to_string(), code_hash, stored_expires_at],
            )
        })?;
        Ok(ExpiringCode { code, expires_at })
    }

    pub fn pair(&self, input: PairDevice) -> Result<PairedDevice, DeviceAuthError> {
        self.assert_not_rate_limited("pair")?;
        let code = input.code.trim().to_ascii_uppercase();
        if code.len() != 10 || !code.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            self.record_failure("pair");
            return Err(DeviceAuthError::Invalid("invalid pairing code".to_owned()));
        }
        validate_public_key(&input.public_key)?;
        if serde_json::to_vec(&input.public_key).map_or(true, |value| value.len() > 4 * 1024) {
            return Err(DeviceAuthError::Invalid(
                "invalid device public key".to_owned(),
            ));
        }
        let now = now_iso();
        let code_hash = sha256_hex(&code);
        let lookup_now = now.clone();
        let pairing_id = self.store.with_connection(move |db| {
            db.query_row(
                "SELECT id FROM pairing_codes WHERE code_hash=? AND used_at IS NULL AND expires_at>? ORDER BY expires_at DESC LIMIT 1",
                params![code_hash, lookup_now],
                |row| row.get::<_, String>(0),
            ).optional()
        })?;
        let Some(pairing_id) = pairing_id else {
            self.record_failure("pair");
            return Err(DeviceAuthError::Invalid("pairing code expired".to_owned()));
        };
        let scopes = normalized_scopes(input.scopes.unwrap_or_else(|| vec![DeviceScope::Control]));
        if scopes.contains(&DeviceScope::Admin) {
            return Err(DeviceAuthError::Invalid(
                "admin pairing requires a local administrator".to_owned(),
            ));
        }
        let consumed_now = now.clone();
        let consumed = self.store.with_connection(move |db| {
            db.execute(
                "UPDATE pairing_codes SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>?",
                params![consumed_now, pairing_id, consumed_now],
            )
        })?;
        if consumed != 1 {
            self.record_failure("pair");
            return Err(DeviceAuthError::Invalid(
                "pairing code already used".to_owned(),
            ));
        }
        let id = input
            .device_id
            .filter(|id| valid_device_id(id))
            .unwrap_or_else(|| format!("dev-{}", Uuid::new_v4()));
        let device = PairedDevice {
            id: id.clone(),
            name: truncate_chars(input.name.trim(), 120, "YAADE device"),
            algorithm: truncate_chars(input.algorithm.trim(), 64, "Ed25519"),
            scopes,
            created_at: now_iso(),
            last_used_at: None,
            revoked_at: None,
        };
        let stored_device = device.clone();
        let public_key = serde_json::to_string(&input.public_key).unwrap_or_default();
        self.store.with_connection(move |db| db.execute(
            "INSERT INTO devices(id,name,public_key,algorithm,scopes_json,created_at) VALUES(?,?,?,?,?,?)",
            params![
                stored_device.id,
                stored_device.name,
                public_key,
                stored_device.algorithm,
                serde_json::to_string(&stored_device.scopes).unwrap_or_else(|_| "[\"control\"]".to_owned()),
                stored_device.created_at,
            ],
        ))?;
        self.audit("device.paired", Some(&id), json!({ "name": device.name }))?;
        Ok(device)
    }

    pub fn list(&self) -> Result<Vec<PairedDevice>, DeviceAuthError> {
        self.store.with_connection(|db| {
            let mut statement = db.prepare(
                "SELECT id,name,algorithm,scopes_json,created_at,last_used_at,revoked_at FROM devices ORDER BY created_at DESC",
            )?;
            statement.query_map([], device_from_row)?.collect()
        }).map_err(Into::into)
    }

    pub fn revoke(&self, device_id: &str) -> Result<bool, DeviceAuthError> {
        let stored_device_id = device_id.to_owned();
        let changed = self.store.with_connection(move |db| {
            db.execute(
                "UPDATE devices SET revoked_at=COALESCE(revoked_at, ?) WHERE id=?",
                params![now_iso(), stored_device_id],
            )
        })?;
        let mut ephemeral = self.lock();
        ephemeral
            .sessions
            .retain(|_, session| session.device_id != device_id);
        drop(ephemeral);
        if changed > 0 {
            self.audit("device.revoked", Some(device_id), json!({}))?;
        }
        Ok(changed > 0)
    }

    pub fn challenge(&self, device_id: &str) -> Result<Challenge, DeviceAuthError> {
        if !valid_device_id(device_id) {
            return Err(DeviceAuthError::Unauthorized(
                "invalid device id".to_owned(),
            ));
        }
        let device = self.device_row(device_id)?;
        if device
            .as_ref()
            .is_none_or(|(_, device)| device.revoked_at.is_some())
        {
            return Err(DeviceAuthError::Unauthorized(
                "device is revoked or unknown".to_owned(),
            ));
        }
        let nonce = URL_SAFE_NO_PAD.encode(random_bytes::<32>()?);
        let expires_at_instant = Instant::now() + CHALLENGE_TTL;
        let mut ephemeral = self.lock();
        cleanup(&mut ephemeral);
        ephemeral.challenges.insert(
            nonce.clone(),
            PendingChallenge {
                device_id: device_id.to_owned(),
                expires_at: expires_at_instant,
            },
        );
        ephemeral.challenge_order.push_back(nonce.clone());
        ephemeral.evict_challenges();
        Ok(Challenge {
            nonce,
            expires_at: timestamp_after(CHALLENGE_TTL),
        })
    }

    pub fn authenticate(
        &self,
        input: AuthenticateDevice,
    ) -> Result<DeviceSessionResult, DeviceAuthError> {
        if !valid_device_id(&input.device_id)
            || input.nonce.len() > 128
            || input.signature.len() > 2_048
        {
            self.record_failure("invalid-device");
            return Err(DeviceAuthError::Unauthorized(
                "invalid authentication payload".to_owned(),
            ));
        }
        self.assert_not_rate_limited(&input.device_id)?;
        let challenge = {
            let mut ephemeral = self.lock();
            cleanup(&mut ephemeral);
            ephemeral.challenges.remove(&input.nonce)
        };
        let Some(_challenge) = challenge.filter(|challenge| {
            challenge.device_id == input.device_id && challenge.expires_at > Instant::now()
        }) else {
            self.record_failure(&input.device_id);
            return Err(DeviceAuthError::Unauthorized(
                "challenge expired".to_owned(),
            ));
        };
        let Some((public_key, device)) = self.device_row(&input.device_id)? else {
            self.record_failure(&input.device_id);
            return Err(DeviceAuthError::Unauthorized(
                "device is revoked or unknown".to_owned(),
            ));
        };
        if device.revoked_at.is_some()
            || !verify_signature(&public_key, &input.nonce, &input.signature)
        {
            self.record_failure(&input.device_id);
            return Err(DeviceAuthError::Unauthorized(
                "invalid device signature".to_owned(),
            ));
        }
        let token = URL_SAFE_NO_PAD.encode(random_bytes::<32>()?);
        let expires = Instant::now() + SESSION_TTL;
        let mut ephemeral = self.lock();
        ephemeral.failures.remove(&input.device_id);
        ephemeral.sessions.insert(
            token.clone(),
            Session {
                device_id: input.device_id.clone(),
                scopes: device.scopes.clone(),
                expires_at: expires,
            },
        );
        ephemeral.session_order.push_back(token.clone());
        ephemeral.evict_sessions();
        drop(ephemeral);
        self.touch_device(&input.device_id)?;
        Ok(DeviceSessionResult {
            token,
            expires_at: timestamp_after(SESSION_TTL),
            device,
        })
    }

    pub fn session(&self, token: &str) -> Result<Option<DeviceSession>, DeviceAuthError> {
        let session = {
            let mut ephemeral = self.lock();
            cleanup(&mut ephemeral);
            ephemeral.sessions.get(token).cloned()
        };
        let Some(session) = session else {
            return Ok(None);
        };
        let Some((_, device)) = self.device_row(&session.device_id)? else {
            return Ok(None);
        };
        if device.revoked_at.is_some() {
            return Ok(None);
        }
        self.touch_device(&session.device_id)?;
        Ok(Some(DeviceSession {
            device_id: session.device_id,
            scopes: session.scopes,
        }))
    }

    pub fn rotate(&self, token: &str) -> Result<DeviceSessionResult, DeviceAuthError> {
        let current = {
            let mut ephemeral = self.lock();
            cleanup(&mut ephemeral);
            ephemeral.sessions.remove(token)
        }
        .ok_or_else(|| DeviceAuthError::Unauthorized("unknown session".to_owned()))?;
        let Some((_, device)) = self.device_row(&current.device_id)? else {
            return Err(DeviceAuthError::Unauthorized(
                "device is revoked or unknown".to_owned(),
            ));
        };
        if device.revoked_at.is_some() {
            return Err(DeviceAuthError::Unauthorized(
                "device is revoked or unknown".to_owned(),
            ));
        }
        let next = URL_SAFE_NO_PAD.encode(random_bytes::<32>()?);
        let mut ephemeral = self.lock();
        ephemeral.sessions.insert(
            next.clone(),
            Session {
                device_id: current.device_id.clone(),
                scopes: current.scopes,
                expires_at: Instant::now() + SESSION_TTL,
            },
        );
        ephemeral.session_order.push_back(next.clone());
        ephemeral.evict_sessions();
        drop(ephemeral);
        self.touch_device(&current.device_id)?;
        self.audit("device.rotated", Some(&current.device_id), json!({}))?;
        Ok(DeviceSessionResult {
            token: next,
            expires_at: timestamp_after(SESSION_TTL),
            device,
        })
    }

    fn device_row(&self, id: &str) -> Result<Option<(String, PairedDevice)>, DeviceAuthError> {
        let id = id.to_owned();
        self.store.with_connection(move |db| db.query_row(
            "SELECT public_key,id,name,algorithm,scopes_json,created_at,last_used_at,revoked_at FROM devices WHERE id=?",
            [id],
            |row| {
                let public_key = row.get(0)?;
                let device = PairedDevice {
                    id: row.get(1)?, name: row.get(2)?, algorithm: row.get(3)?,
                    scopes: parse_scopes(&row.get::<_, String>(4)?), created_at: row.get(5)?,
                    last_used_at: row.get(6)?, revoked_at: row.get(7)?,
                };
                Ok((public_key, device))
            },
        ).optional()).map_err(Into::into)
    }

    fn touch_device(&self, id: &str) -> Result<(), DeviceAuthError> {
        let id = id.to_owned();
        self.store.with_connection(move |db| {
            db.execute(
                "UPDATE devices SET last_used_at=? WHERE id=?",
                params![now_iso(), id],
            )
        })?;
        Ok(())
    }

    fn audit(
        &self,
        action: &str,
        device_id: Option<&str>,
        details: Value,
    ) -> Result<(), DeviceAuthError> {
        let action = action.to_owned();
        let device_id = device_id.map(str::to_owned);
        self.store.with_connection(move |db| db.execute(
            "INSERT INTO audit_events(id,occurred_at,device_id,action,resource_type,resource_id,details_json) VALUES(?,?,?,?,?,?,?)",
            params![Uuid::new_v4().to_string(), now_iso(), device_id, action, "device", device_id, details.to_string()],
        ))?;
        Ok(())
    }

    fn assert_not_rate_limited(&self, key: &str) -> Result<(), DeviceAuthError> {
        let mut ephemeral = self.lock();
        cleanup(&mut ephemeral);
        if ephemeral
            .failures
            .get(key)
            .is_some_and(|items| items.len() >= FAILURE_LIMIT)
        {
            return Err(DeviceAuthError::RateLimited);
        }
        Ok(())
    }

    fn record_failure(&self, key: &str) {
        let mut ephemeral = self.lock();
        cleanup(&mut ephemeral);
        ephemeral
            .failures
            .entry(key.to_owned())
            .or_default()
            .push_back(Instant::now());
        ephemeral.failure_order.push_back(key.to_owned());
        while ephemeral.failures.len() > MAX_FAILURE_KEYS {
            if let Some(oldest) = ephemeral.failure_order.pop_front() {
                ephemeral.failures.remove(&oldest);
            }
        }
    }

    fn lock(&self) -> MutexGuard<'_, Ephemeral> {
        self.ephemeral
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn default_algorithm() -> String {
    "Ed25519".to_owned()
}

fn device_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PairedDevice> {
    Ok(PairedDevice {
        id: row.get(0)?,
        name: row.get(1)?,
        algorithm: row.get(2)?,
        scopes: parse_scopes(&row.get::<_, String>(3)?),
        created_at: row.get(4)?,
        last_used_at: row.get(5)?,
        revoked_at: row.get(6)?,
    })
}

fn parse_scopes(value: &str) -> Vec<DeviceScope> {
    serde_json::from_str::<Vec<DeviceScope>>(value)
        .map(normalized_scopes)
        .unwrap_or_else(|_| vec![DeviceScope::Control])
}

fn normalized_scopes(scopes: Vec<DeviceScope>) -> Vec<DeviceScope> {
    let mut result = Vec::new();
    for scope in scopes {
        if !result.contains(&scope) {
            result.push(scope)
        }
    }
    if result.is_empty() {
        result.push(DeviceScope::Control)
    }
    result
}

fn valid_device_id(id: &str) -> bool {
    (8..=96).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn validate_public_key(value: &Value) -> Result<(), DeviceAuthError> {
    let valid = value.as_object().is_some_and(|key| {
        key.get("kty").and_then(Value::as_str).is_some()
            && key.get("crv").and_then(Value::as_str).is_some()
    });
    if valid {
        Ok(())
    } else {
        Err(DeviceAuthError::Invalid(
            "invalid device public key".to_owned(),
        ))
    }
}

fn verify_signature(public_key: &str, nonce: &str, signature: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(public_key) else {
        return false;
    };
    let Some(key) = value.as_object() else {
        return false;
    };
    if key.get("kty").and_then(Value::as_str) != Some("OKP")
        || key.get("crv").and_then(Value::as_str) != Some("Ed25519")
    {
        return false;
    }
    let Some(encoded) = key.get("x").and_then(Value::as_str) else {
        return false;
    };
    let Ok(bytes) = URL_SAFE_NO_PAD.decode(encoded) else {
        return false;
    };
    if bytes.len() != 32 {
        return false;
    }
    let Ok(signature_bytes) = URL_SAFE_NO_PAD.decode(signature) else {
        return false;
    };
    UnparsedPublicKey::new(&ED25519, bytes)
        .verify(nonce.as_bytes(), &signature_bytes)
        .is_ok()
}

fn cleanup(ephemeral: &mut Ephemeral) {
    let now = Instant::now();
    ephemeral
        .challenges
        .retain(|_, challenge| challenge.expires_at > now);
    ephemeral
        .sessions
        .retain(|_, session| session.expires_at > now);
    for failures in ephemeral.failures.values_mut() {
        while failures
            .front()
            .is_some_and(|at| now.duration_since(*at) >= FAILURE_WINDOW)
        {
            failures.pop_front();
        }
    }
    ephemeral
        .failures
        .retain(|_, failures| !failures.is_empty());
}

fn random_bytes<const N: usize>() -> Result<[u8; N], DeviceAuthError> {
    let mut bytes = [0_u8; N];
    getrandom::fill(&mut bytes).map_err(|error| DeviceAuthError::Storage(error.to_string()))?;
    Ok(bytes)
}

fn sha256_hex(value: &str) -> String {
    hex_lower(&Sha256::digest(value.as_bytes()))
}
fn hex_upper(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect()
}
fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn timestamp_after(duration: Duration) -> String {
    (jiff::Timestamp::now()
        + jiff::SignedDuration::from_secs(i64::try_from(duration.as_secs()).unwrap_or(0)))
    .to_string()
}
fn truncate_chars(value: &str, max: usize, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_owned()
    } else {
        value.chars().take(max).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::{
        rand::SystemRandom,
        signature::{Ed25519KeyPair, KeyPair as _},
    };

    fn service() -> DeviceAuthService {
        let store = Arc::new(
            StateStore::open(std::path::Path::new(":memory:"), "test".to_owned()).expect("store"),
        );
        DeviceAuthService::new(store).expect("device auth")
    }

    #[test]
    fn pairs_and_authenticates_an_ed25519_device() {
        let service = service();
        let random = SystemRandom::new();
        let document = Ed25519KeyPair::generate_pkcs8(&random).expect("generate key");
        let key = Ed25519KeyPair::from_pkcs8(document.as_ref()).expect("parse key");
        let code = service.create_pairing_code().expect("pairing code");
        let device = service
            .pair(PairDevice {
                code: code.code,
                device_id: Some("device_1234".to_owned()),
                name: "Browser".to_owned(),
                public_key: json!({
                    "kty": "OKP",
                    "crv": "Ed25519",
                    "x": URL_SAFE_NO_PAD.encode(key.public_key().as_ref()),
                }),
                algorithm: "Ed25519".to_owned(),
                scopes: Some(vec![DeviceScope::Observe, DeviceScope::Control]),
            })
            .expect("pair");
        let challenge = service.challenge(&device.id).expect("challenge");
        let authenticated = service
            .authenticate(AuthenticateDevice {
                device_id: device.id.clone(),
                nonce: challenge.nonce.clone(),
                signature: URL_SAFE_NO_PAD.encode(key.sign(challenge.nonce.as_bytes()).as_ref()),
            })
            .expect("authenticate");

        let session = service
            .session(&authenticated.token)
            .expect("session lookup")
            .expect("active session");
        assert_eq!(session.device_id, device.id);
        assert!(session.scopes.contains(&DeviceScope::Control));
    }

    #[test]
    fn credential_rotation_keeps_metadata_and_invalidates_old_token() {
        let service = service();
        let random = SystemRandom::new();
        let document = Ed25519KeyPair::generate_pkcs8(&random).expect("generate key");
        let key = Ed25519KeyPair::from_pkcs8(document.as_ref()).expect("parse key");
        let code = service.create_pairing_code().expect("pairing code");
        let device = service
            .pair(PairDevice {
                code: code.code,
                device_id: Some("device_rotate".to_owned()),
                name: "Browser".to_owned(),
                public_key: json!({
                    "kty": "OKP",
                    "crv": "Ed25519",
                    "x": URL_SAFE_NO_PAD.encode(key.public_key().as_ref()),
                }),
                algorithm: "Ed25519".to_owned(),
                scopes: None,
            })
            .expect("pair");
        let challenge = service.challenge(&device.id).expect("challenge");
        let authenticated = service
            .authenticate(AuthenticateDevice {
                device_id: device.id.clone(),
                nonce: challenge.nonce.clone(),
                signature: URL_SAFE_NO_PAD.encode(key.sign(challenge.nonce.as_bytes()).as_ref()),
            })
            .expect("authenticate");
        let rotated = service.rotate(&authenticated.token).expect("rotate");
        assert_eq!(rotated.device.id, device.id);
        assert!(
            service
                .session(&authenticated.token)
                .expect("old lookup")
                .is_none()
        );
        assert!(
            service
                .session(&rotated.token)
                .expect("new lookup")
                .is_some()
        );
    }

    #[test]
    fn revocation_invalidates_active_sessions() {
        let service = service();
        let random = SystemRandom::new();
        let document = Ed25519KeyPair::generate_pkcs8(&random).expect("generate key");
        let key = Ed25519KeyPair::from_pkcs8(document.as_ref()).expect("parse key");
        let code = service.create_pairing_code().expect("pairing code");
        let device = service
            .pair(PairDevice {
                code: code.code,
                device_id: Some("device_revoke".to_owned()),
                name: "Browser".to_owned(),
                public_key: json!({
                    "kty": "OKP", "crv": "Ed25519",
                    "x": URL_SAFE_NO_PAD.encode(key.public_key().as_ref()),
                }),
                algorithm: "Ed25519".to_owned(),
                scopes: None,
            })
            .expect("pair");
        let challenge = service.challenge(&device.id).expect("challenge");
        let authenticated = service
            .authenticate(AuthenticateDevice {
                device_id: device.id.clone(),
                nonce: challenge.nonce.clone(),
                signature: URL_SAFE_NO_PAD.encode(key.sign(challenge.nonce.as_bytes()).as_ref()),
            })
            .expect("authenticate");
        assert!(service.revoke(&device.id).expect("revoke"));
        assert!(
            service
                .session(&authenticated.token)
                .expect("lookup")
                .is_none()
        );
    }

    #[test]
    fn repeated_failed_authentications_are_rate_limited_and_bounded() {
        let service = service();
        for index in 0..FAILURE_LIMIT {
            let result = service.authenticate(AuthenticateDevice {
                device_id: "unknown_device".to_owned(),
                nonce: format!("nonce-{index}"),
                signature: "invalid".to_owned(),
            });
            assert!(result.is_err());
        }
        assert!(matches!(
            service.authenticate(AuthenticateDevice {
                device_id: "unknown_device".to_owned(),
                nonce: "final".to_owned(),
                signature: "invalid".to_owned(),
            }),
            Err(DeviceAuthError::RateLimited)
        ));
        for index in 0..(MAX_FAILURE_KEYS + 100) {
            service.record_failure(&format!("device-{index:08}"));
        }
        assert!(service.lock().failures.len() <= MAX_FAILURE_KEYS);
    }

    #[test]
    fn rejects_admin_pairing() {
        let service = service();
        let code = service.create_pairing_code().expect("pairing code");
        let result = service.pair(PairDevice {
            code: code.code,
            device_id: None,
            name: "Admin".to_owned(),
            public_key: json!({ "kty": "OKP", "crv": "Ed25519", "x": "invalid" }),
            algorithm: "Ed25519".to_owned(),
            scopes: Some(vec![DeviceScope::Admin]),
        });
        assert!(
            matches!(result, Err(DeviceAuthError::Invalid(message)) if message.contains("local administrator"))
        );
    }
}
