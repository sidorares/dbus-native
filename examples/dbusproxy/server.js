const http = require('http');
const fs = require('fs');
const path = require('path');
const sockjs = require('sockjs');
const dbus = require('../../index');

// 1. Echo sockjs server
const sockjs_opts = {
  sockjs_url: 'https://cdn.jsdelivr.net/npm/sockjs-client@1/dist/sockjs.min.js'
};

const sockjs_echo = sockjs.createServer(sockjs_opts);
sockjs_echo.on('connection', conn => {
  const dbusConn = dbus.sessionBus().connection;
  conn.on('data', message => {
    //conn.write(message);
    try {
      //console.log('about to parse', message)
      const o = JSON.parse(message);
      //console.log('after parse', [o]);
      try {
        dbusConn.message(o);
      } catch (ee) {
        console.log(ee);
      }
      //console.log('sent to dbus');
    } catch {}
  });
  dbusConn.on('message', msg => {
    //console.log('GOT MESSAGE', msg);
    conn.write(JSON.stringify(msg));
    //conn.write(msg);
  });
});

// 2. Static files server
//
// One page, served from a fixed path. This used to be `node-static`, which is
// unmaintained and carries an unfixed directory-traversal advisory
// (CVE-2023-26111) -- for a single file that is a dependency, and an attack
// surface, in exchange for nothing. Nothing here is built from the request, so
// there is no path to traverse.
const indexHtml = path.join(__dirname, 'index.html');
const serveIndex = (req, res) => {
  if (req.url !== '/' && req.url.split('?')[0] !== '/index.html') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found\n');
  }
  fs.readFile(indexHtml, (err, body) => {
    if (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end(`${err.message}\n`);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
};

// 3. Usual http stuff
const server = http.createServer();
server.addListener('request', serveIndex);
server.addListener('upgrade', (req, res) => {
  res.end();
});

sockjs_echo.installHandlers(server, { prefix: '/echo' });

// Bound to the loopback interface on purpose. Every message arriving on the
// socket is forwarded to the session bus unauthenticated, so anyone who can
// reach this port can do anything the user can: read their keyring prompts,
// drive their desktop, call systemd. It used to listen on 0.0.0.0, which
// offered all of that to the local network.
console.log(' [*] Listening on 127.0.0.1:9999');
server.listen(9999, '127.0.0.1');
