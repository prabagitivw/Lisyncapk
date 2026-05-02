// app.js (Version 2.2.0 - Cell Count Fix + Clean Disconnect)

// UI Elements
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const dashboard = document.getElementById('dashboard');
const logsDiv = document.getElementById('logs');
const clearLogsBtn = document.getElementById('clearLogsBtn');
const connStatus = document.getElementById('val-connection');
const btnModeEss = document.getElementById('btn-mode-ess');
const btnModeEv = document.getElementById('btn-mode-ev');

// UUID inputs
const serviceUuidInput = document.getElementById('serviceUuid');
const txUuidInput = document.getElementById('txUuid');
const rxUuidInput = document.getElementById('rxUuid');

// Bluetooth State
let bleDevice = null;
let bleServer = null;
let txCharacteristic = null;
let rxCharacteristic = null;
let pollInterval = null;

// Protocol State
let activePollingMode = 'ess'; // 'ess' or 'ev'
let jbdStep = 0; 
// jbdData holds accumulated JBD state across the 3-step poll cycle
let jbdData = { cell_voltages_V: [], temperature_C: [], battery_id: "", cell_count: 0, SOH_percent: '--' };

// Buffer for incoming data chunks
let receiveBuffer = new Uint8Array(0);
let bufferTimeout = null;

// Gauge Tracking
let dynMaxVoltage = 0;
let dynMinVoltage = 0;
let dynMaxCurrent = 50; 

// BMS Constants
const protection_names = [
    "Cell OV", "Cell UV", "Total OV", "Total UV", "Chg OC1", "Chg OC2", 
    "Dchg OC1", "Dchg OC2", "Chg HT", "Chg LT", "Dchg HT", "Dchg LT", 
    "MOS HT", "Amb HT", "Amb LT", "Press Diff", "Temp Diff", "SOC Low", 
    "Shortcircuit", "Monomer Off", "Temp Drop", "Chg MOS Fault", 
    "Dchg MOS Fault", "Curr Limit", "Aerosol Fault", "Full Chg", "AFE Comm Err"
];
const jbd_protection_names = [
    "Cell OV", "Cell UV", "Total OV", "Total UV", "Chg HT", "Chg LT", 
    "Dchg HT", "Dchg LT", "Chg OC", "Dchg OC", "ShortCkt", "AFE IC Err", "Software Lock"
];
const alarm_names = [
    "Cell OV", "Cell UV", "Total OV", "Total UV", "Chg OC", "Dchg OC", 
    "Chg HT", "Chg LT", "Dchg HT", "Dchg LT", "MOS HT", "Amb HT", 
    "Amb LT", "Press Diff", "Temp Diff", "SOC Low", "EEP Fault", "RTC Err"
];
const mos_status_names = [
    "Dchg MOS", "Chg MOS", "Prechg MOS", "Heat MOS", "Fan MOS", "Node1", "Node2", "Limiting"
];

// Logging
function log(msg, isError = false) {
    const entry = document.createElement('div');
    entry.className = `log-entry ${isError ? 'log-err' : ''}`;
    const time = new Date().toLocaleTimeString();
    entry.innerHTML = `<span class="log-time">[${time}]</span> <span>${msg}</span>`;
    logsDiv.prepend(entry);
    console.log(`[BMS] ${msg}`);
}
if(clearLogsBtn) clearLogsBtn.addEventListener('click', () => { logsDiv.innerHTML = ''; });

// Mode Toggle logic
if (btnModeEss) btnModeEss.addEventListener('click', () => {
    activePollingMode = 'ess';
    btnModeEss.style.background = 'var(--accent-color)';
    btnModeEss.style.color = 'white';
    btnModeEv.style.background = 'rgba(255,255,255,0.05)';
    btnModeEv.style.color = 'var(--text-secondary)';
    log('Switched Polling to ESS');
});

if (btnModeEv) btnModeEv.addEventListener('click', () => {
    activePollingMode = 'ev';
    btnModeEv.style.background = 'var(--accent-color)';
    btnModeEv.style.color = 'white';
    btnModeEss.style.background = 'rgba(255,255,255,0.05)';
    btnModeEss.style.color = 'var(--text-secondary)';
    log('Switched Polling to EV (JBD)');
});

// --- Checksums ---
function crc16_modbus(data, len) {
    let crc = 0xFFFF;
    for (let i = 0; i < len; i++) {
        crc ^= data[i];
        for (let j = 0; j < 8; j++) {
            if (crc & 0x0001) crc = (crc >> 1) ^ 0xA001;
            else crc >>= 1;
        }
    }
    return crc;
}
function jbd_checksum(cmd_code, length_byte) {
    let sum = cmd_code + length_byte;
    sum = ((~sum) + 1) & 0xFFFF;
    return sum;
}
function verify_jbd_checksum(response, len) {
    let received_checksum = (response[len - 3] << 8) | response[len - 2];
    let calculated_sum = 0;
    for (let i = 2; i < len - 3; i++) { calculated_sum += response[i]; }
    let calculated_checksum = ((~calculated_sum) + 1) & 0xFFFF;
    return received_checksum === calculated_checksum;
}

// --- Command Builders ---
function build_ess_command() {
    const cmd = new Uint8Array(10);
    cmd[0] = 0x01; cmd[1] = 0x78; cmd[2] = 0x10; cmd[3] = 0x00; cmd[4] = 0x10;
    cmd[5] = 0xA0; cmd[6] = 0x00; cmd[7] = 0x00;
    const crc = crc16_modbus(cmd, 8);
    cmd[8] = crc & 0xFF; cmd[9] = (crc >> 8) & 0xFF;
    return cmd;
}
function build_jbd_command(cmd_code) {
    const cmd = new Uint8Array(7);
    cmd[0] = 0xDD; cmd[1] = 0xA5; cmd[2] = cmd_code; cmd[3] = 0x00;
    const checksum = jbd_checksum(cmd_code, 0x00);
    cmd[4] = (checksum >> 8) & 0xFF; cmd[5] = checksum & 0xFF;
    cmd[6] = 0x77;
    return cmd;
}

// UI Utilities
function parseUuid(uuidStr) {
    uuidStr = uuidStr.toLowerCase().trim();
    if (uuidStr.startsWith('0x')) return parseInt(uuidStr, 16);
    if (/^[0-9a-f]{4}$/.test(uuidStr)) return parseInt(uuidStr, 16);
    return uuidStr;
}

function updateGauge(pathId, textId, value, min, max, unit, isSoc = false) {
    const path = document.getElementById(pathId);
    const text = document.getElementById(textId);
    if (!path || !text) return;
    let percent = (value - min) / (max - min);
    if (percent < 0) percent = 0; if (percent > 1) percent = 1;
    const offset = 125.6 - (percent * 125.6);
    path.style.strokeDashoffset = offset;
    text.textContent = value.toFixed(isSoc ? 0 : 1) + unit;
}

function updateCenterGauge(negPathId, posPathId, textId, value, maxLimit, unit) {
    const negPath = document.getElementById(negPathId);
    const posPath = document.getElementById(posPathId);
    const text = document.getElementById(textId);
    if (!negPath || !posPath || !text) return;
    const halfLength = 62.83;
    let percent = Math.abs(value) / maxLimit;
    if (percent > 1) percent = 1;
    const offset = halfLength - (percent * halfLength);
    if (value >= 0) {
        negPath.style.strokeDashoffset = halfLength; posPath.style.strokeDashoffset = offset;
        posPath.style.stroke = "var(--success-color)";
    } else {
        posPath.style.strokeDashoffset = halfLength; negPath.style.strokeDashoffset = offset;
        negPath.style.stroke = "var(--warning-color)";
    }
    text.textContent = value.toFixed(1) + unit;
}

// Bluetooth logic
connectBtn.addEventListener('click', connectToBluetooth);
disconnectBtn.addEventListener('click', disconnectBluetooth);

async function connectToBluetooth() {
    try {
        const serviceUuid = parseUuid(serviceUuidInput.value);
        log("v2.2.0 Connecting...");
        bleDevice = await navigator.bluetooth.requestDevice({ 
            acceptAllDevices: true, 
            optionalServices: [serviceUuid, '00010203-0405-0607-0809-0a0b0c0d1912'] 
        });
        bleDevice.addEventListener('gattserverdisconnected', onDisconnected);
        bleServer = await bleDevice.gatt.connect();
        const service = await bleServer.getPrimaryService(serviceUuid);
        txCharacteristic = await service.getCharacteristic(parseUuid(txUuidInput.value));
        rxCharacteristic = await service.getCharacteristic(parseUuid(rxUuidInput.value));
        await rxCharacteristic.startNotifications();
        rxCharacteristic.addEventListener('characteristicvaluechanged', handleNotifications);
        
        log('Connected! (v2.1)');
        connectBtn.classList.add('hidden');
        disconnectBtn.classList.remove('hidden');
        dashboard.classList.remove('hidden');
        connStatus.textContent = 'Connected: ' + (bleDevice.name || bleDevice.id || 'BMS');
        connStatus.className = 'status-indicator connected';
        // showDeviceInfo(); // BLE info panel hidden (panel code preserved for future use)

        // Show device name above SOC
        const stripName = document.getElementById('strip-device-name');
        if (stripName) stripName.textContent = bleDevice.name || '(No Name)';

        startPolling();
    } catch (error) { log('Connection failed: ' + error, true); }
}

function onDisconnected() {
    log('Disconnected', true);
    stopPolling();

    // Reset BLE state
    bleDevice = null; bleServer = null;
    txCharacteristic = null; rxCharacteristic = null;
    receiveBuffer = new Uint8Array(0);

    // Reset JBD accumulated data
    jbdData = { cell_voltages_V: [], temperature_C: [], battery_id: '', cell_count: 0, SOH_percent: '--' };
    jbdStep = 0;

    // Reset gauge tracking
    dynMaxVoltage = 0; dynMinVoltage = 0; dynMaxCurrent = 50;

    // Header
    connectBtn.classList.remove('hidden');
    disconnectBtn.classList.add('hidden');
    connStatus.textContent = 'Disconnected';
    connStatus.className = 'status-indicator disconnected';

    // Hide device info panel & reset device name
    const panel = document.getElementById('device-info-panel');
    if (panel) panel.classList.add('hidden');
    const stripName = document.getElementById('strip-device-name');
    if (stripName) stripName.textContent = '--';

    // Hide dashboard
    dashboard.classList.add('hidden');

    // Reset all displayed values to defaults
    resetDashboard();
}

function resetDashboard() {
    // Gauges
    updateGauge('gauge-soc-path',  'val-soc',     0, 0, 100, '%', true);
    updateGauge('gauge-volt-path', 'val-voltage',  0, 0, 100, '');
    updateCenterGauge('gauge-curr-neg', 'gauge-curr-pos', 'val-current', 0, 50, '');

    // Info row
    const ids = ['val-rem-cap','val-rated-cap','val-soh','val-cycles',
                 'val-battery-id','val-timestamp','val-device-id',
                 'val-cell-max','val-cell-min','val-cell-avg'];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '--'; });

    // Temperatures
    document.getElementById('val-temp-mos').textContent = '--°C';
    document.getElementById('val-temp-amb').textContent = '--°C';
    document.getElementById('sensor-list').innerHTML = '';

    // Cells
    document.getElementById('cell-list').innerHTML = '';

    // Status tags
    ['status-battery','status-protection','status-alarms','status-mos'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '<span class="tag">None</span>';
    });
}

function showDeviceInfo() {
    const panel = document.getElementById('device-info-panel');
    if (!panel) return;
    panel.classList.remove('hidden');

    // Device name — may be null for nameless BLE devices
    const name = bleDevice.name || '(No advertised name)';
    document.getElementById('ble-name').textContent = name;

    // Device ID — browser-assigned identifier
    // On Android Chrome this may resemble a MAC; on desktop it's a random UUID
    const devId = bleDevice.id || '(Not available)';
    document.getElementById('ble-device-id').textContent = devId;

    // UUIDs from input fields
    document.getElementById('ble-service-uuid').textContent = serviceUuidInput.value.toUpperCase();
    document.getElementById('ble-tx-uuid').textContent = txUuidInput.value.toUpperCase();
    document.getElementById('ble-rx-uuid').textContent = rxUuidInput.value.toUpperCase();

    // Active protocol
    document.getElementById('ble-protocol').textContent =
        activePollingMode === 'ess' ? '⚡ ESS BMS (Modbus)' : '🔋 Smart BMS (JBD)';

    // Connection timestamp
    document.getElementById('ble-conn-time').textContent = new Date().toLocaleString();
}

function disconnectBluetooth() {
    if (bleDevice && bleDevice.gatt.connected) bleDevice.gatt.disconnect();
}

function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(sendBMSRequest, 5000);
}

function stopPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

async function writeCmd(cmd) {
    try {
        await txCharacteristic.writeValueWithResponse(cmd);
    } catch(e) {
        try { await txCharacteristic.writeValueWithoutResponse(cmd); }
        catch(e2) { log('Write failed: ' + e2, true); }
    }
}

async function sendBMSRequest() {
    if (!txCharacteristic) return;
    try {
        if (activePollingMode === 'ess') {
            await writeCmd(build_ess_command());
        } else {
            const jbdCmds = [0x03, 0x04, 0x05];
            await writeCmd(build_jbd_command(jbdCmds[jbdStep]));
            jbdStep = (jbdStep + 1) % 3;
        }
        log(`Requested ${activePollingMode.toUpperCase()} data`);
    } catch (error) { log('Poll Error: ' + error, true); }
}

function handleNotifications(event) {
    const chunk = new Uint8Array(event.target.value.buffer);
    if (receiveBuffer.length === 0) {
        log(`Data In: ${chunk[0].toString(16)}...`); // Log first byte
    }
    const newBuffer = new Uint8Array(receiveBuffer.length + chunk.length);
    newBuffer.set(receiveBuffer);
    newBuffer.set(chunk, receiveBuffer.length);
    receiveBuffer = newBuffer;
    if (bufferTimeout) clearTimeout(bufferTimeout);
    bufferTimeout = setTimeout(processBuffer, 200); // 200ms for slow links
}

function processBuffer() {
    const response = receiveBuffer;
    const len = response.length;
    receiveBuffer = new Uint8Array(0);
    if (len < 4) return;

    // PASSIVE DETECTION (No mode check required)
    if (response[0] === 0x01 && response[1] === 0x78) {
        if (len < 150) { log(`Short ESS frame (${len}b)`); return; }
        const received_crc = (response[len - 1] << 8) | response[len - 2];
        if (received_crc === crc16_modbus(response, len - 2)) {
            parse_ess_response(response);
        } else { log('ESS CRC Error', true); }
    } else if (response[0] === 0xDD) {
        if (response[len-1] === 0x77 && verify_jbd_checksum(response, len)) {
            parse_jbd_response(response, len);
        } else { log('JBD Checksum Error', true); }
    } else {
        log(`Unknown Frame Start: ${response[0].toString(16)}`, true);
    }
}

function parse_ess_response(response) {
    const data = {};
    data.device_id = response[0];
    data.voltage_V = ((response[8] << 8) | response[9]) / 100.0;
    const cur_raw = (response[12] << 24) | (response[13] << 16) | (response[14] << 8) | response[15];
    data.current_A = (new Int32Array([cur_raw])[0] - 300000) / 1000.0;
    data.SOC_percent = ((response[16] << 8) | response[17]) * 0.01;
    data.remaining_capacity_mAh = ((response[18] << 8) | response[19]) * 0.01;
    data.cycle_count = (response[44] << 8) | response[45];
    data.SOH_percent = (response[30] << 8) | response[31];
    data.cell_count = (response[74] << 8) | response[75];
    data.temp_sensor_count = (response[108] << 8) | response[109];
    data.MOSFET_temperature = ((response[24] << 8) | response[25]) * 0.1 - 50;
    data.ambient_temperature = ((response[26] << 8) | response[27]) * 0.1 - 50;
    data.max_vtg_cell_value = ((response[48] << 8) | response[49]) * 0.001;
    data.min_vtg_cell_value = ((response[52] << 8) | response[53]) * 0.001;
    data.avg_cell_vtg = ((response[54] << 8) | response[55]) * 0.001;
    data.protection_status = [response[32], response[33], response[34], response[35]];
    data.alarm_status = [response[36], response[37], response[38], response[39]];
    data.mos_status = [response[40], response[41]];
    data.temperature_C = [];
    for (let i = 0; i < data.temp_sensor_count; i++) {
        data.temperature_C.push(((response[110 + i*2] << 8) | response[111 + i*2]) * 0.1 - 50);
    }
    data.cell_voltages_V = [];
    for (let i = 0; i < data.cell_count; i++) {
        data.cell_voltages_V.push(((response[76 + i*2] << 8) | response[77 + i*2]) / 1000.0);
    }
    let id_bytes = response.slice(124, 156);
    data.battery_id = "";
    for (let b of id_bytes) { if (b >= 32 && b <= 126) data.battery_id += String.fromCharCode(b); else break; }
    updateUI(data, 'ess');
}

function parse_jbd_response(response, len) {
    const cmd = response[1];
    const data = jbdData;

    if (cmd === 0x03) {
        // Basic info frame
        data.voltage_V = ((response[4] << 8) | response[5]) * 0.01;
        const cur_raw = (response[6] << 8) | response[7];
        data.current_A = (new Int16Array([cur_raw])[0]) * 0.01;
        // JBD reports capacity in 10mAh units
        data.remaining_capacity_mAh = ((response[8] << 8) | response[9]) * 10;
        data.rated_capacity_mAh    = ((response[10] << 8) | response[11]) * 10;
        data.cycle_count = (response[12] << 8) | response[13];
        data.protection_status = [response[18], response[19], 0, 0];
        data.SOC_percent = response[23];
        data.mos_status = [response[24], 0];
        // NOTE: response[25] is the BMS configured series count — can be wrong for
        // multi-string packs. We store it only as a hint; the 0x04 frame overrides it.
        data.cell_count_hint = response[25];
        data.temp_sensor_count = response[26];
        data.temperature_C = [];
        for (let i = 0; i < data.temp_sensor_count; i++) {
            data.temperature_C.push(((response[27 + i*2] << 8) | response[28 + i*2]) * 0.1 - 273.1);
        }
        data.MOSFET_temperature = data.temperature_C[0] !== undefined ? data.temperature_C[0] : 0;
        data.ambient_temperature = data.temperature_C[1] !== undefined ? data.temperature_C[1] : (data.temperature_C[0] || 0);
        data.SOH_percent = '--'; // JBD basic frame has no SOH field

    } else if (cmd === 0x04) {
        // Cell voltage frame — payload length byte (response[3]) = 2 * actual_cell_count
        // This is the AUTHORITATIVE source for series cell count.
        const actualCells = Math.floor(response[3] / 2);
        data.cell_count = actualCells; // override whatever 0x03 said
        data.cell_voltages_V = [];
        let sum = 0;
        for (let i = 0; i < actualCells; i++) {
            let v = ((response[4 + i*2] << 8) | response[5 + i*2]) * 0.001;
            data.cell_voltages_V.push(v);
            sum += v;
        }
        if (actualCells > 0) {
            data.avg_cell_vtg       = sum / actualCells;
            data.max_vtg_cell_value = Math.max(...data.cell_voltages_V);
            data.min_vtg_cell_value = Math.min(...data.cell_voltages_V);
            // Recalculate pack voltage from actual cells for sanity-check
            data.voltage_V_cells    = sum;
        }
        log(`JBD: ${actualCells}S cells parsed (BMS hint was ${data.cell_count_hint || '?'}S)`);

    } else if (cmd === 0x05) {
        const name_len = response[3];
        data.battery_id = '';
        for (let i = 0; i < name_len; i++) data.battery_id += String.fromCharCode(response[4 + i]);
    }

    updateUI(data, 'ev');
}

function updateUI(data, mode) {
    if (document.getElementById('val-device-id')) 
        document.getElementById('val-device-id').textContent = data.device_id || '--';
    document.getElementById('val-battery-id').textContent = data.battery_id || 'Unknown';
    document.getElementById('val-timestamp').textContent = new Date().toLocaleTimeString();
    document.getElementById('val-rem-cap').textContent = (data.remaining_capacity_mAh / 1000).toFixed(2);
    if (document.getElementById('val-rated-cap'))
        document.getElementById('val-rated-cap').textContent = data.rated_capacity_mAh ? (data.rated_capacity_mAh / 1000).toFixed(2) : '--';
    document.getElementById('val-soh').textContent = (data.SOH_percent !== undefined ? data.SOH_percent : '--');
    document.getElementById('val-cycles').textContent = (data.cycle_count !== undefined && data.cycle_count !== null ? data.cycle_count : '--');

    updateGauge('gauge-soc-path', 'val-soc', data.SOC_percent || 0, 0, 100, '%', true);
    if (data.cell_count > 0) {
        dynMinVoltage = data.cell_count * 2.8; dynMaxVoltage = data.cell_count * 4.25;
    }
    updateGauge('gauge-volt-path', 'val-voltage', data.voltage_V || 0, dynMinVoltage || 0, dynMaxVoltage || 100, '');

    if (Math.abs(data.current_A) > dynMaxCurrent) dynMaxCurrent = Math.abs(data.current_A) * 1.2;
    updateCenterGauge('gauge-curr-neg', 'gauge-curr-pos', 'val-current', data.current_A || 0, dynMaxCurrent, '');

    document.getElementById('val-temp-mos').textContent = (data.MOSFET_temperature || 0).toFixed(1) + '°C';
    document.getElementById('val-temp-amb').textContent = (data.ambient_temperature || 0).toFixed(1) + '°C';
    
    const sensorList = document.getElementById('sensor-list');
    sensorList.innerHTML = '';
    (data.temperature_C || []).forEach((t, i) => {
        sensorList.innerHTML += `<div class="cell-box"><span class="cell-num">S${i+1}</span><span class="cell-val">${t.toFixed(1)}°</span></div>`;
    });

    document.getElementById('val-cell-max').textContent = (data.max_vtg_cell_value || 0).toFixed(3);
    document.getElementById('val-cell-min').textContent = (data.min_vtg_cell_value || 0).toFixed(3);
    document.getElementById('val-cell-avg').textContent = (data.avg_cell_vtg || 0).toFixed(3);

    const cellList = document.getElementById('cell-list');
    cellList.innerHTML = '';
    (data.cell_voltages_V || []).forEach((v, i) => {
        cellList.innerHTML += `<div class="cell-box"><span class="cell-num">C${i+1}</span><span class="cell-val">${v.toFixed(3)}</span></div>`;
    });

    let status_str = "Idle";
    if (Math.abs(data.current_A) > 0.1) status_str = data.current_A > 0 ? "Charging" : "Discharging";
    document.getElementById('status-battery').innerHTML = `<span class="tag ${status_str === 'Charging' ? 'success' : 'alert'}">${status_str}</span>`;

    const pNames = mode === 'ev' ? jbd_protection_names : protection_names;
    if (data.protection_status) {
        const pBits = (data.protection_status[0] << 24) | (data.protection_status[1] << 16) | (data.protection_status[2] << 8) | data.protection_status[3];
        renderTags('status-protection', pBits, pNames, 'alert');
    }
    
    if (data.alarm_status) {
        const aBits = (data.alarm_status[0] << 24) | (data.alarm_status[1] << 16) | (data.alarm_status[2] << 8) | data.alarm_status[3];
        renderTags('status-alarms', aBits, alarm_names, 'warn');
    }

    if (data.mos_status) {
        const mBits = (data.mos_status[0] << 8) | data.mos_status[1];
        renderTags('status-mos', mBits, mos_status_names, 'success');
    }
}

function renderTags(elementId, bitmask, namesArray, styleClass) {
    const el = document.getElementById(elementId); if (!el) return;
    el.innerHTML = ''; let found = false;
    for (let i = 0; i < namesArray.length; i++) {
        if (bitmask & (1 << i)) {
            el.innerHTML += `<span class="tag ${styleClass}">${namesArray[i]}</span>`;
            found = true;
        }
    }
    if (!found) el.innerHTML = `<span class="tag">None</span>`;
}
