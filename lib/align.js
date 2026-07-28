function align(ps, n) {
  const pad = n - (ps._offset % n);
  if (pad === 0 || pad === n) return;
  // Buffer.alloc() is already zero-filled, which is exactly what d-bus
  // padding bytes must be.
  ps.put(Buffer.alloc(pad));
  ps._offset += pad;
}

exports.align = align;
