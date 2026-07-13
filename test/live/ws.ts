/**
 * Live suite: all 12 WebIMAP WebSocket actions against real madmail.
 */
import { tryMethod, sleep, type LiveAccount } from './harness';

async function inboxMessages(account: LiveAccount): Promise<any[]> {
    await account.backgroundFetch(0);
    await sleep(500);
    const m = await account.wsRequest('list_messages', { mailbox: 'INBOX', since_uid: 0 });
    return Array.isArray(m) ? m : [];
}

export async function runWsSuite(
    account: LiveAccount,
    peerLabel = 'e2e',
    opts: {
        peerAccount?: LiveAccount | null;
        accountEmail?: string;
    } = {},
) {
    const folder = `E2E_${peerLabel}_${Date.now().toString(36)}`;
    const renamed = `${folder}_renamed`;

    await tryMethod('WS/list_mailboxes', async () => {
        const m = await account.wsRequest('list_mailboxes', {});
        const names = (m as any[]).map(x => x.name);
        if (!names.includes('INBOX')) throw new Error('no INBOX');
        return names.join(',');
    });

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

    let msgs = await inboxMessages(account);
    if (!msgs.length && opts.peerAccount && opts.accountEmail) {
        await tryMethod('WS/seed INBOX msg', async () => {
            await opts.peerAccount!.sendMessage(opts.accountEmail!, `ws-seed-${Date.now()}`);
            await sleep(2500);
            msgs = await inboxMessages(account);
            if (!msgs.length) throw new Error('no INBOX messages after peer seed');
            return `n=${msgs.length}`;
        });
    }

    await tryMethod('WS/list_messages INBOX', async () => {
        msgs = await inboxMessages(account);
        return `n=${msgs.length}`;
    });

    await tryMethod('WS/search', async () => {
        const r = await account.wsRequest('search', { query: 'E2E' });
        return `n=${Array.isArray(r) ? r.length : '?'}`;
    });

    if (!msgs.length) {
        throw new Error('WS suite: INBOX empty — cannot test flags/copy/move/delete');
    }

    const uid = msgs[msgs.length - 1].uid;

    await tryMethod('WS/flags add Seen', async () => {
        const r = await account.wsRequest('flags', {
            mailbox: 'INBOX',
            uid,
            flags: ['\\Seen'],
            op: 'add',
        });
        return r?.status || 'ok';
    });

    await tryMethod('WS/flags remove Seen', async () => {
        const r = await account.wsRequest('flags', {
            mailbox: 'INBOX',
            uid,
            flags: ['\\Seen'],
            op: 'remove',
        });
        return r?.status || 'ok';
    });

    await tryMethod('WS/copy', async () => {
        const r = await account.wsRequest('copy', {
            mailbox: 'INBOX',
            uid,
            dest_mailbox: renamed,
        });
        return r?.status || 'ok';
    });

    const copied = await account.wsRequest('list_messages', { mailbox: renamed, since_uid: 0 }) as any[];
    if (!copied?.length) {
        throw new Error('WS/copy: dest mailbox has no messages after copy');
    }

    await tryMethod('WS/move', async () => {
        const destMsgs = await account.wsRequest('list_messages', { mailbox: renamed, since_uid: 0 }) as any[];
        const moveUid = destMsgs[destMsgs.length - 1].uid;
        const r = await account.wsRequest('move', {
            mailbox: renamed,
            uid: moveUid,
            dest_mailbox: 'INBOX',
        });
        return r?.status || 'ok';
    });

    await tryMethod('WS/delete', async () => {
        const fresh = await inboxMessages(account);
        const delUid = fresh[fresh.length - 1]?.uid;
        if (!delUid) throw new Error('no uid for delete');
        const r = await account.wsRequest('delete', { mailbox: 'INBOX', uid: delUid });
        return r?.status || 'ok';
    });

    await tryMethod('WS/fetch', async () => {
        const fresh = await inboxMessages(account);
        const fetchUid = fresh[fresh.length - 1]?.uid;
        if (!fetchUid) throw new Error('no uid for fetch');
        const r = await account.wsRequest('fetch', { mailbox: 'INBOX', uid: fetchUid });
        if (!r?.body && !r?.uid) throw new Error('empty fetch');
        return `uid=${r.uid ?? fetchUid}`;
    });

    await tryMethod('WS/delete_mailbox', async () => {
        const r = await account.wsRequest('delete_mailbox', { name: renamed });
        if (r?.status !== 'deleted') throw new Error(JSON.stringify(r));
        return 'deleted';
    });

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