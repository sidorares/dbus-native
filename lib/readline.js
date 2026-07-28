// Read a single LF-terminated line from a stream, leaving anything after the
// newline on the stream for the next reader.
//
// Used by the SASL handshake, which is line oriented; once BEGIN has been sent
// the connection switches to binary framing and this is no longer involved.
module.exports = function readOneLine(stream, cb) {
  const parts = [];

  function readable() {
    let chunk;
    while ((chunk = stream.read()) !== null) {
      const newline = chunk.indexOf(0x0a);
      if (newline === -1) {
        parts.push(chunk);
        continue;
      }

      parts.push(chunk.subarray(0, newline));
      const line = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      const rest = chunk.subarray(newline + 1);

      // Detach before handing anything back: the callback normally starts the
      // next readOneLine, and unshift() re-emits 'readable'.
      stream.removeListener('readable', readable);
      if (rest.length > 0) stream.unshift(rest);

      try {
        cb(line);
      } catch (error) {
        stream.emit('error', error);
      }
      return;
    }
  }

  stream.on('readable', readable);
};
