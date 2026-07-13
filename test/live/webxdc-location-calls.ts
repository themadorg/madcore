/**
 * Live suite: webxdc, location streaming, call signaling.
 */
import { tryMethod, type LiveAccount, type LiveContact } from './harness';

export async function runWebxdcSuite(
    account: LiveAccount,
    contact: LiveContact,
    _peerEmail: string,
) {
    const sent = await tryMethod('sendWebxdc', () =>
        account.sendWebxdc(contact, {
            data: btoa('PK\x03\x04fake-xdc'),
            name: 'E2E App',
            filename: 'app.xdc',
        }));

    const wxId = sent?.message?.id || sent?.msgId;
    if (!wxId) throw new Error('sendWebxdc did not return msg id');

    await tryMethod('sendWebxdcStatusUpdate', () =>
        account.sendWebxdcStatusUpdate(contact, wxId, { payload: { hello: 1 }, serial: 1 }));
    await tryMethod('getWebxdcStatusUpdates', () =>
        account.getWebxdcStatusUpdates(wxId, 0));
}

export async function runLocationSuite(account: LiveAccount, peerEmail: string) {
    await tryMethod('sendLocationsToChat', () =>
        account.sendLocationsToChat(peerEmail, { durationSec: 120 }));
    await tryMethod('setLocation', () =>
        account.setLocation({ lat: 35.7, lon: 51.4, accuracy: 10 }));
    await tryMethod('getLocations', () =>
        account.getLocations(peerEmail).then((p: any[]) => `n=${p.length}`));
    await tryMethod('stopSendingLocations', () => account.stopSendingLocations(peerEmail));
}

export async function runCallsSuite(account: LiveAccount, contact: LiveContact) {
    await tryMethod('setIceServers', () => {
        account.setIceServers([{ urls: 'stun:stun.l.google.com:19302' }]);
    });
    await tryMethod('getIceServers', () => `${account.getIceServers().length} servers`);
    const call = await tryMethod('placeOutgoingCall', () =>
        account.placeOutgoingCall(contact, { video: false }));
    if (!call?.callId) throw new Error('placeOutgoingCall did not return callId');
    await tryMethod('getCall', () => account.getCall(call.callId)?.state);
    await tryMethod('endCall', () => account.endCall(call.callId));
}