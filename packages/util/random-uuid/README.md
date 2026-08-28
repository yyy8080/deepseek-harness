# dsh-random-uuid

English | [中文](README.zh.md)

One random-identifier primitive — a zero-dependency function shared by every host and browser package that needs an RFC 4122 version 4 UUID and cannot assume a secure context.

## Why the package exists

`crypto.randomUUID` is a secure-context-only Web API. A browser reaches it over HTTPS and over a loopback origin, and **not** over plain `http://<lan-or-public-ip>/`; the property is simply absent there, so calling it throws `crypto.randomUUID is not a function`. Every other piece of the harness's browser wire path works over plain HTTP, so a client that mints ids with `crypto.randomUUID` breaks on the first RPC of a test or LAN deployment.

`crypto.getRandomValues` carries no secure-context restriction and is backed by the same CSPRNG, so this package prefers the platform method where it exists and derives the identical version-4, variant-1 layout from 16 random bytes where it does not. Node ≥ 19 always takes the first path.

```ts
import { randomUuid } from '@deepseek-ai/dsh-random-uuid'

const id = randomUuid() // '5d1a0f0e-2b39-4c2f-9f4b-1c8a2f7d6e01'
```

It is a **library, not a service or plugin**: no `ctx`, registers nothing, holds no state.

## Who must use it

Any code path that can execute in a browser: the client API carrier (`dsh-host-apiproxy` `AbstractApiClient`), the generic Connection RPC caller, and UI packages minting draft-local ids. Host-only code that never ships to the browser may keep `node:crypto`'s `randomUUID`.

## Known Limitations and Deferred Work

- **Requires a Web Crypto global** — a platform exposing neither `crypto.randomUUID` nor `crypto.getRandomValues` throws. There is deliberately no `Math.random` path: silently degrading id entropy is worse than a loud failure, and every engine in the supported range (browsers, Node ≥ 19) has one of the two.
