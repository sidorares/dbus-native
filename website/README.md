# The documentation site

[Docusaurus](https://docusaurus.io/) build of the markdown in this repository,
published to <https://sidorares.github.io/dbus-native/> by
[`.github/workflows/docs.yml`](../.github/workflows/docs.yml) on every push to
`master`.

## There is no content here

Every page is a file in the repository root or in `docs/`. `docs-manifest.js`
lists them, `scripts/sync-docs.js` copies them into `website/docs/` at build
time, and `website/docs/` is git-ignored. So:

- **To change what a page says, edit the source file** — `README.md`,
  `docs/api.md`, `ROADMAP.md`, and so on. Nothing here needs touching, and the
  file goes on reading correctly on GitHub.
- **To add a page**, add an entry to `docs-manifest.js` and put its id in
  `sidebars.js`.

The sync step also rewrites the links between those files: a link to another
page becomes a link to that page, and a link to any other file in the
repository becomes a link to it on GitHub. A relative link that resolves to
nothing fails the build rather than becoming a 404 later.

## Running it

```shell
npm install
npm start           # sync, then serve with hot reload on http://localhost:3000
npm run build       # sync, then build into build/
npm run serve       # serve build/ as it will be served in production
```

`npm start` does not re-sync when a source file changes — it copied the file at
startup. Restart it, or run `npm run sync` in another shell and let hot reload
pick the copy up.

The site is a separate npm project on purpose: `dbus-native` itself has one
runtime dependency, and nothing here is going anywhere near that.
