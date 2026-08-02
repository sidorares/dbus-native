// Every page on this site is a file that already lives in the repository. This
// table is the only place that mapping is written down: `scripts/sync-docs.js`
// copies each `source` into `docs/<out>` and rewrites the links between them,
// and `docusaurus.config.js` reads it back so "Edit this page" points at the
// original rather than at the copy.
//
// The markdown stays where it is. Nothing here is a second copy to keep in
// sync, and every one of these files still reads correctly on GitHub.

module.exports = [
  {
    source: 'README.md',
    out: 'intro.md',
    slug: '/',
    title: 'dbus-native',
    sidebarLabel: 'Introduction',
    description:
      'D-Bus protocol client and server for node.js, implemented in pure JavaScript.'
  },
  {
    source: 'docs/api.md',
    out: 'api.md',
    title: 'API reference',
    sidebarLabel: 'API reference',
    description:
      'The complete public surface: entry points, options, methods, events, error classes and diagnostics channels.'
  },
  {
    source: 'docs/migrating-to-2.0.md',
    out: 'migrating-to-2.0.md',
    title: 'Migrating to 0.14.0',
    sidebarLabel: 'To 0.14.0 (value shapes)',
    description:
      'Variants, dicts and 64-bit integers changed shape in 0.14.0. What that breaks, and how to move.'
  },
  {
    source: 'docs/migrating-to-0.7.md',
    out: 'migrating-to-0.7.md',
    title: 'Migrating to 0.7',
    sidebarLabel: 'To 0.7 (errors)',
    description:
      'D-Bus errors became real Error objects in 0.7. What that breaks, and how to move.'
  },
  {
    source: 'docs/deprecations.md',
    out: 'deprecations.md',
    title: 'Deprecations',
    sidebarLabel: 'Deprecations',
    description:
      'Stable DBUS_DEPxxxx codes for behaviour that changes in a future major release.'
  },
  {
    source: 'CHANGELOG.md',
    out: 'changelog.md',
    title: 'Changelog',
    sidebarLabel: 'Changelog',
    description: 'Every released version of dbus-native.'
  },
  {
    source: 'ROADMAP.md',
    out: 'roadmap.md',
    title: 'Roadmap',
    sidebarLabel: 'Roadmap',
    description: 'The current backlog, and what is deliberately not being done.'
  },
  {
    source: 'RELEASE_PLAN.md',
    out: 'release-plan.md',
    title: 'Release plan',
    sidebarLabel: 'Release plan',
    description:
      'How the design in BIG_FUTURE_PLANS gets delivered without forking the ecosystem.'
  },
  {
    source: 'BIG_FUTURE_PLANS.md',
    out: 'big-future-plans.md',
    title: 'Big future plans',
    sidebarLabel: 'Big future plans',
    description:
      'What dbus-native would look like if it were designed today, with backwards compatibility off the table.'
  },
  {
    source: 'E2E_DOCKER_TESTING.md',
    out: 'e2e-docker-testing.md',
    title: 'End-to-end testing',
    sidebarLabel: 'End-to-end testing',
    description:
      'Running the test suite against real desktop D-Bus services in a Linux container.'
  }
];
