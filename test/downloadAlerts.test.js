const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
    getRequestLifecycleState,
    sendRequestAlert,
    sendRequestStatusAlert
} = require('../services/downloadAlerts');

test('detects request lifecycle changes from queue and import history', () => {
    const request = { service: 'Radarr', managerMediaId: 42 };
    const queue = [{
        _service: 'Radarr',
        _managerMediaId: 42,
        _type: 'movie',
        _title: 'Sample Movie',
        trackedDownloadState: 'Downloading'
    }];
    assert.deepEqual(getRequestLifecycleState(request, queue, []), {
        notificationStatus: 'Downloading',
        historyStatus: 'Downloading',
        detail: null
    });

    assert.deepEqual(getRequestLifecycleState(request, [], [{
        service: 'Radarr',
        managerMediaId: 42,
        eventType: 'movieFileImported',
        statusDetail: null,
        date: '2026-10-09T00:00:00.000Z'
    }]), {
        notificationStatus: 'Completed',
        historyStatus: 'Completed',
        detail: null
    });
});

test('sends request status notices to the configured channel and only pings the requester', async t => {
    const previousChannelId = process.env.ALERT_CHANNEL_ID;
    process.env.ALERT_CHANNEL_ID = 'status-channel';
    t.after(() => {
        if (previousChannelId === undefined) delete process.env.ALERT_CHANNEL_ID;
        else process.env.ALERT_CHANNEL_ID = previousChannelId;
    });

    let sent;
    const client = {
        channels: {
            fetch: async () => ({ send: async message => { sent = message; } })
        }
    };
    await sendRequestStatusAlert(client, {
        requesterId: 'user-123',
        title: 'Sample Movie',
        service: 'Radarr'
    }, 'Downloading');

    assert.match(sent.content, /has started downloading/);
    assert.deepEqual(sent.allowedMentions, { users: ['user-123'] });
});

test('posts a request summary to the configured alert channel without pinging the requester', async t => {
    const previousChannelId = process.env.ALERT_CHANNEL_ID;
    process.env.ALERT_CHANNEL_ID = 'channel-123';
    t.after(() => {
        if (previousChannelId === undefined) delete process.env.ALERT_CHANNEL_ID;
        else process.env.ALERT_CHANNEL_ID = previousChannelId;
    });

    let fetchedChannelId;
    let sentMessage;
    const client = {
        channels: {
            fetch: async channelId => {
                fetchedChannelId = channelId;
                return { send: async message => { sentMessage = message; } };
            }
        }
    };

    await sendRequestAlert(client, {
        type: 'anime',
        title: 'Sample Anime',
        requesterId: 'user-456',
        service: 'Sonarr',
        alreadyExists: false
    });

    assert.equal(fetchedChannelId, 'channel-123');
    assert.match(sentMessage.content, /New Anime request:\*\* Sample Anime/);
    assert.match(sentMessage.content, /<@user-456>/);
    assert.match(sentMessage.content, /search for available releases was started/);
    assert.deepEqual(sentMessage.allowedMentions, { parse: [] });
});

test('does not publish a request notice when an item is already in the library', async t => {
    const previousChannelId = process.env.ALERT_CHANNEL_ID;
    process.env.ALERT_CHANNEL_ID = 'channel-123';
    t.after(() => {
        if (previousChannelId === undefined) delete process.env.ALERT_CHANNEL_ID;
        else process.env.ALERT_CHANNEL_ID = previousChannelId;
    });

    let fetchCount = 0;
    const client = {
        channels: {
            fetch: async () => { fetchCount += 1; }
        }
    };

    const sent = await sendRequestAlert(client, { alreadyExists: true });

    assert.equal(sent, false);
    assert.equal(fetchCount, 0);
});

test('reports when no request announcement channel is configured', async t => {
    const previousChannelId = process.env.ALERT_CHANNEL_ID;
    delete process.env.ALERT_CHANNEL_ID;
    t.after(() => {
        if (previousChannelId !== undefined) process.env.ALERT_CHANNEL_ID = previousChannelId;
    });

    await assert.rejects(
        sendRequestAlert({ channels: {} }, {}),
        /Set the request and download alert channel ID/
    );
});

test('reports when the configured alert channel cannot be used', async t => {
    const previousChannelId = process.env.ALERT_CHANNEL_ID;
    process.env.ALERT_CHANNEL_ID = 'missing-channel';
    t.after(() => {
        if (previousChannelId === undefined) delete process.env.ALERT_CHANNEL_ID;
        else process.env.ALERT_CHANNEL_ID = previousChannelId;
    });

    await assert.rejects(
        sendRequestAlert({ channels: { fetch: async () => null } }, {}),
        /channel is unavailable/
    );
});
