// (C)
// Web Push for the phone companion: VAPID (RFC 8292) and aes128gcm payload
// encryption (RFC 8291 over RFC 8188), on p256 0.14. It replaces the web-push
// crate, whose newest release still pins jwt-simple 0.12 and with it p256
// 0.13, elliptic-curve 0.13 and crypto-bigint 0.5.5 (RUSTSEC-2026-0387).
//
// Keys stay in the format web-push used (base64url, no padding): the private
// key is the raw 32-byte scalar, the public key the 65-byte uncompressed point
// the browser was handed as applicationServerKey. Phones that subscribed under
// the old code keep working without subscribing again.

use base64::Engine as _;
use p256::ecdsa::signature::Signer as _;
use p256::{PublicKey, SecretKey};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// Who the push services may contact about this sender (RFC 8292 `sub`).
const VAPID_SUBJECT: &str = "mailto:companion@plutos-terminals.local";
/// How long a VAPID token stays valid. RFC 8292 caps it at 24 hours; 12 hours
/// leaves room for a clock that runs ahead.
const VAPID_LIFETIME_SECS: u64 = 12 * 60 * 60;
/// The record size written into the header. One record carries the whole
/// message.
const RECORD_SIZE: u32 = 4096;
/// Push services take a body of at most 4096 bytes (RFC 8291 section 4): the
/// 86-byte header, the 16-byte tag, and this much padded plaintext.
const MAX_PADDED: usize = 4096 - 86 - 16;
/// The largest payload: the padded plaintext less the 0x02 delimiter.
pub(crate) const MAX_PAYLOAD: usize = MAX_PADDED - 1;
/// Padding block: the padded plaintext (delimiter included) is a multiple of
/// this, as the web-push crate (through ece) sent it, so a message's length
/// says less about what it carries.
const PAD_BLOCK: usize = 128;
/// How long a push service keeps an undelivered message, in seconds: 28 days,
/// web-push's default, kept.
const TTL_SECS: u32 = 28 * 24 * 60 * 60;

/// A secret key from 32 random bytes. p256 0.14 takes rand_core 0.10's RNG,
/// which the tree's rand 0.8 is not, so the bytes come from rand 0.8's OsRng
/// and a value outside the curve order (odds about 2^-32) is drawn again.
fn random_secret() -> SecretKey {
    use rand::RngCore as _;
    loop {
        let mut bytes = zeroize::Zeroizing::new([0u8; 32]);
        rand::rngs::OsRng.fill_bytes(&mut bytes[..]);
        if let Ok(secret) = SecretKey::from_slice(&bytes[..]) {
            return secret;
        }
    }
}

/// The uncompressed SEC1 point (0x04 || x || y, 65 bytes).
fn uncompressed(public: &PublicKey) -> Vec<u8> {
    // P-256 does not compress by default, so this is the 65-byte form.
    public.to_sec1_bytes().into_vec()
}

/// A fresh VAPID keypair as `(private_b64url, public_b64url)`.
pub(crate) fn generate_vapid() -> (String, String) {
    let secret = random_secret();
    let public = uncompressed(&secret.public_key());
    (B64.encode(secret.to_bytes()), B64.encode(public))
}

fn vapid_secret(private_b64: &str) -> Result<SecretKey, String> {
    let bytes = zeroize::Zeroizing::new(B64.decode(private_b64.trim()).map_err(|_| "VAPID key is not base64url".to_string())?);
    if bytes.len() != 32 {
        return Err("VAPID key is not a 32-byte P-256 scalar".into());
    }
    SecretKey::from_slice(&bytes).map_err(|_| "VAPID key is not a valid P-256 scalar".into())
}

/// A browser's subscription keys, checked: `p256dh` must be a point on P-256
/// and `auth` exactly 16 bytes (RFC 8291 section 3).
pub(crate) struct UaKeys {
    public: PublicKey,
    auth: [u8; 16],
}

impl UaKeys {
    pub(crate) fn parse(p256dh_b64: &str, auth_b64: &str) -> Result<Self, String> {
        let point = B64.decode(p256dh_b64.trim()).map_err(|_| "subscription p256dh is not base64url".to_string())?;
        if point.len() != 65 || point[0] != 0x04 {
            return Err("subscription p256dh is not an uncompressed P-256 point".into());
        }
        let public = PublicKey::from_sec1_bytes(&point).map_err(|_| "subscription p256dh is not on P-256".to_string())?;
        let auth: [u8; 16] = B64
            .decode(auth_b64.trim())
            .ok()
            .and_then(|a| a.try_into().ok())
            .ok_or_else(|| "subscription auth is not 16 bytes of base64url".to_string())?;
        Ok(Self { public, auth })
    }
}

/// The audience a push service expects in the token: the endpoint's origin,
/// scheme and host, with the port only when it is not the scheme's default.
fn audience(endpoint: &str) -> Result<String, String> {
    let u = reqwest::Url::parse(endpoint).map_err(|_| "push endpoint is not a URL".to_string())?;
    let origin = u.origin();
    if !origin.is_tuple() {
        return Err("push endpoint has no origin".into());
    }
    Ok(origin.ascii_serialization())
}

/// The VAPID `Authorization` header value (RFC 8292 section 3):
/// `vapid t=<ES256 JWT>, k=<public key>`.
fn vapid_authorization(private_b64: &str, endpoint: &str, now_secs: u64) -> Result<String, String> {
    let secret = vapid_secret(private_b64)?;
    let header = B64.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = serde_json::json!({
        "aud": audience(endpoint)?,
        "exp": now_secs + VAPID_LIFETIME_SECS,
        "sub": VAPID_SUBJECT,
    });
    let claims = B64.encode(serde_json::to_vec(&claims).map_err(|e| e.to_string())?);
    let signing_input = format!("{header}.{claims}");
    let key = p256::ecdsa::SigningKey::from(&secret);
    let signature: p256::ecdsa::Signature = key.sign(signing_input.as_bytes());
    let public = B64.encode(uncompressed(&secret.public_key()));
    Ok(format!("vapid t={signing_input}.{}, k={public}", B64.encode(signature.to_bytes())))
}

fn hkdf_expand(salt: &[u8], ikm: &[u8], info: &[u8], out: &mut [u8]) -> Result<(), String> {
    hkdf::Hkdf::<sha2::Sha256>::new(Some(salt), ikm)
        .expand(info, out)
        .map_err(|_| "hkdf expand failed".to_string())
}

/// The aes128gcm message body for `payload` (RFC 8291 section 3.4, one RFC
/// 8188 record): `salt || rs || idlen || as_public || ciphertext`. The
/// ephemeral key, the salt and the padding block come from the caller so the
/// RFC's own example (unpadded) can be reproduced byte for byte; `encrypt`
/// draws a fresh key and salt every time and pads to PAD_BLOCK.
fn encrypt_with(payload: &[u8], ua: &UaKeys, as_secret: &SecretKey, salt: &[u8; 16], pad_block: usize) -> Result<Vec<u8>, String> {
    use aes_gcm::aead::{Aead as _, KeyInit as _};
    if payload.len() > MAX_PAYLOAD {
        return Err(format!("push payload is {} bytes; one record holds {MAX_PAYLOAD}", payload.len()));
    }
    // The delimiter and zero padding up to the next block, never past what one
    // record may hold.
    let padded_len = (payload.len() + 1).div_ceil(pad_block.max(1)) * pad_block.max(1);
    let padded_len = padded_len.min(MAX_PADDED);
    let as_public = uncompressed(&as_secret.public_key());
    let ua_public = uncompressed(&ua.public);
    let shared = p256::ecdh::diffie_hellman(as_secret.to_nonzero_scalar(), ua.public.as_affine());

    // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" 0x00 || ua_public || as_public, 32)
    let mut key_info = Vec::with_capacity(14 + 65 + 65);
    key_info.extend_from_slice(b"WebPush: info\0");
    key_info.extend_from_slice(&ua_public);
    key_info.extend_from_slice(&as_public);
    let mut ikm = zeroize::Zeroizing::new([0u8; 32]);
    hkdf_expand(&ua.auth, shared.raw_secret_bytes().as_slice(), &key_info, &mut ikm[..])?;

    let mut cek = zeroize::Zeroizing::new([0u8; 16]);
    hkdf_expand(salt, &ikm[..], b"Content-Encoding: aes128gcm\0", &mut cek[..])?;
    let mut nonce = [0u8; 12];
    hkdf_expand(salt, &ikm[..], b"Content-Encoding: nonce\0", &mut nonce)?;

    // The last (and only) record: the payload, the 0x02 delimiter, then zeros.
    let mut plaintext = zeroize::Zeroizing::new(Vec::with_capacity(padded_len));
    plaintext.extend_from_slice(payload);
    plaintext.push(0x02);
    plaintext.resize(padded_len, 0);
    let cipher = aes_gcm::Aes128Gcm::new_from_slice(&cek[..]).map_err(|_| "aes key".to_string())?;
    let ciphertext = cipher
        .encrypt(&nonce.into(), plaintext.as_slice())
        .map_err(|_| "aes-gcm encrypt failed".to_string())?;

    let mut body = Vec::with_capacity(16 + 4 + 1 + 65 + ciphertext.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(as_public.len() as u8);
    body.extend_from_slice(&as_public);
    body.extend_from_slice(&ciphertext);
    Ok(body)
}

/// The encrypted body with a fresh ephemeral key and salt: neither may ever be
/// reused, since the pair fixes the AES key and nonce.
pub(crate) fn encrypt(payload: &[u8], ua: &UaKeys) -> Result<Vec<u8>, String> {
    use rand::RngCore as _;
    let mut salt = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    encrypt_with(payload, ua, &random_secret(), &salt, PAD_BLOCK)
}

/// The client every push goes through: https only, and redirects refused, so
/// a push service's answer cannot walk the message to a host that was never
/// checked. Proxies from the environment apply, as for the app's other calls.
pub(crate) fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())
}

/// POST one push through `client`. `endpoint` must already be the checked
/// spelling (companion.rs checked_push_endpoint). Any answer but a 2xx is an
/// error, a redirect included; the body is never read.
pub(crate) async fn send(client: &reqwest::Client, endpoint: &str, ua: &UaKeys, vapid_private_b64: &str, payload: &[u8]) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "system clock is before 1970".to_string())?
        .as_secs();
    let authorization = vapid_authorization(vapid_private_b64, endpoint, now)?;
    let body = encrypt(payload, ua)?;
    let response = client
        .post(endpoint)
        .header("TTL", TTL_SECS.to_string())
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .header("Authorization", authorization)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("push request failed: {}", e.without_url()))?;
    let status = response.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("push service answered {status}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(s: &str) -> Vec<u8> {
        B64.decode(s.split_whitespace().collect::<String>()).unwrap()
    }

    // RFC 8291 Appendix A: inputs, and the header and ciphertext they give.
    const AS_PRIVATE: &str = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    const AS_PUBLIC: &str = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    const UA_PUBLIC: &str = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV- JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const UA_PRIVATE: &str = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
    const SALT: &str = "DGv6ra1nlYgDCS1FRnbzlw";
    const AUTH: &str = "BTBZMqHH6r4Tts7J_aSIgg";
    const PLAINTEXT: &str = "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24";
    const HEADER: &str = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8";
    const CIPHERTEXT: &str = "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ";

    fn rfc_ua() -> UaKeys {
        let ua_public: String = UA_PUBLIC.split_whitespace().collect();
        UaKeys::parse(&ua_public, AUTH).unwrap()
    }

    #[test]
    fn reproduces_the_rfc_8291_example_byte_for_byte() {
        let as_secret = SecretKey::from_slice(&b64(AS_PRIVATE)).unwrap();
        assert_eq!(uncompressed(&as_secret.public_key()), b64(AS_PUBLIC));
        let salt: [u8; 16] = b64(SALT).try_into().unwrap();
        let body = encrypt_with(&b64(PLAINTEXT), &rfc_ua(), &as_secret, &salt, 1).unwrap();
        let mut expected = b64(HEADER);
        assert_eq!(expected.len(), 86);
        expected.extend(b64(CIPHERTEXT));
        assert_eq!(body, expected);
    }

    /// The user agent's side (RFC 8291 section 3.4 run backwards), written
    /// from the RFC rather than from encrypt_with.
    fn decrypt(body: &[u8], ua_private: &SecretKey, auth: &[u8; 16]) -> Result<Vec<u8>, String> {
        use aes_gcm::aead::{Aead as _, KeyInit as _};
        let salt = &body[..16];
        let rs = u32::from_be_bytes(body[16..20].try_into().unwrap());
        assert_eq!(rs, 4096);
        let idlen = body[20] as usize;
        let as_public = PublicKey::from_sec1_bytes(&body[21..21 + idlen]).map_err(|_| "keyid")?;
        let ciphertext = &body[21 + idlen..];
        let shared = p256::ecdh::diffie_hellman(ua_private.to_nonzero_scalar(), as_public.as_affine());
        let ua_public = ua_private.public_key().to_sec1_bytes();
        let mut info = b"WebPush: info\0".to_vec();
        info.extend_from_slice(&ua_public);
        info.extend_from_slice(&body[21..21 + idlen]);
        let mut ikm = [0u8; 32];
        hkdf::Hkdf::<sha2::Sha256>::new(Some(auth), shared.raw_secret_bytes().as_slice()).expand(&info, &mut ikm).unwrap();
        let prk = hkdf::Hkdf::<sha2::Sha256>::new(Some(salt), &ikm);
        let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
        prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).unwrap();
        prk.expand(b"Content-Encoding: nonce\0", &mut nonce).unwrap();
        let mut plain = aes_gcm::Aes128Gcm::new_from_slice(&cek)
            .unwrap()
            .decrypt(&nonce.into(), ciphertext)
            .map_err(|_| "tag".to_string())?;
        while plain.last() == Some(&0) {
            plain.pop();
        }
        assert_eq!(plain.pop(), Some(0x02), "last-record delimiter");
        Ok(plain)
    }

    #[test]
    fn a_browser_reads_what_encrypt_sends_and_a_flipped_byte_fails() {
        let ua_private = SecretKey::from_slice(&b64(UA_PRIVATE)).unwrap();
        let ua = rfc_ua();
        let body = encrypt(br#"{"title":"api","body":"finished"}"#, &ua).unwrap();
        assert_eq!(decrypt(&body, &ua_private, &ua.auth).unwrap(), br#"{"title":"api","body":"finished"}"#);
        let mut bad = body.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(decrypt(&bad, &ua_private, &ua.auth).is_err());
    }

    // A message the web-push crate (0.11, through ece 2.3) built on
    // 2026-10-29 for the RFC's user agent key, before it was removed: what
    // phones have been receiving. Our decoder opens it, padding and all, and
    // ours pads the same payload to the same length.
    const WEB_PUSH_BODY: &str = "88ebnfZMM4E8eJk8GaWiSgAAEABBBKDkupbL4Drkb6OTy42073_G_aOLlFqunnB43pUHATVjN0gbeUullpUOlOOnFeP9GD8qINeGLr0OYuP5M0eJlci-ivkNU_y73NiXmkw-8ZQ8RiTCMPNTF1v0dz-JPrzvedcAD8A_RY2kTwJXqxgEq3rx1AtWs0NtSESvKmhJxyB9Sdbydicvcyw-AB4h7LUvKX0m6MN9nJ81AYEP6prMqbvr6HcqL-29GmYnyBt4-d25gwEXNPYW3yb_gfRBjhYng7yoEEjtf0sgW3R-JbBl9Uo";

    #[test]
    fn opens_what_web_push_sent_and_pads_the_same_way() {
        let ua_private = SecretKey::from_slice(&b64(UA_PRIVATE)).unwrap();
        let ua = rfc_ua();
        let theirs = b64(WEB_PUSH_BODY);
        let payload = br#"{"title":"api","body":"finished"}"#;
        assert_eq!(decrypt(&theirs, &ua_private, &ua.auth).unwrap(), payload);
        let ours = encrypt(payload, &ua).unwrap();
        assert_eq!(ours.len(), theirs.len());
        assert_eq!(ours[16..21], theirs[16..21], "record size and key id length");
        // Padding: payload + delimiter rounded up to 128, capped for one record.
        assert_eq!(encrypt(&[b'a'; 127], &ua).unwrap().len(), 86 + 128 + 16);
        assert_eq!(encrypt(&[b'a'; 128], &ua).unwrap().len(), 86 + 256 + 16);
    }

    #[test]
    fn every_message_gets_a_fresh_salt_and_key() {
        let ua = rfc_ua();
        let (a, b) = (encrypt(b"x", &ua).unwrap(), encrypt(b"x", &ua).unwrap());
        assert_ne!(a[..16], b[..16], "salt");
        assert_ne!(a[21..86], b[21..86], "ephemeral key");
    }

    #[test]
    fn a_payload_one_record_cannot_hold_is_refused() {
        let ua = rfc_ua();
        assert_eq!(encrypt(&vec![b'a'; MAX_PAYLOAD], &ua).unwrap().len(), 4096);
        assert!(encrypt(&vec![b'a'; MAX_PAYLOAD + 1], &ua).is_err());
    }

    #[test]
    fn hostile_subscription_keys_are_errors_not_panics() {
        let good: String = UA_PUBLIC.split_whitespace().collect();
        let mut off_curve = b64(&good);
        off_curve[64] ^= 1;
        let compressed = p256::PublicKey::from_sec1_bytes(&b64(&good)).unwrap();
        let compressed = {
            use p256::elliptic_curve::sec1::ToSec1Point as _;
            compressed.as_affine().to_sec1_point(true).as_bytes().to_vec()
        };
        for (p256dh, auth) in [
            (B64.encode(&off_curve), AUTH.to_string()),
            (B64.encode(&compressed), AUTH.to_string()),
            (B64.encode([4u8; 65]), AUTH.to_string()),
            (String::new(), AUTH.to_string()),
            ("not base64!".to_string(), AUTH.to_string()),
            (good.clone(), B64.encode([1u8; 15])),
            (good.clone(), B64.encode([1u8; 17])),
            (good.clone(), "%%%".to_string()),
        ] {
            assert!(UaKeys::parse(&p256dh, &auth).is_err(), "{p256dh} {auth}");
        }
        for bad in ["", "AAAA", &B64.encode([0u8; 32]), &B64.encode([0xffu8; 32]), &B64.encode([1u8; 33])] {
            assert!(vapid_secret(bad).is_err(), "{bad}");
        }
    }

    // A key the web-push/p256 0.13 code generated and stored (made on
    // 2026-10-29 before that code was removed): it still loads, and gives the
    // same public key the phones were subscribed with.
    const OLD_PRIVATE: &str = "n9zl865eaSoLVA2iaGiQFbkPIg2P_2S4KADIyq2tZJE";
    const OLD_PUBLIC: &str = "BHE8F9ufFvgy-8aAWsDlodKM8ACj_0062M-1iLWfoXdRgcVgAFyGsYW6mc5lS58jW8t-7EbJb2PV6NMI_vBY_E8";

    #[test]
    fn keys_stored_by_the_old_code_still_sign_as_the_same_key() {
        let secret = vapid_secret(OLD_PRIVATE).unwrap();
        assert_eq!(B64.encode(uncompressed(&secret.public_key())), OLD_PUBLIC);
        let header = vapid_authorization(OLD_PRIVATE, "https://fcm.googleapis.com/fcm/send/abc", 1_700_000_000).unwrap();
        assert!(header.ends_with(&format!(", k={OLD_PUBLIC}")));
        let (private, public) = generate_vapid();
        assert_eq!(B64.decode(&private).unwrap().len(), 32);
        assert_eq!(B64.decode(&public).unwrap().len(), 65);
        assert_eq!(B64.encode(uncompressed(&vapid_secret(&private).unwrap().public_key())), public);
    }

    #[test]
    fn the_vapid_token_says_who_it_is_for_until_when_and_verifies() {
        use p256::ecdsa::signature::Verifier as _;
        let header = vapid_authorization(OLD_PRIVATE, "https://web.push.apple.com:443/QGuQ/abc?x=1", 1_700_000_000).unwrap();
        let rest = header.strip_prefix("vapid t=").unwrap();
        let (token, k) = rest.split_once(", k=").unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let head: serde_json::Value = serde_json::from_slice(&B64.decode(parts[0]).unwrap()).unwrap();
        assert_eq!(head, serde_json::json!({ "typ": "JWT", "alg": "ES256" }));
        let claims: serde_json::Value = serde_json::from_slice(&B64.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://web.push.apple.com", "origin only, default port dropped");
        assert_eq!(claims["exp"], 1_700_000_000u64 + 12 * 3600);
        assert_eq!(claims["sub"], VAPID_SUBJECT);
        let key = p256::ecdsa::VerifyingKey::from_sec1_bytes(&B64.decode(k).unwrap()).unwrap();
        let sig = p256::ecdsa::Signature::from_slice(&B64.decode(parts[2]).unwrap()).unwrap();
        key.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig).unwrap();
        assert!(key.verify(b"something else", &sig).is_err());
        assert_eq!(
            audience("https://updates.push.services.mozilla.com:8443/wpush/v2/x").unwrap(),
            "https://updates.push.services.mozilla.com:8443"
        );
    }

    // What a push service receives: the headers web-push sent (TTL 28 days,
    // aes128gcm, the VAPID Authorization), no legacy Crypto-Key header, and a
    // body the subscriber can open.
    #[tokio::test]
    async fn the_request_carries_what_push_services_expect() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let service = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = service.local_addr().unwrap().port();
        let seen = tokio::spawn(async move {
            let (mut c, _) = service.accept().await.unwrap();
            let mut req = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = c.read(&mut buf).await.unwrap();
                req.extend_from_slice(&buf[..n]);
                if let Some(end) = req.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&req[..end]).to_ascii_lowercase();
                    let len: usize = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length: "))
                        .unwrap()
                        .trim()
                        .parse()
                        .unwrap();
                    if req.len() >= end + 4 + len {
                        let _ = c.write_all(b"HTTP/1.1 201 Created\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                        return (head, req[end + 4..end + 4 + len].to_vec());
                    }
                }
                if n == 0 {
                    panic!("closed early");
                }
            }
        });
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        send(&client, &format!("http://127.0.0.1:{port}/push/abc"), &rfc_ua(), OLD_PRIVATE, br#"{"t":1}"#).await.unwrap();
        let (head, body) = seen.await.unwrap();
        assert!(head.starts_with("post /push/abc "), "{head}");
        assert!(head.contains("\nttl: 2419200"), "{head}");
        assert!(head.contains("\ncontent-encoding: aes128gcm"), "{head}");
        assert!(head.contains("\ncontent-type: application/octet-stream"), "{head}");
        assert!(head.contains("\nauthorization: vapid t=ey"), "{head}");
        assert!(head.contains(&format!(", k={}", OLD_PUBLIC.to_ascii_lowercase())), "{head}");
        assert!(!head.contains("crypto-key"), "{head}");
        assert!(!head.contains("urgency"), "{head}");
        let ua_private = SecretKey::from_slice(&b64(UA_PRIVATE)).unwrap();
        assert_eq!(decrypt(&body, &ua_private, &rfc_ua().auth).unwrap(), br#"{"t":1}"#);
        assert_eq!(body.len(), 86 + 128 + 16);
    }

    // A push service's refusal (a gone subscription, a bad token, an outage)
    // comes back as an error with the status and nothing from the body.
    #[tokio::test]
    async fn a_refusal_from_the_push_service_is_an_error() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        for (status, line) in [(410, "410 Gone"), (403, "403 Forbidden"), (503, "503 Service Unavailable")] {
            let service = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = service.local_addr().unwrap().port();
            tokio::spawn(async move {
                let (mut c, _) = service.accept().await.unwrap();
                let mut buf = vec![0u8; 16384];
                let _ = c.read(&mut buf).await;
                let reply = format!("HTTP/1.1 {line}\r\nContent-Length: 13\r\nConnection: close\r\n\r\nsecret detail");
                let _ = c.write_all(reply.as_bytes()).await;
            });
            let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
            let err = send(&client, &format!("http://127.0.0.1:{port}/p"), &rfc_ua(), OLD_PRIVATE, b"{}").await.unwrap_err();
            assert!(err.starts_with(&format!("push service answered {status}")), "{err}");
            assert!(!err.contains("secret"), "{err}");
        }
    }

    // A push service that answers with a redirect does not get the message
    // forwarded anywhere: the second server is never contacted.
    #[tokio::test]
    async fn a_redirect_from_the_push_service_is_not_followed() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let elsewhere = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let elsewhere_port = elsewhere.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let counted = hits.clone();
        tokio::spawn(async move {
            while let Ok((_c, _)) = elsewhere.accept().await {
                counted.fetch_add(1, Ordering::SeqCst);
            }
        });
        let service = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = service.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut c, _)) = service.accept().await {
                let mut buf = vec![0u8; 16384];
                let _ = c.read(&mut buf).await;
                let reply = format!(
                    "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:{elsewhere_port}/x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                let _ = c.write_all(reply.as_bytes()).await;
            }
        });
        let (private, _) = generate_vapid();
        // The app's client with https_only off, so a local server can stand
        // in for the push service; the redirect rule is the one under test.
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        let result = send(&client, &format!("http://127.0.0.1:{port}/push/abc"), &rfc_ua(), &private, b"{}").await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(result, Err("push service answered 307 Temporary Redirect".to_string()));
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }
}

#[cfg(test)]
mod client_tests {
    // The production client refuses plain http and does not follow redirects.
    #[tokio::test]
    async fn the_push_client_is_https_only() {
        let client = super::client().unwrap();
        let (private, _) = super::generate_vapid();
        let ua: String = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4".into();
        let ua = super::UaKeys::parse(&ua, "BTBZMqHH6r4Tts7J_aSIgg").unwrap();
        let err = super::send(&client, "http://127.0.0.1:9/push", &ua, &private, b"{}").await.unwrap_err();
        assert!(err.starts_with("push request failed"), "{err}");
        let src = include_str!("webpush.rs");
        let body = &src[src.find("pub(crate) fn client()").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.contains(".redirect(reqwest::redirect::Policy::none())"));
    }
}
