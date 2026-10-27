const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MessageFlags } = require('discord.js');
const {
    cancelRequestCommand,
    myRequestsCommand,
    retryRequestCommand,
    handleRetryRequestCommand,
    createMatchEmbed,
    createMatchComponents,
    handleMyRequestsCommand,
    getRequestPolicy
} = require('../commands/request');
const { requestHistory } = require('../services/requestHistory');

test('request restrictions are disabled by default and parse configured limits and channels', t => {
    const previousLimit = process.env.REQUEST_MAX_ACTIVE_PER_USER;
    const previousChannels = process.env.REQUEST_ALLOWED_CHANNEL_IDS;
    t.after(() => {
        if (previousLimit === undefined) delete process.env.REQUEST_MAX_ACTIVE_PER_USER;
        else process.env.REQUEST_MAX_ACTIVE_PER_USER = previousLimit;
        if (previousChannels === undefined) delete process.env.REQUEST_ALLOWED_CHANNEL_IDS;
        else process.env.REQUEST_ALLOWED_CHANNEL_IDS = previousChannels;
    });

    delete process.env.REQUEST_MAX_ACTIVE_PER_USER;
    delete process.env.REQUEST_ALLOWED_CHANNEL_IDS;
    assert.deepEqual(getRequestPolicy(), { maxActiveRequests: null, allowedChannels: [] });

    process.env.REQUEST_MAX_ACTIVE_PER_USER = '3';
    process.env.REQUEST_ALLOWED_CHANNEL_IDS = '12345678901234567, 23456789012345678';
    assert.deepEqual(getRequestPolicy(), {
        maxActiveRequests: 3,
        allowedChannels: ['12345678901234567', '23456789012345678']
    });
});

test('rejects malformed request limits and channel identifiers', t => {
    const previousLimit = process.env.REQUEST_MAX_ACTIVE_PER_USER;
    const previousChannels = process.env.REQUEST_ALLOWED_CHANNEL_IDS;
    t.after(() => {
        if (previousLimit === undefined) delete process.env.REQUEST_MAX_ACTIVE_PER_USER;
        else process.env.REQUEST_MAX_ACTIVE_PER_USER = previousLimit;
        if (previousChannels === undefined) delete process.env.REQUEST_ALLOWED_CHANNEL_IDS;
        else process.env.REQUEST_ALLOWED_CHANNEL_IDS = previousChannels;
    });

    process.env.REQUEST_MAX_ACTIVE_PER_USER = '-1';
    delete process.env.REQUEST_ALLOWED_CHANNEL_IDS;
    assert.throws(getRequestPolicy, /whole number from 1 to 9999/);

    delete process.env.REQUEST_MAX_ACTIVE_PER_USER;
    process.env.REQUEST_ALLOWED_CHANNEL_IDS = 'not-a-channel';
    assert.throws(getRequestPolicy, /comma-separated Discord channel IDs/);
});

test('cancel-request command is registered with its dedicated slash command name', () => {
    assert.equal(cancelRequestCommand.toJSON().name, 'cancel-request');
});

test('my-requests command is registered with its dedicated slash command name', () => {
    assert.equal(myRequestsCommand.toJSON().name, 'my-requests');
});

test('retry-request is limited by default to server managers', () => {
    const command = retryRequestCommand.toJSON();
    assert.equal(command.name, 'retry-request');
    assert.ok(command.default_member_permissions);
});

test('retry-request refuses users without server-manager permissions', async () => {
    let response;
    await handleRetryRequestCommand({
        memberPermissions: { has: () => false },
        reply: async options => { response = options; }
    });
    assert.match(response.content, /Manage Server permission/);
});

test('request previews include poster art and clear result details', () => {
    const result = {
        title: 'Sample Movie',
        year: 2025,
        overview: 'A sample summary.',
        genres: ['Drama'],
        ratings: { tmdb: { value: 7.5 } },
        images: [{ coverType: 'poster', remoteUrl: 'https://example.test/poster.jpg' }]
    };
    const embed = createMatchEmbed(result, 'movie').toJSON();
    assert.equal(embed.thumbnail.url, 'https://example.test/poster.jpg');
    assert.match(embed.description, /sample summary/);
    assert.ok(embed.fields.some(field => field.name === 'Ratings' && /7.5/.test(field.value)));
    assert.equal(createMatchComponents([result]).length, 2);
});

test("my-requests privately displays at most 10 of the requester's newest requests", async t => {
    const originalList = requestHistory.listRecentRequestsByRequester;
    t.after(() => { requestHistory.listRecentRequestsByRequester = originalList; });
    let query;
    requestHistory.listRecentRequestsByRequester = async (...args) => {
        query = args;
        return Array.from({ length: 11 }, (_, index) => ({
            title: `Request ${index + 1}`,
            type: 'movie',
            status: 'Requested',
            requestedAt: '2026-10-09T00:00:00.000Z'
        }));
    };
    let response;

    await handleMyRequestsCommand({
        user: { id: 'user-1' },
        reply: async options => { response = options; }
    });

    assert.deepEqual(query, ['user-1', 11]);
    assert.equal(response.flags, MessageFlags.Ephemeral);
    assert.equal(response.allowedMentions.parse.length, 0);
    assert.equal((response.content.match(/• \*\*Request/g) || []).length, 10);
    assert.match(response.content, /older history is available in the desktop dashboard/);
    assert.doesNotMatch(response.content, /Request 11/);
});
