/**
 * rPGP-compatible symmetric SecureJoin encryption (salted S2K + SEIPDv2/OCB).
 *
 * openpgp.js v6 cannot emit salted S2K ESK packets (only iterated/argon2), but
 * Delta Chat core only attempts symmetric decrypt when S2K type is Salted.
 *
 * Strategy: let openpgp.js build SEIPDv2 + sign, then replace the SKESK packet
 * with a manually encoded salted-S2K ESK using the same session key.
 */
import * as openpgp from 'openpgp';

const RPGP_SYMM_CONFIG = {
    aeadProtect: true,
    preferredAEADAlgorithm: openpgp.enums.aead.ocb,
    preferredSymmetricAlgorithm: openpgp.enums.symmetric.aes128,
    // 2^(7+6) = 8192 byte AEAD chunks (matches core SecureJoin defaults)
    aeadChunkSizeByte: 7,
    nonDeterministicSignaturesViaNotation: false,
} as const;

type SkeskWire = {
    read(bytes: Uint8Array): void;
    decrypt(passphrase: string, config?: object): Promise<void>;
    sessionKey: Uint8Array | null;
    sessionKeyAlgorithm: number | null;
    sessionKeyEncryptionAlgorithm: number | null;
};

function hashAlgoName(id: number): string {
    // rPGP / OpenPGP hash IDs we may see on the wire (SecureJoin uses SHA-256).
    switch (id) {
        case 2:
            return 'SHA-1';
        case 8:
            return 'SHA-256';
        case 9:
            return 'SHA-384';
        case 10:
            return 'SHA-512';
        default:
            return 'SHA-256';
    }
}

/** Salted S2K (RFC 4880 §3.7.1.2) — matches rPGP `StringToKey::Salted`. */
async function saltedS2KDerive(
    passphrase: string,
    salt: Uint8Array,
    numBytes: number,
    hashAlgo = 8,
): Promise<Uint8Array> {
    const pw = new TextEncoder().encode(passphrase);
    const digestName = hashAlgoName(hashAlgo);
    const parts: Uint8Array[] = [];
    let got = 0;
    let prefix = 0;
    while (got < numBytes) {
        const buf = new Uint8Array(prefix + salt.length + pw.length);
        if (prefix > 0) buf.set(new Uint8Array(prefix), 0);
        buf.set(salt, prefix);
        buf.set(pw, prefix + salt.length);
        const digest = new Uint8Array(await crypto.subtle.digest(digestName, buf));
        parts.push(digest);
        got += digest.length;
        prefix++;
    }
    const out = new Uint8Array(numBytes);
    let offset = 0;
    for (const p of parts) {
        const take = Math.min(p.length, numBytes - offset);
        out.set(p.subarray(0, take), offset);
        offset += take;
        if (offset >= numBytes) break;
    }
    return out;
}

/** rPGP SKESK v4 session-key wrapping — regular AES-CFB, IV = 0 (not OpenPGP CFB). */
async function aesCfbCryptRegular(
    key: Uint8Array,
    data: Uint8Array,
    encrypt: boolean,
): Promise<Uint8Array> {
    try {
        const { createCipheriv, createDecipheriv } = await import('node:crypto');
        const iv = Buffer.alloc(16, 0);
        const cipher = encrypt
            ? createCipheriv('aes-128-cfb', Buffer.from(key), iv)
            : createDecipheriv('aes-128-cfb', Buffer.from(key), iv);
        cipher.setAutoPadding(false);
        return new Uint8Array(Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]));
    } catch {
        // Browser fallback: CFB-128 (ciphertext feedback).
        const blockSize = 16;
        const iv = new Uint8Array(blockSize);
        const out = new Uint8Array(data.length);
        let shiftRegister = iv;
        let pos = 0;
        while (pos < data.length) {
            const keystream = await aesEcbBlock(key, shiftRegister);
            const n = Math.min(blockSize, data.length - pos);
            for (let i = 0; i < n; i++) {
                out[pos + i] = data[pos + i] ^ keystream[i];
            }
            if (n === blockSize) {
                shiftRegister = new Uint8Array(
                    encrypt ? out.subarray(pos, pos + blockSize) : data.subarray(pos, pos + blockSize),
                );
            } else {
                const next = new Uint8Array(blockSize);
                next.set(shiftRegister.subarray(n));
                const feedback = encrypt ? out.subarray(pos, pos + n) : data.subarray(pos, pos + n);
                next.set(feedback, blockSize - n);
                shiftRegister = next;
            }
            pos += n;
        }
        return out;
    }
}

async function aesCfbEncryptRegular(key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
    return aesCfbCryptRegular(key, plaintext, true);
}

async function aesCfbDecryptRegular(key: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
    return aesCfbCryptRegular(key, ciphertext, false);
}

async function aesEcbBlock(key: Uint8Array, block: Uint8Array): Promise<Uint8Array> {
    try {
        const { createCipheriv } = await import('node:crypto');
        const cipher = createCipheriv('aes-128-ecb', Buffer.from(key), null);
        cipher.setAutoPadding(false);
        return new Uint8Array(cipher.update(Buffer.from(block)));
    } catch {
        const keyBytes = new Uint8Array(key);
        const blockBytes = new Uint8Array(block);
        const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
        const iv = new Uint8Array(16);
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, k, blockBytes));
        return ct.subarray(0, 16);
    }
}

function writePacket(tag: number, body: Uint8Array): Uint8Array {
    const len = body.length;
    let hdr: Uint8Array;
    if (len < 192) {
        hdr = new Uint8Array([0xc0 | tag, len]);
    } else if (len < 8384) {
        hdr = new Uint8Array([0xc0 | tag, ((len - 192) >> 8) + 192, (len - 192) & 0xff]);
    } else {
        hdr = new Uint8Array([
            0xc0 | tag,
            0xff,
            (len >> 24) & 0xff,
            (len >> 16) & 0xff,
            (len >> 8) & 0xff,
            len & 0xff,
        ]);
    }
    const out = new Uint8Array(hdr.length + body.length);
    out.set(hdr, 0);
    out.set(body, hdr.length);
    return out;
}

function parsePacket(bytes: Uint8Array, offset = 0): {
    tag: number;
    body: Uint8Array;
    packetBytes: Uint8Array;
    next: number;
} {
    const start = offset;
    const hdr = bytes[offset++];
    const tag = hdr & 0x3f;
    let len = bytes[offset++];
    if (len >= 192 && len < 224) {
        len = ((len - 192) << 8) + bytes[offset++] + 192;
    } else if (len === 255) {
        len =
            (bytes[offset] << 24) |
            (bytes[offset + 1] << 16) |
            (bytes[offset + 2] << 8) |
            bytes[offset + 3];
        offset += 4;
    }
    const body = bytes.subarray(offset, offset + len);
    return { tag, body, packetBytes: bytes.subarray(start, offset + len), next: offset + len };
}

const OCB_BLOCK = 16;
const OCB_IV = 15;
const OCB_TAG = 16;
const OCB_L_TABLE = 32;

function ocbNtz(n: number): number {
    if (n === 0) return 0;
    let v = 0;
    while ((n & 1) === 0) {
        n >>= 1;
        v++;
    }
    return v;
}

function xorBlock(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!;
    return out;
}

function xorMutBlock(a: Uint8Array, b: Uint8Array): void {
    for (let i = 0; i < a.length; i++) a[i] ^= b[i]!;
}

function readU128Be(bytes: Uint8Array): bigint {
    let v = 0n;
    for (let i = 0; i < 16; i++) v = (v << 8n) | BigInt(bytes[i]!);
    return v;
}

function writeU128Be(v: bigint): Uint8Array {
    const out = new Uint8Array(16);
    let x = v;
    for (let i = 15; i >= 0; i--) {
        out[i] = Number(x & 0xffn);
        x >>= 8n;
    }
    return out;
}

/** ocb3 GF(2^128) double — matches rPGP's `ocb3` crate (not openpgp.js OCB). */
function ocb3Double(block: Uint8Array): Uint8Array {
    let v = readU128Be(block);
    const vHi = v >> 127n;
    v <<= 1n;
    v ^= vHi ^ (vHi << 1n) ^ (vHi << 2n) ^ (vHi << 7n);
    return writeU128Be(v);
}

async function ocb3KeyVars(encipher: (block: Uint8Array) => Promise<Uint8Array>): Promise<{
    llStar: Uint8Array;
    llDollar: Uint8Array;
    ll: Uint8Array[];
}> {
    const llStar = await encipher(new Uint8Array(OCB_BLOCK));
    const llDollar = ocb3Double(llStar);
    const ll: Uint8Array[] = [];
    let llI = llDollar;
    for (let i = 0; i < OCB_L_TABLE; i++) {
        llI = ocb3Double(llI);
        ll[i] = llI;
    }
    return { llStar, llDollar, ll };
}

async function ocb3InitialOffset(
    encipher: (block: Uint8Array) => Promise<Uint8Array>,
    nonce: Uint8Array,
): Promise<Uint8Array> {
    const block = new Uint8Array(OCB_BLOCK);
    block[0] = 0;
    const start = OCB_BLOCK - nonce.length;
    block.set(nonce, start);
    block[start - 1]! |= 1;
    const bottom = block[15]! & 0b111111;
    const top = readU128Be(block) & ~0b111111n;
    const kTop = await encipher(writeU128Be(top));
    const stretch = new Uint8Array(24);
    stretch.set(kTop, 0);
    const tmp = kTop.slice();
    for (let i = 0; i < 8; i++) tmp[i] ^= tmp[i + 1]!;
    stretch.set(tmp.subarray(0, 8), 16);
    const stretchLow = readU128Be(stretch.subarray(0, 16));
    let stretchHi = 0n;
    for (let i = 16; i < 24; i++) stretchHi = (stretchHi << 8n) | BigInt(stretch[i]!);
    const offset = (stretchLow << BigInt(bottom)) | (stretchHi >> BigInt(64 - bottom));
    return writeU128Be(offset);
}

async function ocb3Hash(
    encipher: (block: Uint8Array) => Promise<Uint8Array>,
    llStar: Uint8Array,
    ll: Uint8Array[],
    associatedData: Uint8Array,
): Promise<Uint8Array> {
    let offsetI = new Uint8Array(OCB_BLOCK);
    let sumI = new Uint8Array(OCB_BLOCK);
    let i = 1;
    const fullBlocks = Math.floor(associatedData.length / OCB_BLOCK);
    for (let b = 0; b < fullBlocks; b++) {
        xorMutBlock(offsetI, ll[ocbNtz(i)]!);
        let aI = xorBlock(associatedData.subarray(b * OCB_BLOCK, (b + 1) * OCB_BLOCK), offsetI);
        aI = await encipher(aI);
        xorMutBlock(sumI, aI);
        i++;
    }
    const rem = associatedData.length % OCB_BLOCK;
    if (rem > 0) {
        xorMutBlock(offsetI, llStar);
        const cipherInput = new Uint8Array(OCB_BLOCK);
        cipherInput.set(associatedData.subarray(fullBlocks * OCB_BLOCK), 0);
        cipherInput[rem] = 0b1000_0000;
        xorMutBlock(cipherInput, offsetI);
        const enc = await encipher(cipherInput);
        xorMutBlock(sumI, enc);
    }
    return sumI;
}

async function hkdfSha256(
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
    length: number,
): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt, info },
        key,
        length * 8,
    );
    return new Uint8Array(bits);
}

/** RFC 9580 SKESK v6 associated data: 0xC3 | tag, version, sym, aead. */
function skeskV6Adata(symAlg: number, aeadAlg: number): Uint8Array {
    return new Uint8Array([0xc3, 0x06, symAlg, aeadAlg]);
}

/** ocb3 OCB-AES128 encrypt (rPGP-compatible; openpgp.js OCB encrypt is not). */
async function ocb3Aes128Encrypt(
    key: Uint8Array,
    plaintext: Uint8Array,
    nonce: Uint8Array,
    adata: Uint8Array,
): Promise<Uint8Array> {
    const encipher = (block: Uint8Array) => aesEcbBlock(key, block);
    const { llStar, llDollar, ll } = await ocb3KeyVars(encipher);
    let offsetI = await ocb3InitialOffset(encipher, nonce);
    let checksumI = new Uint8Array(OCB_BLOCK);
    const out = new Uint8Array(plaintext.length + OCB_TAG);
    let pos = 0;
    let i = 1;
    const fullBlocks = Math.floor(plaintext.length / OCB_BLOCK);
    for (let b = 0; b < fullBlocks; b++) {
        xorMutBlock(offsetI, ll[ocbNtz(i)]!);
        const pBlock = plaintext.subarray(b * OCB_BLOCK, (b + 1) * OCB_BLOCK);
        xorMutBlock(checksumI, pBlock);
        let cBlock = xorBlock(pBlock, offsetI);
        cBlock = await encipher(cBlock);
        xorMutBlock(cBlock, offsetI);
        out.set(cBlock, pos);
        pos += OCB_BLOCK;
        i++;
    }
    const rem = plaintext.length % OCB_BLOCK;
    if (rem > 0) {
        xorMutBlock(offsetI, llStar);
        const pad = await encipher(offsetI.slice());
        const pStar = plaintext.subarray(fullBlocks * OCB_BLOCK);
        const cStar = xorBlock(pStar, pad.subarray(0, rem));
        out.set(cStar, pos);
        const checksumRhs = new Uint8Array(OCB_BLOCK);
        checksumRhs.set(pStar, 0);
        checksumRhs[rem] = 0b1000_0000;
        xorMutBlock(checksumI, checksumRhs);
        pos += rem;
    }
    const fullTag = checksumI.slice();
    xorMutBlock(fullTag, offsetI);
    xorMutBlock(fullTag, llDollar);
    const encTag = await encipher(fullTag);
    const adHash = await ocb3Hash(encipher, llStar, ll, adata);
    const tag = xorBlock(encTag, adHash);
    out.set(tag, pos);
    return out;
}

type SkeskPacketWire = {
    read(bytes: Uint8Array): void;
    write(): Uint8Array;
    s2k: {
        write(): Uint8Array;
        produceKey(passphrase: string, numBytes: number, config?: object): Promise<Uint8Array>;
        salt: Uint8Array | null;
    };
    sessionKeyEncryptionAlgorithm: number | null;
    iv: Uint8Array | null;
    encrypted: Uint8Array | null;
};

/** Parse a salted-S2K template via openpgp (GenericS2K with produceKey). */
function loadSaltedS2kTemplate(salt: Uint8Array, symAlg: number): SkeskPacketWire['s2k'] {
    const s2kWire = new Uint8Array([1, 8, ...salt]);
    const firstLen = 3 + s2kWire.length + OCB_IV;
    const probe = new Uint8Array([
        6,
        firstLen,
        symAlg,
        openpgp.enums.aead.ocb,
        s2kWire.length,
        ...s2kWire,
        ...new Uint8Array(OCB_IV),
        ...new Uint8Array(OCB_BLOCK + OCB_TAG),
    ]);
    const pkt = new openpgp.SymEncryptedSessionKeyPacket(RPGP_SYMM_CONFIG) as unknown as SkeskPacketWire;
    pkt.read(probe);
    return pkt.s2k;
}

/** V6 SKESK + salted S2K + OCB — wire format rPGP 0.20 accepts (unlike v4 SKESK). */
async function buildSaltedEskPacketV6(
    passphrase: string,
    sessionKey: Uint8Array,
    algorithm: number = openpgp.enums.symmetric.aes128,
): Promise<Uint8Array> {
    const salt = crypto.getRandomValues(new Uint8Array(8));
    const aeadAlg = openpgp.enums.aead.ocb;
    const s2k = loadSaltedS2kTemplate(salt, algorithm);
    const keySize = 16;
    const ikm = await s2k.produceKey(passphrase, keySize, RPGP_SYMM_CONFIG);
    const adata = skeskV6Adata(algorithm, aeadAlg);
    const okm = await hkdfSha256(ikm, new Uint8Array(), adata, keySize);
    const iv = crypto.getRandomValues(new Uint8Array(OCB_IV));
    const encrypted = await ocb3Aes128Encrypt(okm, sessionKey, iv, adata);

    const pkt = new openpgp.SymEncryptedSessionKeyPacket(RPGP_SYMM_CONFIG) as unknown as SkeskPacketWire;
    pkt.sessionKeyEncryptionAlgorithm = algorithm;
    pkt.s2k = s2k;
    pkt.iv = iv;
    pkt.encrypted = encrypted;
    return writePacket(3, pkt.write());
}

function uint8ToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary);
}

function armorMessage(packetBytes: Uint8Array): string {
    const b64 = uint8ToBase64(packetBytes);
    const lines: string[] = ['-----BEGIN PGP MESSAGE-----', ''];
    for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
    lines.push('-----END PGP MESSAGE-----', '');
    return lines.join('\n');
}

/**
 * Sign + symmetrically encrypt (salted S2K + SEIPDv2/OCB) for SecureJoin v3 interop with core.
 */
export async function encryptSymmetricSecureJoinRpgp(
    rawMimePayload: string,
    sharedSecret: string,
    signingKey: openpgp.PrivateKey,
): Promise<string> {
    // Sign-then-encrypt at the literal layer (matches rPGP MessageBuilder: OPS+body+sig inside SEIPD).
    const encBinary = (await openpgp.encrypt({
        message: await openpgp.createMessage({
            binary: new TextEncoder().encode(rawMimePayload),
        }),
        passwords: [sharedSecret],
        signingKeys: signingKey,
        format: 'binary',
        config: RPGP_SYMM_CONFIG,
    })) as Uint8Array;

    const packets: ReturnType<typeof parsePacket>[] = [];
    let offset = 0;
    while (offset < encBinary.length) {
        const pkt = parsePacket(encBinary, offset);
        packets.push(pkt);
        offset = pkt.next;
    }

    const skeskIdx = packets.findIndex(p => p.tag === 3);
    const seipIdx = packets.findIndex(p => p.tag === 18);
    if (skeskIdx < 0 || seipIdx < 0) {
        const tags = packets.map(p => p.tag).join(', ');
        throw new Error(`Unexpected PGP packet sequence (tags: ${tags})`);
    }

    const skesk = new openpgp.SymEncryptedSessionKeyPacket() as unknown as SkeskWire;
    skesk.read(packets[skeskIdx]!.body);
    await skesk.decrypt(sharedSecret, RPGP_SYMM_CONFIG);
    if (!skesk.sessionKey) {
        throw new Error('Failed to extract session key for salted ESK');
    }

    const algo =
        skesk.sessionKeyAlgorithm ??
        skesk.sessionKeyEncryptionAlgorithm ??
        openpgp.enums.symmetric.aes128;

    const eskBytes = await buildSaltedEskPacketV6(sharedSecret, new Uint8Array(skesk.sessionKey), algo);

    // Replace only the leading SKESK packet; preserve the rest of the binary verbatim
    // (openpgp v6 may append metadata after SEIPD — re-parsing would corrupt SEIPD).
    const first = parsePacket(encBinary, 0);
    if (first.tag !== 3) {
        throw new Error(`Expected SKESK as first packet, got tag ${first.tag}`);
    }
    const all = new Uint8Array(eskBytes.length + encBinary.length - first.next);
    all.set(eskBytes, 0);
    all.set(encBinary.subarray(first.next), eskBytes.length);
    return armorMessage(all);
}

function armoredToBinary(armored: string): Uint8Array {
    const lines = armored
        .replace(/\r/g, '')
        .split('\n')
        .filter(l => !l.startsWith('-----') && l.trim().length > 0);
    const b64 = lines.join('');
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

async function unwrapSkeskBody(body: Uint8Array, sharedSecret: string): Promise<{
    sessionKey: Uint8Array;
    algorithm: number;
}> {
    if (body[0] === 6) {
        const pkt = new openpgp.SymEncryptedSessionKeyPacket(RPGP_SYMM_CONFIG) as unknown as SkeskWire;
        pkt.read(body);
        await pkt.decrypt(sharedSecret, RPGP_SYMM_CONFIG);
        if (!pkt.sessionKey) {
            throw new Error('Failed to decrypt V6 SKESK');
        }
        return {
            sessionKey: new Uint8Array(pkt.sessionKey),
            algorithm:
                pkt.sessionKeyAlgorithm ??
                pkt.sessionKeyEncryptionAlgorithm ??
                openpgp.enums.symmetric.aes128,
        };
    }
    return unwrapSaltedSkeskV4Body(body, sharedSecret);
}

async function unwrapSaltedSkeskV4Body(body: Uint8Array, sharedSecret: string): Promise<{
    sessionKey: Uint8Array;
    algorithm: number;
}> {
    if (body.length < 14 || body[0] !== 4 || body[2] !== 1) {
        throw new Error('SKESK is not salted S2K v4');
    }
    const symAlgo = body[1]!;
    const hashAlgo = body[3]!;
    const salt = body.subarray(4, 12);
    const encKey = body.subarray(12);
    const derived = await saltedS2KDerive(sharedSecret, salt, 16, hashAlgo);
    const plain = await aesCfbDecryptRegular(derived, encKey);
    if (plain.length < 2) {
        throw new Error('SKESK payload too short');
    }
    return { sessionKey: plain.subarray(1), algorithm: plain[0] ?? symAlgo };
}

/**
 * Decrypt rPGP salted-S2K symmetric SecureJoin messages (core vc-request-pubkey / vc-pubkey).
 * openpgp.js password decrypt often fails on rPGP's regular-AES-CFB ESK wrapping.
 */
export async function decryptSymmetricSecureJoinRpgp(
    armoredMessage: string,
    sharedSecret: string,
): Promise<string> {
    const decryptConfig = {
        allowUnauthenticatedMessages: true,
        enableParsingV5Entities: true,
        parseAEADEncryptedV4KeysAsLegacy: true,
    } as const;

    const message = await openpgp.readMessage({
        armoredMessage,
        config: decryptConfig,
    });

    const bin = armoredToBinary(armoredMessage);
    const skeskPkt = parsePacket(bin, 0);
    if (skeskPkt.tag !== 3) {
        throw new Error(`Expected SKESK first, got tag ${skeskPkt.tag}`);
    }

    const { sessionKey } = await unwrapSkeskBody(skeskPkt.body, sharedSecret);

    const { data } = await openpgp.decrypt({
        message,
        sessionKeys: [{ data: sessionKey, algorithm: 'aes128' }],
        config: decryptConfig,
    });

    return typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
}

/** @internal Exported for rPGP interop unit tests only. */
export const _rpgpSkeskTest = {
    buildSaltedEskPacketV6,
    ocb3Aes128Encrypt,
};