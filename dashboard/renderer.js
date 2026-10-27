const queueElement = document.getElementById('queue');
const errorsElement = document.getElementById('errors');
const updatedElement = document.getElementById('updated');
const summaryElement = document.getElementById('summary');
const greetingElement = document.getElementById('greeting');
const refreshButton = document.getElementById('refresh');
const trackerRefreshButton = document.getElementById('tracker-refresh');
const trackerMessage = document.getElementById('tracker-message');
const minimizeWindowButton = document.getElementById('minimize-window');
const maximizeWindowButton = document.getElementById('maximize-window');
const closeWindowButton = document.getElementById('close-window');
const completionsElement = document.getElementById('completions');
const requestsElement = document.getElementById('requests');
const attentionElement = document.getElementById('attention');
const mascotCard = document.getElementById('mascot-card');
const assistantState = document.getElementById('assistant-state');
const settingsOpenButton = document.getElementById('settings-open');
const settingsDialog = document.getElementById('settings-dialog');
const settingsForm = document.getElementById('settings-form');
const settingsCloseButton = document.getElementById('settings-close');
const settingsMessage = document.getElementById('settings-message');
const registerCommandButton = document.getElementById('register-command');
const welcomeView = document.getElementById('welcome-view');
const settingsView = document.getElementById('settings-view');
const welcomeStartButton = document.getElementById('welcome-start');
const welcomeLaterButton = document.getElementById('welcome-later');
const welcomeMessage = document.getElementById('welcome-message');
const botStatusElement = document.getElementById('bot-status');
const requestSearch = document.getElementById('request-search');
const requestStatusFilter = document.getElementById('request-status-filter');
const activeCountElement = document.getElementById('active-count');
const stalledCountElement = document.getElementById('stalled-count');
const seedingCountElement = document.getElementById('seeding-count');
const completionCountElement = document.getElementById('completion-count');
const mediaSyncItems = [...document.querySelectorAll('[data-media-sync]')];
const mediaSyncHelp = document.querySelector('[data-media-sync-help]');
let refreshInProgress = false;
let recentRequests = [];

function createElement(tagName, className, text) {
    const element = document.createElement(tagName);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

function renderQueue(items) {
    const activeItems = items.filter(item => !item.needsAttention);
    queueElement.replaceChildren();

    if (activeItems.length === 0) {
        queueElement.append(createElement('p', 'empty-state', 'No active downloads right now.'));
        return;
    }

    for (const item of activeItems) {
        const card = createElement('article', 'download-card');
        const topline = createElement('div', 'download-topline');
        const details = document.createElement('div');
        const subtitle = item.downloadSpeed > 0
            ? `${item.service} · ${formatSpeed(item.downloadSpeed)}`
            : item.service;
        details.append(
            createElement('h3', 'download-title', item.title),
            createElement('span', 'download-service', subtitle)
        );
        topline.append(details, createElement('span', 'download-status', item.status));
        card.append(topline);
        if (item.statusDetail) {
            card.append(createElement('p', 'download-explanation', item.statusDetail));
        }

        if (item.progress !== null) {
            const progressTrack = createElement('progress', 'progress-track');
            progressTrack.max = 100;
            progressTrack.value = item.progress;
            const caption = createElement('div', 'progress-caption');
            caption.append(
                createElement('span', '', item.timeLeft ? `Remaining: ${item.timeLeft}` : 'Download progress'),
                createElement('span', '', `${item.progress}%`)
            );
            card.append(progressTrack, caption);
        }

        queueElement.append(card);
    }
}

function formatDate(value) {
    if (!value) return 'Date unavailable';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString();
}

function formatSpeed(bytesPerSecond) {
    if (bytesPerSecond >= 1024 * 1024) {
        return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
    }
    if (bytesPerSecond >= 1024) {
        return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
    }
    return `${bytesPerSecond} B/s`;
}

function setMaximizeButtonState(isMaximized) {
    maximizeWindowButton.textContent = isMaximized ? '❐' : '□';
    maximizeWindowButton.title = isMaximized ? 'Restore window' : 'Maximize window';
    maximizeWindowButton.setAttribute(
        'aria-label',
        isMaximized ? 'Restore window' : 'Maximize window'
    );
}

if (window.downloadDashboard) {
    function renderMediaSync(role, state) {
        const item = mediaSyncItems.find(candidate => candidate.dataset.mediaSync === role);
        if (!item) return;
        if (typeof state.scriptPath === 'string') item.dataset.scriptPath = state.scriptPath;
        const scriptPath = item.dataset.scriptPath || '';
        item.querySelector('[data-media-sync-path]').textContent = scriptPath || 'No script selected.';
        const status = item.querySelector('[data-media-sync-status]');
        status.textContent = state.message;
        status.classList.toggle('failure', Boolean(state.failure));
        item.querySelector('[data-media-sync-action="start"]').disabled = !scriptPath || state.running;
        item.querySelector('[data-media-sync-action="stop"]').disabled = !state.running
            || state.message.startsWith('Stopping ');
        item.querySelector('[data-media-sync-action="choose"]').disabled = state.running;
    }

    async function loadMediaSyncStatus() {
        try {
            const states = await window.downloadDashboard.getMediaSyncStatus();
            for (const [role, state] of Object.entries(states)) renderMediaSync(role, state);
        } catch (error) {
            for (const item of mediaSyncItems) {
                const status = item.querySelector('[data-media-sync-status]');
                status.textContent = error instanceof Error
                    ? error.message
                    : 'Could not load media sync status.';
                status.classList.add('failure');
            }
        }
    }

    async function showMediaSyncError(role, error, fallbackMessage) {
        const message = error instanceof Error ? error.message : fallbackMessage;
        const item = mediaSyncItems.find(candidate => candidate.dataset.mediaSync === role);
        if (!item) return;
        const status = item.querySelector('[data-media-sync-status]');
        try {
            const states = await window.downloadDashboard.getMediaSyncStatus();
            renderMediaSync(role, { ...states[role], message, failure: true });
        } catch (reloadError) {
            status.textContent = message;
            status.classList.add('failure');
            console.error('Could not reload personal media sync status:', reloadError);
            item.querySelector('[data-media-sync-action="start"]').disabled =
                item.querySelector('[data-media-sync-path]').textContent === 'No script selected.';
            item.querySelector('[data-media-sync-action="stop"]').disabled = true;
        }
    }

    for (const item of mediaSyncItems) {
        const role = item.dataset.mediaSync;
        const status = item.querySelector('[data-media-sync-status]');
        const chooseButton = item.querySelector('[data-media-sync-action="choose"]');
        const startButton = item.querySelector('[data-media-sync-action="start"]');
        const stopButton = item.querySelector('[data-media-sync-action="stop"]');

        chooseButton.addEventListener('click', async () => {
            chooseButton.disabled = true;
            status.classList.remove('failure');
            status.textContent = 'Choose a script...';
            try {
                const states = await window.downloadDashboard.chooseMediaSyncScript(role);
                for (const [stateRole, state] of Object.entries(states)) renderMediaSync(stateRole, state);
            } catch (error) {
                await showMediaSyncError(role, error, 'Could not choose a script.');
            }
        });

        startButton.addEventListener('click', async () => {
            startButton.disabled = true;
            status.classList.remove('failure');
            status.textContent = 'Starting script...';
            try {
                renderMediaSync(role, await window.downloadDashboard.startMediaSync(role));
            } catch (error) {
                await showMediaSyncError(role, error, 'Could not start the script.');
            }
        });

        stopButton.addEventListener('click', async () => {
            stopButton.disabled = true;
            status.classList.remove('failure');
            status.textContent = 'Stopping script...';
            try {
                renderMediaSync(role, await window.downloadDashboard.stopMediaSync(role));
            } catch (error) {
                await showMediaSyncError(role, error, 'Could not stop the script.');
            }
        });
    }

    window.downloadDashboard.onMediaSyncStatus(({ role, ...state }) => renderMediaSync(role, state));
    window.downloadDashboard.getPlatform().then(platform => {
        if (platform === 'win32') {
            mediaSyncHelp.textContent = 'Choose and run separate .bat scripts for TV and movies. Scripts stay on this computer and are not included in the installer.';
            for (const item of mediaSyncItems) {
                item.querySelector('[data-media-sync-action="choose"]').textContent = 'Choose .bat';
            }
        } else {
            mediaSyncHelp.textContent = 'Choose and run separate .sh scripts for TV and movies. Scripts stay on this computer and are not included in the installer.';
            for (const item of mediaSyncItems) {
                item.querySelector('[data-media-sync-action="choose"]').textContent = 'Choose .sh';
            }
        }
    }).catch(error => {
        console.error('Could not detect the operating system for personal media sync:', error);
    });
    loadMediaSyncStatus();

    function showWelcome() {
        welcomeView.hidden = false;
        settingsView.hidden = true;
        settingsDialog.showModal();
    }

    function showSettings() {
        welcomeView.hidden = true;
        settingsView.hidden = false;
        if (!settingsDialog.open) settingsDialog.showModal();
    }

    async function loadSettings(openIfIncomplete = true) {
        try {
            const settings = await window.downloadDashboard.getSettings();
            botStatusElement.textContent = settings.botState.message;
            botStatusElement.dataset.running = String(settings.botState.running);
            for (const input of settingsForm.querySelectorAll('[data-setting]')) {
                const key = input.dataset.setting;
                if (input.hasAttribute('data-secret')) {
                    const configured = settings.configuredSecrets[key];
                    input.placeholder = configured
                        ? 'Saved securely — leave blank to keep'
                        : 'Enter credential';
                } else {
                    input.value = settings.values[key] || '';
                }
            }

            if (settings.firstRun) {
                if (!settingsDialog.open) showWelcome();
            } else if (openIfIncomplete && (!settings.configuredSecrets.DISCORD_TOKEN
                || !settings.values.RADARR_URL
                || !settings.configuredSecrets.RADARR_API_KEY
                || !settings.values.SONARR_URL
                || !settings.configuredSecrets.SONARR_API_KEY)) {
                if (!settingsDialog.open) showSettings();
            }
            return settings;
        } catch (error) {
            settingsMessage.textContent = error instanceof Error
                ? error.message
                : 'Could not load settings.';
            settingsMessage.classList.add('failure');
        }
    }

    settingsOpenButton.addEventListener('click', () => {
        loadSettings(false).then(() => showSettings());
    });
    settingsCloseButton.addEventListener('click', () => settingsDialog.close());
    welcomeStartButton.addEventListener('click', async () => {
        welcomeStartButton.disabled = true;
        welcomeMessage.textContent = 'Preparing your setup...';
        welcomeMessage.classList.remove('failure');
        try {
            await window.downloadDashboard.completeWelcome();
            showSettings();
        } catch (error) {
            welcomeMessage.textContent = error instanceof Error
                ? error.message
                : 'Could not open setup.';
            welcomeMessage.classList.add('failure');
        } finally {
            welcomeStartButton.disabled = false;
        }
    });
    welcomeLaterButton.addEventListener('click', async () => {
        welcomeLaterButton.disabled = true;
        welcomeMessage.textContent = 'Saving your choice...';
        try {
            await window.downloadDashboard.completeWelcome();
            settingsDialog.close();
        } catch (error) {
            welcomeMessage.textContent = error instanceof Error
                ? error.message
                : 'Could not save your choice.';
            welcomeMessage.classList.add('failure');
        } finally {
            welcomeLaterButton.disabled = false;
        }
    });
    window.downloadDashboard.onBotStatus(state => {
        botStatusElement.textContent = state.message;
        botStatusElement.dataset.running = String(state.running);
    });

    const connectionSettings = {
        discord: { token: 'DISCORD_TOKEN', clientId: 'CLIENT_ID', guildId: 'GUILD_ID' },
        radarr: { url: 'RADARR_URL', apiKey: 'RADARR_API_KEY' },
        sonarr: { url: 'SONARR_URL', apiKey: 'SONARR_API_KEY' },
        torrent: {
            client: 'TORRENT_CLIENT',
            url: 'TORRENT_URL',
            username: 'TORRENT_USERNAME',
            password: 'TORRENT_PASSWORD'
        }
    };
    function getConnectionValues(service) {
        return Object.fromEntries(Object.entries(connectionSettings[service]).map(([field, key]) => [
            field,
            settingsForm.querySelector(`[data-setting="${key}"]`).value.trim()
        ]));
    }

    for (const button of settingsForm.querySelectorAll('[data-test]')) {
        button.addEventListener('click', async () => {
            const service = button.dataset.test;
            const result = settingsForm.querySelector(`[data-result="${service}"]`);

            button.disabled = true;
            result.textContent = 'Testing connection...';
            result.classList.remove('failure');
            try {
                const response = await window.downloadDashboard.testConnection(service, getConnectionValues(service));
                result.textContent = response.message;
            } catch (error) {
                result.textContent = error instanceof Error ? error.message : 'Connection test failed.';
                result.classList.add('failure');
            } finally {
                button.disabled = false;
            }
        });
    }

    document.getElementById('check-all-connections').addEventListener('click', async event => {
        const button = event.currentTarget;
        const summary = document.getElementById('connection-check-summary');
        button.disabled = true;
        summary.classList.remove('failure');
        summary.textContent = 'Checking Discord, Radarr, and Sonarr...';
        const services = ['discord', 'radarr', 'sonarr'];
        if (settingsForm.querySelector('[data-setting="TORRENT_CLIENT"]').value) services.push('torrent');
        const results = await Promise.all(services.map(async service => {
            const target = settingsForm.querySelector(`[data-result="${service}"]`);
            target.textContent = 'Testing connection...';
            target.classList.remove('failure');
            try {
                const response = await window.downloadDashboard.testConnection(service, getConnectionValues(service));
                target.textContent = response.message;
                return { service, success: true };
            } catch (error) {
                target.textContent = error instanceof Error ? error.message : 'Connection test failed.';
                target.classList.add('failure');
                return { service, success: false };
            }
        }));
        const passed = results.filter(result => result.success).length;
        summary.textContent = `${passed} of ${results.length} configured service checks passed.`;
        summary.classList.toggle('failure', passed < results.length);
        button.disabled = false;
    });

    settingsForm.addEventListener('submit', async event => {
        event.preventDefault();
        const settings = {};
        for (const input of settingsForm.querySelectorAll('[data-setting]')) {
            settings[input.dataset.setting] = input.value.trim();
        }
        const saveButton = settingsForm.querySelector('.settings-save');
        saveButton.disabled = true;
        settingsMessage.classList.remove('failure');
        settingsMessage.textContent = 'Saving settings...';
        try {
            const result = await window.downloadDashboard.saveSettings(settings);
            await loadSettings();
            for (const input of settingsForm.querySelectorAll('[data-secret]')) input.value = '';
            settingsMessage.textContent = result.botRunning
                ? 'Settings saved securely. The Discord bot is starting.'
                : 'Settings saved securely. Add a Discord bot token to start the bot.';
            botStatusElement.textContent = result.botState.message;
            botStatusElement.dataset.running = String(result.botState.running);
            if (result.botRunning) refresh();
        } catch (error) {
            settingsMessage.textContent = error instanceof Error ? error.message : 'Could not save settings.';
            settingsMessage.classList.add('failure');
        } finally {
            saveButton.disabled = false;
        }
    });

    registerCommandButton.addEventListener('click', async () => {
        registerCommandButton.disabled = true;
        settingsMessage.classList.remove('failure');
        settingsMessage.textContent = 'Registering the Discord command...';
        try {
            const result = await window.downloadDashboard.registerCommand();
            settingsMessage.textContent = result.message;
        } catch (error) {
            settingsMessage.textContent = error instanceof Error
                ? error.message
                : 'Could not register the Discord command.';
            settingsMessage.classList.add('failure');
        } finally {
            registerCommandButton.disabled = false;
        }
    });

    loadSettings();

    trackerRefreshButton.addEventListener('click', async () => {
        trackerRefreshButton.disabled = true;
        trackerMessage.hidden = false;
        trackerMessage.className = 'tracker-message';
        trackerMessage.textContent = 'Requesting a tracker update for all torrents...';

        try {
            await window.downloadDashboard.reannounceAllTrackers();
            trackerMessage.classList.add('success');
            trackerMessage.textContent = 'Tracker update requested for all torrents. Trackers may enforce their own announce intervals.';
        } catch (error) {
            trackerMessage.classList.add('failure');
            trackerMessage.textContent = error instanceof Error
                ? error.message
                : 'Could not request tracker updates.';
        } finally {
            trackerRefreshButton.disabled = false;
        }
    });
} else {
    trackerRefreshButton.disabled = true;
    trackerRefreshButton.title = 'Available in the desktop app';
    for (const item of mediaSyncItems) {
        for (const button of item.querySelectorAll('button')) button.disabled = true;
        item.querySelector('[data-media-sync-status]').textContent = 'Available in the desktop app.';
    }
}

if (window.downloadDashboard) {
    window.downloadDashboard.getWindowState()
        .then(state => setMaximizeButtonState(state.isMaximized))
        .catch(error => console.error('Could not read dashboard window state:', error));

    minimizeWindowButton.addEventListener('click', () => {
        window.downloadDashboard.minimizeWindow()
            .catch(error => console.error('Could not minimize dashboard window:', error));
    });

    maximizeWindowButton.addEventListener('click', async () => {
        try {
            const state = await window.downloadDashboard.toggleMaximizeWindow();
            setMaximizeButtonState(state.isMaximized);
        } catch (error) {
            console.error('Could not maximize dashboard window:', error);
        }
    });

    closeWindowButton.addEventListener('click', () => {
        window.downloadDashboard.hideWindow()
            .catch(error => console.error('Could not hide dashboard window:', error));
    });
} else {
    minimizeWindowButton.disabled = true;
    maximizeWindowButton.disabled = true;
    closeWindowButton.disabled = true;
}

function renderCompletions(items) {
    completionsElement.replaceChildren();
    if (items.length === 0) {
        completionsElement.append(createElement('p', 'empty-state', 'No recent imports reported by Radarr or Sonarr.'));
        return;
    }

    for (const item of items) {
        const card = createElement('article', 'history-card');
        card.append(
            createElement('h3', 'download-title', item.title),
            createElement('div', 'history-meta', `${item.service} · ${formatDate(item.date)}`)
        );
        completionsElement.append(card);
    }
}

function renderAttention(items) {
    attentionElement.replaceChildren();
    if (items.length === 0) {
        attentionElement.append(createElement('p', 'empty-state', 'No stalled or failed downloads reported.'));
        return;
    }

    for (const item of items) {
        const card = createElement('article', 'history-card');
        const topline = createElement('div', 'download-topline');
        const details = document.createElement('div');
        details.append(
            createElement('h3', 'download-title', item.title),
            createElement('div', 'history-meta', item.service)
        );
        topline.append(details, createElement('span', 'download-status attention-status', item.status));
        card.append(topline);
        if (item.statusDetail) card.append(createElement('p', 'download-explanation', item.statusDetail));
        if (item.date) card.append(createElement('div', 'history-meta', formatDate(item.date)));
        attentionElement.append(card);
    }
}

function renderRequests(items) {
    requestsElement.replaceChildren();
    const query = requestSearch.value.trim().toLocaleLowerCase();
    const status = requestStatusFilter.value.toLocaleLowerCase();
    const filteredItems = items.filter(item => {
        const matchesQuery = !query
            || `${item.title} ${item.requesterName}`.toLocaleLowerCase().includes(query);
        return matchesQuery && (!status || item.status.toLocaleLowerCase() === status);
    });
    if (filteredItems.length === 0) {
        requestsElement.append(createElement('p', 'empty-state', items.length
            ? 'No requests match these filters.'
            : 'No requests have been recorded yet.'));
        return;
    }

    for (const item of filteredItems) {
        const card = createElement('article', 'history-card');
        const topline = createElement('div', 'download-topline');
        const details = document.createElement('div');
        details.append(
            createElement('h3', 'download-title', item.title),
            createElement('div', 'history-meta', `${item.type.toUpperCase()} · requested by ${item.requesterName}`)
        );
        topline.append(details, createElement('span', 'download-status', item.status));
        card.append(topline);
        if (item.statusDetail) card.append(createElement('p', 'download-explanation', item.statusDetail));
        card.append(createElement('div', 'history-meta', `Requested ${formatDate(item.requestedAt)}`));
        if (!['Completed', 'Failed', 'Already in library', 'Cancelled'].includes(item.status)) {
            const cancelButton = createElement('button', 'history-cancel', 'Mark cancelled');
            cancelButton.type = 'button';
            cancelButton.addEventListener('click', async () => {
                cancelButton.disabled = true;
                try {
                    await window.downloadDashboard.cancelRequest(item.id);
                    await refresh();
                } catch (error) {
                    cancelButton.disabled = false;
                    errorsElement.hidden = false;
                    errorsElement.append(createElement('p', 'error-message',
                        error instanceof Error ? error.message : 'Could not cancel the request.'));
                }
            });
            card.append(cancelButton);
        }
        requestsElement.append(card);
    }
}

function updateRequestStatusOptions(items) {
    const selectedStatus = requestStatusFilter.value;
    requestStatusFilter.replaceChildren(new Option('All statuses', ''));
    const statuses = [...new Set(items.map(item => item.status))].sort((left, right) =>
        left.localeCompare(right)
    );
    for (const status of statuses) {
        requestStatusFilter.add(new Option(status, status));
    }
    if (statuses.includes(selectedStatus)) requestStatusFilter.value = selectedStatus;
}

async function refresh() {
    if (refreshInProgress) return;
    refreshInProgress = true;
    refreshButton.disabled = true;
    errorsElement.hidden = true;
    errorsElement.replaceChildren();

    try {
        if (!window.downloadDashboard || typeof window.downloadDashboard.getStatus !== 'function') {
            throw new Error('This page is not connected to the desktop app. Close this browser tab and launch the dashboard with "npm run desktop".');
        }

        const result = await window.downloadDashboard.getStatus();
        renderQueue(result.queue);
        renderAttention(result.attention);
        renderCompletions(result.recentCompletions);
        recentRequests = result.requestHistory;
        updateRequestStatusOptions(recentRequests);
        renderRequests(recentRequests);

        const activity = result.activity || {
            activeDownloads: result.queue.filter(item => item.isActiveDownload).length,
            stalled: result.queue.filter(item => item.stalled).length,
            seeding: 0,
            activeSeeding: 0
        };
        const mascotState = result.mascotState || (
            activity.activeDownloads > 0
                ? 'working'
                : activity.stalled > 0 && activity.activeSeeding === 0
                    ? 'waiting'
                    : activity.seeding > 0
                        ? 'monitoring'
                        : result.errors.length > 0 ? 'error' : 'idle'
        );
        activeCountElement.textContent = String(activity.activeDownloads);
        stalledCountElement.textContent = String(activity.stalled);
        seedingCountElement.textContent = String(activity.seeding);
        completionCountElement.textContent = String(result.recentCompletions.length);

        if (mascotState === 'working') {
            greetingElement.textContent = 'I’m flying through your downloads!';
            summaryElement.textContent = `${activity.activeDownloads} active download${activity.activeDownloads === 1 ? '' : 's'}${activity.stalled ? ` · ${activity.stalled} stalled` : ''}.`;
            mascotCard.dataset.state = mascotState;
            assistantState.textContent = 'In flight';
        } else if (mascotState === 'waiting') {
            greetingElement.textContent = 'Just waiting for these to pick up.';
            summaryElement.textContent = `${activity.stalled} stalled item${activity.stalled === 1 ? '' : 's'} waiting for activity.`;
            mascotCard.dataset.state = mascotState;
            assistantState.textContent = 'Waiting';
        } else if (mascotState === 'idle') {
            greetingElement.textContent = 'Taking a little nap.';
            summaryElement.textContent = 'Nothing is downloading, stalled, or seeding.';
            mascotCard.dataset.state = mascotState;
            assistantState.textContent = 'Sleeping';
        } else if (mascotState === 'monitoring') {
            greetingElement.textContent = 'Keeping an eye on your seeds.';
            summaryElement.textContent = `${activity.seeding} torrent${activity.seeding === 1 ? '' : 's'} seeding${activity.stalled ? ` · ${activity.stalled} stalled` : ''}.`;
            mascotCard.dataset.state = mascotState;
            assistantState.textContent = 'Monitoring';
        } else {
            greetingElement.textContent = 'I found a connection issue.';
            summaryElement.textContent = 'Check the media manager settings and try refreshing.';
            mascotCard.dataset.state = 'error';
            assistantState.textContent = 'Needs a hand';
        }

        if (result.errors.length > 0) {
            errorsElement.hidden = false;
            for (const error of result.errors) {
                const exists = [...errorsElement.children].some(child => child.textContent === error);
                if (!exists) errorsElement.append(createElement('p', 'error-message', error));
            }
        }

        updatedElement.textContent = `Updated ${new Date(result.updatedAt).toLocaleTimeString()}`;
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        const bridgeUnavailable = message.includes('not connected to the desktop app');
        queueElement.replaceChildren(
            createElement(
                'p',
                'empty-state',
                bridgeUnavailable
                    ? 'Live download status is available in the desktop app.'
                    : 'Could not load download status.'
            )
        );
        errorsElement.hidden = false;
        errorsElement.append(createElement('p', 'error-message', message));
        if (bridgeUnavailable) {
            attentionElement.replaceChildren(createElement('p', 'empty-state', 'Available in the desktop app.'));
            completionsElement.replaceChildren(createElement('p', 'empty-state', 'Available in the desktop app.'));
            requestsElement.replaceChildren(createElement('p', 'empty-state', 'Available in the desktop app.'));
            greetingElement.textContent = 'Open the desktop app to connect.';
            summaryElement.textContent = 'Launch with “npm run desktop” to view live activity.';
            assistantState.textContent = 'Desktop app needed';
        } else {
            greetingElement.textContent = 'I couldn’t reach the download queue.';
            summaryElement.textContent = 'Check the app logs and try refreshing.';
            assistantState.textContent = 'Needs a hand';
        }
        mascotCard.dataset.state = 'error';
    } finally {
        refreshButton.disabled = false;
        refreshInProgress = false;
    }
}

refreshButton.addEventListener('click', refresh);
requestSearch.addEventListener('input', () => renderRequests(recentRequests));
requestStatusFilter.addEventListener('change', () => renderRequests(recentRequests));

document.getElementById('export-history').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
        const rows = await window.downloadDashboard.exportHistory();
        const columns = [
            'id', 'type', 'mediaId', 'title', 'service', 'managerMediaId',
            'requesterId', 'requesterName', 'status', 'statusDetail',
            'requestedAt', 'updatedAt', 'completedAt'
        ];
        const escapeCsv = value => {
            let text = String(value ?? '');
            if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
            return `"${text.replaceAll('"', '""')}"`;
        };
        const csv = [columns.join(','), ...rows.map(row =>
            columns.map(column => escapeCsv(row[column])).join(',')
        )].join('\r\n');
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `request-history-${new Date().toISOString().slice(0, 10)}.csv`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
        errorsElement.hidden = false;
        errorsElement.append(createElement('p', 'error-message',
            error instanceof Error ? error.message : 'Could not export request history.'));
    } finally {
        button.disabled = false;
    }
});

document.getElementById('clear-history').addEventListener('click', async event => {
    if (!window.confirm('Permanently clear all request history? This does not remove media or downloads.')) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
        await window.downloadDashboard.clearHistory();
        await refresh();
    } catch (error) {
        errorsElement.hidden = false;
        errorsElement.append(createElement('p', 'error-message',
            error instanceof Error ? error.message : 'Could not clear request history.'));
    } finally {
        button.disabled = false;
    }
});

for (const button of settingsForm.querySelectorAll('[data-load-options]')) {
    button.addEventListener('click', async () => {
        const service = button.dataset.loadOptions;
        const result = settingsForm.querySelector(`[data-options-result="${service}"]`);
        button.disabled = true;
        result.classList.remove('failure');
        result.textContent = `Loading ${service === 'radarr' ? 'Radarr' : 'Sonarr'} options...`;
        try {
            const options = await window.downloadDashboard.getManagerOptions(service, {
                url: settingsForm.querySelector(`[data-setting="${service.toUpperCase()}_URL"]`).value.trim(),
                apiKey: settingsForm.querySelector(`[data-setting="${service.toUpperCase()}_API_KEY"]`).value.trim()
            });
            const roots = document.getElementById(`${service}-roots`);
            const profiles = document.getElementById(`${service}-profiles`);
            roots.replaceChildren(...options.rootFolders.map(folder => {
                const option = document.createElement('option');
                option.value = folder.path;
                option.label = folder.freeSpace
                    ? `${folder.path} · ${formatBytes(folder.freeSpace)} free`
                    : folder.path;
                return option;
            }));
            profiles.replaceChildren(...options.qualityProfiles.map(profile => {
                const option = document.createElement('option');
                option.value = String(profile.id);
                option.label = `${profile.name} (ID ${profile.id})`;
                return option;
            }));
            result.textContent = `Loaded ${options.rootFolders.length} folders and ${options.qualityProfiles.length} quality profiles.`;
        } catch (error) {
            result.textContent = error instanceof Error ? error.message : 'Could not load manager options.';
            result.classList.add('failure');
        } finally {
            button.disabled = false;
        }
    });
}

refresh();
setInterval(refresh, 30_000);

function formatBytes(bytes) {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
    return `${bytes} bytes`;
}
