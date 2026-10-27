const {
    getTorrents: getQBittorrentTorrents,
    reannounceAllTrackers: reannounceQBittorrent,
    testConnection: testQBittorrent
} = require('./qbittorrent');

class TorrentClientError extends Error {}

const SUPPORTED_CLIENTS = new Set(['qbittorrent', 'transmission', 'deluge', 'bittorrent']);

function getConfig(override = {}) {
    const client = override.client || process.env.TORRENT_CLIENT
        || (process.env.QBITTORRENT_URL ? 'qbittorrent' : '');
    if (!SUPPORTED_CLIENTS.has(client)) {
        if (!client) return null;
        throw new TorrentClientError('Choose qBittorrent, Transmission, or Deluge in Settings.');
    }

    const url = override.url || process.env.TORRENT_URL || process.env.QBITTORRENT_URL;
    const username = override.username ?? process.env.TORRENT_USERNAME ?? process.env.QBITTORRENT_USERNAME ?? '';
    const password = override.password ?? process.env.TORRENT_PASSWORD ?? process.env.QBITTORRENT_PASSWORD ?? '';
    if (!url) throw new TorrentClientError(`Enter the ${clientLabel(client)} Web UI URL in Settings.`);

    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch {
        throw new TorrentClientError('Torrent client URL must be a valid HTTP or HTTPS URL.');
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new TorrentClientError('Torrent client URL must use HTTP or HTTPS.');
    }
    if (client === 'qbittorrent' && (!username || !password)) {
        throw new TorrentClientError('Enter the qBittorrent Web UI username and password in Settings.');
    }
    if (client === 'transmission' && Boolean(username) !== Boolean(password)) {
        throw new TorrentClientError('Enter both the Transmission username and password, or leave both blank.');
    }
    if (client === 'deluge' && !password) {
        throw new TorrentClientError('Enter the Deluge Web UI password in Settings.');
    }
    if (client === 'bittorrent' && (!username || !password)) {
        throw new TorrentClientError('Enter the BitTorrent Web UI username and password in Settings.');
    }

    return {
        client,
        baseUrl: url.replace(/\/+$/, ''),
        username,
        password
    };
}

function clientLabel(client) {
    return client === 'qbittorrent'
        ? 'qBittorrent'
        : client === 'transmission' ? 'Transmission'
            : client === 'deluge' ? 'Deluge' : 'BitTorrent / µTorrent';
}

async function fetchFor(config, url, options = {}) {
    try {
        return await fetch(url, options);
    } catch {
        throw new TorrentClientError(`Could not connect to ${clientLabel(config.client)}. Check its Web UI URL and that remote access is enabled.`);
    }
}

async function parseJson(response, client) {
    try {
        return await response.json();
    } catch {
        throw new TorrentClientError(`${clientLabel(client)} returned invalid JSON.`);
    }
}

async function transmissionCall(config, method, args = {}) {
    const endpoint = `${config.baseUrl}/transmission/rpc`;
    const headers = {
        'Content-Type': 'application/json',
        ...config.username ? {
            Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`
        } : {}
    };
    const body = JSON.stringify({ method, arguments: args });
    let response = await fetchFor(config, endpoint, { method: 'POST', headers, body });
    if (response.status === 401) {
        throw new TorrentClientError('Transmission rejected the login. Check its RPC username and password in Settings.');
    }
    if (response.status === 409) {
        const sessionId = response.headers.get('x-transmission-session-id');
        if (!sessionId) throw new TorrentClientError('Transmission did not return an RPC session token.');
        response = await fetchFor(config, endpoint, {
            method: 'POST',
            headers: { ...headers, 'X-Transmission-Session-Id': sessionId },
            body
        });
    }
    if (!response.ok) {
        throw new TorrentClientError(`Transmission RPC failed with HTTP ${response.status}.`);
    }
    const result = await parseJson(response, 'transmission');
    if (result.result !== 'success') {
        throw new TorrentClientError(`Transmission RPC ${method} failed: ${result.result || 'unexpected response'}.`);
    }
    return result.arguments || {};
}

function normalizeTransmission(torrent) {
    const status = Number(torrent.status);
    const state = status === 4 ? 'downloading'
        : status === 3 ? 'queuedDL'
            : status === 1 || status === 2 ? 'checkingDL'
                : status === 6 ? 'uploading'
                    : status === 5 ? 'queuedUP'
                        : status === 7 ? 'checkingUP'
                            : status === 0 ? (torrent.isFinished ? 'pausedUP' : 'pausedDL')
                                : 'unknown';
    const size = Number(torrent.totalSize);
    const left = Number(torrent.leftUntilDone);
    return {
        id: Number(torrent.id),
        hash: torrent.hashString || String(torrent.id),
        name: torrent.name,
        state,
        progress: size > 0 ? (size - left) / size : 0,
        dlspeed: Number(torrent.rateDownload) || 0,
        eta: Number(torrent.eta) >= 0 ? Number(torrent.eta) : 8640000
    };
}

async function getTransmissionTorrents(config) {
    const result = await transmissionCall(config, 'torrent-get', {
        fields: ['id', 'hashString', 'name', 'status', 'isFinished', 'totalSize', 'leftUntilDone', 'rateDownload', 'eta']
    });
    if (!Array.isArray(result.torrents)) {
        throw new TorrentClientError('Transmission returned an unexpected torrent list.');
    }
    return result.torrents.map(normalizeTransmission);
}

async function delugeCall(config, method, params = [], session = {}) {
    const response = await fetchFor(config, `${config.baseUrl}/json`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(session.cookies ? { Cookie: session.cookies } : {})
        },
        body: JSON.stringify({ method, params, id: 1 })
    });
    if (response.status === 401 || response.status === 403) {
        throw new TorrentClientError('Deluge rejected the Web UI password. Check Settings.');
    }
    if (!response.ok) throw new TorrentClientError(`Deluge Web API failed with HTTP ${response.status}.`);

    const result = await parseJson(response, 'deluge');
    if (result.error) {
        if (/auth|password|login/i.test(result.error.message || '')) {
            throw new TorrentClientError('Deluge rejected the Web UI password. Check Settings.');
        }
        throw new TorrentClientError(`Deluge ${method} failed: ${result.error.message || 'unexpected response'}.`);
    }
    return { result: result.result, cookies: response.headers.get('set-cookie') };
}

async function createDelugeSession(config) {
    const login = await delugeCall(config, 'auth.login', [config.password]);
    if (login.result !== true) throw new TorrentClientError('Deluge rejected the Web UI password. Check Settings.');
    return { cookies: login.cookies ? login.cookies.split(';', 1)[0] : '' };
}

async function getDelugeTorrents(config, session) {
    const fields = [
        'name', 'state', 'progress', 'download_payload_rate', 'eta',
        'total_size', 'total_done', 'tracker_status'
    ];
    const response = await delugeCall(config, 'core.get_torrents_status', [{}, fields], session);
    if (!response.result || typeof response.result !== 'object' || Array.isArray(response.result)) {
        throw new TorrentClientError('Deluge returned an unexpected torrent list.');
    }
    return Object.entries(response.result).map(([hash, torrent]) => {
        const sourceState = String(torrent.state || 'Unknown').toLowerCase();
        const complete = Number(torrent.progress) >= 100;
        const state = sourceState === 'downloading' ? 'downloading'
            : sourceState === 'seeding' ? 'uploading'
                : sourceState === 'paused' ? (complete ? 'pausedUP' : 'pausedDL')
                    : sourceState === 'checking' ? (complete ? 'checkingUP' : 'checkingDL')
                        : sourceState === 'error' ? 'error'
                            : sourceState === 'queued' ? (complete ? 'queuedUP' : 'queuedDL')
                                : 'unknown';
        const eta = Number(torrent.eta);
        const totalSize = Number(torrent.total_size);
        const totalDone = Number(torrent.total_done);
        return {
            hash,
            name: torrent.name || 'Unknown torrent',
            state,
            progress: Number.isFinite(Number(torrent.progress))
                ? Number(torrent.progress) / 100
                : totalSize > 0 ? totalDone / totalSize : 0,
            dlspeed: Number(torrent.download_payload_rate) || 0,
            eta: Number.isFinite(eta) && eta >= 0 ? eta : 8640000
        };
    });
}

async function createBitTorrentSession(config) {
    const authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
    const response = await fetchFor(config, `${config.baseUrl}/gui/token.html`, {
        headers: { Authorization: authorization }
    });
    if (response.status === 401 || response.status === 403) {
        throw new TorrentClientError('BitTorrent Web UI rejected the login. Check the username and password in Settings.');
    }
    if (!response.ok) {
        throw new TorrentClientError(`BitTorrent Web UI token request failed with HTTP ${response.status}.`);
    }
    const html = await response.text();
    const match = html.match(/<div[^>]*id=["']token["'][^>]*>\s*([^<\s]+)\s*<\/div>/i);
    if (!match) throw new TorrentClientError('BitTorrent Web UI did not return an RPC token. Enable its Web UI access.');
    const cookie = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
        : (response.headers.get('set-cookie') || '').split(';', 1)[0];
    return { authorization, cookie, token: match[1] };
}

async function bitTorrentCall(config, session, parameters) {
    const query = new URLSearchParams({ ...parameters, token: session.token });
    const response = await fetchFor(config, `${config.baseUrl}/gui/?${query}`, {
        headers: {
            Authorization: session.authorization,
            ...(session.cookie ? { Cookie: session.cookie } : {})
        }
    });
    if (response.status === 401 || response.status === 403) {
        throw new TorrentClientError('BitTorrent Web UI rejected the login. Check the username and password in Settings.');
    }
    if (!response.ok) {
        throw new TorrentClientError(`BitTorrent Web UI request failed with HTTP ${response.status}.`);
    }
    return parseJson(response, 'bittorrent');
}

function normalizeBitTorrent(torrent) {
    if (!Array.isArray(torrent) || torrent.length < 9) {
        throw new TorrentClientError('BitTorrent Web UI returned an invalid torrent record.');
    }
    const flags = Number(torrent[1]) || 0;
    const size = Number(torrent[3]) || 0;
    const downloaded = Number(torrent[4]) || 0;
    const downloadSpeed = Number(torrent[8]) || 0;
    const remaining = Number(torrent[17]);
    const complete = size > 0 && (
        Number.isFinite(remaining) ? remaining <= 0 : downloaded >= size
    );
    const state = flags & 16 ? 'error'
        : flags & 2 || flags & 4 ? (complete ? 'checkingUP' : 'checkingDL')
            : flags & 32 ? (complete ? 'pausedUP' : 'pausedDL')
                : flags & 64 ? (complete ? 'queuedUP' : 'queuedDL')
                    : flags & 1 ? complete
                        ? 'uploading'
                        : downloadSpeed > 0 ? 'downloading' : 'stalledDL'
                        : complete ? 'pausedUP' : 'pausedDL';
    const eta = Number(torrent[9]);
    return {
        hash: String(torrent[0]),
        name: String(torrent[2] || 'Unknown torrent'),
        state,
        progress: size > 0 ? Math.max(0, Math.min(1, downloaded / size)) : 0,
        dlspeed: downloadSpeed,
        eta: Number.isFinite(eta) && eta >= 0 ? eta : 8640000
    };
}

async function getBitTorrentTorrents(config, session) {
    const response = await bitTorrentCall(config, session, { list: '1' });
    if (!Array.isArray(response.torrents)) {
        throw new TorrentClientError('BitTorrent Web UI returned an unexpected torrent list.');
    }
    return response.torrents.map(normalizeBitTorrent);
}

async function getTorrents(override) {
    const config = getConfig(override);
    if (!config) return { configured: false, torrents: [] };
    if (config.client === 'qbittorrent') {
        const result = await getQBittorrentTorrents(toQBittorrentConfig(config));
        return { configured: result.configured, client: config.client, torrents: result.torrents };
    }
    if (config.client === 'transmission') {
        return {
            configured: true,
            client: config.client,
            torrents: await getTransmissionTorrents(config)
        };
    }
    if (config.client === 'bittorrent') {
        const session = await createBitTorrentSession(config);
        return {
            configured: true,
            client: config.client,
            torrents: await getBitTorrentTorrents(config, session)
        };
    }
    const session = await createDelugeSession(config);
    return {
        configured: true,
        client: config.client,
        torrents: await getDelugeTorrents(config, session)
    };
}

function toQBittorrentConfig(config) {
    return { url: config.baseUrl, username: config.username, password: config.password };
}

async function testConnection(override = {}) {
    const config = getConfig(override);
    if (!config) throw new TorrentClientError('Choose and configure a torrent client in Settings.');
    if (config.client === 'qbittorrent') {
        await testQBittorrent(config);
    } else if (config.client === 'transmission') {
        await transmissionCall(config, 'session-get');
    } else if (config.client === 'bittorrent') {
        const session = await createBitTorrentSession(config);
        await getBitTorrentTorrents(config, session);
    } else {
        await createDelugeSession(config);
    }
    return { success: true, message: `Connected to ${clientLabel(config.client)}.` };
}

async function reannounceAllTrackers() {
    const config = getConfig();
    if (!config) throw new TorrentClientError('Choose and configure a torrent client in Settings.');
    if (config.client === 'qbittorrent') return reannounceQBittorrent(toQBittorrentConfig(config));
    if (config.client === 'transmission') {
        const torrents = await getTransmissionTorrents(config);
        await transmissionCall(config, 'torrent-reannounce', {
            ids: torrents.map(torrent => torrent.id)
        });
    } else if (config.client === 'bittorrent') {
        const session = await createBitTorrentSession(config);
        const torrents = await getBitTorrentTorrents(config, session);
        await Promise.all(torrents.map(torrent => bitTorrentCall(config, session, {
            action: 'forcereannounce',
            hash: torrent.hash
        })));
    } else {
        const session = await createDelugeSession(config);
        const torrents = await getDelugeTorrents(config, session);
        await delugeCall(config, 'core.force_reannounce', [torrents.map(torrent => torrent.hash)], session);
    }
    return { success: true };
}

module.exports = {
    TorrentClientError,
    getConfig,
    getTorrents,
    reannounceAllTrackers,
    testConnection
};
