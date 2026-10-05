use reqwest::header::{HeaderValue, AUTHORIZATION};
use serde::Serialize;
use std::time::Duration;

#[derive(Debug, Serialize)]
pub(crate) struct KeyError {
    code: &'static str,
    message: &'static str,
}

impl KeyError {
    pub(crate) fn storage() -> Self {
        Self {
            code: "storage_error",
            message: "The key could not be saved securely. Try again.",
        }
    }

    fn invalid() -> Self {
        Self { code: "invalid_key", message: "The provider rejected this API key. Check the key and its permissions, then try again." }
    }

    fn unavailable() -> Self {
        Self { code: "provider_unavailable", message: "The provider could not verify the key right now. Try again. Your saved key has not changed." }
    }
}

pub(crate) async fn validate(provider: &str, key: &str) -> Result<(), KeyError> {
    let endpoint = match provider {
        "deepgram" => "https://api.deepgram.com/v1/auth/token",
        "assemblyAi" => "https://streaming.assemblyai.com/v3/token?expires_in_seconds=1",
        _ => return Err(KeyError::invalid()),
    };
    check(provider, key, endpoint).await
}

async fn check(provider: &str, key: &str, endpoint: &str) -> Result<(), KeyError> {
    if key.is_empty() || key.len() > 8192 || !key.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(KeyError::invalid());
    }
    let value = if provider == "deepgram" {
        format!("Token {key}")
    } else {
        key.to_owned()
    };
    let mut authorization = HeaderValue::from_str(&value).map_err(|_| KeyError::invalid())?;
    authorization.set_sensitive(true);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| KeyError::unavailable())?;
    let response = client
        .get(endpoint)
        .header(AUTHORIZATION, authorization)
        .send()
        .await
        .map_err(|_| KeyError::unavailable())?;
    // Do not read or retain provider response bodies, which may contain tokens.
    match response.status().as_u16() {
        200 => Ok(()),
        401 | 403 => Err(KeyError::invalid()),
        _ => Err(KeyError::unavailable()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[tokio::test]
    async fn key_checks_bind_credentials_to_provider_and_reject_errors_without_echoing_secrets() {
        for (provider, status, expected) in [
            ("deepgram", 200, None),
            ("assemblyAi", 200, None),
            ("deepgram", 401, Some("invalid_key")),
            ("assemblyAi", 403, Some("invalid_key")),
            ("deepgram", 429, Some("provider_unavailable")),
            ("assemblyAi", 503, Some("provider_unavailable")),
            ("deepgram", 302, Some("provider_unavailable")),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/check", listener.local_addr().unwrap());
            let worker = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                let text = String::from_utf8(request).unwrap().to_lowercase();
                let prefix = if provider == "deepgram" { "Token " } else { "" };
                assert!(text.contains(
                    &format!("authorization: {prefix}test-private-key\r\n").to_lowercase()
                ));
                write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Length: 16\r\nLocation: http://127.0.0.1:1/leak\r\nConnection: close\r\n\r\ntest-private-key").unwrap();
            });
            let result = check(provider, "test-private-key", &url).await;
            assert_eq!(result.as_ref().err().map(|e| e.code), expected);
            assert!(!format!("{result:?}").contains("test-private-key"));
            worker.join().unwrap();
        }
        assert_eq!(
            validate("unknown", "key").await.unwrap_err().code,
            "invalid_key"
        );
        assert_eq!(
            validate("deepgram", "bad\r\nkey").await.unwrap_err().code,
            "invalid_key"
        );
    }
}
