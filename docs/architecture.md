# Architecture & Protocol Internals

Internal design of **madcore-web**: modules, transport, and persistence.

**Also see:** [Examples](./examples.md) · [Security](./security.md) · [Core parity](./parity.md)

---

## Package Layout

```
madcore-web/
├── sdk.ts             # Public barrel re-exports
├── store.ts           # MemoryStore, IndexedDBStore, createStore, registry
├── types.ts           # Public type definitions
├── account/           # Class hierarchy (inheritance)
│   ├── utils.ts       # IDs, base64
│   ├── base.ts        # State, lifecycle, transport, events, persist
│   ├── contacts.ts    # Contacts, block list, QR
│   ├── messaging.ts   # 1:1 outbound sends
│   ├── groups.ts      # Groups / channels + unified send()
│   ├── securejoin.ts  # SecureJoin handshake
│   ├── profile.ts     # Display name & avatar
│   ├── inbox.ts       # Inbound pipeline + chat store ops
│   ├── features.ts    # Webxdc, location, calls, backup, config
│   ├── account.ts     # DeltaChatAccount (concrete)
│   ├── manager.ts     # DeltaChatSDK multi-account factory
│   └── index.ts       # Layer re-exports
└── lib/               # Functional protocol helpers (SDKContext)
    ├── transport.ts   # WebSocket + REST
    ├── crypto.ts      # OpenPGP / Autocrypt
    ├── mime.ts        # RFC 2822 parse / decrypt
    ├── mime-build.ts  # Shared PGP/MIME envelopes
    ├── messaging.ts   # 1:1 send helpers
    ├── securejoin.ts  # QR / SecureJoin
    ├── group.ts       # Group fan-out
    ├── viewtype.ts    # Viewtype ↔ store type
    ├── webxdc.ts      # Webxdc apps
    ├── backup.ts      # Encrypted backup blob
    ├── location.ts    # Location streaming
    ├── calls.ts       # WebRTC signaling
    ├── profile.ts     # Avatar helpers
    ├── context.ts     # SDKContext
    └── logger.ts      # Log levels
```

### Account class inheritance

```
AccountBase
  → AccountContacts
    → AccountMessaging
      → AccountGroups
        → AccountSecureJoin
          → AccountProfile
            → AccountInbox
              → AccountFeatures
                → DeltaChatAccount
```

Protocol logic lives in `lib/*` pure functions. Account classes hold state, events, and storage.

---

## The WebSocket Protocol

The SDK talks to a Delta Chat Relay with **JSON-RPC over WebSocket**.

### Client request

```json
{
  "req_id": "1",
  "action": "send",
  "data": {
    "from": "user@relay.example",
    "to": ["bob@relay.example"],
    "body": "Raw MIME Message"
  }
}
```

### Server response

```json
{
  "req_id": "1",
  "action": "send",
  "data": "OK"
}
```

### Push (no `req_id`)

```json
{
  "action": "push",
  "data": {
    "uid": 1234,
    "body": "Full RFC 2822 Message..."
  }
}
```

---

## The UID System

1. Each mailbox message has an incremental integer **UID**.
2. On `connect()`, the SDK sends its highest known UID (`lastSeenUid` from the store when available).
3. The server pushes messages with higher UIDs (catch-up after offline).

`lastSeenUid` is part of the account snapshot and is updated as inbound mail is processed.

---

## Storage

### Backends

| Backend | When |
|---------|------|
| `createStore()` | **Default** — IndexedDB if available, else MemoryStore |
| `IndexedDBStore` | Browser persistence |
| `MemoryStore` | Tests / Node without IDB |

### IndexedDB layout

For base name `madcore-web` (default):

| Database | Contents |
|----------|----------|
| `madcore-web__registry` | Multi-account index: email, serverUrl, displayName |
| `madcore-web-{email}` | Per-account object stores: `account`, `chats`, `messages`, `contacts` |

Isolation: `IndexedDBStore.forAccount(email)` (used by `DeltaChatSDK` automatically).

### What is written when

| Data | Timing |
|------|--------|
| Chats, messages, contacts | **Immediate** on mutation |
| Account snapshot (keys, profile photo, groups registry, config, relays, `lastSeenUid`) | **Debounced** (~250ms) via `schedulePersist()` |
| Registry entry | On `register` / `restoreAccount` / `addAccount` |

### Public APIs

```ts
await acc.saveToStore();      // write account snapshot now
await acc.loadFromStore();    // restore snapshot + contacts maps
await acc.flushPersist();     // cancel debounce + saveToStore
acc.schedulePersist();        // debounce snapshot write

// Manager
await dc.listPersistedAccounts();
await dc.restoreAccount(email, password, serverUrl?);
```

### Ephemeral (not persisted)

Active call sessions, live location streams, SecureJoin invite tokens, and the in-memory webxdc status-update map. Message history (including webxdc instances) still lives in the message store.

---

## Multi-account manager

`DeltaChatSDK()`:

- Holds in-session account handles (`listAccounts` / `getAccount`).
- Gives each account an isolated store when using IndexedDB.
- Remembers emails in the registry for cold start.
- Does **not** store passwords in the registry — the app must supply password on restore.

---

## Lib modules (protocol)

| Module | Role |
|--------|------|
| `transport` | Network only (WS + REST) |
| `crypto` | Keygen, encrypt, Autocrypt headers |
| `mime` / `mime-build` | Parse / build MIME & PGP envelopes |
| `messaging` / `group` | Outbound 1:1 and group payloads |
| `securejoin` | QR + 4-phase handshake |
| `webxdc` / `location` / `calls` | Feature payloads |

---

## Related docs

- [Examples](./examples.md) — app-facing usage and restore flows
- [Security](./security.md) — PGP / SecureJoin
- [Parity](./parity.md) — vs Delta Chat core
