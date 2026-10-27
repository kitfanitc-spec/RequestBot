const { spawn } = require('node:child_process');

const restartDelayMs = 5000;
let child;
let restartTimer;
let stopping = false;

function startBot() {
    child = spawn(process.execPath, ['index.js'], { stdio: 'inherit' });

    child.once('error', error => {
        scheduleRestart(`Could not start the bot: ${error.message}`);
    });

    child.once('exit', (code, signal) => {
        child = undefined;
        if (stopping) return;

        if (code === 0 && !signal) {
            process.exitCode = 0;
            return;
        }

        const reason = signal ? `signal ${signal}` : `exit code ${code}`;
        scheduleRestart(`Bot exited with ${reason}`);
    });
}

function scheduleRestart(reason) {
    if (stopping || restartTimer) return;

    console.error(`${reason}. Restarting in ${restartDelayMs / 1000} seconds...`);
    restartTimer = setTimeout(() => {
        restartTimer = undefined;
        startBot();
    }, restartDelayMs);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
        stopping = true;
        clearTimeout(restartTimer);
        child?.kill(signal);
    });
}

startBot();
