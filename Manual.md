# i-BMS User Manual

Welcome to the i-BMS Dashboard by IVW Private Limited. This guide explains how to install and use the dashboard on your mobile device or computer.

## 1. Installation (Android / Mobile)

To provide the best Bluetooth experience, this app is built as a **Progressive Web App (PWA)**. 

Native Android APKs built using web-wrappers (like Cordova or WebView) actually **block** the Web Bluetooth API for security reasons. By using a PWA, you bypass this restriction, get full access to Chrome's native Bluetooth engine, and you can still install it like a regular app!

### How to Install:
1. Host this folder on a secure local network (using a local server like `python -m http.server`) or upload it to a secure HTTPS host (like GitHub Pages or a private server).
2. Open the URL in **Google Chrome** on your Android device.
3. Tap the **three-dot menu** in the top right corner of Chrome.
4. Select **"Install app"** or **"Add to Home screen"**.
5. The i-BMS app will now appear on your phone's home screen with the IVW logo. It will open in fullscreen mode, look exactly like a native app, and even work offline!

## 2. Using the App

### Connecting to the Battery
1. Ensure your device's Bluetooth is turned **ON**.
2. Tap the **Connect** button at the top right of the dashboard.
3. A system dialog will appear listing nearby Bluetooth devices. Select your BMS (e.g., `JBD-UP16S...`).
4. Once connected, the dashboard will immediately begin streaming live data.

### Advanced Bluetooth Settings
If you ever switch to a different brand of BMS that does not use the default JBD UUIDs:
1. Tap **Bluetooth Settings** to expand the panel.
2. Enter the new **Service UUID**, **TX Characteristic**, and **RX Characteristic**.
3. Tap **Connect**.

## 3. Dynamic Gauges
The dashboard features intelligent SVG gauges:
- **Voltage Gauge**: Automatically scales its boundaries based on the number of cells detected in the battery pack. (Min: `cells * 2.8V`, Max: `cells * 4.25V`).
- **Current Gauge**: Center-aligned gauge. Charging (Positive) draws to the right in green. Discharging (Negative) draws to the left in orange. It automatically scales based on the hardware limits configured in the BMS.
- **State of Charge (SOC)**: Changes colors dynamically: Green (>50%), Yellow (<50%), Red (<20%).

## 4. Troubleshooting
- **Cannot see device:** Ensure Bluetooth and Location services are enabled on your device (Location is required for Bluetooth scanning on Android).
- **"Invalid Service name" error:** Ensure the UUID entered in the settings panel is correct (e.g., `0xff00`).
- **No data flowing:** Check the "Connection Logs" at the bottom of the dashboard. If the CRC check is failing, ensure you are in range of the Bluetooth signal.
