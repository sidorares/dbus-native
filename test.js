var dbus = require('./index.js');
var conn = dbus();

conn.message({
   path: '/org/freedesctop/DBus',
   destination: 'org.freedesktop.DBus',
   interface: 'org.freedesktop.DBus',
   member: 'Hello',
});

conn.message({
   path: '/org/freedesctop/DBus',
   destination: 'org.freedesktop.DBus',
   interface: 'org.freedesktop.DBus',
   member: 'AddMatch',
   signature: 's',
   body: "type='signal'"
});

conn.message({
   path: '/org/freedesctop/DBus',
   destination: 'org.freedesktop.DBus',
   interface: 'org.freedesktop.DBus',
   member: 'AddMatch',
   signature: 's',
   body: "type='method_call'"
});

conn.message({
   path: '/org/freedesctop/DBus',
   destination: 'org.freedesktop.DBus',
   interface: 'org.freedesktop.DBus',
   member: 'AddMatch',
   signature: 's',
   body: "type='method_return'"
});

/*

from client00000000: 6c01 0001 1200 0000 0200 0000 7f00 0000  l...............
from client00000010: 0101 6f00 1500 0000 2f6f 7267 2f66 7265  ..o...../org/fre
from client00000020: 6564 6573 6b74 6f70 2f44 4275 7300 0000  edesktop/DBus...
from client00000030: 0601 7300 1400 0000 6f72 672e 6672 6565  ..s.....org.free
from client00000040: 6465 736b 746f 702e 4442 7573 0000 0000  desktop.DBus....
from client00000050: 0201 7300 1400 0000 6f72 672e 6672 6565  ..s.....org.free
from client00000060: 6465 736b 746f 702e 4442 7573 0000 0000  desktop.DBus....
from client00000070: 0301 7300 0800 0000 4164 644d 6174 6368  ..s.....AddMatch
from client00000080: 0000 0000 0000 0000 0801 6700 0173 0000  ..........g..s..
from client00000090: 0d00 0000 7479 7065 3d27 7369 676e 616c  ....type='signal
from client000000a0: 2700                                     '.

*/
