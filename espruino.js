USB.setConsole(1);

var DELIM = 0x7E;
var STUFF = {};
STUFF[0x7E] = [0x7D,0x5E];
STUFF[0x7D] = [0x7D,0x5D];
STUFF[0x11] = [0x7D,0x31];
STUFF[0x13] = [0x7D,0x33];
var UNSTUFF = {0x5E:0x7E, 0x5D:0x7D, 0x31:0x11, 0x33:0x13};

function buildFrame(cmd, data) {
  if (!data) data = [];
  var len = data.length;
  var sum = cmd + len;
  for (var i = 0; i < data.length; i++) sum += data[i];
  var chk = (~sum) & 0xFF;
  var raw = [0x00, cmd, len].concat(data, [chk]);
  var out = [DELIM];
  for (var i = 0; i < raw.length; i++) {
    var s = STUFF[raw[i]];
    if (s) { out.push(s[0]); out.push(s[1]); }
    else out.push(raw[i]);
  }
  out.push(DELIM);
  return out;
}

function parseResponse(bytes) {
  var first = -1;
  for (var i = 0; i < bytes.length; i++) {
    if (bytes[i] === DELIM) { first = i; break; }
  }
  var last = -1;
  for (var i = bytes.length - 1; i > first; i--) {
    if (bytes[i] === DELIM) { last = i; break; }
  }
  if (first === -1 || last === -1 || first === last) throw "incomplete frame";

  var body = [];
  for (var i = first + 1; i < last; i++) {
    if (bytes[i] === 0x7D && i + 1 < last) {
      i++;
      body.push(UNSTUFF[bytes[i]] !== undefined ? UNSTUFF[bytes[i]] : bytes[i]);
    } else {
      body.push(bytes[i]);
    }
  }

  var addr = body[0], cmd = body[1], state = body[2], len = body[3];
  var data = body.slice(4, 4 + len);
  var chk = body[4 + len];
  var s = addr + cmd + state + len + chk;
  for (var i = 0; i < data.length; i++) s += data[i];
  if ((s & 0xFF) !== 0xFF) throw "checksum";
  if (state !== 0) throw "state 0x" + state.toString(16);
  return data;
}

function readFloatBE(data, off) {
  var buf = new ArrayBuffer(4);
  var u8 = new Uint8Array(buf);
  u8[0] = data[off];
  u8[1] = data[off+1];
  u8[2] = data[off+2];
  u8[3] = data[off+3];
  return new DataView(buf).getFloat32(0, false);
}

function shdlc(cmd, data, cb) {
  var chunks = [];
  var started = false;
  var timer;

  function onData(d) {
    for (var i = 0; i < d.length; i++) {
      var b = d.charCodeAt(i);
      if (b === DELIM) {
        if (!started) { started = true; chunks = [b]; }
        else {
          chunks.push(b);
          clearTimeout(timer);
          Serial1.removeListener('data', onData);
          try { cb(null, parseResponse(chunks)); }
          catch (e) { cb(e); }
          return;
        }
      } else if (started) {
        chunks.push(b);
      }
    }
  }

  timer = setTimeout(function() {
    Serial1.removeListener('data', onData);
    cb("timeout 0x" + cmd.toString(16));
  }, 1000);

  Serial1.on('data', onData);
  Serial1.write(buildFrame(cmd, data));
}

// --- globals -----------------------------------------------------------------

var sensorSerial = "unknown";
var history = [];
var HISTORY_MAX = 30;
var wsClients = [];

function f(n) { return n.toFixed(1); }
function f3(n) { return n.toFixed(3); }

// --- web ---------------------------------------------------------------------

function getPage() {
  return '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
    '<title>SPS30</title><style>' +
    'body{font-family:monospace;max-width:1000px;margin:1rem auto;padding:0 1rem;background:#f8f8f8;color:#222}' +
    'h1{font-size:1.2rem;margin-bottom:.25rem}' +
    'p.meta{color:#666;font-size:.85rem;margin:0 0 1rem}' +
    'table{border-collapse:collapse;width:100%;font-size:.85rem}' +
    'th,td{border:1px solid #ccc;padding:.3rem .5rem;text-align:right}' +
    'th{background:#e8e8e8;text-align:center}' +
    'td:first-child{text-align:left;color:#666}' +
    '.u{display:block;font-size:.7rem;color:#888;font-weight:normal}' +
    '#st{font-size:.8rem;color:#888;margin-bottom:.5rem}' +
    '#st.c{color:#4a4}#st.d{color:#a44}' +
    '#cw{position:relative;height:280px;margin-bottom:1rem}' +
    '</style></head><body>' +
    '<h1>SPS30 Particulate Matter</h1>' +
    '<p class="meta">Serial: ' + sensorSerial + '</p>' +
    '<p id="st" class="d">connecting...</p>' +
    '<div id="cw"><canvas id="ch"></canvas></div>' +
    '<table><thead><tr>' +
    '<th>time</th>' +
    '<th>PM1.0<span class="u">ug/m3</span></th>' +
    '<th>PM2.5<span class="u">ug/m3</span></th>' +
    '<th>PM4.0<span class="u">ug/m3</span></th>' +
    '<th>PM10<span class="u">ug/m3</span></th>' +
    '<th>NC0.5<span class="u">#/cm3</span></th>' +
    '<th>NC1.0<span class="u">#/cm3</span></th>' +
    '<th>NC2.5<span class="u">#/cm3</span></th>' +
    '<th>NC4.0<span class="u">#/cm3</span></th>' +
    '<th>NC10<span class="u">#/cm3</span></th>' +
    '<th>Typ<span class="u">um</span></th>' +
    '</tr></thead><tbody id="tb"></tbody></table>' +
    '<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>' +
    '<script>' +
    'var MAX=200,MR=40,tb=document.getElementById("tb"),st=document.getElementById("st");' +
    'function f(n){return n.toFixed(1)}function f3(n){return n.toFixed(3)}' +
    'var ctx=document.getElementById("ch").getContext("2d");' +
    'var cd={labels:[],datasets:[' +
    '{label:"PM1.0",data:[],borderColor:"#4e9af1",backgroundColor:"transparent",pointRadius:0,tension:.3,yAxisID:"yM"},' +
    '{label:"PM2.5",data:[],borderColor:"#f1a94e",backgroundColor:"transparent",pointRadius:0,tension:.3,yAxisID:"yM"},' +
    '{label:"PM4.0",data:[],borderColor:"#e05c5c",backgroundColor:"transparent",pointRadius:0,tension:.3,yAxisID:"yM"},' +
    '{label:"PM10",data:[],borderColor:"#8e5ce0",backgroundColor:"transparent",pointRadius:0,tension:.3,yAxisID:"yM"},' +
    '{label:"NC0.5",data:[],borderColor:"#4e9af1",borderDash:[4,2],backgroundColor:"transparent",pointRadius:0,tension:.3,yAxisID:"yN"},' +
    '{label:"NC1.0",data:[],borderColor:"#f1a94e",borderDash:[4,2],backgroundColor:"transparent",pointRadius:0,tension:.3,yAxisID:"yN"},' +
    '{label:"NC2.5",data:[],borderColor:"#e05c5c",borderDash:[4,2],backgroundColor:"transparent",pointRadius:0,tension:.3,yAxisID:"yN"},' +
    '{label:"NC4.0",data:[],borderColor:"#8e5ce0",borderDash:[4,2],backgroundColor:"transparent",pointRadius:0,tension:.3,yAxisID:"yN"},' +
    '{label:"NC10",data:[],borderColor:"#5ce0a0",borderDash:[4,2],backgroundColor:"transparent",pointRadius:0,tension:.3,yAxisID:"yN"}' +
    ']};' +
    'var chart=new Chart(ctx,{type:"line",data:cd,options:{animation:false,responsive:true,maintainAspectRatio:false,' +
    'interaction:{mode:"index",intersect:false},' +
    'scales:{x:{ticks:{maxTicksLimit:8,maxRotation:0}},' +
    'yM:{position:"left",title:{display:true,text:"ug/m3"},beginAtZero:true},' +
    'yN:{position:"right",title:{display:true,text:"#/cm3"},beginAtZero:true,grid:{drawOnChartArea:false}}},' +
    'plugins:{legend:{position:"top"}}}});' +
    'function push(m){' +
    'var t=new Date(m.ts).toLocaleTimeString();cd.labels.push(t);' +
    'cd.datasets[0].data.push(m.mc_1p0);cd.datasets[1].data.push(m.mc_2p5);' +
    'cd.datasets[2].data.push(m.mc_4p0);cd.datasets[3].data.push(m.mc_10p0);' +
    'cd.datasets[4].data.push(m.nc_0p5);cd.datasets[5].data.push(m.nc_1p0);' +
    'cd.datasets[6].data.push(m.nc_2p5);cd.datasets[7].data.push(m.nc_4p0);' +
    'cd.datasets[8].data.push(m.nc_10p0);' +
    'if(cd.labels.length>MAX){cd.labels.shift();for(var i=0;i<cd.datasets.length;i++)cd.datasets[i].data.shift()}' +
    'chart.update()}' +
    'function addRow(m){var tr=document.createElement("tr");' +
    'tr.innerHTML="<td>"+new Date(m.ts).toLocaleTimeString()+"</td>"' +
    '+"<td>"+f(m.mc_1p0)+"</td><td>"+f(m.mc_2p5)+"</td><td>"+f(m.mc_4p0)+"</td><td>"+f(m.mc_10p0)+"</td>"' +
    '+"<td>"+f(m.nc_0p5)+"</td><td>"+f(m.nc_1p0)+"</td><td>"+f(m.nc_2p5)+"</td><td>"+f(m.nc_4p0)+"</td>"' +
    '+"<td>"+f(m.nc_10p0)+"</td><td>"+f3(m.typical_particle_size)+"</td>";' +
    'tb.insertBefore(tr,tb.firstChild);while(tb.rows.length>MR)tb.deleteRow(tb.rows.length-1)}' +
    'var lastTs=0;' +
    'function conn(){' +
    'var ws=new WebSocket((location.protocol==="https:"?"wss":"ws")+"://"+location.host);' +
    'ws.onopen=function(){st.textContent="live";st.className="c"};' +
    'ws.onmessage=function(e){var m=JSON.parse(e.data);if(m.ts<=lastTs)return;lastTs=m.ts;push(m);addRow(m)};' +
    'ws.onclose=function(){st.textContent="disconnected";st.className="d";setTimeout(conn,2000)}}' +
    'fetch("/history").then(function(r){return r.json()}).then(function(h){' +
    'for(var i=0;i<h.length;i++){push(h[i]);addRow(h[i])}' +
    'if(h.length)lastTs=h[h.length-1].ts;conn()' +
    '}).catch(function(){conn()});' +
    '</script></body></html>';
}

function pageHandler(req, res) {
  if (req.url === "/history") {
    res.writeHead(200, {"Content-Type": "application/json"});
    res.end(JSON.stringify(history));
    return;
  }
  if (req.url === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(200, {"Content-Type": "text/html"});
  res.end(getPage());
}

function broadcast(obj) {
  history.push(obj);
  if (history.length > HISTORY_MAX) history.shift();
  var msg = JSON.stringify(obj);
  for (var i = wsClients.length - 1; i >= 0; i--) {
    try { wsClients[i].send(msg); }
    catch (e) { wsClients.splice(i, 1); }
  }
}

// --- measurement loop --------------------------------------------------------

function measureLoop() {
  shdlc(0x03, [], function(err, d) {
    if (!err && d.length >= 40) {
      var v = {
        ts: Date.now(),
        mc_1p0:  readFloatBE(d, 0),
        mc_2p5:  readFloatBE(d, 4),
        mc_4p0:  readFloatBE(d, 8),
        mc_10p0: readFloatBE(d, 12),
        nc_0p5:  readFloatBE(d, 16),
        nc_1p0:  readFloatBE(d, 20),
        nc_2p5:  readFloatBE(d, 24),
        nc_4p0:  readFloatBE(d, 28),
        nc_10p0: readFloatBE(d, 32),
        typical_particle_size: readFloatBE(d, 36)
      };
      console.log(
        "PM1.0=" + f(v.mc_1p0) + " PM2.5=" + f(v.mc_2p5) +
        " PM4.0=" + f(v.mc_4p0) + " PM10=" + f(v.mc_10p0) + " ug/m3  " +
        "NC0.5=" + f(v.nc_0p5) + " NC1.0=" + f(v.nc_1p0) +
        " NC2.5=" + f(v.nc_2p5) + " NC4.0=" + f(v.nc_4p0) +
        " NC10=" + f(v.nc_10p0) + " #/cm3  " +
        "typ=" + f3(v.typical_particle_size) + "um"
      );
      broadcast(v);
    } else if (err) {
      console.log("sensor err: " + err);
    }
    setTimeout(measureLoop, 2000);
  });
}

// --- wifi + startup ----------------------------------------------------------

var blinkOn = false;
var blinkInterval = setInterval(function() {
  blinkOn = !blinkOn;
  LED1.write(blinkOn);
}, 500);

var WIFI_NAME = "Datacenter";
var WIFI_OPTIONS = { password: "3Jkje279erkt9" };
var wifi = require("Wifi");

wifi.connect(WIFI_NAME, WIFI_OPTIONS, function(err) {
  if (err) {
    console.log("WiFi error: " + err);
    return;
  }
  console.log("WiFi connected");
});

wifi.on("connected", function() {
  clearInterval(blinkInterval);
  LED1.write(false);

  wifi.getIP(function(err, data) {
    if (err) { console.log("IP error: " + err); return; }
    var ip = data.ip;
    console.log("IP: " + ip);

    // init SPS30
    Serial1.setup(115200, { rx: B7, tx: B6 });

    setTimeout(function() {
      shdlc(0x01, [], function() {
        shdlc(0xD0, [0x03], function(err, data) {
          if (!err) {
            var sn = "";
            for (var i = 0; i < data.length && data[i] !== 0; i++)
              sn += String.fromCharCode(data[i]);
            sensorSerial = sn;
            console.log("SPS30 S/N: " + sn);
          }

          shdlc(0x00, [0x01, 0x03], function(err) {
            if (err) { console.log("start meas err: " + err); return; }
            console.log("SPS30 measurement started");

            // start web server
            var server = require("ws").createServer(pageHandler);
            server.listen(80);
            server.on("websocket", function(ws) {
              wsClients.push(ws);
              console.log("WS client +" + wsClients.length);
              ws.on("close", function() {
                var idx = wsClients.indexOf(ws);
                if (idx >= 0) wsClients.splice(idx, 1);
                console.log("WS client -" + wsClients.length);
              });
            });

            console.log("http://" + ip + "/");
            LED2.write(true);

            // wait a bit for first reading to be ready, then start loop
            setTimeout(measureLoop, 2000);
          });
        });
      });
    }, 500);
  });
});