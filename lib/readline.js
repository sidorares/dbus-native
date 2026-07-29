// Read a single LF-terminated line from a stream, leaving anything after the
// newline on the stream for the next reader.
//
// Used by the SASL handshake, which is line oriented; once BEGIN has been sent
// the connection switches to binary framing and this is no longer involved.
module.exports = function readOneLine(stream, cb) {
  const parts = [];
  let finished = false;

  function readable() {
    if (finished) return;
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
      finished = true;
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

  // Kick it, because attaching the listener is not always enough.
  //
  // read() hands back one buffered chunk at a time, so a peer that wrote three
  // lines in three writes leaves two chunks queued once the first line comes
  // out. Attaching a 'readable' listener while data is already buffered would
  // normally schedule an emit -- but not while an emission is already in
  // progress, and that is exactly the case here: a line-oriented conversation
  // starts its next read from inside the callback of the previous one, which
  // runs inside that emit. The new listener then waits forever for bytes that
  // arrived before it existed, and the exchange stops dead.
  //
  // Harmless when nothing is waiting: read() returns null and the loop does
  // not run. `finished` keeps this from racing a real 'readable'.
  process.nextTick(readable);
};
