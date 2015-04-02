function align(ps, n) {
    var pad = n - ps._offset % n;
    if (pad === 0 || pad === n) return;
    // TODO: write8(0) in a loop (3 to 7 times here) could be more efficient
    var padBuff = Buffer(pad);
    padBuff.fill(0);
    ps.put(Buffer(padBuff));
    ps._offset += pad;
}

exports.align = align;