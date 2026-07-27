# Contributing

Thanks for taking a look. Issues and pull requests are welcome.

## Getting set up

```bash
git clone https://github.com/oliverames/wave-mcp-server.git
cd wave-mcp-server
npm install
npm test
```

The unit tests need no Wave account and no network.

## Before opening a pull request

```bash
node --check index.js     # syntax
npm test                  # 58 unit tests
npm run smoke:list-tools  # starts over stdio, enumerates tools
npm run smoke:packed      # packs, installs, launches via the bin symlink
npm run smoke:schema      # validates every query against live Wave
npm run release:check     # version parity across manifests
```

`smoke:schema` reaches the network but needs no credentials: Wave validates a
document before it checks authentication, so `UNAUTHENTICATED` means the query
is correct and `GRAPHQL_VALIDATION_FAILED` means it is not.

If you touched `worker/`:

```bash
npm ci --prefix worker
npm test --prefix worker
```

`smoke:packed` matters more than its name suggests. npm installs the bin as a
relative symlink, so anything that reasons about `process.argv[1]` or
`import.meta.url` behaves differently under `npx` than under `node index.js`.
That difference once shipped a server that started and sat silent. If you touch
module-level startup code, run this one.

## Adding a tool

1. Add the GraphQL document near its siblings, built with `gql()` so it lands
   in the registry that `smoke:schema` checks.
2. Register with `registerTool` for reads, `registerWriteTool` for anything
   that creates, changes, deletes, or sends. Getting this wrong is the one
   mistake worth being careful about: a write tool registered as a read is
   exposed to every default install.
3. Write the description for someone who has never seen Wave's API. Say what
   the tool does, what it does not, and which tool to use instead when it is
   the wrong choice.
4. Add a test for the input validation, not just the happy path.

## Style

- Comments explain *why*. What the code does should be evident from the code.
- Error messages name the next step. "Invalid input" is not an error message;
  "call wave_list_products to find a product ID" is.
- Money is a string. Floats do not belong in a ledger.
- Match the surrounding code rather than introducing a new idiom.

## Releasing

Maintainer only:

```bash
npm version patch   # runs sync:plugin and stages every manifest
git push --follow-tags
```

The tag triggers the release workflow, which re-runs every gate before it
publishes.
