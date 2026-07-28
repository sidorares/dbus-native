const dbus = require('../index');

const bus = dbus.sessionBus();
const panel = bus.getService('com.canonical.Unity.Panel.Service');
panel.getInterface(
  '/com/canonical/Unity/Panel/Service',
  'com.canonical.Unity.Panel.Service',
  (err, nm) => {
    nm.addListener('EntryActivated', entry => {
      console.log(entry);
    });
  }
);
