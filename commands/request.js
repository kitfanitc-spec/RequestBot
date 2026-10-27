const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
    StringSelectMenuBuilder
} = require('discord.js');
const { searchMedia, addMedia, searchAgain } = require('../services/arrClient');
const { requestHistory } = require('../services/requestHistory');
const { sendRequestAlert } = require('../services/downloadAlerts');

const requestLocks = new Map();

function getResultRatings(result) {
    const ratings = result.ratings && typeof result.ratings === 'object'
        ? Object.entries(result.ratings)
        : [];
    return ratings.flatMap(([source, rating]) => {
        const value = Number(rating?.value);
        return Number.isFinite(value) && value > 0
            ? [`${source.toUpperCase()}: ${value.toFixed(1)}`]
            : [];
    });
}

function createMatchEmbed(result, type) {
    const embed = new EmbedBuilder()
        .setColor(0x3978bb)
        .setTitle(String(result.title || 'Untitled').slice(0, 256));
    const description = typeof result.overview === 'string'
        ? result.overview.slice(0, 4096)
        : 'No summary available.';
    embed.setDescription(description || 'No summary available.');

    const poster = Array.isArray(result.images)
        ? result.images.find(image => image.coverType?.toLowerCase() === 'poster')
        : null;
    const posterUrl = poster?.remoteUrl || poster?.url;
    if (typeof posterUrl === 'string' && /^https?:\/\//i.test(posterUrl)) {
        embed.setThumbnail(posterUrl);
    }

    const metadata = [];
    if (result.year) metadata.push({ name: 'Year', value: String(result.year), inline: true });
    if (type === 'anime') metadata.push({ name: 'Type', value: 'Anime', inline: true });
    if (Array.isArray(result.genres) && result.genres.length > 0) {
        metadata.push({ name: 'Genres', value: result.genres.join(', ').slice(0, 1024), inline: true });
    }
    const ratings = getResultRatings(result);
    if (ratings.length > 0) {
        metadata.push({ name: 'Ratings', value: ratings.join(' · ').slice(0, 1024), inline: true });
    }
    if (metadata.length > 0) embed.addFields(metadata);
    return embed;
}

function createMatchComponents(results) {
    const menu = new StringSelectMenuBuilder()
        .setCustomId('request-match')
        .setPlaceholder('Choose a different match to preview')
        .addOptions(results.slice(0, 25).map((result, index) => {
            const year = result.year ? ` (${result.year})` : '';
            const label = `${result.title}${year}`.slice(0, 100);
            const ratings = getResultRatings(result);
            const description = (ratings.length > 0
                ? ratings.join(' · ')
                : result.overview || 'No summary available.').slice(0, 100);
            return { label, description, value: String(index) };
        }));
    return [
        new ActionRowBuilder().addComponents(menu),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('request-match-confirm')
                .setLabel('Request this title')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('request-match-cancel')
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary)
        )
    ];
}

const requestCommand = new SlashCommandBuilder()
    .setName('request')
    .setDescription('Request a movie, TV show, or anime')
    .addStringOption(option => option
        .setName('type')
        .setDescription('What kind of media are you requesting?')
        .setRequired(true)
        .addChoices(
            { name: 'Movie', value: 'movie' },
            { name: 'TV show', value: 'tv' },
            { name: 'Anime', value: 'anime' }
        ))
    .addStringOption(option => option
        .setName('title')
        .setDescription('Title to search for')
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(100));

const cancelRequestCommand = new SlashCommandBuilder()
    .setName('cancel-request')
    .setDescription('Cancel one of your active requests without removing media or downloads');

const myRequestsCommand = new SlashCommandBuilder()
    .setName('my-requests')
    .setDescription('View your recent media requests');

const retryRequestCommand = new SlashCommandBuilder()
    .setName('retry-request')
    .setDescription('Search again for a failed or stalled request (server managers only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

function getRequestPolicy() {
    const rawLimit = process.env.REQUEST_MAX_ACTIVE_PER_USER?.trim();
    let maxActiveRequests = null;
    if (rawLimit) {
        if (!/^[1-9]\d{0,3}$/.test(rawLimit)) {
            throw new Error('REQUEST_MAX_ACTIVE_PER_USER must be a whole number from 1 to 9999.');
        }
        maxActiveRequests = Number(rawLimit);
    }

    const allowedChannels = (process.env.REQUEST_ALLOWED_CHANNEL_IDS || '')
        .split(',')
        .map(channelId => channelId.trim())
        .filter(Boolean);
    if (allowedChannels.some(channelId => !/^\d{17,20}$/.test(channelId))) {
        throw new Error('REQUEST_ALLOWED_CHANNEL_IDS must contain comma-separated Discord channel IDs.');
    }

    return { maxActiveRequests, allowedChannels };
}

async function withRequesterLock(requesterId, action) {
    const previous = requestLocks.get(requesterId) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    requestLocks.set(requesterId, current);
    await previous;
    try {
        return await action();
    } finally {
        release();
        if (requestLocks.get(requesterId) === current) requestLocks.delete(requesterId);
    }
}

async function handleRequestCommand(interaction) {
    const type = interaction.options.getString('type', true);
    const title = interaction.options.getString('title', true).trim();

    const { maxActiveRequests, allowedChannels } = getRequestPolicy();
    if (allowedChannels.length > 0 && !allowedChannels.includes(interaction.channelId)) {
        await interaction.reply({
            content: 'Requests are only available in the configured request channels.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    if (!title) {
        await interaction.reply({
            content: 'Enter a non-empty title.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    if (maxActiveRequests !== null
        && await requestHistory.countActiveRequestsByRequester(interaction.user.id) >= maxActiveRequests) {
        await interaction.reply({
            content: `You already have ${maxActiveRequests} active request${maxActiveRequests === 1 ? '' : 's'}. Wait for one to finish or use /cancel-request.`,
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const results = await searchMedia(type, title);

    if (results.length === 0) {
        await interaction.editReply(`No matches found for "${title}".`);
        return;
    }

    await interaction.editReply({
        content: `Preview the ${type === 'tv' ? 'TV show' : type} match, then confirm to send it to your media manager:`,
        embeds: [createMatchEmbed(results[0], type)],
        components: createMatchComponents(results)
    });

    const reply = await interaction.fetchReply();
    let selectedIndex = 0;
    let confirmed = false;
    while (!confirmed) {
        let component;
        try {
            component = await reply.awaitMessageComponent({
                filter: candidate => candidate.user.id === interaction.user.id,
                time: 120_000
            });
        } catch (error) {
            if (error.code !== 'InteractionCollectorError') throw error;
            await interaction.editReply({
                content: 'Request selection expired. Run `/request` again when you are ready.',
                embeds: [],
                components: []
            });
            return;
        }

        if (component.customId === 'request-match') {
            const nextIndex = Number(component.values[0]);
            if (!Number.isInteger(nextIndex) || !results[nextIndex]) {
                throw new Error('The selected search result was no longer available.');
            }
            selectedIndex = nextIndex;
            await component.update({
                content: `Preview the ${type === 'tv' ? 'TV show' : type} match, then confirm to send it to your media manager:`,
                embeds: [createMatchEmbed(results[selectedIndex], type)],
                components: createMatchComponents(results)
            });
            continue;
        }
        if (component.customId === 'request-match-cancel') {
            await component.update({
                content: 'Request cancelled. Nothing was sent to your media manager.',
                embeds: [],
                components: []
            });
            return;
        }
        if (component.customId !== 'request-match-confirm') {
            throw new Error('Unknown request selection action.');
        }
        await component.deferUpdate();
        confirmed = true;
    }

    const selected = results[selectedIndex];
    if (!selected) {
        throw new Error('The selected search result was no longer available.');
    }

    const result = await withRequesterLock(interaction.user.id, async () => {
        if (maxActiveRequests !== null
            && await requestHistory.countActiveRequestsByRequester(interaction.user.id) >= maxActiveRequests) {
            return { limitReached: true };
        }
        const added = await addMedia(type, selected);
        await requestHistory.recordRequest({
            type,
            mediaId: type === 'movie' ? selected.tmdbId : selected.tvdbId,
            title: selected.title,
            service: added.service,
            managerMediaId: added.managerMediaId,
            requesterId: interaction.user.id,
            requesterName: interaction.user.globalName || interaction.user.username,
            alreadyExists: added.alreadyExists
        });
        return added;
    });
    if (result.limitReached) {
        await interaction.editReply({
            content: `You already have ${maxActiveRequests} active request${maxActiveRequests === 1 ? '' : 's'}. Wait for one to finish or use /cancel-request.`,
            components: []
        });
        return;
    }

    let notificationWarning = '';
    if (!result.alreadyExists) {
        try {
            await sendRequestAlert(interaction.client, {
                type,
                title: selected.title,
                requesterId: interaction.user.id,
                service: result.service,
                alreadyExists: false
            });
        } catch (error) {
            console.error('Could not publish the request to the Discord alert channel:', error);
            notificationWarning = ' The request was accepted, but the public notice could not be sent. Check the request/download alert channel ID and bot permissions in Settings.';
        }
    }

    const message = result.alreadyExists
        ? `**${selected.title}** is already in ${result.service}, so I did not add it or start another download.`
        : `Added **${selected.title}** to ${result.service} and started a search for available releases. It will appear in Jellyfin after your media managers import it and Jellyfin scans the library.`;

    await interaction.editReply({ content: `${message}${notificationWarning}`, components: [] });
}

async function handleCancelRequestCommand(interaction) {
    const requests = await requestHistory.listActiveRequestsByRequester(interaction.user.id);
    if (requests.length === 0) {
        await interaction.reply({
            content: 'You do not have any active requests to cancel.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const menu = new StringSelectMenuBuilder()
        .setCustomId('cancel-request-selection')
        .setPlaceholder('Choose one of your active requests')
        .addOptions(requests.slice(0, 25).map(request => ({
            label: request.title.slice(0, 100),
            description: `${request.type.toUpperCase()} · ${request.status}`.slice(0, 100),
            value: String(request.id)
        })));
    await interaction.reply({
        content: 'Choose a request to mark cancelled. Its media-manager entry and any download will be left untouched.',
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral
    });

    const reply = await interaction.fetchReply();
    let selection;
    try {
        selection = await reply.awaitMessageComponent({
            componentType: ComponentType.StringSelect,
            filter: component => component.user.id === interaction.user.id,
            time: 120_000
        });
    } catch (error) {
        if (error.code !== 'InteractionCollectorError') throw error;
        await interaction.editReply({
            content: 'Cancellation selection expired. Run `/cancel-request` again when you are ready.',
            components: []
        });
        return;
    }

    await selection.deferUpdate();
    const cancelled = await requestHistory.cancelRequest(
        Number(selection.values[0]),
        interaction.user.id
    );
    await interaction.editReply({
        content: cancelled
            ? 'Request marked cancelled. Its media-manager entry and any download were left untouched.'
            : 'That request is no longer active, so it was not changed.',
        components: []
    });
}

async function handleMyRequestsCommand(interaction) {
    const requests = await requestHistory.listRecentRequestsByRequester(interaction.user.id, 11);
    if (requests.length === 0) {
        await interaction.reply({
            content: 'You have not made any requests yet.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const entries = requests.map(request => {
        const title = request.title.length > 90
            ? `${request.title.slice(0, 87)}...`
            : request.title;
        const type = request.type === 'tv' ? 'TV show' : request.type;
        const requestedDate = new Date(request.requestedAt).toLocaleDateString();
        const status = request.status.length > 35
            ? `${request.status.slice(0, 32)}...`
            : request.status;
        return `• **${title}** — ${status} · ${type} · ${requestedDate}`;
    });
    const olderRequestsNote = requests.length > 10
        ? '\nShowing your 10 most recent requests; older history is available in the desktop dashboard.'
        : '';

    await interaction.reply({
        content: `**Your recent requests**\n${entries.slice(0, 10).join('\n')}${olderRequestsNote}`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] }
    });
}

function canManageRequests(interaction) {
    return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true;
}

async function handleRetryRequestCommand(interaction) {
    if (!canManageRequests(interaction)) {
        await interaction.reply({
            content: 'Only server managers with Manage Server permission can retry requests.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const requests = (await requestHistory.listAllRequests())
        .filter(request => request.managerMediaId
            && ['Failed', 'Stalled', 'Needs attention'].includes(request.status));
    if (requests.length === 0) {
        await interaction.reply({
            content: 'There are no failed or stalled requests available to search again.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const menu = new StringSelectMenuBuilder()
        .setCustomId('retry-request-selection')
        .setPlaceholder('Choose a failed or stalled request')
        .addOptions(requests.slice(0, 25).map(request => ({
            label: `${request.title} (#${request.id})`.slice(0, 100),
            description: `${request.service} · ${request.status}`.slice(0, 100),
            value: String(request.id)
        })));
    await interaction.reply({
        content: 'Choose a request. The media manager will not be changed until you confirm the new search.',
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral
    });

    const reply = await interaction.fetchReply();
    let selection;
    try {
        selection = await reply.awaitMessageComponent({
            componentType: ComponentType.StringSelect,
            filter: component => component.user.id === interaction.user.id,
            time: 120_000
        });
    } catch (error) {
        if (error.code !== 'InteractionCollectorError') throw error;
        await interaction.editReply({
            content: 'Retry selection expired. Run `/retry-request` again when ready.',
            components: []
        });
        return;
    }

    const selected = requests.find(request => request.id === Number(selection.values[0]));
    if (!selected) throw new Error('The selected request is no longer available.');
    await selection.update({
        content: `Confirm a new search for **${selected.title}** in ${selected.service}? This sends a search command to the media manager.`,
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('retry-request-confirm')
                .setLabel('Confirm search')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId('retry-request-cancel')
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary)
        )]
    });

    let confirmation;
    try {
        confirmation = await reply.awaitMessageComponent({
            componentType: ComponentType.Button,
            filter: component => component.user.id === interaction.user.id,
            time: 60_000
        });
    } catch (error) {
        if (error.code !== 'InteractionCollectorError') throw error;
        await interaction.editReply({
            content: 'Search confirmation expired. No new search was sent.',
            components: []
        });
        return;
    }

    if (confirmation.customId === 'retry-request-cancel') {
        await confirmation.update({
            content: 'Cancelled. No new search was sent to the media manager.',
            components: []
        });
        return;
    }
    if (confirmation.customId !== 'retry-request-confirm') {
        throw new Error('Unknown retry action.');
    }
    if (!canManageRequests(confirmation)) {
        await confirmation.update({
            content: 'Your server manager permission changed; no search was sent.',
            components: []
        });
        return;
    }

    await confirmation.deferUpdate();
    const result = await searchAgain(selected.type, selected.managerMediaId);
    await requestHistory.updateStatus(
        selected.id,
        'Searching again',
        'A server manager confirmed a new search in the media manager.'
    );
    await interaction.editReply({
        content: `Search started for **${selected.title}** in ${result.service}.`,
        components: []
    });
}

module.exports = {
    requestCommand,
    cancelRequestCommand,
    myRequestsCommand,
    retryRequestCommand,
    handleRequestCommand,
    handleCancelRequestCommand,
    handleMyRequestsCommand,
    handleRetryRequestCommand,
    createMatchEmbed,
    createMatchComponents,
    getRequestPolicy
};
