const dbus = require('../index');

const bus = dbus.sessionBus();
const ayatana = bus.getService('org.ayatana.bamf');

bus.connection.on('message', console.log);

ayatana.getInterface(
  '/org/ayatana/bamf/matcher',
  'org.ayatana.bamf.matcher',
  (err, bm) => {
    console.log(err, bm);
    bm.on('ActiveWindowChanged', (oldwin, newwin) => {
      console.log('ActiveWindowChanged', oldwin, newwin);
    });
    bm.on('ActiveApplicationChanged', (oldwin, newwin) => {
      console.log('ActiveApplicationChanged', oldwin, newwin);
    });
  }
);
