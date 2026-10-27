const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
    QBittorrentError,
    reannounceAllTrackers,
    testConnection: testQBittorrentConnection
} = require('../services/qbittorrent');

const environmentKeys = [
    'QBITTORRENT_URL',
    'QBITTORRENT_USERNAME',
    'QBITTORRENT_PASSWORD'
];

function setEnvironment(t) {
    const previous = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
    t.after(() => {
        for (const key of environmentKeys) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
    });

    Object.assign(process.env, {
        QBITTORRENT_URL: 'http://qbittorrent.test:8080',
        QBITTORRENT_USERNAME: 'test-user',
        QBITTORRENT_PASSWORD: 'test-password'
    });
}

function mockFetch(t, handler) {
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => handler(new URL(url), options);
    t.after(() => {
        global.fetch = originalFetch;
    });
}

test('reannounces trackers for all torrents using a valid qBittorrent session', async t => {
    setEnvironment(t);
    const calls = [];
    mockFetch(t, (url, options) => {
        calls.push({ url, options });
        if (url.pathname.endsWith('/auth/login')) {
            return new Response(null, {
                status: 204,
                headers: { 'set-cookie': 'SID=session-token; HttpOnly; Path=/' }
            });
        }
        if (url.pathname.endsWith('/torrents/reannounce')) {
            return new Response(null, { status: 200 });
        }
        throw new Error(`Unexpected request: ${url}`);
    });

    assert.deepEqual(await reannounceAllTrackers(), { success: true });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url.href, 'http://qbittorrent.test:8080/api/v2/torrents/reannounce');
    assert.equal(calls[1].options.method, 'POST');
    assert.equal(calls[1].options.headers.Cookie, 'SID=session-token');
    assert.equal(calls[1].options.headers.Origin, 'http://qbittorrent.test:8080');
    assert.equal(calls[1].options.headers.Referer, 'http://qbittorrent.test:8080/');
    assert.equal(calls[1].options.body.toString(), 'hashes=all');
});

test('tests qBittorrent credentials before saving them', async t => {
    const calls = [];
    mockFetch(t, (url, options) => {
        calls.push({ url, options });
        if (url.pathname.endsWith('/auth/login')) {
            return new Response(null, {
                status: 204,
                headers: { 'set-cookie': 'SID=test-session; HttpOnly; Path=/' }
            });
        }
        if (url.pathname.endsWith('/app/version')) {
            return new Response('v5.0.0', { status: 200 });
        }
        throw new Error(`Unexpected request: ${url}`);
    });

    assert.equal(await testQBittorrentConnection({
        url: 'http://new-qbittorrent.test:8080',
        username: 'new-user',
        password: 'new-password'
    }), 'v5.0.0');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.headers.Cookie, 'SID=test-session');
});

test('does not submit a tracker reannounce when login is rejected', async t => {
    setEnvironment(t);
    let requestCount = 0;
    mockFetch(t, () => {
        requestCount += 1;
        return new Response('Unauthorized', { status: 401 });
    });

    await assert.rejects(
        reannounceAllTrackers(),
        error => error instanceof QBittorrentError && error.message.includes('rejected the login')
    );
    assert.equal(requestCount, 1);
});

test('requires qBittorrent configuration before reannouncing trackers', async t => {
    setEnvironment(t);
    delete process.env.QBITTORRENT_PASSWORD;

    await assert.rejects(
        reannounceAllTrackers(),
        error => error instanceof QBittorrentError
            && error.message.includes('username, and password')
    );
});
