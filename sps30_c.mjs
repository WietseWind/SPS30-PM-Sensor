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

  // unstuff
  const body = [];
  const inner = buf.subarray(first + 1, last);
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === 0x7d && i + 1 < inner.length) {
      body.push(UNSTUFF[inner[++i]] ?? inner[i]);
    } else {
      body.push(inner[i]);
    }
  }

  // response layout: ADDR CMD STATE LEN DATA... CHK
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

  async stopMeasurement() {
    return this.transceive(0x01);
  }

  async startMeasurement(format = 0x05) {
    // sub-command 0x01, output format 0x05 = uint16
    return this.transceive(0x00, [0x01, format]);
  }

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

  async startFanClean() {
    return this.transceive(0x56, [], 12000);
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
}

// --- main --------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    'serial-port': { type: 'string', short: 'p', default: '/dev/cu.usbserial-440' },
    'clean': { type: 'boolean', short: 'c', default: false },
  },
});

const port = new SerialPort({ path: values['serial-port'], baudRate: 115200 });
await new Promise((res, rej) => { port.on('open', res); port.on('error', rej); });

const sensor = new Sps30(port);

try {
  try { await sensor.stopMeasurement(); } catch {}
  await sleep(100);

  const serialNumber = await sensor.readSerialNumber();
  console.log(`serial_number: ${serialNumber}`);

  const productType = await sensor.readProductType();
  console.log(`product_type: ${productType}`);

  await sensor.startMeasurement(0x03); // float = IEEE754 big-endian

  if (values.clean) {
    console.log('starting fan clean (~10s)...');
    await sensor.startFanClean();
    console.log('fan clean done');
  }

  for (let i = 0; i < 50; i++) {
    try {
      await sleep(1000);
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
    } catch {
      continue;
    }
  }

  await sensor.stopMeasurement();
} finally {
  port.close();
}
