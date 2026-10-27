const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSettingsStore } = require('../services/settingsStore');

function createTestSafeStorage(available = true) {
    return {
        isEncryptionAvailable: () => available,
        getSelectedStorageBackend: () => 'gnome_libsecret',
        encryptString: value => Buffer.from(value, 'utf8'),
        decryptString: value => value.toString('utf8')
    };
}

test('saves encrypted settings, keeps blank secret fields, and reloads configuration', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'request-bot-settings-'));
    const filePath = path.join(directory, 'settings.json');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const environment = { DISCORD_TOKEN: 'token-from-env' };
    const storage = createTestSafeStorage();
    const store = createSettingsStore({ safeStorage: storage, filePath, environment });

    await store.save({
        DISCORD_TOKEN: '',
        CLIENT_ID: '123',
        RADARR_URL: 'http://radarr.local',
        RADARR_API_KEY: 'radarr-api-secret',
        MEDIA_SYNC_TV_SCRIPT: 'C:\\Users\\test\\TV Show mover.bat',
        MEDIA_SYNC_MOVIE_SCRIPT: 'C:\\Users\\test\\Movie mover.bat'
    });

    const contents = await fs.readFile(filePath, 'utf8');
    assert.equal(contents.includes('radarr-api-secret'), false);
    assert.equal(environment.DISCORD_TOKEN, 'token-from-env');
    assert.equal(environment.CLIENT_ID, '123');

    const restoredEnvironment = {};
    const restoredStore = createSettingsStore({
        safeStorage: storage,
        filePath,
        environment: restoredEnvironment
    });
    const settings = await restoredStore.load();
    assert.equal(restoredEnvironment.RADARR_API_KEY, 'radarr-api-secret');
    assert.equal(settings.configuredSecrets.DISCORD_TOKEN, true);
    assert.equal(settings.values.RADARR_URL, 'http://radarr.local');
    assert.equal(settings.values.MEDIA_SYNC_TV_SCRIPT, 'C:\\Users\\test\\TV Show mover.bat');
    assert.equal(settings.values.MEDIA_SYNC_MOVIE_SCRIPT, 'C:\\Users\\test\\Movie mover.bat');
    assert.equal(Object.hasOwn(settings.values, 'RADARR_API_KEY'), false);
});

test('migrates the previously selected single sync script to the TV script setting', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'request-bot-settings-'));
    const filePath = path.join(directory, 'settings.json');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const storage = createTestSafeStorage();
    const legacyPath = 'C:\\Users\\test\\TV Show mover.bat';
    await fs.writeFile(filePath, JSON.stringify({
        encrypted: storage.encryptString(JSON.stringify({
            MEDIA_SYNC_SCRIPT: legacyPath
        })).toString('base64')
    }));
    const environment = {};
    const store = createSettingsStore({ safeStorage: storage, filePath, environment });

    const settings = await store.load();
    assert.equal(settings.values.MEDIA_SYNC_TV_SCRIPT, legacyPath);
    assert.equal(settings.values.MEDIA_SYNC_MOVIE_SCRIPT, '');
    assert.equal(Object.hasOwn(settings.values, 'MEDIA_SYNC_SCRIPT'), false);
});

test('does not save secrets when secure storage is unavailable', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'request-bot-settings-'));
    const filePath = path.join(directory, 'settings.json');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = createSettingsStore({
        safeStorage: createTestSafeStorage(false),
        filePath,
        environment: {}
    });

    test('does not save credentials with the insecure Linux basic_text backend', async t => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'request-bot-settings-'));
        const filePath = path.join(directory, 'settings.json');
        t.after(() => fs.rm(directory, { recursive: true, force: true }));
        const safeStorage = createTestSafeStorage();
        safeStorage.getSelectedStorageBackend = () => 'basic_text';
        const store = createSettingsStore({
            safeStorage,
            filePath,
            environment: {},
            platform: 'linux'
        });

        await assert.rejects(
            store.save({ DISCORD_TOKEN: 'must-not-be-written' }),
            /Linux keyring secure storage is unavailable/
        );
        await assert.rejects(fs.access(filePath), { code: 'ENOENT' });
    });

    await assert.rejects(
        store.save({ DISCORD_TOKEN: 'must-not-be-written' }),
        /secure storage is unavailable/
    );
    await assert.rejects(fs.access(filePath), { code: 'ENOENT' });
});

test('rejects unknown setting names', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'request-bot-settings-'));
    const filePath = path.join(directory, 'settings.json');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = createSettingsStore({
        safeStorage: createTestSafeStorage(),
        filePath,
        environment: {}
    });

    await assert.rejects(store.save({ UNEXPECTED_SETTING: 'value' }), /Unknown setting/);
});

test('validates and normalizes request access settings', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'request-bot-settings-'));
    const filePath = path.join(directory, 'settings.json');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const environment = {};
    const store = createSettingsStore({
        safeStorage: createTestSafeStorage(),
        filePath,
        environment
    });

    await assert.rejects(
        store.save({ REQUEST_MAX_ACTIVE_PER_USER: '0' }),
        /whole number from 1 to 9999/
    );
    await assert.rejects(
        store.save({ REQUEST_ALLOWED_CHANNEL_IDS: 'not-a-channel' }),
        /comma-separated Discord channel IDs/
    );
    await store.save({
        REQUEST_MAX_ACTIVE_PER_USER: '4',
        REQUEST_ALLOWED_CHANNEL_IDS: '12345678901234567, 12345678901234567'
    });
    const loaded = await store.load();
    assert.equal(environment.REQUEST_MAX_ACTIVE_PER_USER, '4');
    assert.equal(loaded.values.REQUEST_MAX_ACTIVE_PER_USER, '4');
    assert.equal(loaded.values.REQUEST_ALLOWED_CHANNEL_IDS, '12345678901234567');
});

test('shows the welcome screen only until a new user dismisses it', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'request-bot-settings-'));
    const filePath = path.join(directory, 'settings.json');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = createSettingsStore({
        safeStorage: createTestSafeStorage(),
        filePath,
        environment: {}
    });

    assert.equal(store.getPublicSettings().firstRun, true);
    await store.save({ WELCOME_COMPLETED: 'true' });
    assert.equal(store.getPublicSettings().firstRun, false);
});

test('migrates existing qBittorrent settings to the shared client fields', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'request-bot-settings-'));
    const filePath = path.join(directory, 'settings.json');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const storage = createTestSafeStorage();
    const legacyValues = {
        QBITTORRENT_URL: 'http://qbittorrent.local:8080',
        QBITTORRENT_USERNAME: 'existing-user',
        QBITTORRENT_PASSWORD: 'existing-secret'
    };
    await fs.writeFile(filePath, JSON.stringify({
        encrypted: storage.encryptString(JSON.stringify(legacyValues)).toString('base64')
    }));
    const environment = {};
    const store = createSettingsStore({ safeStorage: storage, filePath, environment });

    const settings = await store.load();
    assert.equal(environment.TORRENT_CLIENT, 'qbittorrent');
    assert.equal(environment.TORRENT_URL, legacyValues.QBITTORRENT_URL);
    assert.equal(environment.TORRENT_USERNAME, legacyValues.QBITTORRENT_USERNAME);
    assert.equal(environment.TORRENT_PASSWORD, legacyValues.QBITTORRENT_PASSWORD);
    assert.equal(settings.values.TORRENT_CLIENT, 'qbittorrent');
    assert.equal(settings.configuredSecrets.TORRENT_PASSWORD, true);
});
