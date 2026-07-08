// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Sargassum Training Kit Authors
// ArduCam Mega 5MP capture over the shared HSPI bus (SCK36/MISO37/MOSI35 + CS38; per the Altametry ArduCam
// integration report). The camera is SPI-only and never touches I2C, so it does not interfere with the RGB
// array / PMU. Capture the whole JPEG into a caller buffer (PSRAM) so it can be POSTed in one request.
#pragma once
#include <Arduino.h>
#include <SPI.h>
#include "Arducam_Mega.h"

#ifndef CAM_SCK
#define CAM_SCK 36
#endif
#ifndef CAM_MISO
#define CAM_MISO 37
#endif
#ifndef CAM_MOSI
#define CAM_MOSI 35
#endif
#ifndef CAM_CS
#define CAM_CS 38
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
static bool cam_begin() {
  SPI.begin(CAM_SCK, CAM_MISO, CAM_MOSI);
  pinMode(CAM_CS, OUTPUT);
  digitalWrite(CAM_CS, HIGH);
  g_cam_ok = (g_cam.begin() == CAM_ERR_SUCCESS);
  if (g_cam_ok) g_cam.setAutoFocus(0x00);   // one autofocus pass
  return g_cam_ok;
}

// Capture one JPEG at `mode` into buf (capacity cap). Returns the JPEG byte length, or 0 on failure/oversize.
// readBuff takes a uint8_t length, so read in <=255-byte chunks. (Confirm the installed Arducam_Mega
// release's readBuff/getTotalLength names; the pattern is: read chunks until getTotalLength bytes.)
static size_t cam_capture(CAM_IMAGE_MODE mode, uint8_t *buf, size_t cap) {
  if (!g_cam_ok || !buf) return 0;
  if (g_cam.takePicture(mode, CAM_IMAGE_PIX_FMT_JPG) != CAM_ERR_SUCCESS) return 0;
  uint32_t total = g_cam.getTotalLength();
  if (total == 0 || total > cap) { g_cam.lowPowerOn(); return 0; }
  size_t got = 0;
  while (got < total) {
    uint32_t left = total - got;
    uint8_t want = (left > 255) ? 255 : (uint8_t)left;
    uint8_t n = g_cam.readBuff(buf + got, want);
    if (n == 0) break;
    got += n;
  }
  g_cam.lowPowerOn();   // power the sensor down between shots
  return (got == total) ? total : 0;
}
