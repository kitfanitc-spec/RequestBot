const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
    ArrError,
    searchMedia,
    addMedia,
    searchAgain,
    getQueue,
    getConfigurationOptions,
    testConnection: testArrConnection
} = require('../services/arrClient');

const environmentKeys = [
    'RADARR_URL',
    'RADARR_API_KEY',
    'RADARR_ROOT_FOLDER',
    'RADARR_QUALITY_PROFILE_ID',
    'SONARR_URL',
    'SONARR_API_KEY',
    'SONARR_ROOT_FOLDER',
    'SONARR_QUALITY_PROFILE_ID',
    'SONARR_TV_ROOT_FOLDER',
    'SONARR_TV_QUALITY_PROFILE_ID',
    'SONARR_ANIME_ROOT_FOLDER',
    'SONARR_ANIME_QUALITY_PROFILE_ID'
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
}

function mockFetch(t, handler) {
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => handler(new URL(url), options);
    t.after(() => {
        global.fetch = originalFetch;
    });
}

test('searches Radarr and adds the selected movie with a monitored release search', async t => {
    setEnvironment(t);
    const calls = [];
    mockFetch(t, (url, options) => {
        calls.push({ url, options });
        if (url.pathname.endsWith('/movie/lookup')) {
            return Response.json([{ title: 'Sample Movie', year: 2025, tmdbId: 123 }]);
        }
        if (url.pathname.endsWith('/rootfolder')) return Response.json([{ path: '/movies' }]);
        if (url.pathname.endsWith('/qualityprofile')) return Response.json([{ id: 7 }]);
        if (url.pathname.endsWith('/movie') && options.method === 'POST') return Response.json({ id: 1 });
        if (url.pathname.endsWith('/movie')) return Response.json([]);
        throw new Error(`Unexpected request: ${url}`);
    });

    const [movie] = await searchMedia('movie', 'Sample Movie');
    await addMedia('movie', movie);

    const request = calls.find(call => call.options.method === 'POST');
    const body = JSON.parse(request.options.body);
    assert.equal(request.url.hostname, 'radarr.test');
    assert.equal(request.options.headers['X-Api-Key'], 'radarr-test-key');
    assert.equal(body.tmdbId, 123);
    assert.equal(body.rootFolderPath, '/movies');
    assert.equal(body.minimumAvailability, 'released');
    assert.equal(body.addOptions.searchForMovie, true);
});

test('tests Radarr connections with unsaved settings', async t => {
    setEnvironment(t);
    let request;
    mockFetch(t, (url, options) => {
        request = { url, options };
        return Response.json({ version: '5.0.0' });
    });

    const status = await testArrConnection('movie', {
        url: 'http://new-radarr.test',
        apiKey: 'new-test-key'
    });

    assert.equal(status.version, '5.0.0');
    assert.equal(request.url.href, 'http://new-radarr.test/api/v3/system/status');
    assert.equal(request.options.headers['X-Api-Key'], 'new-test-key');
});

test('starts a targeted Radarr or Sonarr search for an existing manager item', async t => {
    setEnvironment(t);
    const calls = [];
    mockFetch(t, (url, options) => {
        calls.push({ url, options });
        return Response.json({ id: 99, name: JSON.parse(options.body).name });
    });

    await searchAgain('movie', '42');
    await searchAgain('anime', 84);

    assert.deepEqual(calls.map(call => ({
        host: call.url.hostname,
        body: JSON.parse(call.options.body)
    })), [
        { host: 'radarr.test', body: { name: 'MoviesSearch', movieIds: [42] } },
        { host: 'sonarr.test', body: { name: 'SeriesSearch', seriesId: 84 } }
    ]);
    await assert.rejects(searchAgain('movie', 'nope'), /valid media-manager ID/);
});

test('loads Radarr root-folder and quality-profile choices', async t => {
    setEnvironment(t);
    const calls = [];
    mockFetch(t, url => {
        calls.push(url.pathname);
        if (url.pathname.endsWith('/rootfolder')) {
            return Response.json([{ path: '/movies', freeSpace: 1000 }]);
        }
        if (url.pathname.endsWith('/qualityprofile')) {
            return Response.json([{ id: 7, name: 'HD' }]);
        }
        throw new Error(`Unexpected request: ${url}`);
    });

    const result = await getConfigurationOptions('movie', {
        url: 'http://unsaved-radarr.test',
        apiKey: 'unsaved-key'
    });

    assert.deepEqual(calls.sort(), ['/api/v3/qualityprofile', '/api/v3/rootfolder']);
    assert.deepEqual(result.rootFolders, [{ path: '/movies', freeSpace: 1000 }]);
    assert.deepEqual(result.qualityProfiles, [{ id: 7, name: 'HD' }]);
});

test('adds anime through Sonarr with anime series type and shared settings fallback', async t => {
    setEnvironment(t);
    process.env.SONARR_ROOT_FOLDER = '/anime';
    process.env.SONARR_QUALITY_PROFILE_ID = '9';
    const calls = [];
    mockFetch(t, (url, options) => {
        calls.push({ url, options });
        if (url.pathname.endsWith('/series/lookup')) {
            return Response.json([{ title: 'Sample Anime', tvdbId: 456 }]);
        }
        if (url.pathname.endsWith('/rootfolder')) {
            return Response.json([{ path: '/tv' }, { path: '/anime' }]);
        }
        if (url.pathname.endsWith('/qualityprofile')) {
            return Response.json([{ id: 8 }, { id: 9 }]);
        }
        if (url.pathname.endsWith('/series') && options.method === 'POST') return Response.json({ id: 2 });
        if (url.pathname.endsWith('/series')) return Response.json([]);
        throw new Error(`Unexpected request: ${url}`);
    });

    const [anime] = await searchMedia('anime', 'Sample Anime');
    await addMedia('anime', anime);

    const request = calls.find(call => call.options.method === 'POST');
    const body = JSON.parse(request.options.body);
    assert.equal(request.url.hostname, 'sonarr.test');
    assert.equal(body.tvdbId, 456);
    assert.equal(body.seriesType, 'anime');
    assert.equal(body.rootFolderPath, '/anime');
    assert.equal(body.qualityProfileId, 9);
    assert.equal(body.addOptions.searchForMissingEpisodes, true);
});

test('does not add or search again when Radarr already contains the requested movie', async t => {
    setEnvironment(t);
    const calls = [];
    mockFetch(t, (url, options) => {
        calls.push({ url, options });
        if (url.pathname.endsWith('/movie')) return Response.json([{ id: 42, tmdbId: 123 }]);
        throw new Error(`Unexpected request: ${url}`);
    });

    const result = await addMedia('movie', { title: 'Already Added', tmdbId: 123 });

    assert.equal(result.alreadyExists, true);
    assert.equal(result.searchStarted, false);
    assert.equal(result.managerMediaId, 42);
    assert.equal(calls.length, 1);
});

test('does not add or search again when Sonarr already contains the requested show', async t => {
    setEnvironment(t);
    const calls = [];
    mockFetch(t, (url, options) => {
        calls.push({ url, options });
        if (url.pathname.endsWith('/series')) return Response.json([{ id: 21, tvdbId: 456 }]);
        throw new Error(`Unexpected request: ${url}`);
    });

    const result = await addMedia('tv', { title: 'Already Added', tvdbId: 456 });

    assert.equal(result.alreadyExists, true);
    assert.equal(result.searchStarted, false);
    assert.equal(result.managerMediaId, 21);
    assert.equal(calls.length, 1);
});

test('uses configured Radarr root folder and quality profile IDs', async t => {
    setEnvironment(t);
    process.env.RADARR_ROOT_FOLDER = '/movies-4k';
    process.env.RADARR_QUALITY_PROFILE_ID = '7';
    let requestBody;
    mockFetch(t, (url, options) => {
        if (url.pathname.endsWith('/rootfolder')) {
            return Response.json([{ path: '/movies' }, { path: '/movies-4k' }]);
        }
        if (url.pathname.endsWith('/qualityprofile')) {
            return Response.json([{ id: 6 }, { id: 7 }]);
        }
        if (url.pathname.endsWith('/movie') && options.method === 'POST') {
            requestBody = JSON.parse(options.body);
            return Response.json({ id: 1 });
        }
        if (url.pathname.endsWith('/movie')) return Response.json([]);
        throw new Error(`Unexpected request: ${url}`);
    });

    await addMedia('movie', { title: 'Configured Movie', tmdbId: 123 });

    assert.equal(requestBody.rootFolderPath, '/movies-4k');
    assert.equal(requestBody.qualityProfileId, 7);
});

test('uses configured Sonarr TV overrides instead of the shared settings', async t => {
    setEnvironment(t);
    process.env.SONARR_ROOT_FOLDER = '/shared';
    process.env.SONARR_QUALITY_PROFILE_ID = '8';
    process.env.SONARR_TV_ROOT_FOLDER = '/tv-hd';
    process.env.SONARR_TV_QUALITY_PROFILE_ID = '9';
    let requestBody;
    mockFetch(t, (url, options) => {
        if (url.pathname.endsWith('/rootfolder')) {
            return Response.json([{ path: '/shared' }, { path: '/tv-hd' }]);
        }
        if (url.pathname.endsWith('/qualityprofile')) {
            return Response.json([{ id: 8 }, { id: 9 }]);
        }
        if (url.pathname.endsWith('/series') && options.method === 'POST') {
            requestBody = JSON.parse(options.body);
            return Response.json({ id: 1 });
        }
        if (url.pathname.endsWith('/series')) return Response.json([]);
        throw new Error(`Unexpected request: ${url}`);
    });

    await addMedia('tv', { title: 'Configured Show', tvdbId: 456 });

    assert.equal(requestBody.rootFolderPath, '/tv-hd');
    assert.equal(requestBody.qualityProfileId, 9);
});

test('reads completed download queue items from Radarr and Sonarr', async t => {
    setEnvironment(t);
    mockFetch(t, (url, options) => {
        if (url.pathname.endsWith('/queue')) {
            if (url.hostname === 'radarr.test') {
                return Response.json({ records: [{ id: 10, status: 'completed', movie: { title: 'Radarr Result' } }] });
            }
            if (url.hostname === 'sonarr.test') {
                return Response.json({ records: [{ id: 11, status: 'completed', series: { title: 'Sonarr Result' } }] });
            }
        }
        throw new Error(`Unexpected request: ${url}`);
    });

    const movieQueue = await getQueue('movie');
    const tvQueue = await getQueue('tv');

    assert.equal(movieQueue[0]._title, 'Radarr Result');
    assert.equal(movieQueue[0].status, 'completed');
    assert.equal(tvQueue[0]._title, 'Sonarr Result');
    assert.equal(tvQueue[0].status, 'completed');
});

test('reports a clear configuration error without exposing credentials', async t => {
    setEnvironment(t);
    delete process.env.RADARR_API_KEY;

    await assert.rejects(
        searchMedia('movie', 'Sample Movie'),
        error => error instanceof ArrError
            && error.message.includes('RADARR_API_KEY')
            && !error.message.includes('radarr-test-key')
    );
});
