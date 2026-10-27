const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
    getTorrents,
    reannounceAllTrackers,
    testConnection
} = require('../services/torrentClients');

const environmentKeys = [
    'TORRENT_CLIENT',
    'TORRENT_URL',
    'TORRENT_USERNAME',
    'TORRENT_PASSWORD',
    'QBITTORRENT_URL',
    'QBITTORRENT_USERNAME',
    'QBITTORRENT_PASSWORD'
];

function setEnvironment(t, values) {
    const previous = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
    t.after(() => {
        for (const key of environmentKeys) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
    });
    for (const key of environmentKeys) delete process.env[key];
    Object.assign(process.env, values);
}

function mockFetch(t, handler) {
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => handler(new URL(url), options);
    t.after(() => {
        global.fetch = originalFetch;
    });
}

test('uses the Transmission RPC session token and normalizes torrent status', async t => {
    setEnvironment(t, {
        TORRENT_CLIENT: 'transmission',
        TORRENT_URL: 'http://transmission.test:9091',
        TORRENT_USERNAME: 'transmission-user',
        TORRENT_PASSWORD: 'transmission-password'
    });
    const calls = [];
    mockFetch(t, (url, options) => {
        calls.push({ url, options });
        if (calls.length === 1) {
            return new Response('session required', {
                status: 409,
                headers: { 'X-Transmission-Session-Id': 'rpc-session' }
            });
        }
        return Response.json({
            result: 'success',
            arguments: {
                torrents: [{
                    id: 4,
                    hashString: 'transmission-hash',
                    name: 'Transmission download',
                    status: 4,
                    totalSize: 1000,
                    leftUntilDone: 250,
                    rateDownload: 4096,
                    eta: 60
                }]
            }
        });
    });

    const result = await getTorrents();
    assert.equal(result.client, 'transmission');
    assert.equal(result.torrents[0].state, 'downloading');
    assert.equal(result.torrents[0].progress, 0.75);
    assert.equal(result.torrents[0].dlspeed, 4096);
    assert.equal(calls[1].options.headers['X-Transmission-Session-Id'], 'rpc-session');
    assert.equal(JSON.parse(calls[1].options.body).method, 'torrent-get');
});

test('uses a shared connection for qBittorrent selected in Settings', async t => {
    setEnvironment(t, {
        TORRENT_CLIENT: 'qbittorrent',
        TORRENT_URL: 'http://new-qbittorrent.test:8080',
        TORRENT_USERNAME: 'new-user',
        TORRENT_PASSWORD: 'new-password'
    });
    const calls = [];
    mockFetch(t, (url, options) => {
        calls.push({ url, options });
        if (url.pathname.endsWith('/auth/login')) {
            return new Response(null, {
                status: 204,
                headers: { 'set-cookie': 'SID=shared-session; Path=/' }
            });
        }
        if (url.pathname.endsWith('/torrents/info')) {
            return Response.json([{
                hash: 'shared-hash',
                name: 'Shared client download',
                state: 'downloading',
                progress: 0.2,
                dlspeed: 1024,
                eta: 10
            }]);
        }
        throw new Error(`Unexpected request: ${url}`);
    });

    const result = await getTorrents();
    assert.equal(result.client, 'qbittorrent');
    assert.equal(result.configured, true);
    assert.equal(result.torrents[0].name, 'Shared client download');
    assert.match(calls[1].url.href, /^http:\/\/new-qbittorrent\.test:8080\//);
});

test('connects to the BitTorrent Classic Web UI and normalizes torrent statuses', async t => {
    setEnvironment(t, {
        TORRENT_CLIENT: 'bittorrent',
        TORRENT_URL: 'http://bittorrent.test:8080',
        TORRENT_USERNAME: 'web-user',
        TORRENT_PASSWORD: 'web-password'
    });
    const calls = [];
    mockFetch(t, (url, options) => {
        calls.push({ url, options });
        if (url.pathname.endsWith('/gui/token.html')) {
            return new Response('<html><div id="token">classic-token</div></html>', {
                status: 200,
                headers: { 'set-cookie': 'GUID=classic-session; Path=/' }
            });
        }
        if (url.pathname.endsWith('/gui/')) {
            return Response.json({
                torrents: [
                    ['active-hash', 1, 'Classic download', 1000, 400, 0, 0, 0, 4096, 60, '', 0, 0, 0, 0, 0, 0, 600],
                    ['stalled-hash', 1, 'Classic stalled', 1000, 100, 0, 0, 0, 0, 8640000, '', 0, 0, 0, 0, 0, 0, 900],
                    ['seed-hash', 1, 'Classic seed', 1000, 1000, 20, 0, 0, 0, 0, '', 0, 0, 0, 0, 0, 0, 0]
                ]
            });
        }
        throw new Error(`Unexpected request: ${url}`);
    });

    const result = await getTorrents();
    assert.equal(result.client, 'bittorrent');
    assert.equal(result.torrents[0].state, 'downloading');
    assert.equal(result.torrents[0].progress, 0.4);
    assert.equal(result.torrents[1].state, 'stalledDL');
    assert.equal(result.torrents[2].state, 'uploading');
    assert.equal(calls[1].options.headers.Authorization, `Basic ${Buffer.from('web-user:web-password').toString('base64')}`);
    assert.equal(calls[1].options.headers.Cookie, 'GUID=classic-session');
    assert.equal(new URL(calls[1].url).searchParams.get('token'), 'classic-token');
    assert.equal(new URL(calls[1].url).searchParams.get('list'), '1');
});

test('tests BitTorrent Classic Web UI credentials and reannounces every torrent', async t => {
    setEnvironment(t, {
        TORRENT_CLIENT: 'bittorrent',
        TORRENT_URL: 'http://bittorrent.test:8080',
        TORRENT_USERNAME: 'web-user',
        TORRENT_PASSWORD: 'web-password'
    });
    const calls = [];
    mockFetch(t, (url, options) => {
        calls.push({ url, options });
        if (url.pathname.endsWith('/gui/token.html')) {
            return new Response('<div id="token">rpc-token</div>', {
                status: 200,
                headers: { 'set-cookie': 'GUID=rpc-session; Path=/' }
            });
        }
        if (url.pathname.endsWith('/gui/')) {
            const query = new URL(url).searchParams;
            if (query.get('list') === '1') {
                return Response.json({ torrents: [
                    ['hash-one', 1, 'One', 100, 100, 0, 0, 0, 0, 0, '', 0, 0, 0, 0, 0, 0, 0],
                    ['hash-two', 1, 'Two', 100, 100, 0, 0, 0, 0, 0, '', 0, 0, 0, 0, 0, 0, 0]
                ] });
            }
            if (query.get('action') === 'forcereannounce') {
                return Response.json({ status: 'reannouncing' });
            }
        }
        throw new Error(`Unexpected request: ${url}`);
    });

    assert.equal((await testConnection()).success, true);
    calls.length = 0;
    assert.deepEqual(await reannounceAllTrackers(), { success: true });
    const reannounceHashes = calls
        .map(call => new URL(call.url).searchParams)
        .filter(query => query.get('action') === 'forcereannounce')
        .map(query => query.get('hash'))
        .sort();
    assert.deepEqual(reannounceHashes, ['hash-one', 'hash-two']);
});

test('tests and reannounces all Transmission torrents', async t => {
    setEnvironment(t, {
        TORRENT_CLIENT: 'transmission',
        TORRENT_URL: 'http://transmission.test:9091'
    });
    const methods = [];
    mockFetch(t, (_url, options) => {
        const call = JSON.parse(options.body);
        methods.push(call);
        if (!options.headers['X-Transmission-Session-Id']) {
            return new Response(null, {
                status: 409,
                headers: { 'X-Transmission-Session-Id': 'rpc-session' }
            });
        }
        if (call.method === 'session-get') {
            return Response.json({ result: 'success', arguments: { version: '4.0' } });
        }
        if (call.method === 'torrent-get') {
            return Response.json({
                result: 'success',
                arguments: { torrents: [{ id: 11, name: 'One' }, { id: 12, name: 'Two' }] }
            });
        }
        if (call.method === 'torrent-reannounce') {
            return Response.json({ result: 'success', arguments: {} });
        }
        throw new Error(`Unexpected RPC method ${call.method}`);
    });

    assert.equal((await testConnection()).success, true);
    methods.length = 0;
    assert.deepEqual(await reannounceAllTrackers(), { success: true });
    assert.deepEqual(methods.map(call => call.method), [
        'torrent-get',
        'torrent-get',
        'torrent-reannounce',
        'torrent-reannounce'
    ]);
    assert.deepEqual(methods[3].arguments.ids, [11, 12]);
});

test('authenticates to Deluge, reads torrent state, and reannounces all torrents', async t => {
    setEnvironment(t, {
        TORRENT_CLIENT: 'deluge',
        TORRENT_URL: 'http://deluge.test:8112',
        TORRENT_PASSWORD: 'deluge-password'
    });
    const calls = [];
    mockFetch(t, (_url, options) => {
        const call = JSON.parse(options.body);
        calls.push(call);
        if (call.method === 'auth.login') {
            return new Response(JSON.stringify({ result: true, error: null, id: call.id }), {
                status: 200,
                headers: { 'Set-Cookie': 'session_id=deluge-session; Path=/; HttpOnly' }
            });
        }
        if (call.method === 'core.get_torrents_status') {
            return Response.json({
                result: {
                    'download-hash': {
                        name: 'Deluge download',
                        state: 'Downloading',
                        progress: 30,
                        download_payload_rate: 2048,
                        eta: 120,
                        total_size: 1000,
                        total_done: 300
                    },
                    'seed-hash': {
                        name: 'Deluge seed',
                        state: 'Seeding',
                        progress: 100,
                        download_payload_rate: 0,
                        eta: 0,
                        total_size: 1000,
                        total_done: 1000
                    }
                },
                error: null,
                id: call.id
            }, { headers: { 'Set-Cookie': 'session_id=deluge-session; Path=/; HttpOnly' } });
        }
        if (call.method === 'core.force_reannounce') {
            return Response.json({ result: null, error: null, id: call.id });
        }
        throw new Error(`Unexpected RPC method ${call.method}`);
    });

    const result = await getTorrents();
    assert.equal(result.client, 'deluge');
    assert.equal(result.torrents[0].state, 'downloading');
    assert.equal(result.torrents[0].progress, 0.3);
    assert.equal(result.torrents[1].state, 'uploading');
    assert.equal(calls[1].method, 'core.get_torrents_status');
    assert.equal(await testConnection().then(value => value.success), true);
    assert.deepEqual(await reannounceAllTrackers(), { success: true });
    const reannounce = calls.find(call => call.method === 'core.force_reannounce');
    assert.deepEqual(reannounce.params, [['download-hash', 'seed-hash']]);
});
