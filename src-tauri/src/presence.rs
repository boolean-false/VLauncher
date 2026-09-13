#[cfg(unix)]
use crate::presence_ipc::Client as DiscordIpcClient;
#[cfg(windows)]
use discord_rich_presence::DiscordIpcClient;
use discord_rich_presence::{DiscordIpc, activity};
use serde::Serialize;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone, Serialize)]
pub struct PresenceStatus {
    pub configured: bool,
    pub state: String,
}
#[derive(Clone)]
pub struct Presence {
    sender: mpsc::Sender<(bool, bool)>,
    status: Arc<Mutex<PresenceStatus>>,
}
impl Presence {
    pub fn new() -> Self {
        let id = std::env::var("VLAUNCHER_DISCORD_APPLICATION_ID").unwrap_or_else(|_| {
            option_env!("VLAUNCHER_DISCORD_APPLICATION_ID")
                .unwrap_or(include_str!("../discord-application-id.txt"))
                .trim()
                .to_owned()
        });
        let configured = id.len() >= 17 && id.len() <= 20 && id.bytes().all(|c| c.is_ascii_digit());
        let status = Arc::new(Mutex::new(PresenceStatus {
            configured,
            state: if configured {
                "waiting"
            } else {
                "not_configured"
            }
            .into(),
        }));
        let shared = status.clone();
        let (sender, receiver) = mpsc::channel::<(bool, bool)>();
        std::thread::spawn(move || {
            let mut client: Option<DiscordIpcClient> = None;
            let mut enabled = false;
            let mut playing = false;
            let mut since = now();
            loop {
                match receiver.recv_timeout(Duration::from_secs(15)) {
                    Ok((next_enabled, next_playing)) => {
                        if next_playing != playing || (next_enabled && !enabled) {
                            since = now();
                        }
                        enabled = next_enabled;
                        playing = next_playing;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                if !configured {
                    continue;
                }
                if !enabled {
                    if let Some(mut c) = client.take() {
                        let _ = c.clear_activity();
                        let _ = c.close();
                    }
                    shared.lock().unwrap().state = "disabled".into();
                    continue;
                }
                let result = (|| -> Result<(), String> {
                    if client.is_none() {
                        let mut c = DiscordIpcClient::new(&id);
                        c.connect_ipc().map_err(|e| e.to_string())?;
                        c.send(serde_json::json!({"v":1,"client_id":id}), 0)
                            .map_err(|e| e.to_string())?;
                        let (op, reply) = c.recv().map_err(|e| e.to_string())?;
                        if op != 1 || reply["evt"] != "READY" {
                            return Err("Discord rejected handshake".into());
                        }
                        client = Some(c);
                    }
                    let c = client.as_mut().unwrap();
                    c.set_activity(
                        activity::Activity::new()
                            .details(if playing {
                                "Играет в кубики"
                            } else {
                                "В меню"
                            })
                            .state(if playing {
                                "Игра запущена через VLauncher"
                            } else {
                                "Контент-паки, сборки и миры для"
                            })
                            .timestamps(activity::Timestamps::new().start(since)),
                    )
                    .map_err(|e| e.to_string())?;
                    let (op, reply) = c.recv().map_err(|e| e.to_string())?;
                    if op != 1 || reply["evt"] == "ERROR" {
                        return Err("Discord rejected activity".into());
                    }
                    Ok(())
                })();
                if result.is_ok() {
                    if shared.lock().unwrap().state != "connected" {
                        eprintln!("Discord Rich Presence: activity acknowledged by Discord");
                    }
                    shared.lock().unwrap().state = "connected".into();
                } else {
                    if let Some(mut c) = client.take() {
                        let _ = c.close();
                    }
                    shared.lock().unwrap().state = "waiting".into();
                }
            }
            if let Some(mut c) = client {
                let _ = c.clear_activity();
                let _ = c.close();
            }
        });
        Self { sender, status }
    }
    pub fn update(&self, enabled: bool, playing: bool) -> Result<(), String> {
        self.sender
            .send((enabled, playing))
            .map_err(|e| e.to_string())
    }
    pub fn status(&self) -> PresenceStatus {
        self.status.lock().unwrap().clone()
    }
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[tauri::command]
pub fn update_discord_presence(
    state: tauri::State<'_, Presence>,
    enabled: bool,
    playing: bool,
) -> Result<(), String> {
    state.update(enabled, playing)
}
#[tauri::command]
pub fn discord_presence_status(state: tauri::State<'_, Presence>) -> PresenceStatus {
    state.status()
}
