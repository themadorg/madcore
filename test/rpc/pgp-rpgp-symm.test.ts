import { describe, it, expect } from 'bun:test';
import * as openpgp from 'openpgp';
import {
    _rpgpSkeskTest,
    decryptSymmetricSecureJoinRpgp,
    encryptSymmetricSecureJoinRpgp,
} from '../../lib/pgp-rpgp-symm';
import { generateKeys, secureJoinSharedSecret } from '../../lib/crypto';
import { buildSymmSecureJoinInnerMime } from '../../lib/mime-build';

describe('pgp-rpgp-symm', () => {
    it('produces salted S2K + signed SEIPDv2 roundtrip', async () => {
        const { privateKey, publicKey, fingerprint } = await generateKeys('alice@test.example', 'Alice');
        const auth = 'authcode99';
        const secret = secureJoinSharedSecret(fingerprint, auth);
        const inner = buildSymmSecureJoinInnerMime({
            step: 'vc-pubkey',
            auth,
            fromAddr: 'alice@test.example',
            msgId: '<vc@example.com>',
            date: 'Mon, 1 Jan 2024 00:00:00 GMT',
            autocryptHeader: 'Autocrypt: addr=alice@test.example; prefer-encrypt=mutual;\r\n keydata=KEY',
        });

        const armored = await encryptSymmetricSecureJoinRpgp(inner, secret, privateKey);
        const msg = await openpgp.readMessage({ armoredMessage: armored });
        const packets = [...msg.packets].map(p => p.constructor.name);
        expect(packets[0]).toBe('SymEncryptedSessionKeyPacket');
        expect(packets[1]).toBe('SymEncryptedIntegrityProtectedDataPacket');

        const { data, signatures } = await openpgp.decrypt({
            message: msg,
            passwords: [secret],
            verificationKeys: publicKey,
            config: {
                allowUnauthenticatedMessages: true,
                enableParsingV5Entities: true,
            },
        });
        const plain = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
        expect(plain).toContain('Secure-Join: vc-pubkey');
        expect(signatures.length).toBeGreaterThan(0);
        await expect(signatures[0]!.verified).resolves.toBe(true);

        const skesk = [...msg.packets].find(p => p.constructor.name === 'SymEncryptedSessionKeyPacket');
        expect(skesk).toBeDefined();
        expect((skesk as { version?: number }).version).toBe(6);
        const bin = Buffer.from(armored.split('\n').filter(l => !l.startsWith('-----') && l.trim()).join(''), 'base64');
        expect(bin[0]).toBe(0xc3); // SKESK tag 3, old-format packet header
        expect(bin[2]).toBe(0x06); // V6 SKESK body version
        expect(bin[7]).toBe(0x01); // salted S2K type inside V6 fields
    });

    it('buildSaltedEskPacketV6 matches rPGP reference wire format', async () => {
        const orig = crypto.getRandomValues.bind(crypto);
        const fixedSalt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        const fixedIv = new Uint8Array([
            0xe0, 0xec, 0xe9, 0x3f, 0xe2, 0x52, 0xe5, 0xa3, 0xf9, 0x91, 0x5e, 0xd6, 0x62, 0x69, 0xaf,
        ]);
        let saltCalls = 0;
        crypto.getRandomValues = <T extends ArrayBufferView>(arr: T): T => {
            if (arr instanceof Uint8Array && arr.length === 8 && saltCalls++ === 0) {
                arr.set(fixedSalt);
                return arr;
            }
            if (arr instanceof Uint8Array && arr.length === 15) {
                arr.set(fixedIv);
                return arr;
            }
            return orig(arr);
        };
        try {
            const sessionKey = new Uint8Array(16).fill(0x11);
            const packet = await _rpgpSkeskTest.buildSaltedEskPacketV6('pw', sessionKey);
            const expectedBody =
                '061c07020a01080102030405060708e0ece93fe252e5a3f9915ed66269af38a559c18cbfc75eeb00ca48c62bc33b8f6c7000579bb561ffa6cf81b3d017d3';
            // buildSaltedEskPacketV6 returns a full old-format packet (c3 + len + body).
            expect(packet[0]).toBe(0xc3);
            expect(Buffer.from(packet.subarray(2)).toString('hex')).toBe(expectedBody);
        } finally {
            crypto.getRandomValues = orig;
        }
    });

    it('decryptSymmetricSecureJoinRpgp roundtrips encrypt output', async () => {
        const { privateKey, fingerprint } = await generateKeys('bob@test.example', 'Bob');
        const auth = 'joiner-auth-42';
        const secret = secureJoinSharedSecret(fingerprint, auth);
        const inner = buildSymmSecureJoinInnerMime({
            step: 'vc-request-pubkey',
            auth,
            fromAddr: 'bob@test.example',
            msgId: '<req@example.com>',
            date: 'Mon, 1 Jan 2024 00:00:00 GMT',
            autocryptHeader: '',
        });
        const armored = await encryptSymmetricSecureJoinRpgp(inner, secret, privateKey);
        const plain = await decryptSymmetricSecureJoinRpgp(armored, secret);
        expect(plain).toContain('Secure-Join: vc-request-pubkey');
        expect(plain).toContain(`Secure-Join-Auth: ${auth}`);
    });
});