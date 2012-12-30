node-dbus
===========
D-bus protocol client and server for node.js

Installation
------------

Important: install `socat` to be able to use session bus.

```shell
npm install dbus-native
```
or

```shell
git clone https://github.com/sidorares/node-dbus # clone the repo
cd node-dbus 
npm install # install dependencies
sudo cp examples/com.github.sidorares.dbus.Example.conf /etc/dbus-1/system.d/ # if you want to test examples/service.js
```

Usage
------

Short example using desktop notifications service

```js
var dbus = require('dbus-native');
var sessionBus = dbus.sessionBus();
sessionBus.getService('org.freedesktop.Notifications').getInterface(
    '/org/freedesktop/Notifications', 
    'org.freedesktop.Notifications', function(err, notifications) {
        
    // dbus signals are EventEmitter events
    notifications.on('ActionInvoked', function() {
        console.log('ActionInvoked', arguments);
    }); 
    notifications.on('NotificationClosed', function() {
        console.log('NotificationClosed', arguments);
    });
    notifications.Notify('exampl', 0, '', 'summary 3', 'new message text', ['xxx yyy', 'test2', 'test3', 'test4'], [],  5, function(err, id) {
       //setTimeout(function() { n.CloseNotification(id, console.log); }, 4000);
    });
});
```
