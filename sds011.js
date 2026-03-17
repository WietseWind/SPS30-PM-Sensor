const { SerialPort } = require('serialport');

const port = new SerialPort({ path: '/dev/cu.usbserial-440', baudRate: 115200 });

let rxBuf = Buffer.alloc(0);
let resolver = null;

port.on('data', (chunk) => {
  rxBuf = Buffer.concat([rxBuf, chunk]);
  if (rxBuf.length >= 7 && rxBuf[0] === 0x7E && rxBuf[rxBuf.length - 1] === 0x7E) {
    if (resolver) { const r = resolver; resolver = null; r(rxBuf); }
  }
});

function waitFrame(ms = 2000) {
  return new Promise((resolve) => {
    rxBuf = Buffer.alloc(0);
    resolver = resolve;
    setTimeout(() => { if (resolver) { resolver = null; resolve(null); } }, ms);
  });
}

function shdlcFrame(cmd, data = []) {
  const len = data.length;
  const sum = (cmd + len + data.reduce((a, b) => a + b, 0)) & 0xFF;
  const checksum = (~sum + 1) & 0xFF;
  const raw = [0x00, cmd, len, ...data, checksum];
  const stuffed = [];
  for (const b of raw) {
    if ([0x7E, 0x7D, 0x11, 0x13].includes(b)) {
      stuffed.push(0x7D, b ^ 0x20);
    } else {
      stuffed.push(b);
    }
  }
  return Buffer.from([0x7E, ...stuffed, 0x7E]);
}

function unstuff(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x7D && i + 1 < buf.length) {
      out.push(buf[++i] ^ 0x20);
    } else {
      out.push(buf[i]);
    }
  }
  return Buffer.from(out);
}

async function send(cmd, data = []) {
  const p = waitFrame();
  port.write(shdlcFrame(cmd, data));
  port.drain();
  const raw = await p;
  if (!raw) return null;
  const inner = unstuff(raw.slice(1, -1));
  return { state: inner[2], data: inner.slice(4, 4 + inner[3]) };
}

async function main() {
  await new Promise(r => port.on('open', r));

  await send(0x01); // stop (ignore error)

  const sn = await send(0xD0, [0x03]);
  console.log('Serial:', sn?.data.toString('ascii'));

  await send(0x00, [0x01, 0x03]); // start measurement, float
  console.log('Warming up...');
  await new Promise(r => setTimeout(r, 2000));

  const loop = async () => {
    while (true) {
      const resp = await send(0x03);
      if (resp?.data.length >= 40) {
        const d = resp.data;
        const f = [];
        for (let i = 0; i < 40; i += 4) f.push(d.readFloatBE(i));
        console.log(
          `PM1.0: ${f[0].toFixed(1)}  PM2.5: ${f[1].toFixed(1)}  ` +
          `PM4.0: ${f[2].toFixed(1)}  PM10: ${f[3].toFixed(1)} µg/m³  |  ` +
          `Size: ${f[9].toFixed(2)} µm`
        );
      } else {
        console.log('No data yet...');
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  };

  process.on('SIGINT', async () => {
    console.log('\nStopping...');
    await send(0x01);
    port.close();
    process.exit();
  });

  await loop();
}

main().catch(console.error);