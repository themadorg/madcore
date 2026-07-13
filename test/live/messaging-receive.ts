/**
 * Live suite: assert peer actually receives messages (not just send OK).
 */
import {
    PNG, AUDIO_B64, tryMethod, waitForIncomingMsg, waitForEvent, sleep,
    type LiveAccount, type LiveContact,
} from './harness';

export async function runMessagingReceiveSuite(
    sender: LiveAccount,
    receiver: LiveAccount,
    senderEmail: string,
    _receiverEmail: string,
    contactOnSender: LiveContact,
) {
    const ts = Date.now();

    async function recvText(label: string, marker: string) {
        const wait = waitForIncomingMsg(receiver, {
            fromEmail: senderEmail,
            textIncludes: marker,
            timeoutMs: 90_000,
        });
        await tryMethod(`recv/${label} send`, () => sender.sendMessage(contactOnSender, marker));
        await tryMethod(`recv/${label} receive`, async () => {
            const msg = await wait;
            if (!msg?.text?.includes(marker)) throw new Error('text mismatch');
            return msg.text.slice(0, 40);
        });
        await sleep(1200);
    }

    // Image
    const imgMarker = `img-recv-${ts}`;
    const imgWait = waitForIncomingMsg(receiver, {
        fromEmail: senderEmail,
        textIncludes: imgMarker,
        type: 'image',
        timeoutMs: 90_000,
    });
    await tryMethod('recv/image send', () =>
        sender.sendImage(contactOnSender, {
            filename: 'dot.png',
            data: PNG,
            mimeType: 'image/png',
            caption: imgMarker,
        }));
    await tryMethod('recv/image receive', async () => {
        const msg = await imgWait;
        if (!msg?.text?.includes(imgMarker)) throw new Error('caption missing');
        return String(msg.type || msg.viewtype);
    });
    await sleep(1200);

    // File
    const fileMarker = `file-recv-${ts}`;
    const fileWait = waitForIncomingMsg(receiver, {
        fromEmail: senderEmail,
        textIncludes: fileMarker,
        timeoutMs: 90_000,
    });
    await tryMethod('recv/file send', () =>
        sender.sendFile(contactOnSender, {
            filename: 'note.txt',
            data: btoa('e2e file body'),
            mimeType: 'text/plain',
            caption: fileMarker,
        }));
    await tryMethod('recv/file receive', async () => {
        const msg = await fileWait;
        if (!msg?.text?.includes(fileMarker)) throw new Error('file caption missing');
        return 'file ok';
    });
    await sleep(1200);

    // Voice
    const voiceWait = waitForIncomingMsg(receiver, {
        fromEmail: senderEmail,
        type: 'voice',
        timeoutMs: 90_000,
    });
    await tryMethod('recv/voice send', () =>
        sender.sendVoice(contactOnSender, {
            data: AUDIO_B64,
            durationMs: 400,
            mimeType: 'audio/ogg',
        }));
    await tryMethod('recv/voice receive', async () => {
        const msg = await voiceWait;
        if (!msg) throw new Error('voice not received');
        return String(msg.type || msg.viewtype);
    });
    await sleep(1200);

    // Sticker
    const stickerWait = waitForIncomingMsg(receiver, {
        fromEmail: senderEmail,
        type: 'sticker',
        timeoutMs: 90_000,
    });
    await tryMethod('recv/sticker send', () =>
        sender.sendSticker(contactOnSender, {
            data: PNG,
            mimeType: 'image/png',
            filename: 'sticker.png',
        }));
    await tryMethod('recv/sticker receive', async () => {
        const msg = await stickerWait;
        if (!msg) throw new Error('sticker not received');
        return 'sticker ok';
    });
    await sleep(1200);

    // Edit
    const editMarker = `edit-recv-${ts}`;
    const editWait = waitForIncomingMsg(receiver, {
        fromEmail: senderEmail,
        textIncludes: editMarker,
        timeoutMs: 90_000,
    });
    const { msgId: parentId } = await sender.sendMessage(contactOnSender, `before edit ${editMarker}`);
    await sleep(2000);
    await tryMethod('recv/edit send', () =>
        sender.sendEdit(contactOnSender, {
            targetMessage: parentId,
            newText: `after edit ${editMarker}`,
        }));
    await tryMethod('recv/edit receive', async () => {
        const msg = await editWait;
        if (!msg?.text?.includes(editMarker)) throw new Error('edited text not received');
        return msg.text.slice(0, 40);
    });
    await sleep(1200);

    // Delete
    const delWait = waitForEvent(receiver, 'DC_EVENT_MSG_DELETED', {
        timeoutMs: 90_000,
        predicate: (e) => !!e.msgId || !!e.msg?.id,
    });
    const { msgId: delId } = await sender.sendMessage(contactOnSender, `delete me del-${ts}`);
    await sleep(2000);
    await tryMethod('recv/delete send', () =>
        sender.sendDelete(contactOnSender, { targetMessage: delId }));
    await tryMethod('recv/delete receive', async () => {
        await delWait;
        return 'deleted event';
    });
    await sleep(1200);

    // Reply
    const replyMarker = `reply-recv-${ts}`;
    const replyWait = waitForIncomingMsg(receiver, {
        fromEmail: senderEmail,
        textIncludes: replyMarker,
        timeoutMs: 90_000,
    });
    const { msgId: threadId } = await sender.sendMessage(contactOnSender, `thread parent ${replyMarker}`);
    await sleep(1500);
    await tryMethod('recv/reply send', () =>
        sender.sendReply(contactOnSender, {
            parentMessage: threadId,
            text: `thread child ${replyMarker}`,
            quotedText: `thread parent ${replyMarker}`,
        }));
    await tryMethod('recv/reply receive', async () => {
        const msg = await replyWait;
        if (!msg?.text?.includes(replyMarker)) throw new Error('reply not received');
        return 'reply ok';
    });
    await sleep(1200);

    // Reaction (event on receiver)
    const reactMarker = `react-recv-${ts}`;
    const reactWait = waitForEvent(receiver, 'DC_EVENT_INCOMING_REACTION', {
        timeoutMs: 90_000,
        predicate: (e) => e.msg?.text?.includes('🎯') || e.reaction === '🎯',
    });
    const { msgId: reactTarget } = await sender.sendMessage(contactOnSender, reactMarker);
    await sleep(1500);
    await tryMethod('recv/reaction send', () =>
        sender.sendReaction(contactOnSender, { targetMessage: reactTarget, reaction: '🎯' }));
    await tryMethod('recv/reaction receive', async () => {
        await reactWait;
        return '🎯';
    });
}