const { getHistory, getQueue } = require('./arrClient');
const { createRequestHistory } = require('./requestHistory');
const { getTorrents } = require('./torrentClients');

const importedEvents = new Set([
    'downloadfolderimported',
    'moviefileimported',
    'episodefileimported',
    'seriesfolderimported'
]);

function getHistoryMediaId(record, type) {
    return type === 'movie'
        ? record.movieId ?? record.movie?.id
        : record.seriesId ?? record.series?.id;
}

function getHistoryTitle(record, type) {
    if (type === 'movie') return record.movie?.title || record.sourceTitle || record.title || 'Unknown movie';
    const seriesTitle = record.series?.title;
    const episodeTitle = record.episode?.title;
    if (seriesTitle && episodeTitle && seriesTitle !== episodeTitle) {
        return `${seriesTitle} — ${episodeTitle}`;
    }
    return seriesTitle || episodeTitle || record.sourceTitle || record.title || 'Unknown series';
}

function getStatusMessages(item) {
    const messages = [];
    if (typeof item.errorMessage === 'string' && item.errorMessage.trim()) {
        messages.push(item.errorMessage.trim());
    }
    if (typeof item.statusMessage === 'string' && item.statusMessage.trim()) {
        messages.push(item.statusMessage.trim());
    }
    if (Array.isArray(item.statusMessages)) {
        for (const status of item.statusMessages) {
            if (typeof status === 'string' && status.trim()) messages.push(status.trim());
            if (typeof status?.title === 'string' && status.title.trim()) messages.push(status.title.trim());
            if (Array.isArray(status?.messages)) {
                messages.push(...status.messages.filter(message => typeof message === 'string' && message.trim()));
            }
        }
    }
    return [...new Set(messages)];
}

function normalizeQueueItem(item) {
    const state = String(item.trackedDownloadState || item.status || 'In queue');
    const trackedStatus = String(item.trackedDownloadStatus || '').toLowerCase();
    const messages = getStatusMessages(item);
    const joinedMessages = messages.join(' ');
    const failed = /failed|failure|error/i.test(`${state} ${trackedStatus} ${joinedMessages}`);
    const stalled = /stall|stuck|no progress|not progressing/i.test(`${state} ${trackedStatus} ${joinedMessages}`);
    const active = /downloading|importing|moving/i.test(state);
    const size = Number(item.size);
    const sizeLeft = Number(item.sizeleft);
    const progress = Number.isFinite(size) && size > 0 && Number.isFinite(sizeLeft)
        ? Math.max(0, Math.min(100, Math.round(((size - sizeLeft) / size) * 100)))
        : null;

    const needsAttention = trackedStatus === 'warning' || trackedStatus === 'error';
    let status = state;
    if (stalled) status = 'Stalled';
    else if (failed) status = 'Failed';
    else if (needsAttention) status = 'Needs attention';

    let explanation = messages.join(' ');
    if (!explanation && stalled) explanation = 'The media manager reports this download as stalled.';
    if (!explanation && failed) explanation = 'The media manager reports this download failed.';

    return {
        id: `${item._type}:${item.id ?? item._title}`,
        type: item._type,
        managerMediaId: item._managerMediaId
            ?? (item._type === 'movie' ? item.movieId ?? item.movie?.id : item.seriesId ?? item.series?.id),
        title: item._title,
        service: item._service,
        status,
        statusDetail: explanation,
        isActiveDownload: active && !failed && !stalled,
        failed,
        stalled,
        needsAttention: needsAttention || failed || stalled,
        progress,
        timeLeft: item.timeleft || null
    };
}

function normalizeTorrent(torrent, client = 'qBittorrent') {
    const state = String(torrent.state || 'unknown');
    const stateLabels = {
        downloading: 'Downloading',
        forcedDL: 'Downloading',
        stalledDL: 'Stalled',
        queuedDL: 'Queued',
        metaDL: 'Getting metadata',
        checkingDL: 'Checking',
        allocating: 'Allocating',
        uploading: 'Seeding',
        forcedUP: 'Seeding',
        stalledUP: 'Seeding (stalled)',
        queuedUP: 'Queued to seed',
        pausedDL: 'Paused',
        pausedUP: 'Paused',
        error: 'Error',
        missingFiles: 'Missing files',
        checkingUP: 'Checking'
    };
    const downloading = state === 'downloading' || state === 'forcedDL';
    const active = downloading || state === 'metaDL' || Number(torrent.dlspeed) > 0;
    const stalled = state === 'stalledDL';
    const seeding = /(?:uploading|forcedUP|stalledUP|queuedUP|pausedUP|stoppedUP|checkingUP)/.test(state);
    const failed = state === 'error' || state === 'missingFiles';
    const status = stateLabels[state] || state.replaceAll('_', ' ');
    const eta = Number(torrent.eta);

    return {
        id: `${client}:${torrent.hash || torrent.name}`,
        type: 'torrent',
        title: torrent.name || 'Unknown torrent',
        service: client,
        status,
        isActiveDownload: active && !failed && !stalled,
        isSeeding: seeding,
        isActivelySeeding: state === 'uploading' || state === 'forcedUP',
        statusDetail: failed
            ? `${client} reports ${state === 'missingFiles' ? 'that this torrent is missing files.' : 'an error for this torrent.'}`
            : stalled ? `${client} reports that this download is stalled.` : null,
        failed,
        stalled,
        needsAttention: failed || stalled,
        progress: Number.isFinite(Number(torrent.progress))
            ? Math.max(0, Math.min(100, Math.round(Number(torrent.progress) * 100)))
            : null,
        timeLeft: downloading && Number.isFinite(eta) && eta >= 0 && eta < 8640000
            ? formatEta(eta)
            : null,
        downloadSpeed: Number(torrent.dlspeed) || 0
    };
}

function formatEta(seconds) {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function normalizeHistoryRecord(record, type, service) {
    const eventType = String(record.eventType || '');
    return {
        id: `${service}:${type}:${record.id ?? record.downloadId ?? record.date}`,
        type,
        managerMediaId: getHistoryMediaId(record, type),
        title: getHistoryTitle(record, type),
        service,
        eventType,
        date: record.date || null,
        statusDetail: getStatusMessages(record).join(' ') || record.message || null
    };
}

function isImported(item) {
    return importedEvents.has(item.eventType.toLowerCase());
}

function isFailedHistory(item) {
    return /failed|failure/i.test(item.eventType);
}

function getMascotState(activity, hasErrors = false) {
    if (activity.activeDownloads > 0) return 'working';
    if (activity.stalled > 0 && activity.activeSeeding === 0) return 'waiting';
    if (activity.activeDownloads === 0 && activity.stalled === 0 && activity.seeding === 0) {
        return hasErrors ? 'error' : 'idle';
    }
    return 'monitoring';
}

async function getDashboardData(historyStore = createRequestHistory()) {
    const jobs = [
        { kind: 'queue', type: 'movie', service: 'Radarr', run: () => getQueue('movie') },
        { kind: 'history', type: 'movie', service: 'Radarr', run: () => getHistory('movie') },
        { kind: 'queue', type: 'tv', service: 'Sonarr', run: () => getQueue('tv') },
        { kind: 'history', type: 'tv', service: 'Sonarr', run: () => getHistory('tv') }
    ];
    const results = await Promise.allSettled(jobs.map(job => job.run()));
    const queue = [];
    const history = [];
    const errors = [];
    let seedingCount = 0;
    let activeSeedingCount = 0;
    let stalledSeedingCount = 0;

    results.forEach((result, index) => {
        const job = jobs[index];
        if (result.status === 'rejected') {
            errors.push(`${job.service} ${job.kind}: ${result.reason instanceof Error ? result.reason.message : 'Unknown error'}`);
            return;
        }

        if (job.kind === 'queue') {
            queue.push(...result.value.map(normalizeQueueItem));
        } else {
            history.push(...result.value.map(item => normalizeHistoryRecord(item, job.type, job.service)));
        }
    });

    try {
        const torrentResult = await getTorrents();
        if (torrentResult.configured) {
            const clientName = torrentResult.client === 'qbittorrent'
                ? 'qBittorrent'
                : torrentResult.client === 'transmission' ? 'Transmission'
                    : torrentResult.client === 'deluge' ? 'Deluge' : 'BitTorrent / µTorrent';
            const normalizedTorrents = torrentResult.torrents
                .map(torrent => normalizeTorrent(torrent, clientName));
            seedingCount = normalizedTorrents.filter(item => item.isSeeding).length;
            activeSeedingCount = normalizedTorrents.filter(item => item.isActivelySeeding).length;
            stalledSeedingCount = normalizedTorrents
                .filter(item => item.isSeeding && item.status === 'Seeding (stalled)')
                .length;
            const activeTorrents = normalizedTorrents
                .filter(item => !item.isSeeding);
            queue.push(...activeTorrents);
        }
    } catch (error) {
        errors.push(`Torrent client: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    const activity = {
        activeDownloads: queue.filter(item => item.isActiveDownload).length,
        stalled: queue.filter(item => item.stalled).length + stalledSeedingCount,
        seeding: seedingCount,
        activeSeeding: activeSeedingCount
    };

    const recentCompletions = history
        .filter(isImported)
        .sort((left, right) => String(right.date || '').localeCompare(String(left.date || '')))
        .slice(0, 10);

    const failedHistory = history.filter(isFailedHistory);
    const attention = [
        ...queue.filter(item => item.needsAttention).map(item => ({
            id: item.id,
            type: item.type,
            title: item.title,
            service: item.service,
            status: item.status,
            statusDetail: item.statusDetail,
            date: null
        })),
        ...failedHistory.map(item => ({
            id: item.id,
            type: item.type,
            title: item.title,
            service: item.service,
            status: 'Failed',
            statusDetail: item.statusDetail || 'The media manager recorded a failed download.',
            date: item.date
        }))
    ];
    const uniqueAttention = [...new Map(attention.map(item => [
        `${item.service}:${item.type}:${item.title}`,
        item
    ])).values()].slice(0, 10);
    const requests = await historyStore.listRecentRequests();
    const queueByMedia = new Map(queue
        .filter(item => item.managerMediaId !== undefined && item.managerMediaId !== null)
        .map(item => [`${item.service}:${item.managerMediaId}`, item]));
    const terminalHistoryByMedia = new Map();
    for (const item of history) {
        if (!isImported(item) && !isFailedHistory(item)) continue;
        if (item.managerMediaId === undefined || item.managerMediaId === null) continue;
        const key = `${item.service}:${item.managerMediaId}`;
        const previous = terminalHistoryByMedia.get(key);
        if (!previous || String(item.date || '') > String(previous.date || '')) {
            terminalHistoryByMedia.set(key, item);
        }
    }

    for (const request of requests) {
        if (!request.managerMediaId) continue;
        const key = `${request.service}:${request.managerMediaId}`;
        const active = queueByMedia.get(key);
        if (active) {
            await historyStore.updateStatus(
                request.id,
                active.status,
                active.statusDetail
            );
            continue;
        }

        const terminal = terminalHistoryByMedia.get(key);
        if (terminal && isImported(terminal)) {
            await historyStore.updateStatus(
                request.id,
                'Completed',
                terminal.statusDetail,
                terminal.date
            );
        } else if (terminal && isFailedHistory(terminal)) {
            await historyStore.updateStatus(
                request.id,
                'Failed',
                terminal.statusDetail
            );
        }
    }

    const requestHistory = await historyStore.listRecentRequests();

    return {
        queue,
        recentCompletions,
        attention: uniqueAttention,
        requestHistory,
        activity,
        mascotState: getMascotState(activity, errors.length > 0),
        errors,
        updatedAt: new Date().toISOString()
    };
}

module.exports = {
    getDashboardData,
    getMascotState,
    getStatusMessages,
    normalizeHistoryRecord,
    normalizeQueueItem,
    normalizeTorrent
};
