use std::io;
use std::os::fd::AsFd;

use rmux_os::signals::PolledServerSignal;
use tokio::net::unix::pipe;
use tracing::debug;

use crate::diagnostic_log::record_shutdown_request;

pub(crate) struct SignalWatcher {
    wake: pipe::Receiver,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(unix), allow(dead_code))]
pub(crate) enum ServerSignal {
    Shutdown(&'static str),
    ChildChanged,
    RecreateSocket,
}

impl std::fmt::Debug for SignalWatcher {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SignalWatcher")
            .finish_non_exhaustive()
    }
}

impl SignalWatcher {
    pub(crate) fn install() -> io::Result<Self> {
        let wake = rmux_os::signals::install_server_signal_flags()?.into_read_fd();
        // An owned duplicate of the process-global read end, registered without `unsafe`.
        let wake = pipe::Receiver::from_owned_fd(wake.as_fd().try_clone_to_owned()?)?;
        Ok(Self { wake })
    }

    pub(crate) async fn wait(&self) -> io::Result<()> {
        loop {
            self.wake.readable().await?;
            let mut buffer = [0_u8; 64];
            match self.wake.try_read(&mut buffer) {
                Ok(_) => return Ok(()),
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                    ) =>
                {
                    continue;
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub(crate) fn poll(&self) -> Option<ServerSignal> {
        match rmux_os::signals::poll_server_signal_flags()? {
            PolledServerSignal::Interrupt => {
                debug!(signal = "SIGINT", "server received shutdown signal");
                record_shutdown_request("signal-sigint");
                Some(ServerSignal::Shutdown("signal-sigint"))
            }
            PolledServerSignal::Terminate => {
                debug!(signal = "SIGTERM", "server received shutdown signal");
                record_shutdown_request("signal-sigterm");
                Some(ServerSignal::Shutdown("signal-sigterm"))
            }
            PolledServerSignal::ChildChanged => {
                debug!(signal = "SIGCHLD", "server received child status signal");
                Some(ServerSignal::ChildChanged)
            }
            PolledServerSignal::RecreateSocket => {
                debug!(
                    signal = "SIGUSR1",
                    "server received socket recreation signal"
                );
                Some(ServerSignal::RecreateSocket)
            }
            PolledServerSignal::Ignored => {
                debug!("server ignored non-terminating signal");
                None
            }
        }
    }
}
