// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Sargassum Training Kit Authors
#pragma once
#include <Arduino.h>
#include <Wire.h>

// HoverRgbArray — TCA9548A 8-channel I2C multiplexer fronting up to 4x ISL29125 digital RGB light
// sensors on mux channels 0..3 (the sargassum-drifter RGB array). The ISL29125's I2C address is FIXED
// at 0x44, so four identical sensors can't share a bus directly; the mux (default 0x70) isolates each
// behind a channel. Every read is two-step: select the mux channel (write 1<<ch to 0x70), then talk to
// 0x44 behind it. The mux only gates its downstream channels — devices on the main bus (PMU 0x34, RTC
// 0x51, mag 0x3C, BME 0x77) are untouched by channel selection, so the array conflicts with nothing.
//
// The bus the array is wired to (Wire @ 17/18 or Wire1 @ 42/41 on the T-Beam S3 Supreme) is discovered
// at begin(): whichever ACKs 0x70 is bound. Both buses are assumed already brought up by the board
// (display init begins Wire; the PMU/env managers begin Wire1). Hardware-verified 2026-07-03 on the
// bench drifter: mux on Wire(17/18), all four sensors on ch0-3, device-id 0x7D. The sensors sit on the
// BATTERY rail and can come up AFTER boot — reprobe() recovers them without a reset.
class HoverRgbArray {
public:
  static const uint8_t MUX_ADDR = 0x70;   // TCA9548A default address
  static const uint8_t ISL_ADDR = 0x44;   // ISL29125 fixed address (behind the mux)
  static const uint8_t N        = 4;      // sensors on mux channels 0..3

  // ISL29125 register map (Intersil datasheet): device-id reg reads 0x7D; RGB data starts at 0x09 in
  // Green/Red/Blue order, each 16-bit little-endian (low byte then high byte).
  static const uint8_t REG_DEVICE_ID = 0x00;
  static const uint8_t REG_CONFIG1   = 0x01;
  static const uint8_t REG_CONFIG2   = 0x02;
  static const uint8_t REG_CONFIG3   = 0x03;
  static const uint8_t REG_GREEN_L   = 0x09;
  static const uint8_t REG_RED_L     = 0x0B;
  static const uint8_t REG_BLUE_L    = 0x0D;
  static const uint8_t DEVICE_ID     = 0x7D;
  // CONFIG1: RGB mode (bits[2:0]=0b101), 10000-lux range (bit3=1 — no clip under tropical sun; bench
  // indoor readings ~10..3000 confirm ample headroom), 16-bit ADC (bit4=0). = 0x0D.
  static const uint8_t CONFIG1_RGB_10KLUX_16BIT = 0x0D;

  // Bind the mux (whichever bus ACKs 0x70) and init every present ISL29125. Idempotent — safe to call
  // again to re-bind/re-init (e.g. after the battery rail settles). Returns true if the mux was found.
  bool begin() {
    if (probeMux(Wire))       { _bus = &Wire;  _busname = "Wire";  }
    else if (probeMux(Wire1)) { _bus = &Wire1; _busname = "Wire1"; }
    else { _bus = nullptr; _busname = "none"; return false; }
    for (uint8_t c = 0; c < N; c++) _present[c] = initSensor(c);
    deselect();
    return true;
  }

  // Recover sensors that were absent at begin() — the array is battery-rail powered and can enumerate
  // after boot. Cheap to call periodically from the main loop: re-binds the mux if it was lost, then
  // re-inits only the currently-absent channels (a present sensor is left alone). Returns presentCount().
  uint8_t reprobe() {
    if (!_bus) { begin(); return presentCount(); }
    for (uint8_t c = 0; c < N; c++) if (!_present[c]) _present[c] = initSensor(c);
    deselect();
    return presentCount();
  }

  const char* busName() const { return _busname; }
  bool muxFound() const { return _bus != nullptr; }
  bool present(uint8_t c) const { return c < N && _present[c]; }
  uint8_t presentCount() const { uint8_t n = 0; for (uint8_t c = 0; c < N; c++) if (_present[c]) n++; return n; }
  // Bit i set = sensor i present. Travels with each reading so downstream can distinguish an absent
  // sensor from a genuinely dark reading (a covered sensor reads ~0 but IS present).
  uint8_t presentMask() const { uint8_t m = 0; for (uint8_t c = 0; c < N; c++) if (_present[c]) m |= (uint8_t)(1u << c); return m; }

  // Read one sensor's RGB (16-bit each). Returns false — leaving r/g/b untouched — if the mux is absent,
  // the channel is out of range, or the sensor was absent at init: never fabricates a reading.
  bool read(uint8_t c, uint16_t& r, uint16_t& g, uint16_t& b) {
    if (!_bus || c >= N || !_present[c]) return false;
    if (!select(c)) return false;
    g = read16(REG_GREEN_L);
    r = read16(REG_RED_L);
    b = read16(REG_BLUE_L);
    return true;
  }

private:
  TwoWire*    _bus     = nullptr;
  const char* _busname = "none";
  bool        _present[N] = { false, false, false, false };

  bool probeMux(TwoWire& w) {
    w.beginTransmission(MUX_ADDR);
    return w.endTransmission() == 0;
  }
  bool select(uint8_t c) {
    _bus->beginTransmission(MUX_ADDR);
    _bus->write((uint8_t)(1u << c));
    return _bus->endTransmission() == 0;
  }
  void deselect() {
    if (!_bus) return;
    _bus->beginTransmission(MUX_ADDR);
    _bus->write((uint8_t)0x00);
    _bus->endTransmission();
  }
  bool initSensor(uint8_t c) {
    if (!select(c)) return false;
    if (readReg(REG_DEVICE_ID) != DEVICE_ID) return false;   // no ISL29125 behind this channel
    writeReg(REG_CONFIG1, CONFIG1_RGB_10KLUX_16BIT);
    writeReg(REG_CONFIG2, 0x00);   // IR compensation off (raw baseline; downstream derives mat-state)
    writeReg(REG_CONFIG3, 0x00);   // no interrupt/threshold
    return true;
  }
  void writeReg(uint8_t reg, uint8_t val) {
    _bus->beginTransmission(ISL_ADDR);
    _bus->write(reg);
    _bus->write(val);
    _bus->endTransmission();
  }
  uint8_t readReg(uint8_t reg) {
    _bus->beginTransmission(ISL_ADDR);
    _bus->write(reg);
    if (_bus->endTransmission(false) != 0) return 0xFF;   // repeated-start read
    if (_bus->requestFrom((uint8_t)ISL_ADDR, (uint8_t)1) != 1) return 0xFF;
    return (uint8_t)_bus->read();
  }
  uint16_t read16(uint8_t reg) {
    _bus->beginTransmission(ISL_ADDR);
    _bus->write(reg);
    if (_bus->endTransmission(false) != 0) return 0;
    if (_bus->requestFrom((uint8_t)ISL_ADDR, (uint8_t)2) != 2) return 0;
    uint8_t lo = (uint8_t)_bus->read();
    uint8_t hi = (uint8_t)_bus->read();
    return (uint16_t)lo | ((uint16_t)hi << 8);   // ISL29125 is little-endian per color
  }
};
