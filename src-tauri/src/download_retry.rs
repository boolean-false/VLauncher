use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

fn transient(error: &str) -> bool {
    let error = error.to_lowercase();
    if [
        "signature",
        "hash",
        "mismatch",
        "certificate",
        "cancel",
        "paused",
        "отмен",
        "подпис",
        "контрольн",
    ]
    .iter()
    .any(|part| error.contains(part))
    {
        return false;
    }
    let status = [
        "http ",
        "status: ",
        "status ",
        "returned ",
        "http status server error (",
        "http status client error (",
    ]
    .iter()
    .any(|prefix| {
        error.match_indices(prefix).any(|(offset, _)| {
            let code = error[offset + prefix.len()..]
                .split(|c: char| !c.is_ascii_digit())
                .next()
                .unwrap_or("");
            matches!(code, "408" | "429" | "500" | "502" | "503" | "504")
        })
    });
    status
        || [
            "timed out",
            "timeout",
            "connection reset",
            "connection closed",
            "error sending request",
            "error decoding response body",
            "архив загружен не полностью",
            "загрузился не полностью",
            "временно не может получить",
        ]
        .iter()
        .any(|part| error.contains(part))
}

pub(crate) fn retry<T>(
    cancelled: &AtomicBool,
    mut on_retry: impl FnMut(usize),
    mut operation: impl FnMut() -> Result<T, String>,
) -> Result<T, String> {
    for attempt in 0..3 {
        if cancelled.load(Ordering::SeqCst) {
            return Err("download paused by user".into());
        }
        match operation() {
            Err(error) if attempt < 2 && transient(&error) => {
                on_retry(attempt + 2);
                for _ in 0..10 * (attempt + 1) {
                    if cancelled.load(Ordering::SeqCst) {
                        return Err("download paused by user".into());
                    }
                    std::thread::sleep(Duration::from_millis(if cfg!(test) { 1 } else { 100 }));
                }
            }
            result => return result,
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retries_only_temporary_errors_and_can_cancel_wait() {
        let cancelled = AtomicBool::new(false);
        let mut calls = 0;
        let value = retry(
            &cancelled,
            |_| {},
            || {
                calls += 1;
                if calls < 3 {
                    Err("HTTP 503".into())
                } else {
                    Ok(7)
                }
            },
        )
        .unwrap();
        assert_eq!((calls, value), (3, 7));
        for error in [
            "invalid signature",
            "hash mismatch",
            "HTTP 404",
            "certificate error",
            "could not open profile 503",
            "bad package 500",
        ] {
            assert!(!transient(error));
        }
        assert!(transient(
            "HTTP status server error (503 Service Unavailable)"
        ));
        let result: Result<(), String> = retry(
            &cancelled,
            |_| cancelled.store(true, Ordering::SeqCst),
            || Err("HTTP 503".into()),
        );
        assert_eq!(result.unwrap_err(), "download paused by user");
    }
}
