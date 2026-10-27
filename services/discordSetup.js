const { REST, Routes } = require('discord.js');
const {
    requestCommand,
    cancelRequestCommand,
    myRequestsCommand,
    retryRequestCommand
} = require('../commands/request');

function getRest(token = process.env.DISCORD_TOKEN) {
    if (!token) throw new Error('Enter the Discord bot token in Settings.');
    return new REST({ version: '10' }).setToken(token);
}

async function testDiscordConnection(values) {
    if (!values?.token || !values?.clientId || !values?.guildId) {
        throw new Error('Enter the bot token, application ID, and server ID to test Discord.');
    }

    const rest = getRest(values.token);
    try {
        const [user, guild] = await Promise.all([
            rest.get(Routes.user('@me')),
            rest.get(Routes.guild(values.guildId))
        ]);
        return { success: true, message: `Connected as ${user.username} to ${guild.name}.` };
    } catch (error) {
        console.error('Discord connection test failed:', error.message);
        throw new Error('Discord connection failed. Check the bot token, application ID, and server ID.');
    }
}

async function registerSlashCommand({
    token = process.env.DISCORD_TOKEN,
    clientId = process.env.CLIENT_ID,
    guildId = process.env.GUILD_ID
} = {}) {
    if (!token || !clientId || !guildId) {
        throw new Error('Enter the Discord bot token, application ID, and server ID in Settings first.');
    }

    await getRest(token).put(
        Routes.applicationGuildCommands(clientId, guildId),
        {
            body: [
                requestCommand.toJSON(),
                cancelRequestCommand.toJSON(),
                myRequestsCommand.toJSON(),
                retryRequestCommand.toJSON()
            ]
        }
    );
    return {
        success: true,
        message: 'Registered /request, /cancel-request, /my-requests, and /retry-request for your Discord server.'
    };
}

module.exports = { registerSlashCommand, testDiscordConnection };
