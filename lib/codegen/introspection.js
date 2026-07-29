// Turn introspection XML into a plain description that the emitters consume.
//
// xml2js produces a shape that is awkward to walk ('$' attribute bags, arrays
// everywhere, keys missing when an element is absent). Normalising once here
// keeps that out of the emitters and gives the tests something readable to
// assert against.

const xml2js = require('xml2js');

const attrs = el => (el && el.$) || {};

function normaliseArgs(list, defaultDirection) {
  return (list || []).map((arg, index) => {
    const a = attrs(arg);
    return {
      name: a.name || `${a.direction || defaultDirection}${index}`,
      type: a.type || '',
      direction: a.direction || defaultDirection
    };
  });
}

function normaliseInterface(el) {
  const name = attrs(el).name;
  return {
    name,
    methods: (el.method || []).map(m => {
      const args = normaliseArgs(m.arg, 'in');
      return {
        name: attrs(m).name,
        args: args.filter(a => a.direction === 'in'),
        returns: args.filter(a => a.direction === 'out'),
        annotations: (m.annotation || []).map(a => attrs(a))
      };
    }),
    signals: (el.signal || []).map(s => ({
      name: attrs(s).name,
      args: normaliseArgs(s.arg, 'out')
    })),
    properties: (el.property || []).map(p => {
      const a = attrs(p);
      return {
        name: a.name,
        type: a.type || '',
        access: a.access || 'read'
      };
    })
  };
}

/**
 * @returns {Promise<{ interfaces: Array, nodes: string[] }>}
 */
async function parseIntrospection(xml) {
  const parsed = await new xml2js.Parser().parseStringPromise(xml);
  if (!parsed || !parsed.node) {
    throw new Error('Introspection data has no root <node> element');
  }
  const root = parsed.node;
  return {
    // A service may legitimately expose no interfaces at a given path -- it is
    // just a container for child nodes. Returning an empty list rather than
    // throwing is what stops the crash in issue #148.
    interfaces: (root.interface || []).map(normaliseInterface),
    nodes: (root.node || []).map(n => attrs(n).name).filter(Boolean)
  };
}

module.exports = { parseIntrospection };
