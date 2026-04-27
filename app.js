// app.js

// UI Elements
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const dashboard = document.getElementById('dashboard');
const logsDiv = document.getElementById('logs');
const clearLogsBtn = document.getElementById('clearLogsBtn');
const connStatus = document.getElementById('val-connection');

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

// Buffer for incoming data chunks
let receiveBuffer = new Uint8Array(0);
let bufferTimeout = null;

// Gauge Tracking
let dynMaxVoltage = 0;
let dynMinVoltage = 0;
let dynMaxCurrent = 50; // default safe value

// BMS Constants
const MAX_CELLS = 20;
const MAX_SENSORS = 10;
const MAX_PROTECTIONS = 27;
const MAX_ALARMS = 18;
const MAX_MOS_STATUS = 8;

const protection_names = [
    "Cell OV", "Cell UV", "Total OV", "Total UV", "Chg OC1", "Chg OC2", 
    "Dchg OC1", "Dchg OC2", "Chg HT", "Chg LT", "Dchg HT", "Dchg LT", 
    "MOS HT", "Amb HT", "Amb LT", "Press Diff", "Temp Diff", "SOC Low", 
    "Shortcircuit", "Monomer Off", "Temp Drop", "Chg MOS Fault", 
    "Dchg MOS Fault", "Curr Limit", "Aerosol Fault", "Full Chg", "AFE Comm Err"
];

const alarm_names = [
    "Cell OV", "Cell UV", "Total OV", "Total UV", "Chg OC", "Dchg OC", 
    "Chg HT", "Chg LT", "Dchg HT", "Dchg LT", "MOS HT", "Amb HT", 
    "Amb LT", "Press Diff", "Temp Diff", "SOC Low", "EEP Fault", "RTC Err"
];

const mos_status_names = [
    "Dchg MOS", "Chg MOS", "Prechg MOS", "Heat MOS", "Fan MOS", "Node1", "Node2", "Limiting"
];

const battery_status_names = ["Idle", "Charging", "Discharging"];

// Logging
function log(msg, isError = false) {
    const entry = document.createElement('div');
    entry.className = `log-entry ${isError ? 'log-err' : ''}`;
    const time = new Date().toLocaleTimeString();
    entry.innerHTML = `<span class="log-time">[${time}]</span> <span>${msg}</span>`;
    logsDiv.prepend(entry);
}
if(clearLogsBtn) clearLogsBtn.addEventListener('click', () => { logsDiv.innerHTML = ''; });

// CRC16 Modbus
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

// Build Command
function build_command(dev_id) {
    const cmd = new Uint8Array(10);
    cmd[0] = dev_id; cmd[1] = 0x78; cmd[2] = 0x10; cmd[3] = 0x00; cmd[4] = 0x10;
    cmd[5] = 0xA0; cmd[6] = 0x00; cmd[7] = 0x00;
    const crc = crc16_modbus(cmd, 8);
    cmd[8] = crc & 0xFF; cmd[9] = (crc >> 8) & 0xFF;
    return cmd;
}

// UUID Parser
function parseUuid(uuidStr) {
    uuidStr = uuidStr.toLowerCase().trim();
    if (uuidStr.startsWith('0x')) return parseInt(uuidStr, 16);
    if (/^[0-9a-f]{4}$/.test(uuidStr)) return parseInt(uuidStr, 16);
    return uuidStr;
}

// Setup SVG Gauges Function
// Arc length of our SVG path (r=40, semicircle) is 125.6
function updateGauge(pathId, textId, value, min, max, unit, isSoc = false) {
    const path = document.getElementById(pathId);
    const text = document.getElementById(textId);
    
    let percent = (value - min) / (max - min);
    if (percent < 0) percent = 0;
    if (percent > 1) percent = 1;
    
    const offset = 125.6 - (percent * 125.6);
    path.style.strokeDashoffset = offset;
    
    text.textContent = value.toFixed(isSoc ? 0 : 1) + unit;
    
    if (isSoc) {
        if (value < 20) path.style.stroke = "var(--danger-color)";
        else if (value < 50) path.style.stroke = "var(--warning-color)";
        else path.style.stroke = "var(--success-color)";
    }
}

// Center-Out Gauge for Current
function updateCenterGauge(negPathId, posPathId, textId, value, maxLimit, unit) {
    const negPath = document.getElementById(negPathId);
    const posPath = document.getElementById(posPathId);
    const text = document.getElementById(textId);
    
    const halfLength = 62.83;
    let percent = Math.abs(value) / maxLimit;
    if (percent > 1) percent = 1;
    
    const offset = halfLength - (percent * halfLength);
    
    if (value >= 0) {
        negPath.style.strokeDashoffset = halfLength; // Hide negative
        posPath.style.strokeDashoffset = offset;     // Show positive
        posPath.style.stroke = "var(--success-color)"; // Green for charging
    } else {
        posPath.style.strokeDashoffset = halfLength; // Hide positive
        negPath.style.strokeDashoffset = offset;     // Show negative
        negPath.style.stroke = "var(--warning-color)"; // Orange/Yellow for discharging
    }
    
    text.textContent = value.toFixed(1) + unit;
}

// Event Listeners
connectBtn.addEventListener('click', connectToBluetooth);
disconnectBtn.addEventListener('click', disconnectBluetooth);

async function connectToBluetooth() {
    try {
        const serviceUuid = parseUuid(serviceUuidInput.value);
        log('Requesting Device. Service: ' + (typeof serviceUuid === 'number' ? '0x' + serviceUuid.toString(16) : serviceUuid));
        
        bleDevice = await navigator.bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices: [serviceUuid]
        });

        bleDevice.addEventListener('gattserverdisconnected', onDisconnected);
        
        log('Connecting GATT...');
        bleServer = await bleDevice.gatt.connect();
        
        log('Getting Service...');
        const service = await bleServer.getPrimaryService(serviceUuid);
        
        const txUuid = parseUuid(txUuidInput.value);
        const rxUuid = parseUuid(rxUuidInput.value);
        
        log('Getting Characteristics...');
        txCharacteristic = await service.getCharacteristic(txUuid);
        rxCharacteristic = await service.getCharacteristic(rxUuid);
        
        await rxCharacteristic.startNotifications();
        rxCharacteristic.addEventListener('characteristicvaluechanged', handleNotifications);
        
        log('Connected!');
        connectBtn.classList.add('hidden');
        disconnectBtn.classList.remove('hidden');
        dashboard.classList.remove('hidden');
        
        connStatus.textContent = 'Connected: ' + (bleDevice.name || 'BMS');
        connStatus.className = 'status-indicator connected';

        startPolling();
        
    } catch (error) {
        log('Connection failed: ' + error, true);
    }
}

function onDisconnected() {
    log('Device disconnected', true);
    stopPolling();
    connectBtn.classList.remove('hidden');
    disconnectBtn.classList.add('hidden');
    connStatus.textContent = 'Disconnected';
    connStatus.className = 'status-indicator disconnected';
}

function disconnectBluetooth() {
    if (bleDevice && bleDevice.gatt.connected) bleDevice.gatt.disconnect();
}

function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    sendBMSRequest();
    pollInterval = setInterval(sendBMSRequest, 5000);
}

function stopPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

async function sendBMSRequest() {
    if (!txCharacteristic) return;
    const cmd = build_command(0x01);
    try {
        await txCharacteristic.writeValueWithoutResponse(cmd);
        log('Requested data');
    } catch (error) {
        log('Error writing: ' + error, true);
    }
}

function handleNotifications(event) {
    const chunk = new Uint8Array(event.target.value.buffer);
    const newBuffer = new Uint8Array(receiveBuffer.length + chunk.length);
    newBuffer.set(receiveBuffer);
    newBuffer.set(chunk, receiveBuffer.length);
    receiveBuffer = newBuffer;
    
    if (bufferTimeout) clearTimeout(bufferTimeout);
    bufferTimeout = setTimeout(processBuffer, 150);
}

function processBuffer() {
    const response = receiveBuffer;
    const len = response.length;
    receiveBuffer = new Uint8Array(0);
    
    if (len >= 2) {
        const received_crc = (response[len - 1] << 8) | response[len - 2];
        const calculated_crc = crc16_modbus(response, len - 2);
        
        if (received_crc === calculated_crc) {
            parse_response(response, len);
        } else {
            log(`CRC Error. Recv: ${received_crc.toString(16)}, Calc: ${calculated_crc.toString(16)}`, true);
        }
    }
}

function parse_response(response, len) {
    if (len < 150 || response[1] !== 0x78) return;

    const data = {};
    data.device_id = response[0];
    data.voltage_V = ((response[8] << 8) | response[9]) / 100.0;
    
    const current_raw = (response[12] << 24) | (response[13] << 16) | (response[14] << 8) | response[15];
    const signed_current_raw = new Int32Array([current_raw])[0];
    data.current_A = (signed_current_raw - 300000) / 1000.0;
    
    data.SOC_percent = ((response[16] << 8) | response[17]) * 0.01;
    data.remaining_capacity_mAh = ((response[18] << 8) | response[19]) * 0.01;
    data.cycle_count = (response[44] << 8) | response[45];
    data.SOH_percent = (response[30] << 8) | response[31];
    data.cell_count = (response[74] << 8) | response[75];
    data.temp_sensor_count = (response[108] << 8) | response[109];
    
    // Limits for dynamic scaling
    data.charging_voltage = ((response[66] << 8) | response[67]) * 0.1;
    data.max_charging_current = ((response[68] << 8) | response[69]) * 0.1;
    data.max_discharge_current = ((response[72] << 8) | response[73]) * 0.1;

    data.MOSFET_temperature = ((response[24] << 8) | response[25]) * 0.1 - 50;
    data.ambient_temperature = ((response[26] << 8) | response[27]) * 0.1 - 50;
    
    data.max_vtg_cell_value = ((response[48] << 8) | response[49]) * 0.001;
    data.min_vtg_cell_value = ((response[52] << 8) | response[53]) * 0.001;
    data.avg_cell_vtg = ((response[54] << 8) | response[55]) * 0.001;

    data.protection_status = [response[32], response[33], response[34], response[35]];
    data.alarm_status = [response[36], response[37], response[38], response[39]];
    data.charg_status = [response[29], response[30]];
    data.mos_status = [response[40], response[41]];

    data.temperature_C = [];
    for (let i = 0; i < data.temp_sensor_count && i < MAX_SENSORS; i++) {
        let temp_raw = (response[110 + i*2] << 8) | response[111 + i*2];
        data.temperature_C.push((temp_raw * 0.1) - 50);
    }

    data.cell_voltages_V = [];
    for (let i = 0; i < data.cell_count && i < MAX_CELLS; i++) {
        let v = (response[76 + i*2] << 8) | response[77 + i*2];
        data.cell_voltages_V.push(v / 1000.0);
    }

    let battery_id_bytes = response.slice(124, 124 + 32);
    let battery_id = "";
    for (let i = 0; i < battery_id_bytes.length; i++) {
        if (battery_id_bytes[i] >= 32 && battery_id_bytes[i] <= 126) battery_id += String.fromCharCode(battery_id_bytes[i]);
        else break;
    }
    data.battery_id = battery_id || "Unknown";

    updateUI(data);
}

function updateUI(data) {
    // Basic Info Footer
    document.getElementById('val-device-id').textContent = data.device_id;
    document.getElementById('val-battery-id').textContent = data.battery_id;
    document.getElementById('val-timestamp').textContent = new Date().toLocaleTimeString();

    // Data Row
    document.getElementById('val-rem-cap').textContent = data.remaining_capacity_mAh.toFixed(1);
    document.getElementById('val-soh').textContent = data.SOH_percent;
    document.getElementById('val-cycles').textContent = data.cycle_count;

    // --- Dynamic Gauge Scaling Logic ---
    // SOC is always 0-100
    updateGauge('gauge-soc-path', 'val-soc', data.SOC_percent, 0, 100, '%', true);

    // Dynamic Voltage Range
    // Based on standard Li-ion limits per cell (2.8V min, 4.2V max)
    if (data.cell_count > 0) {
        dynMinVoltage = data.cell_count * 2.8;
        dynMaxVoltage = data.cell_count * 4.25;
    } else {
        // Fallback if cell count is 0
        dynMinVoltage = data.voltage_V * 0.8;
        dynMaxVoltage = data.voltage_V * 1.2;
    }
    updateGauge('gauge-volt-path', 'val-voltage', data.voltage_V, dynMinVoltage, dynMaxVoltage, '');

    // Dynamic Current Range
    let maxLimit = Math.max(data.max_charging_current, data.max_discharge_current);
    if (maxLimit > dynMaxCurrent) dynMaxCurrent = maxLimit; 
    if (Math.abs(data.current_A) > dynMaxCurrent) dynMaxCurrent = Math.abs(data.current_A) * 1.2; 
    
    updateCenterGauge('gauge-curr-neg', 'gauge-curr-pos', 'val-current', data.current_A, dynMaxCurrent, '');


    // Temps
    document.getElementById('val-temp-mos').textContent = data.MOSFET_temperature.toFixed(1) + '°C';
    document.getElementById('val-temp-amb').textContent = data.ambient_temperature.toFixed(1) + '°C';
    
    const sensorList = document.getElementById('sensor-list');
    sensorList.innerHTML = '';
    data.temperature_C.forEach((t, i) => {
        sensorList.innerHTML += `<div class="cell-box"><span class="cell-num">S${i+1}</span><span class="cell-val">${t.toFixed(1)}°</span></div>`;
    });

    // Cell Voltages
    document.getElementById('val-cell-max').textContent = data.max_vtg_cell_value.toFixed(3);
    document.getElementById('val-cell-min').textContent = data.min_vtg_cell_value.toFixed(3);
    document.getElementById('val-cell-avg').textContent = data.avg_cell_vtg.toFixed(3);

    const cellList = document.getElementById('cell-list');
    cellList.innerHTML = '';
    data.cell_voltages_V.forEach((v, i) => {
        cellList.innerHTML += `<div class="cell-box"><span class="cell-num">C${i+1}</span><span class="cell-val">${v.toFixed(3)}</span></div>`;
    });

    // Statuses
    let battery_status_idx = (data.charg_status[0] << 8) | data.charg_status[1];
    let battery_status_str = battery_status_idx <= 2 ? battery_status_names[battery_status_idx] : "Unknown";
    document.getElementById('status-battery').innerHTML = `<span class="tag ${battery_status_idx === 1 ? 'success' : 'alert'}">${battery_status_str}</span>`;

    const protection_bits = (data.protection_status[0] << 24) | (data.protection_status[1] << 16) | (data.protection_status[2] << 8) | data.protection_status[3];
    renderTags('status-protection', protection_bits, protection_names, 'alert');

    const alarm_bits = (data.alarm_status[0] << 24) | (data.alarm_status[1] << 16) | (data.alarm_status[2] << 8) | data.alarm_status[3];
    renderTags('status-alarms', alarm_bits, alarm_names, 'warn');

    const mos_bits = (data.mos_status[0] << 8) | data.mos_status[1];
    renderTags('status-mos', mos_bits, mos_status_names, 'success');
}

function renderTags(elementId, bitmask, namesArray, styleClass) {
    const el = document.getElementById(elementId);
    el.innerHTML = '';
    let found = false;
    for (let i = 0; i < namesArray.length; i++) {
        if (bitmask & (1 << i)) {
            el.innerHTML += `<span class="tag ${styleClass}">${namesArray[i]}</span>`;
            found = true;
        }
    }
    if (!found) el.innerHTML = `<span class="tag">None</span>`;
}
