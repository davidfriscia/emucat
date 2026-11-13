//! Typed, serialized QMP over the emulator's private stdio pipes.
//!
//! Call on the blocking pool. IDs remain unique after timeouts; events and stale replies never
//! complete a different command. The reader always drains QEMU, with bounded frames and buffering.
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::{Mutex, mpsc};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug)]
pub enum Command {
    Capabilities,
    Powerdown,
    Quit,
    Screendump { filename: PathBuf },
}

impl Command {
    fn request(&self, id: &str) -> Value {
        match self {
            Self::Capabilities => json!({"execute": "qmp_capabilities", "id": id}),
            Self::Powerdown => json!({"execute": "system_powerdown", "id": id}),
            Self::Quit => json!({"execute": "quit", "id": id}),
            Self::Screendump { filename } => {
                json!({"execute": "screendump", "arguments": {"filename": filename}, "id": id})
            }
        }
    }
}

#[derive(Debug, Error)]
pub enum QmpError {
    #[error("QEMU's monitor cannot be reached: {0}")]
    Io(#[from] std::io::Error),
    #[error("QEMU did not answer before the command deadline")]
    Timeout,
    #[error("QEMU's monitor disconnected")]
    Disconnected,
    #[error("QEMU refused the command ({class}): {description}")]
    Refused { class: String, description: String },
    #[error("QEMU returned a malformed command response")]
    Malformed,
}

struct Connection {
    input: mpsc::SyncSender<Value>,
    replies: mpsc::Receiver<Value>,
}

pub struct QmpChannel {
    connection: Mutex<Connection>,
}

impl std::fmt::Debug for QmpChannel {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("QmpChannel")
    }
}

impl QmpChannel {
    pub fn start(
        mut input: impl Write + Send + 'static,
        output: impl Read + Send + 'static,
    ) -> Self {
        // Even an emulator that stops reading stdin must not hold a caller beyond its deadline.
        let (writer, requests) = mpsc::sync_channel::<Value>(1);
        std::thread::spawn(move || {
            for request in requests {
                if writeln!(input, "{request}")
                    .and_then(|_| input.flush())
                    .is_err()
                {
                    break;
                }
            }
        });
        let (sender, receiver) = mpsc::sync_channel(32);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                // A maximum-sized malformed frame cannot allocate without bound or block draining.
                let mut frame = Vec::new();
                match Read::by_ref(&mut reader)
                    .take(65_537)
                    .read_until(b'\n', &mut frame)
                {
                    Ok(0) | Err(_) => break,
                    _ if frame.len() > 65_536 => break,
                    _ => {}
                }
                let Ok(value) = serde_json::from_slice::<Value>(&frame) else {
                    continue;
                };
                if value.get("event").is_none() && value.get("id").is_some() {
                    let _ = sender.try_send(value);
                }
            }
        });
        Self {
            connection: Mutex::new(Connection {
                input: writer,
                replies: receiver,
            }),
        }
    }

    pub fn execute(&self, command: Command, timeout: Duration) -> Result<Value, QmpError> {
        let deadline = Instant::now() + timeout;
        // Include time waiting for another command in this command's deadline.
        let connection = loop {
            if let Ok(connection) = self.connection.try_lock() {
                break connection;
            }
            if Instant::now() >= deadline {
                return Err(QmpError::Timeout);
            }
            std::thread::sleep(Duration::from_millis(2));
        };
        while connection.replies.try_recv().is_ok() {}
        let id = Uuid::new_v4().to_string();
        connection
            .input
            .try_send(command.request(&id))
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => QmpError::Timeout,
                mpsc::TrySendError::Disconnected(_) => QmpError::Disconnected,
            })?;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let reply =
                connection
                    .replies
                    .recv_timeout(remaining)
                    .map_err(|error| match error {
                        mpsc::RecvTimeoutError::Timeout => QmpError::Timeout,
                        mpsc::RecvTimeoutError::Disconnected => QmpError::Disconnected,
                    })?;
            if reply.get("id").and_then(Value::as_str) != Some(&id) {
                continue;
            }
            match (reply.get("return"), reply.get("error")) {
                (Some(value), None) => return Ok(value.clone()),
                (None, Some(error)) => {
                    let class = error
                        .get("class")
                        .and_then(Value::as_str)
                        .ok_or(QmpError::Malformed)?;
                    let description = error
                        .get("desc")
                        .and_then(Value::as_str)
                        .ok_or(QmpError::Malformed)?;
                    return Err(QmpError::Refused {
                        class: class.to_owned(),
                        description: description.to_owned(),
                    });
                }
                _ => return Err(QmpError::Malformed),
            }
        }
    }

    pub fn negotiate(&self) -> Result<(), QmpError> {
        self.execute(Command::Capabilities, Duration::from_secs(10))
            .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};
    use std::sync::Arc;

    fn channel(server: impl FnOnce(TcpStream) + Send + 'static) -> QmpChannel {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (peer, _) = listener.accept().unwrap();
        std::thread::spawn(move || server(peer));
        QmpChannel::start(client.try_clone().unwrap(), client)
    }

    fn request(reader: &mut BufReader<TcpStream>) -> Value {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }

    #[test]
    fn arguments_ids_events_and_structured_results() {
        let channel = channel(|mut peer| {
            let mut reader = BufReader::new(peer.try_clone().unwrap());
            let capabilities = request(&mut reader);
            assert_eq!(capabilities["execute"], "qmp_capabilities");
            writeln!(peer, "{}", json!({"return": {}, "id": capabilities["id"]})).unwrap();
            let capture = request(&mut reader);
            assert_ne!(capture["id"], capabilities["id"]);
            assert_eq!(capture["arguments"]["filename"], "C:\\captures\\a.ppm");
            writeln!(peer, "not json\n{{\"event\":\"STOP\"}}").unwrap();
            writeln!(
                peer,
                "{}",
                json!({"return": {"ok": true}, "id": capture["id"]})
            )
            .unwrap();
        });
        channel.negotiate().unwrap();
        assert_eq!(
            channel
                .execute(
                    Command::Screendump {
                        filename: PathBuf::from(r"C:\captures\a.ppm")
                    },
                    Duration::from_secs(1)
                )
                .unwrap(),
            json!({"ok": true})
        );
    }

    #[test]
    fn a_timed_out_reply_cannot_satisfy_the_next_command() {
        let channel = channel(|mut peer| {
            let mut reader = BufReader::new(peer.try_clone().unwrap());
            let first = request(&mut reader);
            let second = request(&mut reader);
            writeln!(peer, "{}", json!({"return": {}, "id": first["id"]})).unwrap();
            writeln!(peer, "{}", json!({"error": {"class": "GenericError", "desc": "second failed"}, "id": second["id"]})).unwrap();
        });
        assert!(matches!(
            channel.execute(Command::Powerdown, Duration::from_millis(30)),
            Err(QmpError::Timeout)
        ));
        assert!(
            matches!(channel.execute(Command::Quit, Duration::from_secs(1)), Err(QmpError::Refused { description, .. }) if description == "second failed")
        );
    }

    #[test]
    fn malformed_matching_response_is_an_error() {
        let channel = channel(|mut peer| {
            let value = request(&mut BufReader::new(peer.try_clone().unwrap()));
            writeln!(peer, "{}", json!({"error": {}, "id": value["id"]})).unwrap();
        });
        assert!(matches!(
            channel.execute(Command::Quit, Duration::from_secs(1)),
            Err(QmpError::Malformed)
        ));
    }

    #[test]
    fn concurrent_commands_are_serialized_and_have_distinct_ids() {
        let channel = Arc::new(channel(|mut peer| {
            let mut reader = BufReader::new(peer.try_clone().unwrap());
            let first = request(&mut reader);
            writeln!(
                peer,
                "{}",
                json!({"return": first["execute"], "id": first["id"]})
            )
            .unwrap();
            let second = request(&mut reader);
            assert_ne!(first["id"], second["id"]);
            writeln!(
                peer,
                "{}",
                json!({"return": second["execute"], "id": second["id"]})
            )
            .unwrap();
        }));
        let other = channel.clone();
        let first = std::thread::spawn(move || {
            other
                .execute(Command::Powerdown, Duration::from_secs(1))
                .unwrap()
        });
        let second = channel
            .execute(Command::Quit, Duration::from_secs(1))
            .unwrap();
        assert_eq!(first.join().unwrap(), "system_powerdown");
        assert_eq!(second, "quit");
    }
}
