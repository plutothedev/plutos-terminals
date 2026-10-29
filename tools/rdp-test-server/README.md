<!-- (C) -->
# rdp-test-server

A throwaway local RDP server (IronRDP's `ironrdp-server` 0.13) for checking the
app's RDP client by hand. It is not part of the app build or CI.

It serves a 640x480 desktop that repaints a 64x64 square every 200 ms, prints
every keyboard and mouse event it receives, and accepts one login:
`pluto` / `test-pw-1`.

```bash
cd tools/rdp-test-server
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 2 -subj "/CN=localhost"
cargo run -- 13389 hybrid   # NLA (CredSSP); use "tls" for TLS-only
```

Then, from `src-tauri`:

```bash
RDP_TEST_PORT=13389 cargo test --lib rdp::live -- --ignored --nocapture
```

The live tests connect through the app's own connect code, check the drawn
pixels, send mouse and key input (the server prints it), and check that a wrong
password and a failed pin are refused. Delete `key.pem` and `cert.pem` after.
