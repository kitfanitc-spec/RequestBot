class QBittorrentError extends Error {}

function getConfig(override = {}) {
    const baseUrl = override.url || process.env.QBITTORRENT_URL;
    const username = override.username || process.env.QBITTORRENT_USERNAME;
    const password = override.password || process.env.QBITTORRENT_PASSWORD;
    const configured = [baseUrl, username, password].filter(Boolean).length;

    if (configured === 0) return null;
    if (configured !== 3) {
        throw new QBittorrentError(
            'Enter the qBittorrent Web UI URL, username, and password in Settings.'
        );
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(baseUrl);
    } catch {
        throw new QBittorrentError('QBITTORRENT_URL must be a valid HTTP or HTTPS URL.');
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new QBittorrentError('QBITTORRENT_URL must use HTTP or HTTPS.');
    }

    return { baseUrl: baseUrl.replace(/\/+$/, ''), username, password };
}

async function request(config, endpoint, options = {}) {
    try {
        return await fetch(`${config.baseUrl}/api/v2/${endpoint}`, options);
    } catch {
        throw new QBittorrentError(
            'Could not connect to qBittorrent. Check QBITTORRENT_URL and that Web UI access is enabled.'
        );
    }
}

async function createSession(override) {
    const config = getConfig(override);
    if (!config) return null;

    const loginResponse = await request(config, 'auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            username: config.username,
            password: config.password
        })
    });
    if (!loginResponse.ok) {
        if (loginResponse.status === 401) {
            throw new QBittorrentError(
                'qBittorrent rejected the login. Check its Web UI URL, username, and password in Settings.'
            );
        }
        throw new QBittorrentError(`qBittorrent login failed with HTTP ${loginResponse.status}.`);
    }
    const loginResult = (await loginResponse.text()).trim();
    const loginAccepted = loginResult === 'Ok.'
        || (loginResponse.status === 204 && loginResult === '');
    if (!loginAccepted) {
        throw new QBittorrentError(
            'qBittorrent login failed. Check the Web UI username and password in Settings.'
        );
    }

    const cookies = typeof loginResponse.headers.getSetCookie === 'function'
        ? loginResponse.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]).join('; ')
        : (loginResponse.headers.get('set-cookie') || '').split(';', 1)[0];
    if (!cookies) {
        throw new QBittorrentError('qBittorrent did not return a session cookie after login.');
    }

    return { config, cookies };
}

async function testConnection(connection) {
    const session = await createSession(connection);
    if (!session) throw new QBittorrentError('Enter qBittorrent connection settings first.');

    const response = await request(session.config, 'app/version', {
        headers: { Cookie: session.cookies }
    });
    if (!response.ok) {
        throw new QBittorrentError(`qBittorrent connection test failed with HTTP ${response.status}.`);
    }
    const version = (await response.text()).trim();
    if (!version) throw new QBittorrentError('qBittorrent returned an empty version response.');
    return version;
}

async function getTorrents(override) {
    const session = await createSession(override);
    if (!session) return { configured: false, torrents: [] };

    const { config, cookies } = session;
    const response = await request(config, 'torrents/info', {
        headers: { Cookie: cookies }
    });
    if (!response.ok) {
        throw new QBittorrentError(`Could not read the qBittorrent torrent list (HTTP ${response.status}).`);
    }

    let torrents;
    try {
        torrents = await response.json();
    } catch {
        throw new QBittorrentError('qBittorrent returned invalid torrent data.');
    }
    if (!Array.isArray(torrents)) {
        throw new QBittorrentError('qBittorrent returned unexpected torrent data.');
    }

    return { configured: true, torrents };
}

async function reannounceAllTrackers(override) {
    const session = await createSession(override);
    if (!session) {
        throw new QBittorrentError(
            'Enter the qBittorrent Web UI URL, username, and password in Settings.'
        );
    }

    const response = await request(session.config, 'torrents/reannounce', {
        method: 'POST',
        headers: {
            Cookie: session.cookies,
            Origin: session.config.baseUrl,
            Referer: `${session.config.baseUrl}/`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ hashes: 'all' })
    });

    if (!response.ok) {
        throw new QBittorrentError(
            `qBittorrent could not reannounce torrent trackers (HTTP ${response.status}).`
        );
    }

    return { success: true };
}

module.exports = { QBittorrentError, getTorrents, reannounceAllTrackers, testConnection };
