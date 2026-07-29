# D-Bus proxy / web client example

A bridge between a browser and the session bus. `server.js` accepts
[SockJS](https://github.com/sockjs/sockjs-node) connections, parses each
incoming frame as a JSON D-Bus message and hands it straight to
`connection.message()`; every message coming back off the bus is stringified
and written to the socket. `index.html` is a page that opens one of those
sockets, subscribes to all traffic with three `AddMatch` calls, and renders any
`a(ssssbbusbbi)` reply it sees as an image — that signature is the old
`indicator-sound` menu, hence the `<img>`.

Based on the sockjs `echo` example.

```bash
cd examples/dbusproxy && npm install && node server.js
```

Then open <http://127.0.0.1:9999/>.

> **This is a demonstration, not something to deploy.** Anything that connects
> to the port gets unauthenticated access to your session bus, which is to say
> to your desktop: notifications, secrets prompts, systemd, whatever else is on
> there. It listens on the loopback interface for that reason. Do not put it on
> a routable address, and do not put it behind a reverse proxy.
