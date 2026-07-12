/**
 * Live suite: WebIMAP WebSocket depth (mailbox CRUD, flags, search).
 * Gracefully skips ops madmail rejects (INBOX-only storage).
 */
import { tryMethod, skip, type LiveAccount } from './harness';

function inboxOnly(err: unknown): boolean {
    const msg = (err as Error)?.message || String(err);
    return msg.includes('INBOX-only') || msg.includes('not supported on this server');
}

async function probeMailboxCrud(account: LiveAccount): Promise<boolean> {
    const probe = `_probe_${Date.now().toString(36)}`;
    try {
        const r = await account.wsRequest('create_mailbox', { name: probe });
        if (r?.status !== 'created') return false;
        await account.wsRequest('delete_mailbox', { name: probe });
        return true;
    } catch (e) {
        return !inboxOnly(e);
    }
}

export async function runWsSuite(account: LiveAccount, peerLabel = 'e2e') {
    const folder = `E2E_${peerLabel}_${Date.now().toString(36)}`;
    const mailboxCrud = await probeMailboxCrud(account);
    if (!mailboxCrud) {
        skip('WS/mailbox CRUD', 'INBOX-only server');
    }

    await tryMethod('WS/list_mailboxes', async () => {
        const m = await account.wsRequest('list_mailboxes', {});
        const names = (m as any[]).map(x => x.name);
        if (!names.includes('INBOX')) throw new Error('no INBOX');
        return names.join(',');
    });

    let renamed = `${folder}_renamed`;
    if (mailboxCrud) {
        await tryMethod('WS/create_mailbox', async () => {
            const r = await account.wsRequest('create_mailbox', { name: folder });
            if (r?.status !== 'created') throw new Error(JSON.stringify(r));
            return folder;
        });
        await tryMethod('WS/rename_mailbox', async () => {
            const r = await account.wsRequest('rename_mailbox', { old_name: folder, new_name: renamed });
            if (r?.status !== 'renamed') throw new Error(JSON.stringify(r));
            return renamed;
        });
    }

    await tryMethod('WS/list_messages INBOX', async () => {
        const m = await account.wsRequest('list_messages', { mailbox: 'INBOX', since_uid: 0 });
        return `n=${Array.isArray(m) ? m.length : '?'}`;
    });

    if (mailboxCrud) {
        await tryMethod('WS/search', async () => {
            const r = await account.wsRequest('search', { query: 'E2E' });
            return `n=${Array.isArray(r) ? r.length : '?'}`;
        });
    } else {
        skip('WS/search', 'INBOX-only server');
    }

    const msgs = await account.wsRequest('list_messages', { mailbox: 'INBOX', since_uid: 0 }) as any[];
    if (msgs?.length) {
        const uid = msgs[msgs.length - 1].uid;
        await tryMethod('WS/flags Seen', async () => {
            const r = await account.wsRequest('flags', {
                mailbox: 'INBOX',
                uid,
                flags: ['\\Seen'],
                op: 'add',
            });
            return r?.status || 'ok';
        });
        if (mailboxCrud) {
            await tryMethod('WS/copy', async () => {
                const r = await account.wsRequest('copy', {
                    mailbox: 'INBOX',
                    uid,
                    dest_mailbox: renamed,
                });
                return r?.status || 'ok';
            });
        }
    } else {
        skip('WS/flags Seen', 'no messages in INBOX');
        if (mailboxCrud) skip('WS/copy', 'no messages in INBOX');
    }

    if (mailboxCrud) {
        await tryMethod('WS/delete_mailbox', async () => {
            const r = await account.wsRequest('delete_mailbox', { name: renamed });
            if (r?.status !== 'deleted') throw new Error(JSON.stringify(r));
            return 'deleted';
        });
    }

    await tryMethod('WS/fetch missing → error', async () => {
        try {
            await account.wsRequest('fetch', { uid: 999999999 });
            throw new Error('should have failed');
        } catch (e: any) {
            const msg = e?.message || String(e);
            if (!msg.includes('not found') && !msg.includes('error') && !msg.includes('404')) {
                throw e;
            }
            return msg.slice(0, 40);
        }
    });
}