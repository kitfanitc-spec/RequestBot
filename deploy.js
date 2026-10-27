require('dotenv').config();

const { registerSlashCommand } = require('./services/discordSetup');

if (require.main === module) {
    registerSlashCommand()
        .then(result => console.log(result.message))
        .catch(error => {
            console.error('Command registration failed:', error);
            process.exitCode = 1;
        });
}