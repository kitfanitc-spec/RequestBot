const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getDashboardData, getMascotState, normalizeQueueItem } = require('../services/dashboardData');
const { createRequestHistory } = require('../services/requestHistory');

const environmentKeys = [
    'RADARR_URL',
    'RADARR_API_KEY',
    'SONARR_URL',
    'SONARR_API_KEY',
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
        RADARR_URL: 'http://radarr.test',
        RADARR_API_KEY: 'radarr-test-key',
        SONARR_URL: 'http://sonarr.test',
        SONARR_API_KEY: 'sonarr-test-key'
    });
    for (const key of environmentKeys.slice(4)) delete process.env[key];
}

function mockFetch(t, handler) {
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => handler(new URL(url), options);
    t.after(() => {
        global.fetch = originalFetch;
    });
}

test('normalizes failed and stalled queue states with media-manager explanations', () => {
    const failed = normalizeQueueItem({
        id: 1,
        movieId: 42,
        movie: { title: 'Broken Download' },
        trackedDownloadState: 'failed',
        trackedDownloadStatus: 'error',
        statusMessages: [{ title: 'Import failed', messages: ['No space left on device'] }],
        _type: 'movie',
        _service: 'Radarr',
        _title: 'Broken Download'
    });
    const stalled = normalizeQueueItem({
        id: 2,
        seriesId: 13,
        series: { title: 'Stalled Show' },
        trackedDownloadState: 'stalled',
        statusMessages: [],
        _type: 'tv',
        _service: 'Sonarr',
        _title: 'Stalled Show'
    });
    const downloading = normalizeQueueItem({
        id: 3,
        movieId: 55,
        status: 'downloading',
        _type: 'movie',
        _service: 'Radarr',
        _title: 'Active Movie'
    });

    test('chooses mascot behavior from download, stalled, and seeding counts', () => {
        assert.equal(getMascotState({
            activeDownloads: 1,
            stalled: 4,
            seeding: 2,
            activeSeeding: 1
        }), 'working');
        assert.equal(getMascotState({
            activeDownloads: 0,
            stalled: 3,
            seeding: 0,
            activeSeeding: 0
        }), 'waiting');
        assert.equal(getMascotState({
            activeDownloads: 0,
            stalled: 0,
            seeding: 0,
            activeSeeding: 0
        }), 'idle');
        assert.equal(getMascotState({
            activeDownloads: 0,
            stalled: 0,
            seeding: 2,
            activeSeeding: 2
        }), 'monitoring');
    });

    assert.equal(failed.managerMediaId, 42);
    assert.equal(failed.status, 'Failed');
    assert.equal(failed.statusDetail, 'Import failed No space left on device');
    assert.equal(failed.needsAttention, true);
    assert.equal(failed.isActiveDownload, false);
    assert.equal(stalled.status, 'Stalled');
    assert.equal(stalled.statusDetail, 'The media manager reports this download as stalled.');
    assert.equal(stalled.isActiveDownload, false);
    assert.equal(downloading.isActiveDownload, true);
});

test('shows recent imports and synchronizes failed and completed request history', async t => {
    setEnvironment(t);
    const store = createRequestHistory(':memory:');
    t.after(() => store.close());
    await store.recordRequest({
        type: 'movie',
        mediaId: 500,
        title: 'Finished Movie',
        service: 'Radarr',
        managerMediaId: 33,
        requesterId: 'user-1',
        requesterName: 'Alex',
        alreadyExists: false
    });
    await store.recordRequest({
        type: 'tv',
        mediaId: 600,
        title: 'Failed Show',
        service: 'Sonarr',
        managerMediaId: 20,
        requesterId: 'user-2',
        requesterName: 'Sam',
        alreadyExists: false
    });
    mockFetch(t, (url) => {
        if (url.hostname === 'radarr.test' && url.pathname.endsWith('/queue')) {
            return Response.json({ records: [] });
        }
        if (url.hostname === 'sonarr.test' && url.pathname.endsWith('/queue')) {
            return Response.json({
                records: [{
                    id: 70,
                    seriesId: 20,
                    series: { title: 'Failed Show' },
                    status: 'downloading',
                    trackedDownloadState: 'failed',
                    trackedDownloadStatus: 'error',
                    statusMessages: [{ title: 'Download failed', messages: ['Tracker unavailable'] }],
                    size: 100,
                    sizeleft: 100
                }]
            });
        }
        if (url.hostname === 'radarr.test' && url.pathname.endsWith('/history')) {
            return Response.json({
                records: [{
                    id: 91,
                    eventType: 'downloadFolderImported',
                    date: '2026-10-04T12:00:00Z',
                    movieId: 33,
                    movie: { id: 33, title: 'Finished Movie' }
                }]
            });
        }
        if (url.hostname === 'sonarr.test' && url.pathname.endsWith('/history')) {
            return Response.json({ records: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
    });

    const data = await getDashboardData(store);

    assert.equal(data.recentCompletions[0].title, 'Finished Movie');
    assert.equal(data.attention[0].title, 'Failed Show');
    assert.equal(data.attention[0].statusDetail, 'Download failed Tracker unavailable');

    const requests = Object.fromEntries(data.requestHistory.map(request => [request.title, request]));
    assert.equal(requests['Finished Movie'].requesterName, 'Alex');
    assert.equal(requests['Finished Movie'].status, 'Completed');
    assert.equal(requests['Failed Show'].requesterName, 'Sam');
    assert.equal(requests['Failed Show'].status, 'Failed');
});

test('includes active and stalled qBittorrent downloads but skips seeding torrents', async t => {
    setEnvironment(t);
    process.env.QBITTORRENT_URL = 'http://qbittorrent.test:8080';
    process.env.QBITTORRENT_USERNAME = 'test-user';
    process.env.QBITTORRENT_PASSWORD = 'test-password';
    const store = createRequestHistory(':memory:');
    t.after(() => store.close());
    mockFetch(t, (url) => {
        if ((url.hostname === 'radarr.test' || url.hostname === 'sonarr.test')
            && (url.pathname.endsWith('/queue') || url.pathname.endsWith('/history'))) {
            return Response.json({ records: [] });
        }
        if (url.pathname.endsWith('/auth/login')) {
            return new Response(null, {
                status: 204,
                headers: { 'set-cookie': 'SID=session-token; HttpOnly; Path=/' }
            });
        }
        if (url.pathname.endsWith('/torrents/info')) {
            return Response.json([
                { hash: 'downloading-hash', name: 'Downloading title', state: 'downloading', progress: 0.4, dlspeed: 2048, eta: 3600 },
                { hash: 'stalled-hash', name: 'Stalled title', state: 'stalledDL', progress: 0.1, dlspeed: 0, eta: 8640000 },
                { hash: 'seeding-hash', name: 'Seeding title', state: 'uploading', progress: 1, dlspeed: 0, eta: 8640000 }
            ]);
        }
        throw new Error(`Unexpected request: ${url}`);
    });

    const data = await getDashboardData(store);
    const torrentItems = data.queue.filter(item => item.service === 'qBittorrent');

    assert.equal(torrentItems.length, 2);
    assert.equal(torrentItems[0].title, 'Downloading title');
    assert.equal(torrentItems[0].progress, 40);
    assert.equal(torrentItems[0].timeLeft, '1h');
    assert.equal(torrentItems[0].downloadSpeed, 2048);
    assert.equal(torrentItems[0].isActiveDownload, true);
    assert.equal(torrentItems[1].status, 'Stalled');
    assert.equal(torrentItems[1].needsAttention, true);
    assert.equal(torrentItems[1].isActiveDownload, false);
    assert.deepEqual(data.activity, {
        activeDownloads: 1,
        stalled: 1,
        seeding: 1,
        activeSeeding: 1
    });
});
