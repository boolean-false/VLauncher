use discord_rich_presence::{DiscordIpc, error::Error};
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    time::Duration,
};

pub struct Client {
    id: String,
    socket: Option<UnixStream>,
}
impl Client {
    pub fn new(id: &str) -> Self {
        Self {
            id: id.to_owned(),
            socket: None,
        }
    }
    fn attach(&mut self, socket: UnixStream) -> Result<(), Error> {
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .map_err(Error::ReadError)?;
        socket
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(Error::WriteError)?;
        self.socket = Some(socket);
        Ok(())
    }
}
impl DiscordIpc for Client {
    fn get_client_id(&self) -> &str {
        &self.id
    }
    fn connect_ipc(&mut self) -> Result<(), Error> {
        let mut roots: Vec<PathBuf> = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
            .iter()
            .filter_map(|name| std::env::var_os(name).map(PathBuf::from))
            .collect();
        roots.push(PathBuf::from("/tmp"));
        for root in roots {
            for sub in [
                "",
                "app/com.discordapp.Discord",
                "app/dev.vencord.Vesktop",
                ".flatpak/com.discordapp.Discord/xdg-run",
                ".flatpak/dev.vencord.Vesktop/xdg-run",
                "snap.discord",
                "snap.discord-canary",
            ] {
                for i in 0..10 {
                    if let Ok(socket) =
                        UnixStream::connect(root.join(sub).join(format!("discord-ipc-{i}")))
                    {
                        return self.attach(socket);
                    }
                }
            }
        }
        Err(Error::IPCNotFound)
    }
    fn read(&mut self, data: &mut [u8]) -> Result<(), Error> {
        self.socket
            .as_mut()
            .ok_or(Error::NotConnected)?
            .read_exact(data)
            .map_err(Error::ReadError)
    }
    fn write(&mut self, data: &[u8]) -> Result<(), Error> {
        self.socket
            .as_mut()
            .ok_or(Error::NotConnected)?
            .write_all(data)
            .map_err(Error::WriteError)
    }
    fn close(&mut self) -> Result<(), Error> {
        if let Some(socket) = self.socket.take() {
            let _ = socket.shutdown(std::net::Shutdown::Both);
        }
        Ok(())
    }
    fn recv(&mut self) -> Result<(u32, serde_json::Value), Error> {
        for _ in 0..8 {
            let mut header = [0; 8];
            self.read(&mut header)?;
            let op = u32::from_le_bytes(header[..4].try_into().unwrap());
            let size = u32::from_le_bytes(header[4..].try_into().unwrap()) as usize;
            if size > 1024 * 1024 {
                return Err(Error::DecodeHeader);
            }
            let mut bytes = vec![0; size];
            self.read(&mut bytes)?;
            let value: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|_| Error::JsonParseResponse)?;
            if op == 3 {
                self.send(value, 4)?;
                continue;
            }
            return Ok((op, value));
        }
        Err(Error::DecodeOpcode)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handles_ping_and_rejects_oversized_frames() {
        let (a, mut b) = UnixStream::pair().unwrap();
        let mut client = Client::new("123456789012345678");
        client.attach(a).unwrap();
        let server = std::thread::spawn(move || {
            b.write_all(&3u32.to_le_bytes()).unwrap();
            b.write_all(&2u32.to_le_bytes()).unwrap();
            b.write_all(b"{}").unwrap();
            b.write_all(&1u32.to_le_bytes()).unwrap();
            b.write_all(&2u32.to_le_bytes()).unwrap();
            b.write_all(b"{}").unwrap();
            let mut pong = [0; 10];
            b.read_exact(&mut pong).unwrap();
            assert_eq!(pong[0], 4);
            b.write_all(&1u32.to_le_bytes()).unwrap();
            b.write_all(&(2 * 1024 * 1024u32).to_le_bytes()).unwrap();
        });
        assert_eq!(client.recv().unwrap().0, 1);
        assert!(client.recv().is_err());
        server.join().unwrap();
    }
}
