const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createMediaSyncRunner } = require('../services/mediaSyncRunner');

test('starts a selected batch file hidden and stops its process tree', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'request-bot-sync-'));
    const scriptPath = path.join(directory, 'media sync.bat');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.writeFile(scriptPath, '@echo off\n');

    const child = new EventEmitter();
    child.pid = 1234;
    let spawned;
    let killed;
    const runner = createMediaSyncRunner({
        platform: 'win32',
        spawnProcess: (...args) => {
            spawned = args;
            return child;
        },
        runCommandProcess: async (...args) => {
            killed = args;
        }
    });

    assert.deepEqual(await runner.start(scriptPath), {
        running: true,
        message: 'Batch file is running.',
        failure: false
    });
    assert.equal(spawned[0], 'cmd.exe');
    assert.deepEqual(spawned[1], ['/d', '/s', '/c', `""${path.resolve(scriptPath)}""`]);
    assert.equal(spawned[2].shell, false);
    assert.equal(spawned[2].windowsVerbatimArguments, true);
    assert.equal(spawned[2].windowsHide, true);
    assert.equal(spawned[2].cwd, directory);

    assert.deepEqual(await runner.stop(), {
        running: false,
        message: 'Batch file stopped.',
        failure: false
    });
    assert.deepEqual(killed, ['taskkill', ['/PID', '1234', '/T', '/F']]);
});

test('rejects missing and non-batch script paths', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'request-bot-sync-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const runner = createMediaSyncRunner({ platform: 'win32' });

    await assert.rejects(runner.start(path.join(directory, 'missing.bat')), /ENOENT/);
    await assert.rejects(runner.start(path.join(directory, 'script.txt')), /\.bat file/);
});

test('reports batch process errors and rejects unsupported script extensions', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'request-bot-sync-'));
    const scriptPath = path.join(directory, 'media.bat');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.writeFile(scriptPath, '@echo off\n');

    const child = new EventEmitter();
    child.pid = 1234;
    const statuses = [];
    const runner = createMediaSyncRunner({
        platform: 'win32',
        spawnProcess: () => child,
        onStatus: status => statuses.push(status)
    });

    await runner.start(scriptPath);
    child.emit('error', new Error('permission denied'));
    assert.deepEqual(runner.getStatus(), {
        running: false,
        message: 'Could not run the batch file: permission denied',
        failure: true
    });
    assert.equal(statuses.length, 2);

    const linuxRunner = createMediaSyncRunner({ platform: 'linux' });
    await assert.rejects(linuxRunner.start(scriptPath), /shell \.sh file/);
    const unsupportedRunner = createMediaSyncRunner({ platform: 'freebsd' });
    await assert.rejects(unsupportedRunner.start(scriptPath), /not supported on this platform/);
});

test('includes the batch output when a script exits with an error', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'request-bot-sync-'));
    const scriptPath = path.join(directory, 'media.bat');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.writeFile(scriptPath, '@echo off\n');

    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const runner = createMediaSyncRunner({
        platform: 'win32',
        spawnProcess: () => child
    });

    await runner.start(scriptPath);
    child.stderr.emit('data', Buffer.from('The source folder could not be accessed.'));
    child.emit('close', 1, null);

    assert.deepEqual(runner.getStatus(), {
        running: false,
        message: 'Batch file exited with code 1. Last output: The source folder could not be accessed.',
        failure: true
    });
});

test('starts .sh scripts on macOS and Linux and stops their process groups', async t => {
    for (const platform of ['darwin', 'linux']) {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'request-bot-sync-'));
        const scriptPath = path.join(directory, 'media sync.sh');
        t.after(() => fs.rm(directory, { recursive: true, force: true }));
        await fs.writeFile(scriptPath, 'echo media sync\n');

        const child = new EventEmitter();
        child.pid = 1234;
        let spawned;
        let killed;
        const runner = createMediaSyncRunner({
            platform,
            spawnProcess: (...args) => {
                spawned = args;
                return child;
            },
            killProcessGroup: (pid, signal) => {
                killed = [pid, signal];
                child.emit('close', null, signal);
            }
        });

        assert.deepEqual(await runner.start(scriptPath), {
            running: true,
            message: 'Shell script is running.',
            failure: false
        });
        assert.equal(spawned[0], '/bin/sh');
        assert.deepEqual(spawned[1], [path.resolve(scriptPath)]);
        assert.equal(spawned[2].shell, false);
        assert.equal(spawned[2].detached, true);
        assert.equal(spawned[2].cwd, directory);
        assert.deepEqual(await runner.stop(), {
            running: false,
            message: 'Shell script stopped.',
            failure: false
        });
        assert.deepEqual(killed, [1234, 'SIGTERM']);
    }
});

test('does not report a nonzero batch exit as a failure when stopping it', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'request-bot-sync-'));
    const scriptPath = path.join(directory, 'media.bat');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.writeFile(scriptPath, '@echo off\n');

    const child = new EventEmitter();
    child.pid = 1234;
    const runner = createMediaSyncRunner({
        platform: 'win32',
        spawnProcess: () => child,
        runCommandProcess: async () => {
            child.emit('close', 1, null);
        }
    });

    await runner.start(scriptPath);
    assert.deepEqual(await runner.stop(), {
        running: false,
        message: 'Batch file stopped.',
        failure: false
    });
});
