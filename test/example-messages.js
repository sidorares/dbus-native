const { describe, it } = require('node:test');
const fs = require('fs');
const assert = require('assert');
const unmarshall = require('../lib/message').unmarshall;
const marshall = require('../lib/message').marshall;

const dir = `${__dirname}/fixtures/messages/`;

describe('given base-64 encoded files with complete messages', () => {
  it('should be able to read them all', () => {
    const messages = fs.readdirSync(dir);
    messages.forEach(name => {
      const msg = fs.readFileSync(dir + name, 'ascii');
      const msgBin = Buffer.from(msg, 'base64');
      const unmarshalledMsg = unmarshall(msgBin);
      const marshalled = marshall(unmarshalledMsg);
      assert.deepStrictEqual(unmarshalledMsg, unmarshall(marshalled));
    });
  });
});
