const fs = require('node:fs/promises');
const path = require('node:path');

const SETTING_KEYS = [
    'DISCORD_TOKEN',
    'CLIENT_ID',
    'GUILD_ID',
    'WELCOME_COMPLETED',
    'ALERT_CHANNEL_ID',
    'REQUEST_MAX_ACTIVE_PER_USER',
    'REQUEST_ALLOWED_CHANNEL_IDS',
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
    'SONARR_ANIME_QUALITY_PROFILE_ID',
    'TORRENT_CLIENT',
    'TORRENT_URL',
    'TORRENT_USERNAME',
    'TORRENT_PASSWORD',
    'MEDIA_SYNC_TV_SCRIPT',
    'MEDIA_SYNC_MOVIE_SCRIPT',
    'QBITTORRENT_URL',
    'QBITTORRENT_USERNAME',
    'QBITTORRENT_PASSWORD'
];

const SECRET_KEYS = new Set([
    'DISCORD_TOKEN',
    'RADARR_API_KEY',
    'SONARR_API_KEY',
    'QBITTORRENT_PASSWORD',
    'TORRENT_PASSWORD'
]);

function createSettingsStore({
    safeStorage,
    filePath,
    fileSystem = fs,
    environment = process.env,
    platform = process.platform
}) {
    function isSecureStorageAvailable() {
        if (!safeStorage.isEncryptionAvailable()) return false;
        if (platform !== 'linux') return true;
        const backend = safeStorage.getSelectedStorageBackend();
        return backend !== 'basic_text' && backend !== 'unknown';
    }

    function secureStorageUnavailableMessage(action) {
        const storageName = platform === 'linux' ? 'Linux keyring secure storage' : 'Operating-system secure storage';
        return `${storageName} is unavailable; settings were not ${action}.`;
    }

    async function readSettings() {
        try {
            const stored = JSON.parse(await fileSystem.readFile(filePath, 'utf8'));
            if (typeof stored.encrypted !== 'string') {
                throw new Error('Saved settings have an invalid format.');
            }
            if (!isSecureStorageAvailable()) {
                throw new Error(secureStorageUnavailableMessage('loaded'));
            }

            const decrypted = safeStorage.decryptString(Buffer.from(stored.encrypted, 'base64'));
            const values = JSON.parse(decrypted);
            if (!values || typeof values !== 'object' || Array.isArray(values)) {
                throw new Error('Saved settings have an invalid format.');
            }
            return values;
        } catch (error) {
            if (error.code === 'ENOENT') return {};
            throw error;
        }
    }

    async function load() {
        const saved = await readSettings();
        for (const key of SETTING_KEYS) {
            if (Object.hasOwn(saved, key) && typeof saved[key] === 'string') {
                environment[key] = saved[key];
            }
        }
        if (!environment.MEDIA_SYNC_TV_SCRIPT && typeof saved.MEDIA_SYNC_SCRIPT === 'string') {
            environment.MEDIA_SYNC_TV_SCRIPT = saved.MEDIA_SYNC_SCRIPT;
        }
        if (!environment.TORRENT_CLIENT && environment.QBITTORRENT_URL) {
            environment.TORRENT_CLIENT = 'qbittorrent';
            environment.TORRENT_URL = environment.QBITTORRENT_URL;
            environment.TORRENT_USERNAME = environment.QBITTORRENT_USERNAME || '';
            environment.TORRENT_PASSWORD = environment.QBITTORRENT_PASSWORD || '';
        }
        return getPublicSettings();
    }

    function getPublicSettings() {
        const values = {};
        const configuredSecrets = {};
        for (const key of SETTING_KEYS) {
            if (SECRET_KEYS.has(key)) configuredSecrets[key] = Boolean(environment[key]);
            else values[key] = environment[key] || '';
        }
        const hasExistingConfiguration = Boolean(
            environment.DISCORD_TOKEN
            || environment.RADARR_API_KEY
            || environment.SONARR_API_KEY
        );
        return {
            values,
            configuredSecrets,
            firstRun: environment.WELCOME_COMPLETED !== 'true' && !hasExistingConfiguration
        };
    }

    async function save(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            throw new Error('Settings must be provided as an object.');
        }
        if (!isSecureStorageAvailable()) {
            throw new Error(secureStorageUnavailableMessage('saved'));
        }

        const values = {};
        for (const key of SETTING_KEYS) {
            if (typeof environment[key] === 'string' && environment[key]) {
                values[key] = environment[key];
            }
        }
        if (!values.TORRENT_CLIENT && values.QBITTORRENT_URL) {
            values.TORRENT_CLIENT = 'qbittorrent';
            values.TORRENT_URL = values.QBITTORRENT_URL;
            values.TORRENT_USERNAME = values.QBITTORRENT_USERNAME || '';
            values.TORRENT_PASSWORD = values.QBITTORRENT_PASSWORD || '';
        }
        delete values.QBITTORRENT_URL;
        delete values.QBITTORRENT_USERNAME;
        delete values.QBITTORRENT_PASSWORD;

        for (const [key, value] of Object.entries(input)) {
            if (!SETTING_KEYS.includes(key)) throw new Error(`Unknown setting: ${key}`);
            if (typeof value !== 'string' || value.length > 4096) {
                throw new Error(`${key} must be text no longer than 4096 characters.`);
            }
            if (SECRET_KEYS.has(key) && value.trim() === '') continue;
            if (key === 'REQUEST_MAX_ACTIVE_PER_USER' && value.trim()
                && !/^[1-9]\d{0,3}$/.test(value.trim())) {
                throw new Error('REQUEST_MAX_ACTIVE_PER_USER must be a whole number from 1 to 9999.');
            }
            if (key === 'REQUEST_ALLOWED_CHANNEL_IDS' && value.trim()) {
                const channelIds = value.split(',').map(channelId => channelId.trim());
                if (channelIds.some(channelId => !/^\d{17,20}$/.test(channelId))) {
                    throw new Error('REQUEST_ALLOWED_CHANNEL_IDS must contain comma-separated Discord channel IDs.');
                }
                values[key] = [...new Set(channelIds)].join(', ');
                continue;
            }
            if (value.trim() === '') delete values[key];
            else values[key] = value.trim();
        }

        const encrypted = safeStorage.encryptString(JSON.stringify(values)).toString('base64');
        await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
        const temporaryPath = `${filePath}.${process.pid}.tmp`;
        try {
            await fileSystem.writeFile(temporaryPath, JSON.stringify({ encrypted }), { encoding: 'utf8' });
            await fileSystem.rename(temporaryPath, filePath);
        } catch (error) {
            await fileSystem.rm(temporaryPath, { force: true }).catch(() => {});
            throw error;
        }

        for (const key of SETTING_KEYS) {
            if (Object.hasOwn(values, key)) environment[key] = values[key];
            else delete environment[key];
        }

        return getPublicSettings();
    }

    return { load, save, getPublicSettings };
}

module.exports = { createSettingsStore, SECRET_KEYS, SETTING_KEYS };
