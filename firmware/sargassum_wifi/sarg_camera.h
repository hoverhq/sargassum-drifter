// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Sargassum Training Kit Authors
// ArduCam Mega 5MP capture over its own SPI wiring on the expansion-header GPIOs (SCK38/MISO2/MOSI39/CS48,
// bench-verified by a sensor-ID pin scan: id=0x81). The camera is SPI-only and never touches I2C, so it does
// not interfere with the RGB array / PMU. Capture the whole JPEG into a caller buffer (PSRAM) for one POST.
#pragma once
#include <Arduino.h>
#include <SPI.h>
#include "Arducam_Mega.h"

#ifndef CAM_SCK
#define CAM_SCK 38
#endif
#ifndef CAM_MISO
#define CAM_MISO 2
#endif
#ifndef CAM_MOSI
#define CAM_MOSI 39
#endif
#ifndef CAM_CS
#define CAM_CS 48
#endif

static Arducam_Mega g_cam(CAM_CS);
static bool g_cam_ok = false;

// Resolution name -> Arducam enum. Unknown -> UXGA (1600x1200).
static CAM_IMAGE_MODE cam_mode_from_name(const char *r) {
  if (!strcmp(r, "QVGA")) return CAM_IMAGE_MODE_QVGA;
  if (!strcmp(r, "VGA"))  return CAM_IMAGE_MODE_VGA;
  if (!strcmp(r, "HD"))   return CAM_IMAGE_MODE_HD;
  if (!strcmp(r, "FHD"))  return CAM_IMAGE_MODE_FHD;
  if (!strcmp(r, "5MP") || !strcmp(r, "WQXGA2")) return CAM_IMAGE_MODE_WQXGA2;
  return CAM_IMAGE_MODE_UXGA;
}

// Bring up the shared HSPI bus on the camera pins BEFORE the lib's begin() (so begin() doesn't grab the
// wrong pins), then init the sensor. Returns true if the Arducam reports a live sensor.
// Raw sensor-ID probe (replicates the lib's cameraBusRead: CS low, send reg, two dummy reads, CS high).
// The lib's begin() spins FOREVER (cameraWaitI2cIdle has no timeout) if the sensor doesn't respond, which
// wedges the whole board -- so we must confirm a live sensor BEFORE calling begin(). 0x00/0xFF = no camera.
static bool cam_probe() {
  SPI.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE0));
  digitalWrite(CAM_CS, LOW);
  SPI.transfer(0x40 & 0x7F);   // CAM_REG_SENSOR_ID, read
  SPI.transfer(0x00);
  uint8_t id = SPI.transfer(0x00);
  digitalWrite(CAM_CS, HIGH);
  SPI.endTransaction();
  return (id != 0x00 && id != 0xFF);
}

// Diagnostic: soft-SPI (bit-banged, mode 0) sensor-ID read on an arbitrary pin assignment. Mirrors the
// lib's cameraBusRead: send the reg, clock two dummy bytes, take the LAST byte. Returns the ID.
static uint8_t cam_soft_probe(int sck, int miso, int mosi, int cs) {
  pinMode(sck, OUTPUT); pinMode(mosi, OUTPUT); pinMode(cs, OUTPUT); pinMode(miso, INPUT);
  digitalWrite(sck, LOW); digitalWrite(cs, HIGH); delayMicroseconds(4);
  digitalWrite(cs, LOW); delayMicroseconds(4);
  const uint8_t out[3] = {0x40, 0x00, 0x00};   // CAM_REG_SENSOR_ID read + 2 dummies
  uint8_t in = 0;
  for (int b = 0; b < 3; b++) {
    uint8_t r = 0;
    for (int i = 7; i >= 0; i--) {
      digitalWrite(mosi, (out[b] >> i) & 1);
      delayMicroseconds(2);
      digitalWrite(sck, HIGH);
      delayMicroseconds(2);
      r = (uint8_t)((r << 1) | digitalRead(miso));
      digitalWrite(sck, LOW);
    }
    if (b == 2) in = r;
  }
  digitalWrite(cs, HIGH);
  pinMode(sck, INPUT); pinMode(mosi, INPUT); pinMode(cs, INPUT);   // release the pins
  return in;
}

// Brute-force the camera's 4 SPI pins over the free expansion-header GPIOs (IO45/46 excluded -- they carry
// the BLUE/WHITE LEDs). 7P4 = 840 soft-SPI probes, <1s. Prints every assignment where a sensor answers.
static void cam_scan_pins() {
  static const int P[] = {39, 38, 2, 3, 6, 21, 48};
  const int N = 7;
  int hits = 0;
  for (int a = 0; a < N; a++)
    for (int b = 0; b < N; b++)
      for (int c = 0; c < N; c++)
        for (int d = 0; d < N; d++) {
          if (a == b || a == c || a == d || b == c || b == d || c == d) continue;
          uint8_t id = cam_soft_probe(P[a], P[b], P[c], P[d]);
          if (id != 0x00 && id != 0xFF) {
            Serial.printf("[cam] HIT sck=%d miso=%d mosi=%d cs=%d id=0x%02X\n", P[a], P[b], P[c], P[d], id);
            hits++;
          }
        }
  Serial.printf("[cam] pin scan done (%d hits)\n", hits);
}

// Diagnostic: read the sensor-ID on candidate CS pins (data stays on 36/37/35). A live camera returns a
// plausible ID (e.g. 0x81); 0x00/0xFF = no response. Finds the CS pin if it differs from 38.
static void cam_scan_cs() {
  SPI.end();
  SPI.begin(CAM_SCK, CAM_MISO, CAM_MOSI);
  // Bus sanity: the on-board QMI8658 IMU is on this same HSPI (CS 34). Its WHO_AM_I (reg 0x00, read bit7) is
  // 0x05. If we can read it, the data pins 36/37/35 + SPI are proven good and the camera fault is its own.
  pinMode(34, OUTPUT); digitalWrite(34, HIGH);
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  digitalWrite(34, LOW);
  SPI.transfer(0x00 | 0x80);
  uint8_t who = SPI.transfer(0x00);
  digitalWrite(34, HIGH);
  SPI.endTransaction();
  Serial.printf("[cam] IMU(CS34) WHO_AM_I=0x%02X (0x05 => data pins 36/37/35 OK => camera-only fault)\n", who);
  static const int cands[] = {1, 2, 4, 5, 6, 7, 8, 9, 14, 15, 16, 21, 38, 39, 40, 43, 44, 48};
  for (unsigned i = 0; i < sizeof(cands) / sizeof(cands[0]); i++) {
    int cs = cands[i];
    pinMode(cs, OUTPUT);
    digitalWrite(cs, HIGH);
    SPI.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE0));
    digitalWrite(cs, LOW);
    SPI.transfer(0x40 & 0x7F);
    SPI.transfer(0x00);
    uint8_t id = SPI.transfer(0x00);
    digitalWrite(cs, HIGH);
    SPI.endTransaction();
    Serial.printf("[cam] scan CS=%d id=0x%02X%s\n", cs, id, (id != 0x00 && id != 0xFF) ? "  <-- RESPONDS" : "");
  }
}

static bool cam_begin() {
  // The ArduCam lib drives the GLOBAL SPI bus and ESP32's begin() guard blocks a re-init on custom pins, so
  // if the framework already began SPI on its default pins, the lib's begin() can hang. end() first, then
  // begin() on OUR pins, forces the bus onto 36/37/35 before the lib touches it.
  SPI.end();
  SPI.begin(CAM_SCK, CAM_MISO, CAM_MOSI);
  pinMode(CAM_CS, OUTPUT);
  digitalWrite(CAM_CS, HIGH);
  g_cam_ok = false;
  if (!cam_probe()) return false;             // no live sensor -> DON'T call the (no-timeout, wedging) begin()
  g_cam_ok = (g_cam.begin() == CAM_ERR_SUCCESS);
  if (g_cam_ok) g_cam.setAutoFocus(0x00);     // one autofocus pass
  return g_cam_ok;
}

// Capture one JPEG at `mode` into buf (capacity cap). Returns the JPEG byte length, or 0 on failure/oversize.
// readBuff takes a uint8_t length, so read in <=255-byte chunks. (Confirm the installed Arducam_Mega
// release's readBuff/getTotalLength names; the pattern is: read chunks until getTotalLength bytes.)
static size_t cam_capture(CAM_IMAGE_MODE mode, uint8_t *buf, size_t cap) {
  if (!g_cam_ok || !buf) return 0;
  // Wake the sensor FIRST: with the lib's lowPowerMode flag set (as lowPowerOn leaves it, and begin() never
  // clears it), the capture-done wait inside takePicture bails out immediately and the FIFO length reads 0.
  g_cam.lowPowerOff();
  delay(60);
  uint32_t total = 0;
  for (int attempt = 0; attempt < 2 && total == 0; attempt++) {   // first shot after wake can be empty; retry once
    CamStatus st = g_cam.takePicture(mode, CAM_IMAGE_PIX_FMT_JPG);
    total = g_cam.getTotalLength();
    Serial.printf("[cam] takePicture st=%d total=%u (attempt %d)\n", (int)st, total, attempt + 1);
    if (st != CAM_ERR_SUCCESS) total = 0;
  }
  if (total == 0 || total > cap) { g_cam.lowPowerOn(); return 0; }
  size_t got = 0;
  while (got < total) {
    uint32_t left = total - got;
    uint8_t want = (left > 255) ? 255 : (uint8_t)left;
    uint8_t n = g_cam.readBuff(buf + got, want);
    if (n == 0) break;
    got += n;
  }
  g_cam.lowPowerOn();   // power the sensor down between shots (cam_capture wakes it on the next shot)
  if (got != total) Serial.printf("[cam] short read %u/%u\n", (unsigned)got, (unsigned)total);
  return (got == total) ? total : 0;
}
