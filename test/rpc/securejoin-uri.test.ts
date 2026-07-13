/**
 * SecureJoin URI parse / generate (IP-literal + paste hygiene).
 */
import { describe, it, expect } from 'bun:test';
import { parseSecureJoinURI, generateSecureJoinURI } from '../../lib/securejoin';
import { DeltaChatAccount, MemoryStore } from '../../sdk';

describe('SecureJoin URI', () => {
    it('parses Delta Chat v=3 invite with IP-literal email', () => {
        const uri =
            'https://i.delta.chat/#A6138700702D3BE74B0B185EE6109928B929696C&v=3&i=WsjmUdhijGW9RjVgNFCcjrpM&s=BHS4B2AMYvr8IgDfqqDN_lkz&a=dkupk6hkabui%40%5B192.0.2.1%5D&n=MadMailCore+Test';
        const p = parseSecureJoinURI(uri);
        expect(p.fingerprint).toBe('A6138700702D3BE74B0B185EE6109928B929696C');
        expect(p.inviteNumber).toBe('WsjmUdhijGW9RjVgNFCcjrpM');
        expect(p.auth).toBe('BHS4B2AMYvr8IgDfqqDN_lkz');
        expect(p.inviterEmail).toBe('dkupk6hkabui@[192.0.2.1]');
        expect(p.name).toBe('MadMailCore Test');
    });

    it('tolerates whitespace in pasted URI', () => {
        const uri =
            'https://i.delta.chat/#AABB\n&i=inv&s=auth&a=user%40%5B1.2.3.4%5D&n=X';
        const p = parseSecureJoinURI(uri);
        expect(p.fingerprint).toBe('AABB');
        expect(p.inviterEmail).toBe('user@[1.2.3.4]');
    });

    it('generateSecureJoinURI encodes IP-literal and includes v=3', async () => {
        const store = new MemoryStore();
        const acc = new DeltaChatAccount(
            store,
            'acc',
            'alice@[192.0.2.1]',
            'pw',
            'https://192.0.2.1',
        );
        await acc.generateKeys('Alice');
        const uri = acc.generateSecureJoinURI();
        expect(uri).toContain('https://i.delta.chat/#');
        expect(uri).toContain('&v=3&');
        expect(uri).toContain(encodeURIComponent('alice@[192.0.2.1]'));
        const p = parseSecureJoinURI(uri);
        expect(p.inviterEmail).toBe('alice@[192.0.2.1]');
        expect(p.inviteNumber.length).toBeGreaterThan(8);
        expect(p.auth.length).toBeGreaterThan(8);
    });
});
