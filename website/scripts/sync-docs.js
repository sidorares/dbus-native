#!/usr/bin/env node
'use strict';

// Copies the repository's markdown into `docs/` for Docusaurus to build.
//
// The point is that there is no second copy of the documentation. Every page
// on the site is one of the files in `docs-manifest.js`, still readable on
// GitHub, still the thing a pull request edits. This script does the three
// things that stand between a repository markdown file and a site page:
//
//   1. adds the front matter Docusaurus wants (title, slug, description),
//   2. rewrites the links between those files so they point at pages,
//   3. rewrites links to files that are *not* pages so they point at GitHub.
//
// Step 3 is also a check: a relative link to a file that does not exist is an
// error here rather than a 404 later, so the site build fails the same way for
// a broken repository link as it does for a broken site link.

const fs = require('node:fs');
const path = require('node:path');

const manifest = require('../docs-manifest');

const websiteDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(websiteDir, '..');
const outDir = path.join(websiteDir, 'docs');
const blobUrl = 'https://github.com/sidorares/dbus-native/blob/master/';

// Absolute path of every file that becomes a page, so a link between two of
// them can become a link between two pages.
const pageFor = new Map(
  manifest.map(entry => [path.join(repoRoot, entry.source), entry.out])
);

// `[text](target)`, with the optional `"title"` CommonMark allows. Targets in
// this repository contain no spaces or parentheses; one that did would simply
// not match, and would be left alone.
const LINK = /\]\(\s*([^)\s]+?)(\s+"[^"]*")?\s*\)/g;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

function yaml(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Docusaurus resolves a link to a `.md` file the same way GitHub does, so a
// page-to-page link is left as a file reference rather than turned into a URL.
// That keeps `baseUrl` out of the content and lets the build report a link to
// a page that no longer exists.
function rewriteLinks(body, entry) {
  const sourceDir = path.dirname(path.join(repoRoot, entry.source));

  return body.replace(LINK, (match, target, title = '') => {
    if (EXTERNAL.test(target)) return match;

    const hash = target.indexOf('#');
    const file = hash === -1 ? target : target.slice(0, hash);
    const anchor = hash === -1 ? '' : target.slice(hash);
    if (file === '') return match;

    const absolute = path.resolve(sourceDir, file);
    const page = pageFor.get(absolute);
    if (page) return `](./${page}${anchor}${title})`;

    const relative = path.relative(repoRoot, absolute);
    if (relative.startsWith('..') || !fs.existsSync(absolute)) {
      throw new Error(
        `${entry.source}: link to "${target}" does not resolve to a file in the repository`
      );
    }

    return `](${blobUrl}${relative.split(path.sep).join('/')}${anchor}${title})`;
  });
}

function frontMatter(entry) {
  const lines = [
    `id: ${yaml(path.basename(entry.out, '.md'))}`,
    `title: ${yaml(entry.title)}`,
    `sidebar_label: ${yaml(entry.sidebarLabel)}`,
    `description: ${yaml(entry.description)}`
  ];
  if (entry.slug) lines.push(`slug: ${yaml(entry.slug)}`);

  return `---\n${lines.join('\n')}\n---\n`;
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const entry of manifest) {
  const source = path.join(repoRoot, entry.source);
  const body = fs.readFileSync(source, 'utf8');

  if (body.startsWith('---\n')) {
    throw new Error(
      `${entry.source}: already has front matter, which this script would duplicate`
    );
  }

  const generated =
    `${frontMatter(entry)}\n` +
    `<!-- Generated from ${entry.source} by website/scripts/sync-docs.js. Edit that file. -->\n\n` +
    `${rewriteLinks(body, entry)}`;

  fs.writeFileSync(path.join(outDir, entry.out), generated);
  console.log(`${entry.source} -> docs/${entry.out}`);
}

console.log(
  `\n${manifest.length} pages written to ${path.relative(repoRoot, outDir)}/`
);
