# Security notes

This is a **disposable field-rig training kit**, not a production service. Several deliberate shortcuts make
the beach test simple to stand up and tear down. **Do not copy them into a production deployment.**

## Not-production patterns in this repo

- **Bearer-token auth only.** The cloud API gates every request on a single shared bearer token
  (`SARG_TOKEN`). There are no user accounts, no per-device credentials, no rotation, no scopes. It is a
  throwaway token for a throwaway box on a controlled hotspot. A real deployment needs proper
  authentication and per-device identity.
- **The firmware skips TLS certificate validation** (`WiFiClientSecure::setInsecure()`). The board accepts
  any server certificate, so it trusts whatever answers at `SARG_URL` — acceptable only on a controlled
  network with a throwaway token, and a man-in-the-middle risk anywhere else. A real deployment must pin or
  validate the server certificate (build with a CA PEM; see the note in `firmware/sargassum_wifi/main.cpp`).
- **The token is served to the browser.** `GET /` bakes the bearer into the dashboard page so the naked URL
  works with no login. That exposes the token to anyone who can load the page — fine for a disposable rig
  with no real data, unacceptable for anything real.
- **The bearer token is baked into the firmware image** at build time (`-D SARG_TOKEN`). Anyone who has a
  flashed board — or the compiled `.bin` — can extract it. Treat a token as **burned** once a flashed board
  leaves your hands; rotate it (and re-flash) if a board is lost or handed off.
- **The database is a local SQLite file**, single-process, torn down with the box. No backups, no access
  control beyond the token.

## What the repo does NOT ship

- **No secrets.** No tokens, keys, PEMs, or real endpoints are committed. WiFi credentials and the bearer
  token are supplied at build/run time and never stored in the repo. `SARG_TOKEN` has **no default** on the
  cloud side — the server refuses to start without it.
- **No prebuilt firmware binaries.** The firmware is distributed as source only (see the LICENSE note on the
  LGPL-2.1 Arduino-ESP32 core); build it yourself with `pio run`.

If you adapt this for real use, replace the auth model, validate TLS, and move secrets into a proper secret
store.
