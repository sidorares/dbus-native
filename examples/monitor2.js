var dbus = require('../index.js');
var bus = dbus.sessionBus();
// TODO: put all matches to one string here
bus.invoke({
   member: 'AddMatch',
   signature: 's',
   body: ["type='signal',"]
});

/*
bus.invoke({
   member: 'AddMatch',
   signature: 's',
   body: ["type='method_call'"]
});
bus.invoke({
   member: 'AddMatch',
   signature: 's',
   body: ["type='method_return'"]
});
*/
