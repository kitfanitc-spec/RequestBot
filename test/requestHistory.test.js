const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRequestHistory } = require('../services/requestHistory');

test('request history supports active limits, owner-only cancellation, and export listing', async t => {
    const history = createRequestHistory(':memory:');
    t.after(() => history.close());
    const id = await history.recordRequest({
        type: 'movie',
        mediaId: 123,
        title: 'Example Movie',
        service: 'Radarr',
        managerMediaId: 7,
        requesterId: 'user-1',
        requesterName: 'Alex',
        alreadyExists: false
    });

    assert.equal(await history.countActiveRequestsByRequester('user-1'), 1);
    assert.equal(await history.countActiveRequestsByRequester('user-2'), 0);
    assert.equal(await history.cancelRequest(id, 'user-2'), false);
    assert.equal(await history.countActiveRequestsByRequester('user-1'), 1);
    assert.equal(await history.cancelRequest(id, 'user-1'), true);
    assert.equal(await history.countActiveRequestsByRequester('user-1'), 0);

    await history.updateStatus(id, 'Downloading');
    const [request] = await history.listAllRequests();
    assert.equal(request.status, 'Cancelled');
    assert.match(request.statusDetail, /left untouched/);
    assert.equal(await history.cancelRequest(id, 'user-1'), false);

    await history.clearAllRequests();
    assert.deepEqual(await history.listAllRequests(), []);
});

test("request history lists only the requester's newest entries up to the requested limit", async t => {
    const history = createRequestHistory(':memory:');
    t.after(() => history.close());
    for (const [requesterId, title] of [
        ['user-1', 'First request'],
        ['user-2', 'Other user request'],
        ['user-1', 'Second request'],
        ['user-1', 'Third request']
    ]) {
        await history.recordRequest({
            type: 'movie',
            title,
            service: 'Radarr',
            requesterId,
            requesterName: requesterId,
            alreadyExists: false
        });
    }

    const requests = await history.listRecentRequestsByRequester('user-1', 2);
    assert.deepEqual(requests.map(request => request.title), [
        'Third request',
        'Second request'
    ]);
    assert.ok(requests.every(request => request.requesterId === 'user-1'));
});

test('request status notification state records each status transition once', async t => {
    const history = createRequestHistory(':memory:');
    t.after(() => history.close());
    const id = await history.recordRequest({
        type: 'movie',
        title: 'Status Movie',
        service: 'Radarr',
        requesterId: 'user-1',
        requesterName: 'Alex',
        managerMediaId: 77,
        alreadyExists: false
    });

    assert.equal(await history.hasUnnotifiedStatus(id, 'Downloading'), true);
    await history.recordNotifiedStatus(id, 'Downloading');
    assert.equal(await history.hasUnnotifiedStatus(id, 'Downloading'), false);
    assert.equal(await history.hasUnnotifiedStatus(id, 'Completed'), true);
    await history.recordNotifiedStatus(id, 'Completed');
    assert.equal(await history.hasUnnotifiedStatus(id, 'Completed'), false);
});
