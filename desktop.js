require('dotenv').config();

const fs = require('node:fs/promises');
const { createMediaSyncRunner } = require('./services/mediaSyncRunner');
const { constants } = require('node:fs');
const path = require('node:path');
const {
    app,
    BrowserWindow,
    dialog,
    globalShortcut,
    ipcMain,
    Menu,
    nativeImage,
    safeStorage,
    Tray
} = require('electron');
const { getDashboardData } = require('./services/dashboardData');
const { getConfigurationOptions } = require('./services/arrClient');
const { reannounceAllTrackers } = require('./services/torrentClients');
const { testConnection } = require('./services/connectionTests');
const { registerSlashCommand } = require('./services/discordSetup');
const { requestHistory } = require('./services/requestHistory');
const { createSettingsStore } = require('./services/settingsStore');
const { startBot, stopBot } = require('./index');

const toggleShortcut = 'CommandOrControl+Shift+D';
app.setName('Request Bot');
let dashboardWindow;
let botClient;
let tray;
let settingsStore;
let isQuitting = false;
let quitCleanupPending = false;
let botState = { running: false, message: 'Setup required' };
function getMediaSyncScriptPath(role) {
    if (!settingsStore) return '';
    const scriptKey = role === 'tv' ? 'MEDIA_SYNC_TV_SCRIPT' : 'MEDIA_SYNC_MOVIE_SCRIPT';
    return settingsStore.getPublicSettings().values[scriptKey] || '';
}

const mediaSyncRunners = Object.fromEntries(['tv', 'movies'].map(role => [
    role,
    createMediaSyncRunner({
        onStatus: status => dashboardWindow?.webContents.send('media-sync:status', {
            role,
            ...status,
            scriptPath: getMediaSyncScriptPath(role)
        })
    })
]));

function requireMediaSyncRole(role) {
    if (!Object.hasOwn(mediaSyncRunners, role)) {
        throw new Error('Choose TV or movies for media sync.');
    }
    return role;
}

function getMediaSyncDashboardState() {
    const settings = settingsStore.getPublicSettings();
    return Object.fromEntries(Object.entries(mediaSyncRunners).map(([role, runner]) => {
        const scriptKey = role === 'tv' ? 'MEDIA_SYNC_TV_SCRIPT' : 'MEDIA_SYNC_MOVIE_SCRIPT';
        return [role, {
            ...runner.getStatus(),
            scriptPath: settings.values[scriptKey] || ''
        }];
    }));
}

function startConfiguredBot() {
    if (!process.env.DISCORD_TOKEN) {
        botState = { running: false, message: 'Setup required' };
        return undefined;
    }

    const client = startBot();
    botState = { running: false, message: 'Connecting to Discord...' };
    client.once('clientReady', () => {
        botState = { running: true, message: 'Bot is connected' };
        dashboardWindow?.webContents.send('bot:status', botState);
    });
    client.once('botLoginError', () => {
        botState = { running: false, message: 'Discord login failed — check Settings' };
        dashboardWindow?.webContents.send('bot:status', botState);
    });
    return client;
}

function requireDashboard(event) {
    if (event.sender !== dashboardWindow?.webContents) {
        throw new Error('Settings are only available to the desktop dashboard.');
    }
}

async function configureRequestHistory() {
    const targetPath = path.join(app.getPath('userData'), 'request-history.sqlite');
    if (!app.isPackaged) {
        const legacyPath = path.join(__dirname, 'request-history.sqlite');
        try {
            await fs.access(targetPath);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            try {
                await fs.copyFile(legacyPath, targetPath, constants.COPYFILE_EXCL);
            } catch (copyError) {
                if (copyError.code !== 'ENOENT' && copyError.code !== 'EEXIST') throw copyError;
            }
        }
    }
    requestHistory.configure(targetPath);
}

function showDashboard() {
    if (!dashboardWindow) {
        createDashboardWindow();
        return;
    }

    dashboardWindow.show();
    dashboardWindow.focus();
}

function toggleDashboard() {
    if (!dashboardWindow) return;

    if (dashboardWindow.isVisible()) {
        dashboardWindow.hide();
    } else {
        showDashboard();
    }
}

function createDashboardWindow() {
    dashboardWindow = new BrowserWindow({
        width: 560,
        height: 720,
        minWidth: 440,
        minHeight: 560,
        show: false,
        frame: false,
        title: 'Request Bot - Downloads',
        backgroundColor: '#111827',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    ipcMain.handle('app:get-platform', event => {
        requireDashboard(event);
        return process.platform;
    });

    dashboardWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    dashboardWindow.loadFile(path.join(__dirname, 'dashboard', 'index.html'));
    dashboardWindow.once('ready-to-show', () => dashboardWindow.show());
    dashboardWindow.on('close', event => {
        if (isQuitting) return;
        event.preventDefault();
        dashboardWindow.hide();
    });
    dashboardWindow.on('closed', () => {
        dashboardWindow = undefined;
    });
}

function createTray() {
    const iconData = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAu0lEQVR42mNgGMog4+qL/wNqOQwPqOWDwhEDGgUDngboYlnFzIv/0THMAdjkYJjqlpLqALIdg82AO6/+k4TJdgQllhLjGKIdQC3L0R1BsQP2X/pIEJPtAHzBT4zF+BxCVDTg8z2ywaaBdWSFBNkOQLcchpHF01p3omB8oUC2A5AtR3cEXRyALwRISQcUOYCUNEA1B1AjF5DkgAHLhgNeEA2qonjAKqMBr46JbZCQimnaOqKJpaNgFNALAABZeUPDoF5uZAAAAABJRU5ErkJggg==';
    const icon = nativeImage.createFromBuffer(Buffer.from(iconData, 'base64'));
    if (icon.isEmpty()) throw new Error('Could not load the Request Bot tray icon.');

    tray = new Tray(icon);
    tray.setToolTip('Request Bot');
    tray.setContextMenu(Menu.buildFromTemplate([
        {
            label: 'Open dashboard',
            click: showDashboard
        },
        { type: 'separator' },
        {
            label: 'Stop Request Bot',
            click: () => app.quit()
        }
    ]));
    tray.on('click', showDashboard);
}

ipcMain.handle('downloads:get-status', async () => getDashboardData(requestHistory));
ipcMain.handle('history:export', async event => {
    requireDashboard(event);
    return requestHistory.listAllRequests();
});
ipcMain.handle('history:clear', async event => {
    requireDashboard(event);
    await requestHistory.clearAllRequests();
    return { success: true };
});
ipcMain.handle('history:cancel-request', async (event, id) => {
    requireDashboard(event);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Choose a valid request to cancel.');
    return requestHistory.cancelRequest(id);
});

ipcMain.handle('settings:get', event => {
    requireDashboard(event);
    return { ...settingsStore.getPublicSettings(), botState };
});

ipcMain.handle('settings:complete-welcome', async event => {
    requireDashboard(event);
    await settingsStore.save({ WELCOME_COMPLETED: 'true' });
    return { success: true };
});

ipcMain.handle('settings:save', async (event, settings) => {
    requireDashboard(event);
    await settingsStore.save(settings);

    if (botClient) {
        await stopBot(botClient);
        botClient = undefined;
    }
    botClient = startConfiguredBot();
    return { botRunning: Boolean(botClient), botState };
});

ipcMain.handle('settings:test-connection', (event, service, values) => {
    requireDashboard(event);
    const secretFields = {
        discord: { token: 'DISCORD_TOKEN' },
        radarr: { apiKey: 'RADARR_API_KEY' },
        sonarr: { apiKey: 'SONARR_API_KEY' },
        torrent: { password: 'TORRENT_PASSWORD' }
    }[service] || {};
    const connection = { ...values };
    for (const [field, envName] of Object.entries(secretFields)) {
        if (!connection[field]) connection[field] = process.env[envName] || '';
    }
    return testConnection(service, connection);
});

ipcMain.handle('settings:get-manager-options', (event, service, values) => {
    requireDashboard(event);
    if (!['radarr', 'sonarr'].includes(service)) throw new Error('Choose Radarr or Sonarr.');
    const prefix = service.toUpperCase();
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
        throw new Error('Enter the service connection settings first.');
    }
    return getConfigurationOptions(service === 'radarr' ? 'movie' : 'tv', {
        url: typeof values.url === 'string' && values.url.trim()
            ? values.url.trim()
            : process.env[`${prefix}_URL`],
        apiKey: typeof values.apiKey === 'string' && values.apiKey.trim()
            ? values.apiKey.trim()
            : process.env[`${prefix}_API_KEY`]
    });
});

ipcMain.handle('settings:register-command', (event) => {
    requireDashboard(event);
    return registerSlashCommand();
});

ipcMain.handle('trackers:reannounce-all', event => {
    requireDashboard(event);

    return reannounceAllTrackers();
});

ipcMain.handle('media-sync:choose-script', async (event, role) => {
    requireDashboard(event);
    const selectedRole = requireMediaSyncRole(role);
    if (mediaSyncRunners[selectedRole].getStatus().running) {
        throw new Error(`Stop ${selectedRole === 'tv' ? 'TV' : 'movie'} sync before choosing a different script.`);
    }
    const extension = process.platform === 'win32' ? 'bat' : 'sh';
    const result = await dialog.showOpenDialog(dashboardWindow, {
        title: `Choose your personal ${selectedRole === 'tv' ? 'TV' : 'movie'} sync script`,
        properties: ['openFile'],
        filters: [{ name: `${extension.toUpperCase()} scripts`, extensions: [extension] }]
    });
    if (result.canceled) return getMediaSyncDashboardState();

    const scriptPath = result.filePaths[0];
    const settingKey = selectedRole === 'tv' ? 'MEDIA_SYNC_TV_SCRIPT' : 'MEDIA_SYNC_MOVIE_SCRIPT';
    await settingsStore.save({ [settingKey]: scriptPath });
    return getMediaSyncDashboardState();
});

ipcMain.handle('media-sync:get-status', event => {
    requireDashboard(event);
    return getMediaSyncDashboardState();
});

ipcMain.handle('media-sync:start', async (event, role) => {
    requireDashboard(event);
    const selectedRole = requireMediaSyncRole(role);
    const state = getMediaSyncDashboardState()[selectedRole];
    const status = await mediaSyncRunners[selectedRole].start(state.scriptPath);
    return { role: selectedRole, ...status, scriptPath: state.scriptPath };
});

ipcMain.handle('media-sync:stop', async (event, role) => {
    requireDashboard(event);
    const selectedRole = requireMediaSyncRole(role);
    const status = await mediaSyncRunners[selectedRole].stop();
    return {
        role: selectedRole,
        ...status,
        scriptPath: getMediaSyncDashboardState()[selectedRole].scriptPath
    };
});

ipcMain.handle('window:get-state', event => {
    requireDashboard(event);

    return { isMaximized: dashboardWindow.isMaximized() };
});

ipcMain.handle('window:minimize', event => {
    requireDashboard(event);

    dashboardWindow.minimize();
});

ipcMain.handle('window:toggle-maximize', event => {
    requireDashboard(event);

    if (dashboardWindow.isMaximized()) dashboardWindow.unmaximize();
    else dashboardWindow.maximize();

    return { isMaximized: dashboardWindow.isMaximized() };
});

ipcMain.handle('window:hide', event => {
    requireDashboard(event);

    dashboardWindow.hide();
});

app.whenReady().then(() => {
    settingsStore = createSettingsStore({
        safeStorage,
        filePath: path.join(app.getPath('userData'), 'settings.json')
    });
    return settingsStore.load();
}).then(() => {
    return configureRequestHistory();
}).then(() => {
    botClient = startConfiguredBot();
    createDashboardWindow();
    createTray();

    if (!globalShortcut.register(toggleShortcut, toggleDashboard)) {
        console.error(`Could not register the ${toggleShortcut} global shortcut. It may already be in use.`);
    }

    app.on('activate', () => {
        if (!dashboardWindow) createDashboardWindow();
        else dashboardWindow.show();
    });
}).catch(error => {
    console.error('Desktop app failed to start:', error);
    app.quit();
});

app.on('before-quit', event => {
    const runningRunners = Object.values(mediaSyncRunners).filter(runner => runner.getStatus().running);
    if (runningRunners.length > 0) {
        event.preventDefault();
        if (quitCleanupPending) return;
        quitCleanupPending = true;
        Promise.all(runningRunners.map(runner => runner.stop())).then(() => {
            quitCleanupPending = false;
            app.quit();
        }).catch(error => {
            quitCleanupPending = false;
            console.error('Could not stop all personal media sync scripts before quitting:', error);
            showDashboard();
        });
        return;
    }

    isQuitting = true;
    globalShortcut.unregisterAll();
    if (tray) tray.destroy();
    if (botClient) stopBot(botClient);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => app.quit());
}
