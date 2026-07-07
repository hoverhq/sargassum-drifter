# Sargassum Drifter Training Kit

An in-situ, train-in-the-field kit for classifying what a floating RGB-sensor drifter is sitting in:
**open water**, **inside a sargassum mat**, or **out of the water** (on deck / being handled). A small
Random Forest runs on the drifter itself; you label real readings from a web console, train a model on the
box, and push it to the drifter over the air — a full label → train → push loop you can run on a beach.

- **Drifter firmware** (ESP32-S3): reads four RGB sensors, computes features, runs the on-board model,
  smooths the verdict, and streams timestamped readings + detections to the cloud over WiFi.
- **Cloud console** (FastAPI + a no-build React page): shows the live board state, lets you label spans of
  readings, trains a Random Forest on the box (CPU), and serves the model back to the drifter.
- **Shared feature + model code** compiled into BOTH the firmware and the trainer, so the model trains on
  bit-identical features to what the drifter computes on-board.

The classifier is multiclass: `open-water` (0) / `in-mat` (1) / `out-of-water` (2). Training with only two
of the classes works fine — the third is added the moment you label some out-of-water spans.

## Layout

```
cloud/                 FastAPI app + model train/serve + the web console
  app.py               API + dashboard server
  model_serialize.py   Random Forest <-> compact on-board artifact (the board<->trainer contract)
  train.py             one-click train pipeline (features -> separability gate -> RF)
  features.py          Python front-end to the shared C feature transform (via cffi)
  synthetic.py         physics-generated RGB for the test bench
  store.py             local SQLite store
  static/drifter/      the React console (loaded via Babel-in-browser, no build step)
  test_*.py            the test suite (pytest)
firmware/
  sargassum_wifi/main.cpp   the drifter sketch
  shared/                   the 3 shared units (RGB array driver, feature transform, model evaluator)
  boards/                   the LilyGo T-Beam Supreme board definition
  platformio.ini           standalone PlatformIO project
  FIELD-RUNBOOK.md          field-deployment checklist
```

## Cloud: run it

Requires Python 3.9+ and a C compiler (the feature transform is compiled from the shared C via cffi).

```bash
cd cloud
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python sarg_features_build.py          # compile the shared feature transform (_sarg_cffi)
SARG_TOKEN=pick-a-token uvicorn app:app --host 0.0.0.0 --port 8000
```

`SARG_TOKEN` is required — the server refuses to start without it (there is no default). Open
`http://localhost:8000/` — the page bakes the token in, so the naked URL works. Run the tests with `pytest`.

## Firmware: build + flash

Requires [PlatformIO](https://platformio.org/). Target board: **LilyGo T-Beam Supreme** (ESP32-S3, 8MB
flash / 8MB PSRAM) — the board definition ships in `firmware/boards/`.

```bash
cd firmware
pio run                                # build (uses the placeholder config)
```

Supply your WiFi + server config at build time (never commit real values), then flash:

```bash
PLATFORMIO_BUILD_FLAGS="-DWIFI_SSID='\"myssid\"' -DWIFI_PASS='\"mypass\"' \
  -DSARG_URL='\"https://your-server.example\"' -DSARG_TOKEN='\"your-token\"' -DSARG_DRIFTER='\"drifter1\"'" \
  pio run -t upload
```

This repo is **source-only** — it ships no prebuilt binaries. See [SECURITY.md](SECURITY.md) for why, and
for the disposable-rig shortcuts you should not copy into production. Field-deployment steps are in
[firmware/FIELD-RUNBOOK.md](firmware/FIELD-RUNBOOK.md).

## The train loop

1. Put the drifter in a known condition (in a mat / in clear water / out of the water) and **label** a span
   of readings in the console.
2. Repeat across conditions and lighting. **Train** — the console shows validation accuracy and flags a thin
   or lopsided dataset before it hits the board.
3. **Push** a model to the drifter. It pulls the new model over the air (poll-if-newer) and hot-swaps it.
4. Watch the live board verdict — that field test is the real ground truth. Every trained model is kept, so
   you can fall back to an earlier one if a new one disappoints.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Each source file carries an SPDX header.

Third-party dependencies are permissively licensed (React MIT, FastAPI MIT, scikit-learn BSD-3, SQLite
public domain, ESP-IDF Apache-2.0). The Arduino-ESP32 core the firmware links is LGPL-2.1, which is why this
kit is distributed as source only — build the firmware yourself rather than redistributing a binary.
