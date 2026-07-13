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
    const keyBytes = new Uint8Array(key);
    const blockBytes = new Uint8Array(block);
    const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
    const iv = new Uint8Array(16);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, k, blockBytes));
    return ct.subarray(0, 16);
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

async function buildSaltedEskPacket(
    passphrase: string,
    sessionKey: Uint8Array,
    algorithm: number = openpgp.enums.symmetric.aes128,
): Promise<Uint8Array> {
    const salt = crypto.getRandomValues(new Uint8Array(8));
    const derived = await saltedS2KDerive(passphrase, salt, 16);
    const payload = new Uint8Array(1 + sessionKey.length);
    payload[0] = algorithm;
    payload.set(sessionKey, 1);
    const encrypted = await aesCfbEncryptRegular(derived, payload);
    const body = new Uint8Array(2 + 1 + 1 + 8 + encrypted.length);
    let o = 0;
    body[o++] = 4; // ESK version
    body[o++] = algorithm;
    body[o++] = 1; // S2K type: salted
    body[o++] = 8; // hash: SHA256
    body.set(salt, o);
    o += 8;
    body.set(encrypted, o);
    return writePacket(3, body);
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

    const eskBytes = await buildSaltedEskPacket(sharedSecret, new Uint8Array(skesk.sessionKey), algo);

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

async function unwrapSaltedSkeskBody(body: Uint8Array, sharedSecret: string): Promise<{
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

    const { sessionKey } = await unwrapSaltedSkeskBody(skeskPkt.body, sharedSecret);

    const { data } = await openpgp.decrypt({
        message,
        sessionKeys: [{ data: sessionKey, algorithm: 'aes128' }],
        config: decryptConfig,
    });

    return typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
}