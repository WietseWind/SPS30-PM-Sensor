#!/usr/bin/env node

/**
 * Simulates what a Dragino RS485-NB would do:
 *  1. Send raw SHDLC frames to the SPS30
 *  2. Capture the raw bytes back (no parsing, just buffer everything)
 *  3. Then decode the raw bytes as if they arrived as a hex payload from NB-IoT
 */

import { SerialPort } from 'serialport';
import { setTimeout as sleep } from 'timers/promises';
import { parseArgs } from 'util';

// --- Pre-built raw SHDLC frames (exactly what the Dragino would send) --------

const FRAMES = {
  stop:  Buffer.from([0x7e, 0x00, 0x01, 0x00, 0xfe, 0x7e]),
  // start measurement, uint16 format: sub-cmd 0x01, format 0x05
  start: Buffer.from([0x7e, 0x00, 0x00, 0x02, 0x01, 0x05, 0xf7, 0x7e]),
  // read measured values
  read:  Buffer.from([0x7e, 0x00, 0x03, 0x00, 0xfc, 0x7e]),
};

// --- Raw send + capture (no SHDLC awareness) ---------------------------------

function sendAndCapture(port, frame, captureMs = 1000) {
  return new Promise((resolve) => {
    const chunks = [];
    const onData = (chunk) => chunks.push(Buffer.from(chunk));
    port.on('data', onData);
    port.write(frame);
    setTimeout(() => {
      port.off('data', onData);
      resolve(Buffer.concat(chunks));
    }, captureMs);
  });
}

// --- Dragino-side: decode raw payload ----------------------------------------

function decodeRawShdlc(raw) {
  const hex = Buffer.from(raw).toString('hex').match(/.{2}/g).join(' ');
  console.log(`  raw hex (${raw.length} bytes): ${hex}`);

  // find frame delimiters
  const first = raw.indexOf(0x7e);
  const last = raw.lastIndexOf(0x7e);
  if (first === -1 || first === last) {
    console.log('  no valid SHDLC frame found');
    return null;
  }

  // unstuff
  const inner = raw.subarray(first + 1, last);
  const body = [];
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === 0x7d && i + 1 < inner.length) {
      const map = { 0x5e: 0x7e, 0x5d: 0x7d, 0x31: 0x11, 0x33: 0x13 };
      body.push(map[inner[++i]] ?? inner[i]);
    } else {
      body.push(inner[i]);
    }
  }

  const [addr, cmd, state, len, ...rest] = body;
  const data = rest.slice(0, len);
  const chk = rest[len];

  console.log(`  addr=0x${addr.toString(16)} cmd=0x${cmd.toString(16)} state=0x${state.toString(16)} len=${len} chk=0x${chk?.toString(16)}`);

  const sum = (addr + cmd + state + len + data.reduce((s, b) => s + b, 0) + (chk ?? 0)) & 0xff;
  console.log(`  checksum ${sum === 0xff ? 'OK' : 'FAIL'}`);

  if (data.length >= 20) {
    const buf = Buffer.from(data);
    const f = (n) => n.toString().padStart(5);
    console.log(`  --- decoded uint16 values ---`);
    console.log(`  PM1.0:  ${f(buf.readUInt16BE(0))} µg/m³   nc_0p5: ${f(buf.readUInt16BE(8))} #/cm³`);
    console.log(`  PM2.5:  ${f(buf.readUInt16BE(2))} µg/m³   nc_1p0: ${f(buf.readUInt16BE(10))} #/cm³`);
    console.log(`  PM4.0:  ${f(buf.readUInt16BE(4))} µg/m³   nc_2p5: ${f(buf.readUInt16BE(12))} #/cm³`);
    console.log(`  PM10:   ${f(buf.readUInt16BE(6))} µg/m³   nc_4p0: ${f(buf.readUInt16BE(14))} #/cm³`);
    console.log(`                              nc_10p0: ${f(buf.readUInt16BE(16))} #/cm³`);
    console.log(`                     typical_size: ${f(buf.readUInt16BE(18))}`);
  }

  return data;
}

// --- main --------------------------------------------------------------------

const { values } = parseArgs({
  options: { 'serial-port': { type: 'string', short: 'p', default: '/dev/cu.usbserial-440' } },
});

const port = new SerialPort({ path: values['serial-port'], baudRate: 115200 });
await new Promise((res, rej) => { port.on('open', res); port.on('error', rej); });

try {
  // 1. stop (ignore errors, sensor might not be running)
  console.log('>>> sending STOP');
  const stopResp = await sendAndCapture(port, FRAMES.stop, 500);
  console.log(`  got ${stopResp.length} bytes back`);

  // 2. start measurement
  console.log('\n>>> sending START (uint16 mode)');
  const startResp = await sendAndCapture(port, FRAMES.start, 500);
  console.log(`  got ${startResp.length} bytes back`);

  // 3. wait for sensor to produce data
  console.log('\nwaiting 3s for sensor warm-up...\n');
  await sleep(3000);

  // 4. read a few times
  for (let i = 0; i < 10; i++) {
    console.log(`>>> READ #${i + 1}`);
    const raw = await sendAndCapture(port, FRAMES.read, 500);
    decodeRawShdlc(raw);
    console.log('');
    await sleep(1000);
  }

  // 5. stop
  console.log('>>> sending STOP');
  await sendAndCapture(port, FRAMES.stop, 500);
} finally {
  port.close();
}
