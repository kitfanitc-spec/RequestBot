const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

function runCommand(command, args) {
    return new Promise((resolve, reject) => {
        execFile(command, args, error => {
            if (error) reject(error);
            else resolve();
        });
    });
}

function createMediaSyncRunner({
    spawnProcess = spawn,
    runCommandProcess = runCommand,
    killProcessGroup = (pid, signal) => process.kill(-pid, signal),
    platform = process.platform,
    onStatus = () => {}
} = {}) {
    let child;
    let stopping;
    let stoppingProcess;
    let status = { running: false, message: 'Stopped', failure: false };
    let output = '';
    const isWindows = platform === 'win32';
    const isUnix = platform === 'darwin' || platform === 'linux';
    const scriptExtension = isWindows ? '.bat' : '.sh';
    const scriptDescription = isWindows ? 'Windows .bat file' : 'shell .sh file';
    const processDescription = isWindows ? 'Batch file' : 'Shell script';

    function updateStatus(nextStatus) {
        status = nextStatus;
        onStatus({ ...status });
    }

    async function start(scriptPath) {
        if (!isWindows && !isUnix) {
            throw new Error('Personal media sync is not supported on this platform.');
        }
        if (typeof scriptPath !== 'string' || !scriptPath.trim()) {
            throw new Error(`Choose a ${scriptDescription} before starting media sync.`);
        }
        const resolvedPath = path.resolve(scriptPath.trim());
        if (path.extname(resolvedPath).toLowerCase() !== scriptExtension) {
            throw new Error(`Choose a ${scriptDescription}.`);
        }
        const fileInfo = await fs.stat(resolvedPath);
        if (!fileInfo.isFile()) {
            throw new Error('The selected script is not a file.');
        }
        if (child) {
            throw new Error('Media sync is already running.');
        }

        const process = isWindows
            ? spawnProcess('cmd.exe', ['/d', '/s', '/c', `""${resolvedPath}""`], {
                shell: false,
                windowsVerbatimArguments: true,
                windowsHide: true,
                cwd: path.dirname(resolvedPath),
                stdio: ['ignore', 'pipe', 'pipe']
            })
            : spawnProcess('/bin/sh', [resolvedPath], {
                shell: false,
                detached: true,
                cwd: path.dirname(resolvedPath),
                stdio: ['ignore', 'pipe', 'pipe']
            });
        output = '';
        child = process;
        updateStatus({ running: true, message: `${processDescription} is running.`, failure: false });

        for (const stream of [process.stdout, process.stderr]) {
            stream?.on('data', chunk => {
                output = `${output}${chunk.toString('utf8')}`.slice(-1200);
            });
        }

        process.once('error', error => {
            if (child !== process) return;
            child = undefined;
            updateStatus({
                running: false,
                message: `Could not run the ${processDescription.toLowerCase()}: ${error.message}`,
                failure: true
            });
        });
        process.once('close', (code, signal) => {
            if (child !== process) return;
            child = undefined;
            if (stoppingProcess === process) {
                stoppingProcess = undefined;
                updateStatus({ running: false, message: `${processDescription} stopped.`, failure: false });
                return;
            }
            const failed = code !== 0 && code !== null;
            const details = output.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' | ');
            updateStatus({
                running: false,
                message: failed
                    ? `${processDescription} exited with code ${code}.${details ? ` Last output: ${details}` : ''}`
                    : signal
                        ? `${processDescription} stopped.`
                        : `${processDescription} finished.`,
                failure: failed
            });
        });

        return getStatus();
    }

    async function stop() {
        if (!child) return getStatus();
        if (stopping) return stopping;

        const process = child;
        if (!Number.isSafeInteger(process.pid) || process.pid < 1) {
            throw new Error(`Could not identify the running ${processDescription.toLowerCase()}.`);
        }

        stoppingProcess = process;
        updateStatus({ running: true, message: `Stopping ${processDescription.toLowerCase()}...`, failure: false });
        stopping = (async () => {
            try {
                if (isWindows) {
                    await runCommandProcess('taskkill', [
                        '/PID',
                        String(process.pid),
                        '/T',
                        '/F'
                    ]);
                } else {
                    const closed = new Promise(resolve => {
                        process.once('close', resolve);
                    });
                    killProcessGroup(process.pid, 'SIGTERM');
                    let timeout;
                    const exited = await Promise.race([
                        closed.then(() => true),
                        new Promise(resolve => {
                            timeout = setTimeout(() => resolve(false), 2000);
                        })
                    ]);
                    clearTimeout(timeout);
                    if (!exited && child === process) {
                        killProcessGroup(process.pid, 'SIGKILL');
                        await Promise.race([
                            closed,
                            new Promise((_, reject) => {
                                timeout = setTimeout(
                                    () => reject(new Error('The shell script did not stop after SIGKILL.')),
                                    2000
                                );
                            })
                        ]);
                        clearTimeout(timeout);
                    }
                }
            } catch (error) {
                if (child !== process) return getStatus();
                stoppingProcess = undefined;
                const message = `Could not stop the ${processDescription.toLowerCase()}: ${error.message}`;
                updateStatus({ running: true, message, failure: true });
                throw new Error(message, { cause: error });
            }

            if (child === process) {
                child = undefined;
                stoppingProcess = undefined;
                updateStatus({ running: false, message: `${processDescription} stopped.`, failure: false });
            }
            return getStatus();
        })();

        try {
            return await stopping;
        } finally {
            stopping = undefined;
        }
    }

    function getStatus() {
        return { ...status };
    }

    return { start, stop, getStatus };
}

module.exports = { createMediaSyncRunner };
