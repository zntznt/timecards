# Node + TypeScript gotchas (read before "fixing" a weird error)

This project runs `.ts` files **directly** on Node 22+ with no compiler, no
bundler, no dependencies. Node does *type-stripping* only — it removes type
annotations and runs the rest. That's fast and dependency-free, but it's not a
full TypeScript compiler, so a few things you'd expect to work don't.

## Won't run under strip-only TS (avoid these)

- **Constructor parameter properties** — `constructor(private store: Storage) {}`.
  Fails with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. → Declare fields explicitly and
  assign in the body. See `core/device.ts`.
- **`enum`** — runtime construct, not type-erasable. → Use a union type
  (`type Mode = "up" | "down"`) or `const` object.
- **`namespace`** with runtime members. → Use plain modules.
- **Parameter decorators / experimental decorators.** → Not used here; don't add.
- **`import ... = require(...)`** (TS-style). → Use ES `import`.

Things that ARE fine: interfaces, type aliases, generics, `as` casts, `satisfies`,
optional/`?` params, union/intersection types, `import type`. All erased cleanly.

## Imports need real file extensions

ES modules require explicit extensions. We import `./foo.ts` in source. The web
build (`web/build.ts`) rewrites `.ts` → `.js` for the browser. In Node, `.ts`
specifiers resolve directly. **Don't drop the extension** — extensionless imports
fail.

## node:sqlite specifics

- Built in on Node 22+ (`import { DatabaseSync } from "node:sqlite"`). On older
  Node it may need a flag or be absent — the project requires Node ≥ 22.
- It's **synchronous**. We wrap it to satisfy the async `Storage` interface
  (just `async` methods returning resolved values). Don't try to "await" the sync
  calls — there's nothing to await; the async wrapper is only for interface parity.
- WAL mode is on for safe concurrent reads (web UI + Pi reading at once).

## Browser build is dependency-free on purpose

`web/build.ts` uses `node:module`'s `stripTypeScriptTypes` + a regex to rewrite
imports. It emits an `ExperimentalWarning` for that API — harmless. If that API is
ever removed, the fallback is to add `esbuild` as the *one* build-time dep; keep it
out of runtime either way.

## Shell note (local dev)

The user's shell prints a `zoxide: detected a possible configuration issue…`
banner on many commands. It's unrelated noise from their `~/.zshrc`, not a project
error. Filter it when reading command output.
