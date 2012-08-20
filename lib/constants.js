module.exports = {
    messageType: {
       invalid: 0,
       methodCall: 1,
       methodReturn: 2,
       error: 2,
       signal: 4  
    }, 
    headerTypeName: [
      null, 'path',
      'interface', 'member',
      'errorName', 'replySerial',
      'destination', 'sender', 'signature'
    ],
    headerTypeId: {
      path: 1,
      interface: 2,
      member: 3,
      errorName: 4,
      repySerial: 5,
      destination: 6,
      sender: 7,
      signature: 8
    },
    flags: {
       noReplyExpected: 1,
       noAutoStart: 2
    },
    endianness: {
       le: 108,
       be: 66
    },
    messageSignature: 'yyyyuua(yv)'
}
