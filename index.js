require('dotenv').config();

const { Client, GatewayIntentBits, MessageFlags } = require('discord.js');
const { ArrError } = require('./services/arrClient');
const {
    handleRequestCommand,
    handleCancelRequestCommand,
    handleMyRequestsCommand,
    handleRetryRequestCommand
} = require('./commands/request');
const { pollDownloadAlerts } = require('./services/downloadAlerts');

const botStates = new WeakMap();

function startBot() {
    if (!process.env.DISCORD_TOKEN) {
        throw new Error('DISCORD_TOKEN is required. Add the bot token in Settings or .env.');
    }

    const client = new Client({
        intents: [GatewayIntentBits.Guilds]
    });

    const state = { alertTimer: undefined, stopped: false };
    botStates.set(client, state);
    client.once('clientReady', () => {
        console.log(`Logged in as ${client.user.tag}`);

        if (process.env.ALERT_CHANNEL_ID) {
            pollDownloadAlerts(client).then(timer => {
                if (state.stopped) clearInterval(timer);
                else state.alertTimer = timer;
            }).catch(error => {
                console.error('Could not start download alerts:', error);
            });
        }
    });
    client.on('interactionCreate', async interaction => {
        if (!interaction.isChatInputCommand()) return;

        if (['request', 'cancel-request', 'my-requests', 'retry-request'].includes(interaction.commandName)) {
            try {
                if (interaction.commandName === 'request') await handleRequestCommand(interaction);
                else if (interaction.commandName === 'cancel-request') {
                    await handleCancelRequestCommand(interaction);
                } else if (interaction.commandName === 'my-requests') {
                    await handleMyRequestsCommand(interaction);
                } else {
                    await handleRetryRequestCommand(interaction);
                }
            } catch (error) {
                console.error('Request command failed:', error);
                const message = error instanceof ArrError
                    ? error.message
                    : 'The request could not be completed. Check the bot logs.';

                try {
                    if (interaction.deferred || interaction.replied) {
                        await interaction.editReply({ content: message, components: [] });
                    } else {
                        await interaction.reply({
                            content: message,
                            flags: MessageFlags.Ephemeral
                        });
                    }
                } catch (responseError) {
                    console.error('Could not report the request error to Discord:', responseError);
                }
            }
        }
    });

    client.login(process.env.DISCORD_TOKEN).catch(error => {
        console.error('Discord login failed:', error);
        client.emit('botLoginError', error);
        if (require.main === module) process.exitCode = 1;
    });

    return client;
}

async function stopBot(client) {
    if (!client) return;
    const state = botStates.get(client);
    if (state) {
        state.stopped = true;
        if (state.alertTimer) clearInterval(state.alertTimer);
    }
    await client.destroy();
}

if (require.main === module) {
    startBot();
}

module.exports = { startBot, stopBot };
