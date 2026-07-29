// The Introspect reply has to be well-formed XML whatever the service put in
// its interface descriptor.
//
// Names that go in the message header are validated at export (see names.js),
// but argument names are not -- the spec gives them no rule and the DTD
// declares the attribute CDATA -- and a property's declared `type` is passed
// through unparsed. An unescaped '&' or '"' in either does not just spoil one
// attribute: it makes the whole document ill-formed, so a peer's parser throws
// and the caller loses every interface on the object.

const { describe, it } = require('node:test');
const assert = require('assert');
const xml2js = require('xml2js');
const stdifaces = require('../lib/stdifaces');
const constants = require('../lib/constants');
const { processXML } = require('../lib/introspect');

// Drive the real Introspect handler and hand back the XML it would send.
function introspect(path, iface) {
  let reply;
  const bus = {
    serial: 1,
    exportedObjects: { [path]: { [iface.name]: [iface, {}] } },
    connection: {
      message: msg => {
        reply = msg;
      }
    }
  };
  const handled = stdifaces(
    {
      interface: 'org.freedesktop.DBus.Introspectable',
      member: 'Introspect',
      path,
      serial: 7,
      sender: ':1.2'
    },
    bus
  );
  assert.strictEqual(handled, 1, 'the handler claimed the message');
  assert.strictEqual(reply.type, constants.messageType.methodReturn);
  return reply.body[0];
}

const parse = xml =>
  new Promise((resolve, reject) =>
    new xml2js.Parser().parseString(xml, (err, result) =>
      err ? reject(err) : resolve(result)
    )
  );

const PATH = '/com/example/Obj';

describe('introspection XML escaping', () => {
  it('escapes an argument name that would otherwise break the document', async () => {
    const xml = introspect(PATH, {
      name: 'com.example.Iface',
      methods: { Frob: ['s', 's', ['a&b'], ['out']] },
      signals: {},
      properties: {}
    });

    assert.match(xml, /name="a&amp;b"/);
    assert.doesNotMatch(xml, /name="a&b"/);
    // The real assertion: a peer can still read it.
    const parsed = await parse(xml);
    const [arg] = parsed.node.interface[0].method[0].arg;
    assert.strictEqual(arg['$'].name, 'a&b', 'and gets the name back intact');
  });

  it('escapes a quote, which would otherwise inject an attribute', async () => {
    const xml = introspect(PATH, {
      name: 'com.example.Iface',
      methods: { Frob: ['s', '', ['ok" /><evil name="pwned'], []] },
      signals: {},
      properties: {}
    });

    assert.doesNotMatch(xml, /<evil/);
    const parsed = await parse(xml);
    const [arg] = parsed.node.interface[0].method[0].arg;
    assert.strictEqual(arg['$'].name, 'ok" /><evil name="pwned');
  });

  it('escapes a declared property type, which is never parsed', async () => {
    const xml = introspect(PATH, {
      name: 'com.example.Iface',
      methods: {},
      signals: {},
      properties: { Broken: { type: 's" access="readwrite', access: 'read' } }
    });

    const parsed = await parse(xml);
    const [prop] = parsed.node.interface[0].property;
    assert.strictEqual(prop['$'].type, 's" access="readwrite');
    assert.strictEqual(prop['$'].access, 'read', 'the real access survives');
  });

  it('escapes a signal argument name', async () => {
    const xml = introspect(PATH, {
      name: 'com.example.Iface',
      methods: {},
      signals: { Pinged: ['s', 'who <& why'] },
      properties: {}
    });

    const parsed = await parse(xml);
    const [arg] = parsed.node.interface[0].signal[0].arg;
    assert.strictEqual(arg['$'].name, 'who <& why');
    assert.strictEqual(arg['$'].direction, undefined, 'signals have none');
  });

  it('leaves ordinary names byte for byte as they were', async () => {
    const xml = introspect(PATH, {
      name: 'com.example.Iface',
      methods: { Frob: ['s', 's', ['input'], ['output']] },
      signals: { Pinged: ['s', 'who'] },
      properties: { Greeting: 's', 'my-prop': { type: 'b', access: 'read' } }
    });

    assert.match(
      xml,
      /<arg type="s" name="input" direction="in" \/>\n {6}<arg type="s" name="output" direction="out" \/>/
    );
    assert.match(xml, /<arg type="s" name="who" \/>/);
    assert.match(
      xml,
      /<property name="Greeting" type="s" access="readwrite"\/>/
    );
    assert.match(xml, /<property name="my-prop" type="b" access="read"\/>/);
    await parse(xml); // and it is still well-formed
  });

  it('survives the round trip into a client proxy', async () => {
    const xml = introspect(PATH, {
      name: 'com.example.Iface',
      methods: { Frob: ['s', 's', ['a&b'], ['c<d']] },
      signals: {},
      properties: {}
    });

    // processXML is what getInterface() feeds the reply to. Before the fix it
    // called back with an xml2js parse error and no interface at all.
    const obj = { name: PATH, service: { name: 'com.example', bus: {} } };
    const proxy = await new Promise((resolve, reject) =>
      processXML(null, xml, obj, (err, result) =>
        err ? reject(err) : resolve(result)
      )
    );
    assert.ok(proxy['com.example.Iface'], 'the interface came back');
    assert.strictEqual(typeof proxy['com.example.Iface'].Frob, 'function');
  });
});
