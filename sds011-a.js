const { SerialPort } = require('serialport');

const port = new SerialPort({
  path: '/dev/cu.usbserial-440',
  baudRate: 9600,
});

let buf = Buffer.alloc(0);

port.on('data', (data) => {
  buf = Buffer.concat([buf, data]);

  while (buf.length >= 10) {
    // Find start byte
    const start = buf.indexOf(0xAA);
    if (start === -1) { buf = Buffer.alloc(0); return; }
    if (start > 0) { buf = buf.subarray(start); }
    if (buf.length < 10) return;

    // Validate: command byte and tail byte
    if (buf[1] !== 0xC0 || buf[9] !== 0xAB) {
      buf = buf.subarray(1);
      continue;
    }

    // Checksum: sum of bytes 2-7 mod 256
    let checksum = 0;
    for (let i = 2; i <= 7; i++) checksum += buf[i];
    if ((checksum & 0xFF) !== buf[8]) {
      buf = buf.subarray(1);
      continue;
    }

    const pm25 = (buf[3] * 256 + buf[2]) / 10;
    const pm10 = (buf[5] * 256 + buf[4]) / 10;
    const deviceId = buf[6].toString(16) + buf[7].toString(16);

    console.log(`PM2.5: ${pm25} µg/m³  PM10: ${pm10} µg/m³  (device: ${deviceId})`);

    buf = buf.subarray(10);
  }
});

port.on('error', (err) => console.error(err.message));