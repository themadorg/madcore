import { describe, it, expect } from 'bun:test';

// rPGP ocb3 reference (see /tmp/pgp-test `ocb_test` bin)
const RPGP_OCB_VECTOR = {
    okm: '08d92d02f997d5d971c79ff25ea18369',
    iv: 'e0ece93fe252e5a3f9915ed66269af',
    plaintext: '11111111111111111111111111111111',
    adata: 'c3060702',
    expected: '38a559c18cbfc75eeb00ca48c62bc33b8f6c7000579bb561ffa6cf81b3d017d3',
};

async function aesEcbBlock(key: Uint8Array, block: Uint8Array): Promise<Uint8Array> {
    const { createCipheriv } = await import('node:crypto');
    const cipher = createCipheriv('aes-128-ecb', Buffer.from(key), null);
    cipher.setAutoPadding(false);
    return new Uint8Array(cipher.update(Buffer.from(block)));
}

const OCB_BLOCK = 16;
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

function ocb3Double(block: Uint8Array): Uint8Array {
    let v = readU128Be(block);
    const vHi = v >> 127n;
    v <<= 1n;
    v ^= vHi ^ (vHi << 1n) ^ (vHi << 2n) ^ (vHi << 7n);
    return writeU128Be(v);
}

async function ocb3KeyVars(encipher: (block: Uint8Array) => Promise<Uint8Array>) {
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

describe('ocb3 vector', () => {
    it('matches rPGP ocb_test output', async () => {
        const okm = Buffer.from(RPGP_OCB_VECTOR.okm, 'hex');
        const iv = Buffer.from(RPGP_OCB_VECTOR.iv, 'hex');
        const pt = Buffer.from(RPGP_OCB_VECTOR.plaintext, 'hex');
        const adata = Buffer.from(RPGP_OCB_VECTOR.adata, 'hex');
        const got = await ocb3Aes128Encrypt(okm, pt, iv, adata);
        expect(Buffer.from(got).toString('hex')).toBe(RPGP_OCB_VECTOR.expected);
    });
});