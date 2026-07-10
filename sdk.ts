/**
 * Delta Chat Web SDK — Multi-Account, Multi-Transport Architecture
 *
 * Usage:
 *   const dc = DeltaChatSDK({ logLevel: 'debug' });
 *   const { id } = await dc.register('https://relay.example');
 *   const acc = dc.getAccount(id);
 *   await acc.connect();
 *   acc.on('DC_EVENT_INCOMING_MSG', handler);
 *
 * Class hierarchy (account/):
 *   AccountBase → Contacts → Messaging → Groups → SecureJoin →
 *   Profile → Inbox → Features → DeltaChatAccount
 *
 * Supporting modules:
 *   - lib/transport.ts — WebSocket + REST API communication
 *   - lib/crypto.ts — PGP encryption, key gen, Autocrypt
 *   - lib/mime.ts — MIME parsing, decryption, attachments
 *   - lib/messaging.ts — Outbound message builders
 *   - lib/securejoin.ts — SecureJoin protocol
 *   - lib/profile.ts — Avatar & display name helpers
 *   - types.ts — Public type definitions
 *   - store.ts — Persistence backends
 */

import { getFingerprintFromArmored } from './lib/crypto';

// ─── Core API ───────────────────────────────────────────────────────────────────

export { DeltaChatSDK, type IDeltaChatManager } from './account/manager';
export { DeltaChatAccount } from './account/account';

// ─── Class layers (for extension / advanced use) ────────────────────────────────

export {
    AccountBase,
    AccountContacts,
    AccountMessaging,
    AccountGroups,
    AccountSecureJoin,
    AccountProfile,
    AccountInbox,
    AccountFeatures,
} from './account';

// ─── Logging ────────────────────────────────────────────────────────────────────

export { log, setLogLevel, getLogLevel } from './lib/logger';
export type { LogLevel } from './lib/logger';

// ─── Types ──────────────────────────────────────────────────────────────────────

export type {
    Credentials,
    RegisterResult,
    AccountInfo,
    AccountStatus,
    TransportStatus,
    RelayInfo,
    IncomingMessage,
    Attachment,
    ParsedMessage,
    DCEvent,
    DCEventData,
    SecureJoinParsed,
    SecureJoinResult,
    WSRequest,
    WSAction,
    MailboxInfo,
    MessageSummary,
    MessageDetail,
    FlagOperation,
    Viewtype,
    SDKConfig,
    Connectivity,
} from './types';
export { ALL_DC_EVENTS, ALL_WS_ACTIONS } from './types';

export type { GroupInfo } from './lib/group';
export type {
    StoredContact,
    StoredMessage,
    StoredChat,
    StoredAccount,
    StoredGroup,
    ChatDraft,
    IDeltaChatStore,
    PersistedAccountMeta,
} from './store';
export {
    MemoryStore,
    IndexedDBStore,
    createStore,
} from './store';
export {
    viewtypeToStoreType,
    storeTypeToViewtype,
    storeTypeFromMime,
} from './lib/viewtype';
export type { MessageStoreType } from './lib/viewtype';
export type { QrScanResult, QrKind } from './lib/securejoin';

export { getFingerprintFromArmored };
