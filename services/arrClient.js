const ARR_API_VERSION = 'v3';

class ArrError extends Error {}

function getConfig(type, override = {}) {
    const service = type === 'movie' ? 'RADARR' : 'SONARR';
    const baseUrl = override.url || process.env[`${service}_URL`];
    const apiKey = override.apiKey || process.env[`${service}_API_KEY`];

    if (!baseUrl || !apiKey) {
        throw new ArrError(`Enter ${service}_URL and ${service}_API_KEY in Settings.`);
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(baseUrl);
    } catch {
        throw new ArrError(`${service}_URL must be a valid HTTP or HTTPS URL.`);
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new ArrError(`${service}_URL must use HTTP or HTTPS.`);
    }

    return {
        service: type === 'movie' ? 'Radarr' : 'Sonarr',
        baseUrl: baseUrl.replace(/\/+$/, ''),
        apiKey
    };
}

async function testConnection(type, connection) {
    const config = getConfig(type, connection);
    const status = await apiRequest(config, 'system/status');
    if (!status || typeof status !== 'object') {
        throw new ArrError(`${config.service} returned unexpected connection-test data.`);
    }
    return status;
}

async function getConfigurationOptions(type, connection) {
    const config = getConfig(type, connection);
    const [rootFolders, qualityProfiles] = await Promise.all([
        apiRequest(config, 'rootfolder'),
        apiRequest(config, 'qualityprofile')
    ]);
    if (!Array.isArray(rootFolders) || !Array.isArray(qualityProfiles)) {
        throw new ArrError(`${config.service} returned unexpected root-folder or quality-profile data.`);
    }
    return {
        rootFolders: rootFolders.map(folder => ({
            path: folder.path,
            freeSpace: folder.freeSpace
        })),
        qualityProfiles: qualityProfiles.map(profile => ({
            id: profile.id,
            name: profile.name
        }))
    };
}

async function apiRequest(config, path, options = {}) {
    let response;
    try {
        response = await fetch(`${config.baseUrl}/api/${ARR_API_VERSION}/${path}`, {
            ...options,
            headers: {
                'X-Api-Key': config.apiKey,
                'Content-Type': 'application/json',
                ...options.headers
            }
        });
    } catch {
        throw new ArrError(`Could not connect to ${config.service}. Check its URL and that the service is running.`);
    }

    if (!response.ok) {
        throw new ArrError(`${config.service} returned HTTP ${response.status} for ${path}. Check its API settings and logs.`);
    }

    if (response.status === 204) return null;
    try {
        return await response.json();
    } catch {
        throw new ArrError(`${config.service} returned invalid JSON for ${path}.`);
    }
}

async function searchMedia(type, title) {
    const config = getConfig(type);
    const endpoint = type === 'movie' ? 'movie/lookup' : 'series/lookup';
    const results = await apiRequest(config, `${endpoint}?term=${encodeURIComponent(title)}`);

    if (!Array.isArray(results)) {
        throw new ArrError(`${config.service} returned an unexpected search response.`);
    }

    return results;
}

function getSetting(envName, options, valueKey, displayName) {
    const configured = process.env[envName];
    if (configured) {
        const value = options.find(option => String(option[valueKey]) === configured);
        if (!value) {
            throw new ArrError(`${envName}="${configured}" was not found in the configured ${displayName}.`);
        }
        return value;
    }

    if (options.length === 1) return options[0];
    if (options.length === 0) {
        throw new ArrError(`No ${displayName} are configured in the media manager.`);
    }

    throw new ArrError(`Set ${envName} in Settings because multiple ${displayName} are configured.`);
}

async function getAddSettings(type) {
    const config = getConfig(type);
    const service = type === 'movie' ? 'RADARR' : 'SONARR';
    const [rootFolders, profiles] = await Promise.all([
        apiRequest(config, 'rootfolder'),
        apiRequest(config, 'qualityprofile')
    ]);
    if (!Array.isArray(rootFolders) || !Array.isArray(profiles)) {
        throw new ArrError(`${config.service} returned unexpected root-folder or quality-profile data.`);
    }
    const subtype = type === 'movie' ? '' : type === 'anime' ? 'ANIME_' : 'TV_';
    const rootFolderVariable = `${service}_${subtype}ROOT_FOLDER`;
    const profileVariable = `${service}_${subtype}QUALITY_PROFILE_ID`;
    const rootFolderSetting = process.env[rootFolderVariable]
        ? rootFolderVariable
        : subtype ? `${service}_ROOT_FOLDER` : rootFolderVariable;
    const profileSetting = process.env[profileVariable]
        ? profileVariable
        : subtype ? `${service}_QUALITY_PROFILE_ID` : profileVariable;
    const rootFolder = getSetting(
        rootFolderSetting,
        rootFolders,
        'path',
        'root folders'
    );
    const profile = getSetting(
        profileSetting,
        profiles,
        'id',
        'quality profiles'
    );

    return { config, rootFolder, profile };
}

async function addMedia(type, media) {
    const config = getConfig(type);
    const endpoint = type === 'movie' ? 'movie' : 'series';
    const idField = type === 'movie' ? 'tmdbId' : 'tvdbId';
    const existing = await apiRequest(config, endpoint);

    if (Array.isArray(existing) && media[idField]
        && existing.some(item => item[idField] === media[idField])) {
        const existingMedia = existing.find(item => item[idField] === media[idField]);
        return {
            alreadyExists: true,
            searchStarted: false,
            service: config.service,
            managerMediaId: existingMedia.id
        };
    }

    const { rootFolder, profile } = await getAddSettings(type);
    const body = type === 'movie'
        ? {
            title: media.title,
            tmdbId: media.tmdbId,
            minimumAvailability: 'released',
            qualityProfileId: profile.id,
            rootFolderPath: rootFolder.path,
            monitored: true,
            addOptions: { searchForMovie: true }
        }
        : {
            title: media.title,
            tvdbId: media.tvdbId,
            qualityProfileId: profile.id,
            rootFolderPath: rootFolder.path,
            seriesType: type === 'anime' ? 'anime' : 'standard',
            seasonFolder: true,
            monitored: true,
            addOptions: { searchForMissingEpisodes: true }
        };

    const addedMedia = await apiRequest(config, endpoint, {
        method: 'POST',
        body: JSON.stringify(body)
    });

    return {
        alreadyExists: false,
        searchStarted: true,
        service: config.service,
        managerMediaId: addedMedia?.id
    };
}

async function searchAgain(type, managerMediaId) {
    if (!['movie', 'tv', 'anime'].includes(type)) {
        throw new ArrError('Choose a movie, TV show, or anime request to search again.');
    }
    const id = Number(managerMediaId);
    if (!Number.isSafeInteger(id) || id < 1) {
        throw new ArrError('This request does not have a valid media-manager ID.');
    }
    const config = getConfig(type);
    const body = type === 'movie'
        ? { name: 'MoviesSearch', movieIds: [id] }
        : { name: 'SeriesSearch', seriesId: id };
    const command = await apiRequest(config, 'command', {
        method: 'POST',
        body: JSON.stringify(body)
    });
    return { service: config.service, command };
}

function normalizeQueue(queue) {
    if (Array.isArray(queue)) return queue;
    if (queue && Array.isArray(queue.records)) return queue.records;
    return [];
}

function getQueueTitle(item, type) {
    if (type === 'movie') {
        return item?.movie?.title || item?.title || 'Unknown movie';
    }

    return item?.series?.title || item?.title || 'Unknown series';
}

async function getQueue(type) {
    const config = getConfig(type);
    const queue = await apiRequest(config, 'queue');
    return normalizeQueue(queue).map(item => ({
        ...item,
        _type: type,
        _service: config.service,
        _managerMediaId: type === 'movie'
            ? item.movieId ?? item.movie?.id
            : item.seriesId ?? item.series?.id,
        _title: getQueueTitle(item, type)
    }));
}

async function getHistory(type, pageSize = 100) {
    const config = getConfig(type);
    const relatedMedia = type === 'movie'
        ? 'includeMovie=true'
        : 'includeSeries=true&includeEpisode=true';
    const history = await apiRequest(
        config,
        `history?page=1&pageSize=${pageSize}&sortKey=date&sortDirection=descending&${relatedMedia}`
    );

    if (Array.isArray(history)) return history;
    if (history && Array.isArray(history.records)) return history.records;
    throw new ArrError(`${config.service} returned unexpected history data.`);
}

module.exports = {
    ArrError,
    searchMedia,
    addMedia,
    searchAgain,
    getConfig,
    testConnection,
    getConfigurationOptions,
    getQueue,
    getQueueTitle,
    getHistory
};
