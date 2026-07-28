const dbus = require('../index');

const bus = dbus.systemBus();
bus.invoke({
  member: 'AddMatch',
  signature: 's',
  body: ["type='signal'"]
});
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
