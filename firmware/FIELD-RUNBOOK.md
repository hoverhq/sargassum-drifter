# Sargassum drifter — field runbook

WiFi-direct sargassum RGB rig.
Board: LilyGO T-Beam Supreme S3/SX1262 + TCA9548A mux + 4× ISL29125 RGB. Sketch: `sargassum_wifi/main.cpp`
(PlatformIO env `sargassum_wifi`; see `platformio.ini`).

## GO checklist — run through this before every deploy (bench or field)

1. **Battery charged.** The 4 ISL29125 RGB sensors are powered off the **battery rail** (PMU ALDO/DLDO), not
   USB — a dead or absent battery reads clean **0/4 present, all-zero RGB** even though the board boots,
   joins WiFi, and POSTs fine. If readings are flat, check the battery **first**, before touching firmware.
2. **AP is on 2.4GHz.** The ESP32 WiFi radio is **2.4GHz-only hardware** — it cannot see a 5GHz-only network
   regardless of security mode. Confirm the AP's 2.4GHz band is actually up (`nmcli dev wifi list` /
   phone WiFi settings) before assuming a "won't join" failure is credentials or WPA-mode related.
   WPA2/WPA3-mixed mode has worked with this AP once band was confirmed — don't assume mixed-mode alone
   is the blocker; check the band first.
3. **Red/blue-paper real-sensor sanity BEFORE deploying.** Point the sensors at a mat sample (or red/blue
   paper) and confirm the dashboard (`your-server.example`) swatches + features move. This is the REAL-SENSOR gate —
   the synthetic testbench (`cloud/synthetic.py` + the test suite) only validates the pipeline's *code*, not
   that the physical sensors are actually reading. Do this every time before trusting a deploy.
4. **your-server.example reachable.** Confirm `https://your-server.example` loads and shows live data before leaving for the
   site. After the trip, tear down your server — and **delete any DNS record** pointing at a released IP
   (a leftover record dangling to a released IP is a takeover risk).

**The dashboard is the ONLY status channel in the field.** With the OLED and charge LED both off (see
below) and the LEDs not yet populated, the board gives no at-the-board sign of life — status (WiFi
joined, model version, verdict, live readings) lives at `your-server.example` only. Bring a phone/hotspot able to
reach it; don't wait on a dark board wondering if it's alive.

## Building + flashing

```bash
cd firmware/
PLATFORMIO_BUILD_FLAGS="-DWIFI_SSID='\"<ssid>\"' -DWIFI_PASS='\"<pass>\"' -DSARG_URL='\"https://your-server.example\"' -DSARG_TOKEN='\"<token>\"' -DSARG_DRIFTER='\"<name>\"'" \
  pio run
```

Creds are injected at **build time only** — never commit real SSID/pass/token (the committed env has
placeholders). Read secret values from a local file (never paste into a chat/session). If a rebuilt binary
still shows an old value, clear the build cache with `rm -rf .pio` and rebuild.

Flash: **esptool at baud 115200, not pio's default 460800** (which corrupts this board's native USB). Enter
download mode (hold BOOT, tap RESET, release BOOT), flash `.pio/build/sargassum_wifi/firmware.bin` at
`0x0/0x8000/0xe000/0x10000` (bootloader/partitions/boot_app0/firmware), then a plain RESET to boot.
**esptool's automatic post-flash reset does not reliably boot this board — always do a physical RESET.**

## No on-board status display

The OLED and the PMU charge LED are both **intentionally disabled** in this build — both are light emitters
that sit near the RGB array and contaminate the measurement. There is no on-board visual status; use the
dashboard at `your-server.example` to confirm the board is live (readings/detections updating).

Serial **is** available over the native USB (USB-Serial-JTAG, `/dev/ttyACM*` on Linux) — an earlier note
here that "serial is not USB-bridged" was wrong. Two quirks made it look silent, both worth knowing:

1. **The sketch only prints at boot.** All `Serial` output is one-time `setup()` messages (WiFi IP, model
   hot-swap) plus the per-POST timing lines; there is nothing periodic in the steady-state `loop()`. A
   console attached *after* boot correctly sees nothing until the next event — that is not a dead port.
2. **Native USB re-enumerates on reset.** Unlike an external USB-bridge chip (FTDI/CP210x), the ESP32-S3's
   native USB-Serial-JTAG peripheral physically disconnects and re-enumerates when the chip resets, so a
   `cat /dev/ttyACM0` opened *before* a reset goes stale mid-capture. To catch the boot burst, trigger the
   reset first, poll for the port to reappear, *then* open a fresh reader:
   ```bash
   esptool --port /dev/ttyACM0 --after hard_reset chip_id   # or a physical RESET
   for i in $(seq 1 30); do [ -e /dev/ttyACM0 ] && break; sleep 0.2; done
   cat /dev/ttyACM0                                          # fresh FD, catches the boot messages
   ```

The dashboard remains the primary live-status channel; serial is the board-side diagnostic when you need to
see what the firmware itself is doing (WiFi join, model version, per-POST timing).

## Known gotchas (this sketch specifically)

- The RGB mux (0x70) + ISL29125s (0x44) and the OLED (0x3D, now disabled) share the **same hardware I2C bus**
  (Wire, SDA 17/SCL 18) — they coexist fine as two devices on one bus; don't move either to SW-I2C or a
  separate bus without re-verifying the other still reads.
- The board's `ts` field is **seconds-since-boot**, not wall-clock — it resets on every reboot. The dashboard
  labels spans relative to the board's own clock (tracked from the latest reading), not the browser's
  `Date.now()`. Anything that queries "recent" data should order by DB insertion order (rowid), not `ts`.
