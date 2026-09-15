use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{io::Read, time::Duration};

const GITHUB_DEVICE_URL: &str = "https://github.com/login/device";
const MAX_RESPONSE_SIZE: u64 = 1024 * 1024;

#[derive(Deserialize, Serialize)]
pub(crate) struct DeviceSession {
    request_id: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct DevicePoll {
    status: String,
    interval: Option<u64>,
    access_token: Option<String>,
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: Option<ErrorBody>,
}

#[derive(Deserialize)]
struct ErrorBody {
    code: Option<String>,
    message: Option<String>,
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(concat!(
            "VLauncher/",
            env!("CARGO_PKG_VERSION"),
            " (+https://vlauncher.space)"
        ))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Не удалось подготовить подключение к VSpace".to_string())
}

fn transport_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "VSpace не ответил вовремя. Проверьте соединение и повторите вход.".into()
    } else if error.is_connect() {
        "Не удалось подключиться к VSpace. Проверьте интернет, DNS, прокси или антивирус.".into()
    } else {
        "Не удалось получить ответ VSpace. Повторите вход.".into()
    }
}

fn server_error(status: reqwest::StatusCode, body: &[u8]) -> String {
    let error = serde_json::from_slice::<ErrorEnvelope>(body)
        .ok()
        .and_then(|envelope| envelope.error);
    match error.as_ref().and_then(|error| error.code.as_deref()) {
        Some("github_oauth_not_configured") => "Вход через GitHub не настроен на VSpace.".into(),
        Some("github_unavailable") | Some("github_invalid_response") => {
            "VSpace сейчас не может связаться с GitHub. Повторите вход позже.".into()
        }
        Some("device_session_not_found") => "Код GitHub истёк. Начните вход заново.".into(),
        Some("device_authorization_failed") => {
            "GitHub отклонил вход или код истёк. Начните вход заново.".into()
        }
        Some("github_username_conflict") => {
            "Этот GitHub-профиль уже связан с другим аккаунтом VLauncher.".into()
        }
        Some("rate_limited") => "Слишком много попыток входа. Немного подождите.".into(),
        _ => error
            .and_then(|error| error.message)
            .filter(|message| !message.trim().is_empty())
            .unwrap_or_else(|| format!("VSpace вернул ошибку {}", status.as_u16())),
    }
}

fn request<T: DeserializeOwned>(path: &str) -> Result<T, String> {
    let response = client()?
        .post(format!(
            "{}{}",
            super::registry_url().trim_end_matches('/'),
            path
        ))
        .send()
        .map_err(transport_error)?;
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_SIZE)
    {
        return Err("VSpace вернул слишком большой ответ".into());
    }
    let mut body = Vec::new();
    response
        .take(MAX_RESPONSE_SIZE + 1)
        .read_to_end(&mut body)
        .map_err(|_| "Не удалось прочитать ответ VSpace".to_string())?;
    if body.len() as u64 > MAX_RESPONSE_SIZE {
        return Err("VSpace вернул слишком большой ответ".into());
    }
    if !status.is_success() {
        return Err(server_error(status, &body));
    }
    serde_json::from_slice(&body).map_err(|_| "VSpace вернул некорректный ответ".to_string())
}

fn valid_request_id(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn validate_session(mut session: DeviceSession) -> Result<DeviceSession, String> {
    let valid_code = (4..=32).contains(&session.user_code.len())
        && session
            .user_code
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-');
    if !valid_request_id(&session.request_id)
        || !valid_code
        || session.verification_uri != GITHUB_DEVICE_URL
        || session.expires_in == 0
    {
        return Err("VSpace вернул некорректную сессию входа".into());
    }
    session.interval = session.interval.clamp(5, 30);
    session.expires_in = session.expires_in.min(900);
    Ok(session)
}

fn validate_poll(mut poll: DevicePoll) -> Result<DevicePoll, String> {
    if !matches!(poll.status.as_str(), "pending" | "complete")
        || poll.status == "complete"
            && poll
                .access_token
                .as_deref()
                .is_none_or(|token| token.trim().is_empty())
    {
        return Err("VSpace вернул некорректный результат входа".into());
    }
    poll.interval = poll.interval.map(|interval| interval.clamp(5, 30));
    Ok(poll)
}

#[tauri::command]
pub(crate) async fn registry_device_start() -> Result<DeviceSession, String> {
    tauri::async_runtime::spawn_blocking(|| request("/auth/device").and_then(validate_session))
        .await
        .map_err(|_| "Запрос входа был прерван".to_string())?
}

#[tauri::command]
pub(crate) async fn registry_device_poll(request_id: String) -> Result<DevicePoll, String> {
    if !valid_request_id(&request_id) {
        return Err("Некорректная сессия входа".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        request(&format!("/auth/device/{request_id}")).and_then(validate_poll)
    })
    .await
    .map_err(|_| "Проверка входа была прервана".to_string())?
}

#[cfg(test)]
mod tests {
    use super::{
        DevicePoll, DeviceSession, server_error, valid_request_id, validate_poll, validate_session,
    };

    #[test]
    fn device_request_ids_cannot_change_the_endpoint_path() {
        assert!(valid_request_id("abcDEF0123_-abcDEF0123_-"));
        assert!(!valid_request_id("../../auth/logout"));
        assert!(!valid_request_id("short"));
    }

    #[test]
    fn registry_errors_are_explained_in_the_launcher() {
        assert_eq!(
            server_error(
                reqwest::StatusCode::TOO_MANY_REQUESTS,
                br#"{"error":{"code":"rate_limited","message":"Rate limited"}}"#,
            ),
            "Слишком много попыток входа. Немного подождите."
        );
    }

    #[test]
    fn device_responses_are_bounded_and_validated() {
        let session = validate_session(DeviceSession {
            request_id: "abcDEF0123_-abcDEF0123_-".into(),
            user_code: "ABCD-1234".into(),
            verification_uri: "https://github.com/login/device".into(),
            expires_in: 3_600,
            interval: 1,
        })
        .unwrap();
        assert_eq!(session.expires_in, 900);
        assert_eq!(session.interval, 5);

        assert!(
            validate_poll(DevicePoll {
                status: "complete".into(),
                interval: None,
                access_token: None,
            })
            .is_err()
        );
    }
}
