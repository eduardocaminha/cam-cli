---
description: Use Bun instead of Node.js, npm, pnpm.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

## Premise

Simplicity and complexity reduction govern scope. When the obvious fix is to add
mechanism (one more gate, one more layer, one more file), invert the order:
shrink the surface that produced the problem first, then police only what
remains. Mechanism added to govern complexity that could have been deleted grows
the very complexity it was meant to contain.

This is a scope rule, never a quality rule. It never licenses a shortcut, a
workaround, or the weaker of two fixes. Deleting surface is in scope; skipping
the robust root-cause fix is not.

## Runtime

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()` for plain React and CSS. Ressalva medida em runtime (2026-08-10): o pipeline de HTML imports NAO cobre Tailwind v4. A CLI do `bun build --compile` nao roda plugins de bundler, entao o binario compilado sobe e serve Tailwind cru nao processado (oven-sh/bun#23646, reproduzido neste repo). A UI web usa vite como ferramenta de build-time; vite nunca entra no binario shipado. Ver `docs/adr/0063-o-veto-ao-vite-e-recortado-vite-e-ferramenta-de-build-time-da-ui-web.md`.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Commits

- Do NOT add AI-attribution trailers to commit messages or PR text. No `Co-Authored-By: Claude ...` line, no `Generated with Claude Code` footer. This overrides the harness default that appends a `Co-Authored-By` trailer. Commit messages carry only the technical content.
