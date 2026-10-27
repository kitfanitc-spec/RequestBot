const { testConnection: testArrConnection } = require('./arrClient');
const { testConnection: testTorrentClientConnection } = require('./torrentClients');
const { testDiscordConnection } = require('./discordSetup');

function requireFields(values, fields, service) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
        throw new Error(`Enter the ${service} connection settings first.`);
    }
    for (const field of fields) {
        if (typeof values[field] !== 'string' || !values[field].trim()) {
            throw new Error(`Enter ${field} to test the ${service} connection.`);
        }
    }
}

async function testConnection(service, values) {
    if (service === 'radarr' || service === 'sonarr') {
        requireFields(values, ['url', 'apiKey'], service);
        await testArrConnection(service === 'radarr' ? 'movie' : 'tv', values);
        return { success: true, message: `Connected to ${service === 'radarr' ? 'Radarr' : 'Sonarr'}.` };
    }

    if (service === 'torrent') {
        requireFields(values, ['client', 'url'], 'torrent client');
        if (values.client === 'qbittorrent' || values.client === 'transmission'
            || values.client === 'bittorrent') {
            requireFields(values, ['username', 'password'], values.client);
        }
        if (values.client === 'deluge') requireFields(values, ['password'], 'Deluge');
        return testTorrentClientConnection(values);
    }

    if (service === 'discord') {
        requireFields(values, ['token', 'clientId', 'guildId'], 'Discord');
        return testDiscordConnection(values);
    }

    throw new Error('Choose a supported service to test.');
}

module.exports = { testConnection };
