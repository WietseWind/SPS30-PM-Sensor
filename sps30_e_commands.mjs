#!/usr/bin/env node

import { SerialPort } from 'serialport';
import { setTimeout as sleep } from 'timers/promises';
import { parseArgs } from 'util';

// --- SHDLC protocol ---------------------------------------------------------

const SHDLC_DELIM = 0x7e;
const STUFF = { 0x7e: [0x7d, 0x5e], 0x7d: [0x7d, 0x5d], 0x11: [0x7d, 0x31], 0x13: [0x7d, 0x33] };
const UNSTUFF = { 0x5e: 0x7e, 0x5d: 0x7d, 0x31: 0x11, 0x33: 0x13 };

function buildFrame(addr, cmd, data = []) {
  const len = data.length;
  const chk = (~(addr + cmd + len + data.reduce((s, b) => s + b, 0))) & 0xff;
  const raw = [addr, cmd, len, ...data, chk];
  const out = [SHDLC_DELIM];
  for (const b of raw) out.push(...(STUFF[b] ?? [b]));
  out.push(SHDLC_DELIM);
  return Buffer.from(out);
}

function parseResponse(buf) {
  const first = buf.indexOf(SHDLC_DELIM);
  const last = buf.lastIndexOf(SHDLC_DELIM);
  if (first === last) throw new Error('incomplete SHDLC frame');

  const body = [];
  const inner = buf.subarray(first + 1, last);
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === 0x7d && i + 1 < inner.length) {
      body.push(UNSTUFF[inner[++i]] ?? inner[i]);
    } else {
      body.push(inner[i]);
    }
  }

  const [addr, cmd, state, len] = body;
  const data = body.slice(4, 4 + len);
  const chk = body[4 + len];

  const sum = (addr + cmd + state + len + data.reduce((s, b) => s + b, 0) + chk) & 0xff;
  if (sum !== 0xff) throw new Error('SHDLC checksum mismatch');
  if (state !== 0) throw new Error(`SPS30 error state: 0x${state.toString(16).padStart(2, '0')}`);

  return Buffer.from(data);
}

// --- SPS30 driver ------------------------------------------------------------

class Sps30 {
  constructor(port, addr = 0x00) {
    this.port = port;
    this.addr = addr;
  }

  transceive(cmd, data = [], timeout = 1000) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let started = false;
      let timer;

      const onData = (chunk) => {
        for (const byte of chunk) {
          if (byte === SHDLC_DELIM) {
            if (!started) {
              started = true;
              chunks.length = 0;
              chunks.push(byte);
            } else {
              chunks.push(byte);
              done();
              try { resolve(parseResponse(Buffer.from(chunks))); }
              catch (e) { reject(e); }
              return;
            }
          } else if (started) {
            chunks.push(byte);
          }
        }
      };

      const done = () => { clearTimeout(timer); this.port.off('data', onData); };
      timer = setTimeout(() => { done(); reject(new Error(`SHDLC timeout (cmd 0x${cmd.toString(16)})`)); }, timeout);

      this.port.on('data', onData);
      this.port.write(buildFrame(this.addr, cmd, data));
    });
  }

  // Send a frame without waiting for a response (used by reset)
  txOnly(cmd, data = []) {
    return new Promise((resolve, reject) => {
      this.port.write(buildFrame(this.addr, cmd, data), (err) => {
        if (err) reject(err); else resolve();
      });
    });
  }

  // --- measurement ---

  async startMeasurement(format = 0x03) {
    // format: 0x03 = float (IEEE754), 0x05 = uint16
    return this.transceive(0x00, [0x01, format]);
  }

  async stopMeasurement() {
    return this.transceive(0x01);
  }

  async readMeasurementValuesFloat() {
    const d = await this.transceive(0x03);
    if (d.length < 40) throw new Error(`unexpected data length: ${d.length}`);
    return {
      mc_1p0:  d.readFloatBE(0),
      mc_2p5:  d.readFloatBE(4),
      mc_4p0:  d.readFloatBE(8),
      mc_10p0: d.readFloatBE(12),
      nc_0p5:  d.readFloatBE(16),
      nc_1p0:  d.readFloatBE(20),
      nc_2p5:  d.readFloatBE(24),
      nc_4p0:  d.readFloatBE(28),
      nc_10p0: d.readFloatBE(32),
      typical_particle_size: d.readFloatBE(36),
    };
  }

  async readMeasurementValuesUint16() {
    const d = await this.transceive(0x03);
    if (d.length < 20) throw new Error(`unexpected data length: ${d.length}`);
    return {
      mc_1p0:  d.readUInt16BE(0),
      mc_2p5:  d.readUInt16BE(2),
      mc_4p0:  d.readUInt16BE(4),
      mc_10p0: d.readUInt16BE(6),
      nc_0p5:  d.readUInt16BE(8),
      nc_1p0:  d.readUInt16BE(10),
      nc_2p5:  d.readUInt16BE(12),
      nc_4p0:  d.readUInt16BE(14),
      nc_10p0: d.readUInt16BE(16),
      typical_particle_size: d.readUInt16BE(18),
    };
  }

  // --- fan cleaning ---

  async startFanClean() {
    return this.transceive(0x56, [], 12000);
  }

  async getFanAutoCleanInterval() {
    const d = await this.transceive(0x80, [0x00]);
    return d.readUInt32BE(0); // seconds
  }

  async setFanAutoCleanInterval(seconds) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(seconds);
    return this.transceive(0x80, [0x00, ...buf]);
  }

  // --- device info ---

  async readSerialNumber() {
    const data = await this.transceive(0xd0, [0x03]);
    const end = data.indexOf(0x00);
    return data.subarray(0, end === -1 ? data.length : end).toString('ascii');
  }

  async readProductType() {
    const data = await this.transceive(0xd0, [0x00]);
    const end = data.indexOf(0x00);
    return data.subarray(0, end === -1 ? data.length : end).toString('ascii');
  }

  async readVersion() {
    const d = await this.transceive(0xd1);
    if (d.length < 7) throw new Error(`unexpected data length: ${d.length}`);
    return {
      firmware_major: d[0],
      firmware_minor: d[1],
      // d[2] is reserved
      hardware_revision: d[3],
      // d[4] is reserved
      shdlc_major: d[5],
      shdlc_minor: d[6],
    };
  }

  // --- power management ---

  async deviceSleep() {
    return this.transceive(0x10);
  }

  async wakeUp() {
    // Send 0xFF byte to wake UART, wait for it to initialize, then send wake cmd
    // May need multiple attempts as the first bytes can be swallowed
    const write = (data) => new Promise((res, rej) => {
      this.port.write(data, (err) => { if (err) rej(err); else res(); });
    });
    await write(Buffer.from([0xff]));
    await sleep(500);
    await write(Buffer.from([0xff]));
    await sleep(100);
    return this.transceive(0x11, [], 3000);
  }

  // --- reset ---

  async reset() {
    // Reset is tx-only, sensor reboots and does not reply
    await this.txOnly(0xd3);
    await sleep(100);
  }
}

// --- CLI ---------------------------------------------------------------------

const USAGE = `
SPS30 UART driver for Node.js

Usage: node sps30.mjs [options] [command]

Options:
  -p, --serial-port <path>   Serial port path (default: /dev/cu.usbserial-440)
  -n, --count <n>            Number of readings for measure (default: 50)
  -i, --interval <ms>        Interval between readings in ms (default: 1000)
  --uint16                   Use uint16 output format instead of float
  -h, --help                 Show this help

Commands:
  measure                    Read sensor values (default)
  info                       Show serial, product type, firmware, auto-clean interval
  clean                      Trigger manual fan cleaning (~10s, requires measurement mode)
  get-clean-interval         Read fan auto-clean interval
  set-clean-interval <sec>   Set fan auto-clean interval in seconds (default 604800 = 7 days)
  sleep                      Put sensor into low-power sleep mode
  wake                       Wake sensor from sleep
  reset                      Reset sensor (reboot)

Examples:
  node sps30.mjs                                     # measure 50x, float, 1s interval
  node sps30.mjs -p /dev/ttyUSB0 measure             # different port
  node sps30.mjs -n 10 -i 2000                       # 10 readings, 2s apart
  node sps30.mjs --uint16                             # uint16 output format
  node sps30.mjs info                                 # show device info
  node sps30.mjs clean                                # trigger fan clean
  node sps30.mjs get-clean-interval                   # read auto-clean interval
  node sps30.mjs set-clean-interval 86400             # set auto-clean to 1 day
  node sps30.mjs sleep                                # put sensor to sleep
  node sps30.mjs wake                                 # wake from sleep
  node sps30.mjs reset                                # reset sensor
`.trim();

const { values, positionals } = parseArgs({
  options: {
    'serial-port': { type: 'string', short: 'p', default: '/dev/cu.usbserial-440' },
    'count':       { type: 'string', short: 'n', default: '50' },
    'interval':    { type: 'string', short: 'i', default: '1000' },
    'uint16':      { type: 'boolean', default: false },
    'help':        { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const command = positionals[0] || 'measure';
const count = parseInt(values.count, 10);
const interval = parseInt(values.interval, 10);

const port = new SerialPort({ path: values['serial-port'], baudRate: 115200 });
await new Promise((res, rej) => { port.on('open', res); port.on('error', rej); });

const sensor = new Sps30(port);

try {
  switch (command) {

    case 'info': {
      try { await sensor.wakeUp(); } catch {}
      try { await sensor.stopMeasurement(); } catch {}
      await sleep(100);

      const serial = await sensor.readSerialNumber();
      const product = await sensor.readProductType();
      const ver = await sensor.readVersion();
      const cleanInterval = await sensor.getFanAutoCleanInterval();

      console.log(`serial_number:    ${serial}`);
      console.log(`product_type:     ${product}`);
      console.log(`firmware:         ${ver.firmware_major}.${ver.firmware_minor}`);
      console.log(`hardware:         ${ver.hardware_revision}`);
      console.log(`shdlc:            ${ver.shdlc_major}.${ver.shdlc_minor}`);
      console.log(`auto_clean:       ${cleanInterval}s (${(cleanInterval / 86400).toFixed(1)} days)`);
      break;
    }

    case 'clean': {
      try { await sensor.wakeUp(); } catch {}
      try { await sensor.stopMeasurement(); } catch {}
      await sleep(100);
      await sensor.startMeasurement(0x03);
      console.log('starting fan clean (~10s)...');
      await sensor.startFanClean();
      console.log('fan clean done');
      await sensor.stopMeasurement();
      break;
    }

    case 'get-clean-interval': {
      try { await sensor.wakeUp(); } catch {}
      try { await sensor.stopMeasurement(); } catch {}
      await sleep(100);
      const secs = await sensor.getFanAutoCleanInterval();
      console.log(`auto_clean_interval: ${secs}s (${(secs / 86400).toFixed(1)} days)`);
      break;
    }

    case 'set-clean-interval': {
      const secs = parseInt(positionals[1], 10);
      if (isNaN(secs)) {
        console.error('usage: node sps30.mjs set-clean-interval <seconds>');
        process.exit(1);
      }
      try { await sensor.wakeUp(); } catch {}
      try { await sensor.stopMeasurement(); } catch {}
      await sleep(100);
      await sensor.setFanAutoCleanInterval(secs);
      console.log(`auto_clean_interval set to ${secs}s (${(secs / 86400).toFixed(1)} days)`);
      break;
    }

    case 'sleep': {
      try { await sensor.stopMeasurement(); } catch {}
      await sleep(100);
      await sensor.deviceSleep();
      console.log('sensor is now in sleep mode');
      break;
    }

    case 'wake': {
      await sensor.wakeUp();
      console.log('sensor is awake');
      break;
    }

    case 'reset': {
      await sensor.reset();
      console.log('sensor reset');
      break;
    }

    case 'measure':
    default: {
      try { await sensor.wakeUp(); } catch {}
      try { await sensor.stopMeasurement(); } catch {}
      await sleep(100);

      const serial = await sensor.readSerialNumber();
      console.log(`serial_number: ${serial}`);

      const product = await sensor.readProductType();
      console.log(`product_type: ${product}`);

      const format = values.uint16 ? 0x05 : 0x03;
      await sensor.startMeasurement(format);

      for (let i = 0; i < count; i++) {
        try {
          await sleep(interval);
          if (values.uint16) {
            const v = await sensor.readMeasurementValuesUint16();
            console.log(
              `mc_1p0: ${v.mc_1p0}; mc_2p5: ${v.mc_2p5}; mc_4p0: ${v.mc_4p0}; mc_10p0: ${v.mc_10p0}; ` +
              `nc_0p5: ${v.nc_0p5}; nc_1p0: ${v.nc_1p0}; nc_2p5: ${v.nc_2p5}; nc_4p0: ${v.nc_4p0}; ` +
              `nc_10p0: ${v.nc_10p0}; typical_particle_size: ${v.typical_particle_size}`
            );
          } else {
            const v = await sensor.readMeasurementValuesFloat();
            const f = (n) => n.toFixed(1);
            console.log(
              `mc_1p0: ${f(v.mc_1p0)}; mc_2p5: ${f(v.mc_2p5)}; mc_4p0: ${f(v.mc_4p0)}; mc_10p0: ${f(v.mc_10p0)}; ` +
              `nc_0p5: ${f(v.nc_0p5)}; nc_1p0: ${f(v.nc_1p0)}; nc_2p5: ${f(v.nc_2p5)}; nc_4p0: ${f(v.nc_4p0)}; ` +
              `nc_10p0: ${f(v.nc_10p0)}; typical_particle_size: ${f(v.typical_particle_size)}`
            );
            console.log(
              `  PM1.0: ${f(v.mc_1p0)} µg/m³  PM2.5: ${f(v.mc_2p5)} µg/m³  PM4.0: ${f(v.mc_4p0)} µg/m³  PM10: ${f(v.mc_10p0)} µg/m³`
            );
          }
        } catch {
          continue;
        }
      }

      await sensor.stopMeasurement();
      break;
    }
  }
} finally {
  port.close();
}
