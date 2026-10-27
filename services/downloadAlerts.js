const { getHistory, getQueue } = require('./arrClient');
const { requestHistory } = require('./requestHistory');
const { normalizeHistoryRecord, normalizeQueueItem } = require('./dashboardData');

function isDownloadComplete(item) {
    const status = String(item?.status ?? '').toLowerCase();
    return status === 'completed' || status === 'downloaded' || status === 'imported';
}

function getCompletedDownloadKey(type, item) {
    const id = item?.id ?? item?.movie?.id ?? item?.series?.id ?? item?._title ?? `${type}-unknown`;
    return `${type}:${id}`;
}

function getCompletedFromQueues(movies, tvShows) {
    const completed = [];
    for (const queue of [movies, tvShows]) {
        for (const item of queue) {
            if (!isDownloadComplete(item)) continue;
            completed.push({
                id: item._managerMediaId ?? item.id,
                title: item._title,
                type: item._type,
                service: item._service,
                managerMediaId: item._managerMediaId
            });
        }
    }

    return completed;
}

async function getCompletedDownloads() {
    const [movies, tvShows] = await Promise.all([
        getQueue('movie'),
        getQueue('tv')
    ]);
    return getCompletedFromQueues(movies, tvShows);
}

async function sendDownloadAlert(client, item) {
    const channelId = process.env.ALERT_CHANNEL_ID;
    if (!channelId) return;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
        console.warn(`Alert channel ${channelId} was not found. Update the alert channel ID in Settings.`);
        return;
    }

    await channel.send({
        content: `Download complete: **${item.title}** (${item.service})`
    });
}

async function sendRequestStatusAlert(client, request, status, detail = null) {
    const channelId = process.env.ALERT_CHANNEL_ID;
    if (!channelId) throw new Error('Set the request and download alert channel ID in Settings.');

    const channel = await client.channels.fetch(channelId);
    if (!channel || typeof channel.send !== 'function') {
        throw new Error('The configured request and download alert channel is unavailable.');
    }

    const messages = {
        Downloading: 'has started downloading',
        Completed: 'is complete and has been imported',
        'Needs attention': 'needs attention'
    };
    const detailText = detail ? `\n**Details:** ${detail.slice(0, 1000)}` : '';
    await channel.send({
        content: `<@${request.requesterId}> **${request.title.slice(0, 250)}** ${messages[status]} (${request.service}).${detailText}`,
        allowedMentions: { users: [request.requesterId] }
    });
}

function getRequestLifecycleState(request, queues, histories) {
    if (!request.managerMediaId) return null;

    const queueItem = queues.find(item =>
        item._service === request.service
        && String(item._managerMediaId) === String(request.managerMediaId));
    if (queueItem) {
        const normalized = normalizeQueueItem(queueItem);
        if (normalized.needsAttention) {
            return {
                notificationStatus: 'Needs attention',
                historyStatus: normalized.failed ? 'Failed' : normalized.status,
                detail: normalized.statusDetail
            };
        }
        if (/downloading/i.test(String(queueItem.trackedDownloadState || queueItem.status || ''))) {
            return {
                notificationStatus: 'Downloading',
                historyStatus: 'Downloading',
                detail: null
            };
        }
        if (/^(completed|downloaded|imported)$/i.test(String(queueItem.status || ''))) {
            return { notificationStatus: 'Completed', historyStatus: 'Completed', detail: null };
        }
    }

    const matchingHistory = histories
        .filter(item => item.service === request.service
            && String(item.managerMediaId) === String(request.managerMediaId))
        .sort((left, right) => String(right.date || '').localeCompare(String(left.date || '')));
    const importedEvents = new Set([
        'downloadfolderimported',
        'moviefileimported',
        'episodefileimported',
        'seriesfolderimported'
    ]);
    const terminalEvent = matchingHistory.find(item =>
        importedEvents.has(item.eventType.toLowerCase())
        || /failed|failure/i.test(item.eventType));
    if (!terminalEvent) return null;
    if (importedEvents.has(terminalEvent.eventType.toLowerCase())) {
        return {
            notificationStatus: 'Completed',
            historyStatus: 'Completed',
            detail: terminalEvent.statusDetail
        };
    }
    return {
        notificationStatus: 'Needs attention',
        historyStatus: 'Failed',
        detail: terminalEvent.statusDetail
    };
}

async function sendRequestAlert(client, request) {
    if (request.alreadyExists) return false;

    const channelId = process.env.ALERT_CHANNEL_ID;
    if (!channelId) {
        throw new Error('Set the request and download alert channel ID in Settings.');
    }

    const channel = await client.channels.fetch(channelId);
    if (!channel || typeof channel.send !== 'function') {
        throw new Error('The configured request and download alert channel is unavailable.');
    }

    const mediaType = request.type === 'movie'
        ? 'Movie'
        : request.type === 'anime' ? 'Anime' : 'TV show';
    await channel.send({
        content: `**New ${mediaType} request:** ${request.title}\n`
            + `**Requested by:** <@${request.requesterId}>\n`
            + `**Status:** Added to the library; a search for available releases was started. (${request.service})`,
        allowedMentions: { parse: [] }
    });
    return true;
}

async function pollDownloadAlerts(client, intervalMs = 30_000) {
    const seen = new Set();
    let checkInProgress = false;

    async function checkForAlerts() {
        if (checkInProgress) return;
        checkInProgress = true;
        try {
            const [requests, movies, tvShows, movieHistory, tvHistory] = await Promise.all([
                requestHistory.listAllRequests(),
                getQueue('movie'),
                getQueue('tv'),
                getHistory('movie'),
                getHistory('tv')
            ]);
            const completed = getCompletedFromQueues(movies, tvShows);
            const queues = [...movies, ...tvShows];
            const histories = [
                ...movieHistory.map(item => normalizeHistoryRecord(item, 'movie', 'Radarr')),
                ...tvHistory.map(item => normalizeHistoryRecord(item, 'tv', 'Sonarr'))
            ];
            const requestMedia = new Set(requests
                .filter(request => request.managerMediaId
                    && !['Cancelled', 'Already in library'].includes(request.status))
                .map(request => `${request.service}:${request.managerMediaId}`));

            for (const request of requests) {
                if (['Cancelled', 'Already in library'].includes(request.status)) continue;
                const state = getRequestLifecycleState(request, queues, histories);
                if (!state) continue;
                if (await requestHistory.hasUnnotifiedStatus(request.id, state.notificationStatus)) {
                    await sendRequestStatusAlert(
                        client,
                        request,
                        state.notificationStatus,
                        state.detail
                    );
                    await requestHistory.recordNotifiedStatus(
                        request.id,
                        state.notificationStatus
                    );
                }
                if (request.status !== state.historyStatus
                    || request.statusDetail !== state.detail) {
                    await requestHistory.updateStatus(
                        request.id,
                        state.historyStatus,
                        state.detail,
                        state.historyStatus === 'Completed'
                            ? request.completedAt || new Date().toISOString()
                            : null
                    );
                }
            }

            for (const item of completed) {
                if (requestMedia.has(`${item.service}:${item.id}`)) continue;
                const key = getCompletedDownloadKey(item.type, item);
                if (seen.has(key)) continue;
                seen.add(key);
                await sendDownloadAlert(client, item);
            }
        } catch (error) {
            console.error('Could not check for request status alerts:', error);
        } finally {
            checkInProgress = false;
        }
    }

    await checkForAlerts();
    return setInterval(checkForAlerts, intervalMs);
}

module.exports = {
    getCompletedDownloads,
    getCompletedDownloadKey,
    getCompletedFromQueues,
    getRequestLifecycleState,
    isDownloadComplete,
    pollDownloadAlerts,
    sendDownloadAlert,
    sendRequestAlert,
    sendRequestStatusAlert
};
