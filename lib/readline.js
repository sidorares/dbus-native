module.exports = function readOneLine (stream, cb) {
  var bytes = [];
  function readable () {
    // TODO (eslint): really infinite?
    while (true) {
      var buf = stream.read(1);
      if (!buf) { return; }
      var b = buf[0];
      if (b === 0x0a) {
        try {
          cb(new Buffer(bytes));
        } catch (error) {
          stream.emit('error', error);
        }
        stream.removeListener('readable', readable);
        return;
      }
      bytes.push(b);
    }
  }
  stream.on('readable', readable);
};
