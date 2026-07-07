// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Sargassum Training Kit Authors
// Sargassum in-situ WiFi-direct firmware. Wires the already-verified pieces: HoverRgbArray (4x ISL29125) ->
// hover_sarg_features (shared C, identical to the cloud trainer) -> hover_sarg_model (SGF3 RF, matches the
// cloud eval_forest exactly: 3-class open-water/in-mat/out-of-water, argmax) -> N-consecutive smoothing
// (mirrors cloud/sargassum/smoothing.py, class-agnostic). Streams
// timestamped readings to the disposable cloud over WiFi (burst-then-idle, buffered across drops), OTA-pulls
// the model (GET /model, ETag poll-if-newer) and HOT-SWAPS it via a double-buffer pointer flip, and POSTs
// smoothed detections. Bench close-gate (pull model + infer on simulated RGB)
// is board-gated. Config via -D: WIFI_SSID/WIFI_PASS, SARG_URL (base), SARG_TOKEN, SARG_DRIFTER.
#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <XPowersLib.h>   // AXP2101 PMU — powers the peripheral/sensor rails on the T-Beam Supreme
#include <Adafruit_GFX.h>
#include <Adafruit_SH110X.h>   // on-board SH1106 128x64 OLED (hardware Wire, shared with the RGB mux — see below)

#include "HoverRgbArray.h"
#include "hover_sarg_features.h"
#include "hover_sarg_model.h"

#ifndef WIFI_SSID
#define WIFI_SSID "REPLACE_SSID"
#endif
#ifndef WIFI_PASS
#define WIFI_PASS "REPLACE_PASS"
#endif
#ifndef SARG_URL
#define SARG_URL "https://REPLACE_IP"   // disposable EC2: https://<raw-public-IP>, self-signed (board setInsecures, no domain)
#endif
#ifndef SARG_TOKEN
#define SARG_TOKEN "CHANGE_ME"
#endif
#ifndef SARG_DRIFTER
#define SARG_DRIFTER "drifter1"
#endif
// LED indicators (re-spec'd for the BLUE+WHITE board -- supersedes the earlier red/white
// design). BLUE = smoothed model verdict (reuses the same N-consecutive state that drives /detections, so
// it never strobes at the mat edge; off if no model is loaded). WHITE = status, three PRECEDENCE-ordered
// patterns: fast blink = no network, slow blink = a model just uploaded (~10s window), heartbeat (PWM
// fade) = normal operation. Both ACTIVE-HIGH and forced OFF at boot (IO45/46 are S3 strapping pins — never
// drive them high at boot). PIN MAPPING ASSUMED, NOT YET BENCH-CONFIRMED: this board's blue/white LEDs are
// presumed wired to the same IO45/IO46 positions as the earlier red/white bring-up (same solder job, LEDs
// swapped) -- confirm on the bench (a per-pin blink-identify test is the fast way) before trusting this.
// Fall back to -D PIN_LED_BLUE=43 / PIN_LED_WHITE=44 (UART0, loses serial) if the bench finds IO45/46
// occupied.
#ifndef PIN_LED_BLUE
#define PIN_LED_BLUE 45
#endif
#ifndef PIN_LED_WHITE
#define PIN_LED_WHITE 46
#endif
#define WHITE_LEDC_CHANNEL   0       // any free LEDC channel (0-15); ESP32-S3's GPIO matrix routes any
                                     // output-capable pin to it, so PWM works on a strapping pin same as
                                     // hardware GPIO once past boot -- IO45/46 are not restricted.
#define WHITE_LEDC_FREQ_HZ   1000    // carrier frequency for the heartbeat fade (well above flicker-fusion)
#define WHITE_LEDC_RES_BITS  8       // 0-255 duty range
#define WHITE_FAST_MS        100    // no-network: ~5Hz (100ms on/100ms off = 200ms period)
#define WHITE_SLOW_MS        500    // just-uploaded: ~1Hz (500ms on/500ms off)
#define WHITE_JUST_UPLOADED_MS 10000 // how long the slow-blink window lasts after a NEW model loads
#define WHITE_HEARTBEAT_MS   2500   // heartbeat fade period (one full dim->bright->dim cycle)

// T-Beam Supreme pins (verified): board I2C bus (RGB mux + OLED + BME) on 17/18; PMU/RTC on Wire1 42/41.
#define PIN_SDA 17
#define PIN_SCL 18
#define PIN_SDA1 42
#define PIN_SCL1 41
#define SMOOTH_N 5           // N-consecutive agree to change state (mirrors the cloud Smoother default)
#define SAMPLE_MS 250        // ~4 Hz sampling
#define POST_MS 1000         // burst-POST cadence (cosmetic only -- no science impact; lower = the
                             // dashboard shows a flipped verdict sooner after the on-board smoother
                             // decides, at the cost of more frequent WiFi transmissions/battery draw)
#define MODEL_POLL_MS 8000   // OTA model-poll cadence (short for the live-iterate feel, per PM)
#define RING_N 128           // reading ring buffer depth (survives a WiFi drop)
#define MODEL_MAX 16384      // max SGF3 blob bytes (double-buffered). 3-class leaves carry 3 floats each
                             // (vs 1 for binary), so the blob grows; 16 KB leaves generous headroom over a
                             // real field model (the 3-class synthetic trains to ~1 KB, a noisier golden ~4 KB).

static XPowersAXP2101 pmu;   // T-Beam Supreme PMU (concrete class, as TBeamBoard uses)
static HoverRgbArray g_rgb;
static sarg_state g_feat;

// Double-buffered model: inference reads g_active; a new OTA pull parses into the idle buffer then flips.
static uint8_t g_model_buf[2][MODEL_MAX];
static sarg_model g_model[2];
static volatile sarg_model *g_active = nullptr;
static uint8_t g_idle = 0;
static int g_model_version = -1;   // ETag last pulled
static uint32_t g_just_uploaded_until_ms = 0;   // WHITE slow-blink window; set on a real hot-swap (not a 304)

// N-consecutive smoother (mirrors cloud/sargassum/smoothing.py Smoother).
static int sm_state = 0, sm_cand = 0, sm_count = 0;
static int smooth(int raw) {
  if (raw == sm_state) { sm_count = 0; sm_cand = sm_state; }
  else if (raw == sm_cand) { if (++sm_count >= SMOOTH_N) { sm_state = raw; sm_count = 0; } }
  else { sm_cand = raw; sm_count = 1; }
  return sm_state;
}

// A buffered reading: raw RGB + timestamp (+ we compute features/detection at sample time).
struct Reading { uint32_t ts; uint16_t rgb[4][3]; uint8_t mask; int state; float proba; uint8_t sat; float feat[SARG_N_FEATURES]; };
static Reading g_ring[RING_N];
static volatile int g_ring_head = 0, g_ring_count = 0;
static Reading g_last;            // latest sample, for the periodic detection POST
static bool g_have_last = false;

static void ring_push(const Reading &r) {
  g_ring[g_ring_head] = r;
  g_ring_head = (g_ring_head + 1) % RING_N;
  if (g_ring_count < RING_N) g_ring_count++;
}

// OLED status (SH1106 128x64 @ 0x3D). The OLED and the RGB mux (0x70) + ISL29125s (0x44) share the SAME
// hardware I2C bus (Wire, SDA 17 / SCL 18) and coexist fine as two devices on it — Adafruit's begin() calls
// Wire.begin() with no args, but that is a no-op once the bus is up on current ESP32 cores, so it does NOT
// disturb the mux (verified against the ESP32 core + confirmed live). Use the HARDWARE-Wire OLED driver, NOT
// SW-I2C: SW-I2C bit-bangs the pins as GPIO and would fight the mux (SW-I2C is only safe when the mux sits
// on its own separate bus). RGB reading 0/4 is a BATTERY-rail symptom (dead/absent battery), not a bus
// bug. The OLED is the operator's ONLY live channel here (LEDs unpopulated, Serial not USB-bridged); rendered
// from the loop, so it also shows WiFi coming up.
static Adafruit_SH1106G g_oled(128, 64, &Wire, -1);
static bool g_oled_ok = false;
static int  g_last_post_code = 0;   // last POST /readings HTTP code, surfaced on the status screen

// ONE persistent TLS client, shared by flushReadings/postDetection/pollModel (all hit the same host).
// HTTPClient's own keep-alive logic (HTTP/1.1 + no "Connection: close") reuses an already-connected
// client automatically -- the cost was never the per-call `HTTPClient http;` (cheap, stack-local, fine to
// keep fresh each call), it was re-doing the TLS HANDSHAKE from scratch on a fresh WiFiClientSecure every
// time. Reusing this one object lets the second+ request in a burst skip the handshake entirely.
static WiFiClientSecure g_tls;

// WHITE status LED: three precedence-ordered patterns, all driven through the SAME LEDC channel (never
// digitalWrite this pin once LEDC owns it -- the peripheral drives the GPIO directly, and mixing the two
// APIs on one pin fights the hardware). fast blink (no net) > slow blink (model just loaded) > heartbeat
// fade (normal). Network-up-but-no-model-yet still reads as heartbeat ("board alive, ready") rather than a
// 4th distinct pattern -- a brief, self-resolving startup window doesn't warrant its own alarm state.
static void updateWhiteLed(uint32_t now) {
  uint32_t duty;
  if (WiFi.status() != WL_CONNECTED) {
    duty = (now % (2 * WHITE_FAST_MS) < WHITE_FAST_MS) ? 255 : 0;                 // fast blink: no network
  } else if (now < g_just_uploaded_until_ms) {
    duty = (now % (2 * WHITE_SLOW_MS) < WHITE_SLOW_MS) ? 255 : 0;                 // slow blink: just uploaded
  } else {
    float phase = (float)(now % WHITE_HEARTBEAT_MS) / (float)WHITE_HEARTBEAT_MS;  // 0..1 triangle fade
    float tri = phase < 0.5f ? (phase * 2.0f) : (2.0f - phase * 2.0f);
    duty = (uint32_t)(tri * 255.0f);
  }
  ledcWrite(WHITE_LEDC_CHANNEL, duty);
}

static void oledStatus(const char *wifiNote) {
  if (!g_oled_ok) return;
  g_oled.clearDisplay();
  g_oled.setTextSize(1);
  g_oled.setTextColor(SH110X_WHITE);
  g_oled.setCursor(0, 0);
  g_oled.println("Sargassum drifter");
  if (WiFi.status() == WL_CONNECTED) { g_oled.print("WiFi "); g_oled.println(WiFi.localIP().toString()); }
  else { g_oled.print("WiFi "); g_oled.println(wifiNote ? wifiNote : "down"); }
  g_oled.print("Model ");
  if (g_active && g_model_version >= 0) { g_oled.print('v'); g_oled.println(g_model_version); } else g_oled.println("none");
  g_oled.print("State "); g_oled.println(sm_state == 1 ? "IN-MAT" : sm_state == 2 ? "OUT OF WATER" : "open water");
  g_oled.print("Conf "); g_oled.print(g_have_last ? g_last.proba : 0.0f, 2);
  if (g_have_last && g_last.sat) g_oled.print(" SAT");
  g_oled.println();
  g_oled.print("RGB "); g_oled.print(g_rgb.presentCount()); g_oled.print("/4 buf "); g_oled.println(g_ring_count);
  g_oled.print("POST "); g_oled.println(g_last_post_code);
  g_oled.display();
}

// SECURITY POSTURE (disposable beach rig — see the operator's no-prod-hardening
// guardrail). TLS defaults to setInsecure(): the board does NOT validate the server cert. Accepted
// trade-off for a THROWAWAY rig on a controlled hotspot with a THROWAWAY bearer token, torn down after the
// test. Risks + why accepted:
//   - A MITM could capture the bearer or serve a wrong model. Bounded by: a controlled hotspot, a throwaway
//     token, and the model being DATA parsed by a bounds-checked SGF3 parser (sarg_model_parse rejects a
//     malformed/short blob -> a hostile pull can misclassify but CANNOT inject code or brick inference).
//   - WIFI_PASS / SARG_TOKEN are build-time -D (baked into the image, as embedded WiFi requires). The
//     COMMITTED values are PLACEHOLDERS (REPLACE_PASS / a throwaway token) — never real secrets; real creds
//     are injected at build time.
// HARDENING PATH (if this ever graduates off the disposable rig): define -D SARG_CA_PEM='"<root PEM>"' to
// validate the cert, and inject creds at provision time instead of baking them.
static void configureTls(WiFiClientSecure &tls) {
#ifdef SARG_CA_PEM
  tls.setCACert(SARG_CA_PEM);   // hardened: validate the server certificate
#else
  tls.setInsecure();            // disposable rig: skip cert validation (documented accepted risk above)
#endif
}

static bool wifiConnect(uint32_t timeout_ms) {
  if (WiFi.status() == WL_CONNECTED) return true;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < timeout_ms) delay(150);
  return WiFi.status() == WL_CONNECTED;
}

// Build one JSON reading object into `out`. (Small hand-rolled JSON — no allocator churn.)
static void reading_json(const Reading &r, String &out) {
  out = "{\"drifter\":\"" SARG_DRIFTER "\",\"ts\":";
  out += r.ts;
  out += ",\"rgb\":[";
  for (int s = 0; s < 4; s++) {
    out += (s ? ",[" : "[");
    out += r.rgb[s][0]; out += ","; out += r.rgb[s][1]; out += ","; out += r.rgb[s][2]; out += "]";
  }
  out += "]}";
}

// Flush the reading ring to POST /readings (batch) + POST /detections for each. Called when connected.
static void flushReadings() {
  if (!g_ring_count) return;
  uint32_t t0 = millis();
  int n = g_ring_count;
  String batch = "[";
  for (int i = 0; i < g_ring_count; i++) {
    int idx = (g_ring_head - g_ring_count + i + RING_N) % RING_N;
    String j; reading_json(g_ring[idx], j);
    batch += (i ? "," : "") + j;
  }
  batch += "]";
  uint32_t t_build = millis();
  HTTPClient http;
  http.begin(g_tls, SARG_URL "/readings");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", "Bearer " SARG_TOKEN);
  int code = http.POST(batch);
  uint32_t t_post = millis();
  http.end();
  Serial.printf("[sarg] POST /readings n=%d build=%ums post=%ums code=%d\n", n, t_build - t0, t_post - t_build, code);
  g_last_post_code = code;              // surfaced on the OLED status screen
  if (code == 200) g_ring_count = 0;    // only clear on confirmed delivery (else keep buffering)
}

// Post the latest smoothed detection (+ features + saturation) for the dashboard readout.
static void postDetection(const Reading &r) {
  uint32_t t0 = millis();
  String body = "{\"drifter\":\"" SARG_DRIFTER "\",\"ts\":";
  body += r.ts; body += ",\"state\":"; body += r.state; body += ",\"proba\":"; body += String(r.proba, 3);
  body += ",\"saturated\":"; body += (r.sat ? "true" : "false"); body += ",\"features\":[";
  for (int i = 0; i < SARG_N_FEATURES; i++) { body += (i ? "," : ""); body += String(r.feat[i], 5); }
  body += "]}";
  HTTPClient http;
  http.begin(g_tls, SARG_URL "/detections");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", "Bearer " SARG_TOKEN);
  int code = http.POST(body);
  uint32_t t1 = millis();
  http.end();
  Serial.printf("[sarg] POST /detections took=%ums code=%d\n", t1 - t0, code);
}

// OTA model-pull: GET /model with If-None-Match=version. 304 => unchanged. 200 => parse into the IDLE
// buffer, then flip g_active (hot-swap; inference never reads a half-written model).
static void pollModel() {
  HTTPClient http;
  http.begin(g_tls, SARG_URL "/model?drifter=" SARG_DRIFTER);
  http.addHeader("Authorization", "Bearer " SARG_TOKEN);
  if (g_model_version >= 0) http.addHeader("If-None-Match", String(g_model_version));
  const char *hdrs[] = {"ETag"};
  http.collectHeaders(hdrs, 1);
  int code = http.GET();
  if (code == 200) {
    int len = http.getSize();
    if (len > 0 && len <= MODEL_MAX) {
      WiFiClient *stream = http.getStreamPtr();
      int got = stream->readBytes(g_model_buf[g_idle], len);
      if (got == len && sarg_model_parse(&g_model[g_idle], g_model_buf[g_idle], len)) {
        g_active = &g_model[g_idle];      // atomic pointer flip = hot-swap
        g_idle ^= 1;
        g_model_version = http.header("ETag").toInt();
        g_just_uploaded_until_ms = millis() + WHITE_JUST_UPLOADED_MS;  // WHITE slow-blinks for a bit
        Serial.printf("[sarg] hot-swapped model v%d (%d bytes, %u trees, %u classes)\n",
                      g_model_version, len, (unsigned)g_model[g_idle ^ 1].n_roots,
                      (unsigned)g_model[g_idle ^ 1].n_classes);
      }
    }
  }
  http.end();
}

static void pmuInit() {
  Wire1.begin(PIN_SDA1, PIN_SCL1);
  if (pmu.begin(Wire1, AXP2101_SLAVE_ADDRESS, PIN_SDA1, PIN_SCL1)) {
    // enable the peripheral rails the sensors/OLED sit on (T-Beam Supreme defaults; bench-verify tunes)
    pmu.setALDO2Voltage(3300); pmu.enableALDO2();
    pmu.setALDO3Voltage(3300); pmu.enableALDO3();
    pmu.setDLDO1Voltage(3300); pmu.enableDLDO1();
    pmu.setChargingLedMode(XPOWERS_CHG_LED_OFF);   // kill the PMU charge LED — its light leaks into the RGB sensors
    Serial.println("[sarg] PMU up (charge LED off)");
  } else {
    Serial.println("[sarg] PMU not found (RGB may be dark without the battery rail)");
  }
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.println("\n[sarg] sargassum WiFi-direct firmware");
  // LEDs off at boot BEFORE anything else (strapping pins latched at reset; we only ever drive them low
  // now, high later) — active-high, so LOW = off. WHITE is then handed to the LEDC peripheral for PWM
  // (heartbeat fade); attach it only AFTER the plain-digital off-state is asserted, so there is no boot
  // glitch where LEDC's own init could drive it high momentarily.
  pinMode(PIN_LED_BLUE, OUTPUT);  digitalWrite(PIN_LED_BLUE, LOW);
  pinMode(PIN_LED_WHITE, OUTPUT); digitalWrite(PIN_LED_WHITE, LOW);
  ledcSetup(WHITE_LEDC_CHANNEL, WHITE_LEDC_FREQ_HZ, WHITE_LEDC_RES_BITS);
  ledcAttachPin(PIN_LED_WHITE, WHITE_LEDC_CHANNEL);
  ledcWrite(WHITE_LEDC_CHANNEL, 0);   // still off
  pmuInit();
  Wire.begin(PIN_SDA, PIN_SCL);
  bool ob = g_oled.begin(0x3D, true);   // SH1106 @ 0x3D on hardware Wire (shared with the RGB mux)
  Wire.begin(PIN_SDA, PIN_SCL);         // re-assert 17/18 (Adafruit begin() calls Wire.begin() no-args)
  // OLED OFF: its lit pixels emit light into the ISL29125 RGB array and contaminate the measurement. Blank
  // the panel (all pixels off = no emission) and leave g_oled_ok=false so the status renderer never lights it.
  g_oled.clearDisplay(); g_oled.oled_command(SH110X_DISPLAYOFF); g_oled.display();
  g_oled_ok = false;
  Serial.printf("[sarg] OLED begin=%d; blanked+off (kept dark so it doesn't contaminate the RGB read)\n", ob);
  configureTls(g_tls);   // once -- flushReadings/postDetection/pollModel all reuse this one client
  sarg_reset(&g_feat);
  if (g_rgb.begin()) Serial.printf("[sarg] RGB array on %s, %u/4 present\n", g_rgb.busName(), g_rgb.presentCount());
  else Serial.println("[sarg] RGB array not found");
  Serial.printf("[sarg] joining WiFi '%s'\n", WIFI_SSID);
  oledStatus("joining");
  if (wifiConnect(20000)) { Serial.printf("[sarg] WiFi ip=%s\n", WiFi.localIP().toString().c_str()); pollModel(); }
  oledStatus(nullptr);
}

void loop() {
  static uint32_t last_sample = 0, last_post = 0, last_poll = 0, last_oled = 0;
  uint32_t now = millis();

  updateWhiteLed(now);   // status: fast blink (no net) > slow blink (model just loaded) > heartbeat

  if (now - last_sample >= SAMPLE_MS) {
    last_sample = now;
    if (g_rgb.presentCount() < HoverRgbArray::N) g_rgb.reprobe();   // battery-settle / hot-plug recovery
    Reading r; r.ts = now / 1000; r.mask = g_rgb.presentMask();
    for (uint8_t c = 0; c < HoverRgbArray::N; c++) {
      uint16_t rr = 0, gg = 0, bb = 0; g_rgb.read(c, rr, gg, bb);
      r.rgb[c][0] = rr; r.rgb[c][1] = gg; r.rgb[c][2] = bb;
    }
    r.sat = sarg_update(&g_feat, r.rgb, r.feat);   // shared streaming features (== the cloud trainer)
    r.proba = 0.0f; r.state = sm_state;
    if (g_active && !r.sat) {                        // infer only on a loaded model + a clean sample
      const sarg_model *m = (const sarg_model *)g_active;
      float pc[SARG_MODEL_MAX_CLASSES];
      sarg_model_proba(m, r.feat, pc);               // per-class probabilities (open-water/in-mat/out-of-water)
      int raw = 0;                                   // argmax over the present classes (ties -> lowest index)
      for (uint16_t c = 1; c < m->n_classes; c++) if (pc[c] > pc[raw]) raw = (int)c;
      r.state = smooth(raw);                          // smoother is class-agnostic; sm_state now 0..n_classes-1
      r.proba = pc[r.state];                          // confidence of the REPORTED (smoothed) class
    }
    ring_push(r);
    g_last = r; g_have_last = true;
    // BLUE = the smoothed IN-MAT verdict only (state 1), so it reads the same whether the model is 2- or
    // 3-class. Off for open-water AND out-of-water. The full 3-state BLUE (solid in-mat / pulse out-of-water
    // / off open-water) rides the LEDC rework once the binary LED is bench-confirmed.
    digitalWrite(PIN_LED_BLUE, (g_active && sm_state == 1) ? HIGH : LOW);
  }

  if (now - last_oled >= 500) { last_oled = now; oledStatus(nullptr); }  // operator's live status channel

  if (WiFi.status() != WL_CONNECTED) { wifiConnect(8000); return; }  // buffer while down; reconnect

  if (now - last_post >= POST_MS) { last_post = now; flushReadings(); if (g_have_last) postDetection(g_last); }
  if (now - last_poll >= MODEL_POLL_MS) { last_poll = now; pollModel(); }
}
