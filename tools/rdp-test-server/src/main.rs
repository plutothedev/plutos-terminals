// (C) Throwaway local RDP server for testing the app's RDP client by hand (see README.md).
use std::num::{NonZeroU16, NonZeroUsize};
use ironrdp_server::{
    BitmapUpdate, Credentials, DesktopSize, DisplayUpdate, KeyboardEvent, MouseEvent, PixelFormat, RdpServer,
    RdpServerDisplay, RdpServerDisplayUpdates, RdpServerInputHandler, TlsIdentityCtx,
};

struct Input;
impl RdpServerInputHandler for Input {
    fn keyboard(&mut self, e: KeyboardEvent) { println!("INPUT key {e:?}"); }
    fn mouse(&mut self, e: MouseEvent) { println!("INPUT mouse {e:?}"); }
}

struct Display;
struct Updates { n: u32 }

#[async_trait::async_trait]
impl RdpServerDisplayUpdates for Updates {
    async fn next_update(&mut self) -> anyhow::Result<Option<DisplayUpdate>> {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        self.n += 1;
        let (w, h) = (64u16, 64u16);
        let mut data = vec![0u8; w as usize * h as usize * 4];
        for px in data.chunks_mut(4) { px.copy_from_slice(&[0x20, 0x80, 0xE0, 0xFF]); } // BGRA
        println!("SERVER sent bitmap {}", self.n);
        Ok(Some(DisplayUpdate::Bitmap(BitmapUpdate {
            x: 10 * (self.n % 10) as u16, y: 20,
            width: NonZeroU16::new(w).unwrap(), height: NonZeroU16::new(h).unwrap(),
            format: PixelFormat::BgrA32, data: data.into(),
            stride: NonZeroUsize::new(w as usize * 4).unwrap(),
        })))
    }
}

#[async_trait::async_trait]
impl RdpServerDisplay for Display {
    async fn size(&mut self) -> DesktopSize { DesktopSize { width: 640, height: 480 } }
    async fn updates(&mut self) -> anyhow::Result<Box<dyn RdpServerDisplayUpdates>> { Ok(Box::new(Updates { n: 0 })) }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let port: u16 = std::env::args().nth(1).and_then(|p| p.parse().ok()).unwrap_or(13389);
    let mode = std::env::args().nth(2).unwrap_or_else(|| "hybrid".into());
    let id = TlsIdentityCtx::init_from_paths("cert.pem".as_ref(), "key.pem".as_ref())?;
    let acceptor = id.make_acceptor()?;
    let b = RdpServer::builder().with_addr(([127, 0, 0, 1], port));
    let b = if mode == "tls" { b.with_tls(acceptor) } else { b.with_hybrid(acceptor, id.pub_key.clone()) };
    let mut server = b.with_input_handler(Input).with_display_handler(Display).build();
    server.set_credentials(Some(Credentials { username: "pluto".into(), password: "test-pw-1".into(), domain: None }));
    println!("SERVER listening on {port} ({mode})");
    server.run().await
}
