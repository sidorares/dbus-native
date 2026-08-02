'use strict';

// The ids here are the `out` filenames in `docs-manifest.js`, minus `.md`.

/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
module.exports = {
  docs: [
    'intro',
    'api',
    {
      type: 'category',
      label: 'Migrating',
      collapsed: false,
      items: ['migrating-to-2.0', 'migrating-to-0.7', 'deprecations']
    },
    {
      type: 'category',
      label: 'The project',
      collapsed: false,
      items: ['changelog', 'roadmap', 'release-plan', 'big-future-plans']
    },
    {
      type: 'category',
      label: 'Contributing',
      collapsed: false,
      items: ['e2e-docker-testing']
    }
  ]
};
