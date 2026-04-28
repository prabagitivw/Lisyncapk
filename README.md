# i-BMS Mobile Dashboard

**by IVW Private Limited**

A Progressive Web App (PWA) for real-time monitoring of IVW Battery Management Systems over Bluetooth Low Energy (BLE). Supports two IVW BMS communication protocols — **ESS BMS** and **Smart BMS**.

---

## Features

- 📶 **Dual-Protocol Support** — Connect to both IVW ESS BMS and IVW Smart BMS devices
- 🔋 **Real-Time Telemetry** — SOC, Voltage, Current, Cell Voltages, Temperatures
- 📊 **SVG Gauges** — Auto-scaling Voltage and bi-directional Current gauge
- 🌡️ **Multi-Sensor Temperatures** — MOSFET, Ambient, and up to 4 NTC sensors
- 🔒 **Protection & Alarm Flags** — Live bitmask decoding for all fault states
- 📱 **PWA** — Installable on Android like a native app, works offline
- 🪵 **Connection Logs** — Live diagnostic log for all BLE events

---

## Supported IVW BMS Hardware

| Mode Button | Protocol | BMS Type | Example Device |
|---|---|---|---|
| **ESS BMS** | Modbus RTU / CRC-16 | IVW ESS Battery Pack | IVW25260380007 |
| **Smart BMS** | IVW Smart BMS Protocol | IVW Smart Battery Pack | IVW22S003AL22S40A |

### Default BLE UUIDs (both protocols use the same service)
| Field | Value |
|---|---|
| Service UUID | `0xFF00` |
| TX (Write) | `0xFF02` |
| RX (Notify) | `0xFF01` |

---

## Installation (Android)

Web Bluetooth is only available in **Google Chrome** over HTTPS. Native Android APKs block this API — use a PWA instead.

### Steps:
1. Host this folder on a secure HTTPS server (e.g. GitHub Pages, local HTTPS server).
2. Open the URL in **Google Chrome** on your Android device.
3. Tap the **three-dot menu** → **"Add to Home screen"** or **"Install app"**.
4. The i-BMS icon will appear on your home screen and open in fullscreen mode.

> **Note:** Chrome on Android requires **Location permission** to scan for Bluetooth devices. This is an Android system requirement for BLE scanning.

---

## How to Use

### 1. Select BMS Protocol
Before connecting, tap the correct button at the top of the screen:
- **ESS BMS** — for IVW ESS battery packs (Modbus-based)
- **Smart BMS** — for IVW Smart battery packs

### 2. Connect
1. Ensure Bluetooth is **ON** on your phone.
2. Tap **Connect**.
3. Select your IVW BMS device from the system dialog.
4. The dashboard will begin streaming live data every **5 seconds**.

### 3. Advanced Settings
If your IVW BMS uses non-standard UUIDs:
1. Tap **Bluetooth Settings** to expand the panel.
2. Enter the correct **Service UUID**, **TX**, and **RX** characteristic UUIDs.
3. Tap **Connect**.

---

## Dashboard Panels

| Panel | Description |
|---|---|
| **SOC Gauge** | State of charge (%), remaining Ah, rated Ah, SOH, cycles |
| **Voltage Gauge** | Pack voltage, auto-scaled to cell count |
| **Current Gauge** | Bi-directional: green = charging, orange = discharging |
| **Cell Voltages** | Individual cell voltages with Max / Min / Avg summary |
| **Temperatures** | MOSFET, Ambient, and all NTC sensor readings |
| **System Status** | Battery state, Protection flags, Alarm flags, MOS status |
| **Connection Logs** | Live BLE event log with timestamps |

---

## Troubleshooting

| Problem | Solution |
|---|---|
| Device not visible | Enable Bluetooth + Location on Android |
| Connected but no data | Check logs for "Data In:" — if missing, verify UUIDs |
| CRC Error in logs | Packet collision — auto-recovers on next poll cycle |
| Old version loading | Hard refresh (Ctrl+Shift+R) or open in Incognito tab |
| "Invalid Service" error | Check UUID format: use `0xff00` not `ff00` |

---

## Project Files

| File | Purpose |
|---|---|
| `index.html` | App layout, gauges, BMS toggle, settings panel |
| `app.js` | BLE connection, protocol parsers, polling loop, UI updates |
| `styles.css` | Glassmorphism dark theme, mobile-first layout |
| `manifest.json` | PWA manifest (icon, display mode, theme color) |
| `sw.js` | Service Worker for offline caching |
| `Manual.md` | End-user installation and usage guide |

---

## Protocol Details

### ESS BMS (Modbus CRC-16)
- Command: `01 78 10 00 10 A0 00 00 [CRC-L] [CRC-H]` (10 bytes)
- Response: 250-byte frame starting with `0x01 0x78`
- Checksum: CRC-16 Modbus on first `N-2` bytes

### Smart BMS (IVW Smart Protocol)
- Commands cycle through 3 register reads per poll:
  - `0x03` — Basic Info (voltage, current, SOC, protection)
  - `0x04` — Cell Voltages
  - `0x05` — Device Name / Battery ID
- Frame: `DD A5 [CMD] 00 [CHK-H] [CHK-L] 77`
- Checksum: Two's complement sum of payload bytes

---

*IVW Private Limited — Battery Technology Division*
