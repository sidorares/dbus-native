// Read the dbus address from the X11 window selection.
//
// This is an optional helper: it is not reachable from index.js and `x11` is
// deliberately not a dependency of dbus-native. Install it yourself
// (`npm install x11`) if you need this fallback.

const x11 = require('x11');
const fs = require('fs');
const os = require('os');

function getDbusAddress(callback) {
  // read machine uuid
  fs.readFile('/var/lib/dbus/machine-id', 'ascii', (err, uuid) => {
    if (err) return callback(err);
    const hostname = os.hostname().split('-')[0];
    x11.createClient((err, display) => {
      const X = display.client;
      const selectionName = `_DBUS_SESSION_BUS_SELECTION_${
        hostname
      }_${uuid.trim()}`;
      X.InternAtom(false, selectionName, (err, id) => {
        if (err) return callback(err);
        X.GetSelectionOwner(id, (err, win) => {
          if (err) return callback(err);
          X.InternAtom(false, '_DBUS_SESSION_BUS_ADDRESS', (err, propId) => {
            if (err) return callback(err);
            win = display.screen[0].root;
            X.GetProperty(0, win, propId, 0, 0, 10000000, (err, val) => {
              if (err) return callback(err);
              callback(null, val.data.toString());
            });
          });
        });
      });
    });
  });
}

module.exports = getDbusAddress;
