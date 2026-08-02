import Layout from '@theme/Layout';
import CodeBlock from '@theme/CodeBlock';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

import styles from './index.module.css';

const features = [
  {
    title: 'Pure JavaScript',
    body: 'No native addons and no build step. The protocol is implemented directly, so the package installs anywhere node does and has one runtime dependency.'
  },
  {
    title: 'Client and server',
    body: 'Call methods on a service, export one of your own, or run a message bus in process for tests. The low-level connection is available when you want the messages themselves.'
  },
  {
    title: 'Promises or callbacks',
    body: 'Every callback-taking method returns a promise when you omit the callback, and the callback form is unchanged. Failures reject with a DBusError carrying the call site.'
  },
  {
    title: 'Types included',
    body: (
      <>
        Types ship with the package and are checked in CI, so they cannot drift.{' '}
        <code>dbus-native types</code> introspects a live service and writes
        TypeScript declarations for it.
      </>
    )
  },
  {
    title: 'Values that look like values',
    body: 'A variant is the value it holds, a string-keyed dict is a plain object, and 64-bit integers are bigint. Each old shape is still available per connection.'
  },
  {
    title: 'Observable and cancellable',
    body: 'Traffic and call timing are published on diagnostics_channel. Calls take a timeout and an AbortSignal, so nothing is left pending forever.'
  }
];

const callExample = `const dbus = require('dbus-native');
const bus = dbus.sessionBus();

const notifications = await bus
  .getService('org.freedesktop.Notifications')
  .getInterface(
    '/org/freedesktop/Notifications',
    'org.freedesktop.Notifications'
  );

const id = await notifications.Notify(
  'example', 0, '', 'summary', 'body text', [], [], 5000
);

notifications.on('ActionInvoked', (id, action) => console.log(id, action));`;

const serviceExample = `const { defineInterface } = require('dbus-native');

const greeter = defineInterface({
  name: 'com.example.Greeter',
  methods: {
    Hello: {
      in: { name: 's' },
      out: { greeting: 's' },
      handler: ({ name }, { sender }) => \`Hello \${name}, from \${sender}\`
    }
  },
  signals: { Greeted: { args: { who: 's' } } }
});

await bus.requestName('com.example.Greeter', 0);
await bus.export('/com/example/Greeter', greeter);

greeter.emit.Greeted('world');`;

function Hero() {
  const { siteConfig } = useDocusaurusContext();

  return (
    <header className={styles.hero}>
      <div className="container">
        <h1 className={styles.title}>{siteConfig.title}</h1>
        <p className={styles.tagline}>{siteConfig.tagline}</p>

        <div className={styles.buttons}>
          <Link className="button button--primary button--lg" to="/docs/">
            Read the docs
          </Link>
          <Link className="button button--secondary button--lg" to="/docs/api">
            API reference
          </Link>
        </div>

        <div className={styles.install}>
          <CodeBlock language="shell">npm install dbus-native</CodeBlock>
        </div>
      </div>
    </header>
  );
}

export default function Home() {
  return (
    <Layout description="D-Bus protocol client and server for node.js, implemented in pure JavaScript. Reference documentation, migration guides and the release plan.">
      <Hero />

      <main>
        <section className={styles.section}>
          <div className="container">
            <div className={styles.features}>
              {features.map(feature => (
                <div className={styles.feature} key={feature.title}>
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.sectionAlt}>
          <div className="container">
            <h2 className={styles.sectionTitle}>Both ends of the bus</h2>
            <div className={styles.exampleGrid}>
              <div>
                <CodeBlock language="js" title="Calling a service">
                  {callExample}
                </CodeBlock>
              </div>
              <div>
                <CodeBlock language="js" title="Exporting one">
                  {serviceExample}
                </CodeBlock>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className="container">
            <h2 className={styles.sectionTitle}>Upgrading?</h2>
            <div className={styles.features}>
              <div className={styles.feature}>
                <h3>
                  <Link to="/docs/migrating-to-2.0">Migrating to 0.14.0</Link>
                </h3>
                <p>
                  Variants, dicts and 64-bit integers changed shape. Leads with
                  bigint, which is the part that breaks code far from the call.
                </p>
              </div>
              <div className={styles.feature}>
                <h3>
                  <Link to="/docs/migrating-to-0.7">Migrating to 0.7</Link>
                </h3>
                <p>
                  D-Bus errors became real Error objects. A codemod rewrites the
                  call sites it can attribute, and reports the rest.
                </p>
              </div>
              <div className={styles.feature}>
                <h3>
                  <Link to="/docs/deprecations">Deprecations</Link>
                </h3>
                <p>
                  Stable codes for behaviour that changes in a future major, so
                  you can migrate before it does.{' '}
                  <code>npx dbus-native lint</code> finds the call sites.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
