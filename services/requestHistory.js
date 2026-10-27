const path = require('node:path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

function createRequestHistory(filename = path.join(__dirname, '..', 'request-history.sqlite')) {
    let databasePromise;
    let databasePath = filename;

    async function getDatabase() {
        if (!databasePromise) {
            databasePromise = open({ filename: databasePath, driver: sqlite3.Database }).then(async database => {
                await database.exec(`
                    CREATE TABLE IF NOT EXISTS requests (
                        id INTEGER PRIMARY KEY,
                        media_type TEXT NOT NULL,
                        media_id TEXT,
                        title TEXT NOT NULL,
                        service TEXT NOT NULL,
                        manager_media_id TEXT,
                        requester_id TEXT NOT NULL,
                        requester_name TEXT NOT NULL,
                        status TEXT NOT NULL,
                        status_detail TEXT,
                        requested_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        completed_at TEXT
                    );
                    CREATE INDEX IF NOT EXISTS requests_requested_at
                        ON requests(requested_at DESC);
                    CREATE INDEX IF NOT EXISTS requests_manager_media
                        ON requests(service, manager_media_id);
                    CREATE TABLE IF NOT EXISTS request_notification_states (
                        request_id INTEGER PRIMARY KEY,
                        status TEXT NOT NULL
                    );
                `);
                return database;
            }).catch(error => {
                databasePromise = undefined;
                throw error;
            });
        }

        return databasePromise;
    }

    async function recordRequest(request) {
        const database = await getDatabase();
        const now = new Date().toISOString();
        const initialStatus = request.alreadyExists ? 'Already in library' : 'Requested';
        const result = await database.run(
            `INSERT INTO requests (
                media_type, media_id, title, service, manager_media_id,
                requester_id, requester_name, status, status_detail,
                requested_at, updated_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            request.type,
            request.mediaId ? String(request.mediaId) : null,
            request.title,
            request.service,
            request.managerMediaId ? String(request.managerMediaId) : null,
            request.requesterId,
            request.requesterName,
            initialStatus,
            null,
            now,
            now,
            null
        );
        await database.run(
            `INSERT INTO request_notification_states (request_id, status)
             VALUES (?, ?)`,
            result.lastID,
            initialStatus
        );
        return result.lastID;
    }

    async function listRecentRequests(limit = 50) {
        const database = await getDatabase();
        return database.all(
            `SELECT id, media_type AS type, media_id AS mediaId, title, service,
                    manager_media_id AS managerMediaId,
                    requester_id AS requesterId, requester_name AS requesterName,
                    status, status_detail AS statusDetail,
                    requested_at AS requestedAt, updated_at AS updatedAt,
                    completed_at AS completedAt
             FROM requests
             ORDER BY requested_at DESC, id DESC
             LIMIT ?`,
            limit
        );
    }

    async function listRecentRequestsByRequester(requesterId, limit = 10) {
        const database = await getDatabase();
        return database.all(
            `SELECT id, media_type AS type, media_id AS mediaId, title, service,
                    manager_media_id AS managerMediaId,
                    requester_id AS requesterId, requester_name AS requesterName,
                    status, status_detail AS statusDetail,
                    requested_at AS requestedAt, updated_at AS updatedAt,
                    completed_at AS completedAt
             FROM requests
             WHERE requester_id = ?
             ORDER BY requested_at DESC, id DESC
             LIMIT ?`,
            requesterId,
            limit
        );
    }

    async function listAllRequests() {
        const database = await getDatabase();
        return database.all(
            `SELECT id, media_type AS type, media_id AS mediaId, title, service,
                    manager_media_id AS managerMediaId,
                    requester_id AS requesterId, requester_name AS requesterName,
                    status, status_detail AS statusDetail,
                    requested_at AS requestedAt, updated_at AS updatedAt,
                    completed_at AS completedAt
             FROM requests
             ORDER BY requested_at DESC, id DESC`
        );
    }

    async function listActiveRequestsByRequester(requesterId) {
        const database = await getDatabase();
        return database.all(
            `SELECT id, media_type AS type, media_id AS mediaId, title, service,
                    manager_media_id AS managerMediaId,
                    requester_id AS requesterId, requester_name AS requesterName,
                    status, status_detail AS statusDetail,
                    requested_at AS requestedAt, updated_at AS updatedAt,
                    completed_at AS completedAt
             FROM requests
             WHERE requester_id = ?
               AND status NOT IN ('Completed', 'Failed', 'Already in library', 'Cancelled')
             ORDER BY requested_at DESC, id DESC`,
            requesterId
        );
    }

    async function countActiveRequestsByRequester(requesterId) {
        const database = await getDatabase();
        const result = await database.get(
            `SELECT COUNT(*) AS count
             FROM requests
             WHERE requester_id = ?
               AND status NOT IN ('Completed', 'Failed', 'Already in library', 'Cancelled')`,
            requesterId
        );
        return result.count;
    }

    async function updateStatus(id, status, statusDetail = null, completedAt = null) {
        const database = await getDatabase();
        await database.run(
            `UPDATE requests
             SET status = ?, status_detail = ?, updated_at = ?,
                 completed_at = COALESCE(?, completed_at)
             WHERE id = ? AND status != 'Cancelled'`,
            status,
            statusDetail,
            new Date().toISOString(),
            completedAt,
            id
        );
    }

    async function hasUnnotifiedStatus(id, status) {
        const database = await getDatabase();
        const previous = await database.get(
            'SELECT status FROM request_notification_states WHERE request_id = ?',
            id
        );
        if (!previous) {
            await database.run(
                'INSERT INTO request_notification_states (request_id, status) VALUES (?, ?)',
                id,
                status
            );
            return false;
        }
        return previous.status !== status;
    }

    async function recordNotifiedStatus(id, status) {
        const database = await getDatabase();
        await database.run(
            `INSERT INTO request_notification_states (request_id, status)
             VALUES (?, ?)
             ON CONFLICT(request_id) DO UPDATE SET status = excluded.status`,
            id,
            status
        );
    }

    async function cancelRequest(id, requesterId) {
        const database = await getDatabase();
        const conditions = [
            `status NOT IN ('Completed', 'Failed', 'Already in library', 'Cancelled')`
        ];
        const parameters = [
            'Cancelled',
            'Cancelled in Request Bot. Media and downloads were left untouched.',
            new Date().toISOString(),
            id
        ];
        if (requesterId !== undefined) {
            conditions.push('requester_id = ?');
            parameters.push(requesterId);
        }
        const result = await database.run(
            `UPDATE requests
             SET status = ?, status_detail = ?, updated_at = ?
             WHERE id = ? AND ${conditions.join(' AND ')}`,
            ...parameters
        );
        return result.changes > 0;
    }

    async function clearAllRequests() {
        const database = await getDatabase();
        await database.run('DELETE FROM request_notification_states');
        await database.run('DELETE FROM requests');
    }

    async function close() {
        if (!databasePromise) return;
        const database = await databasePromise;
        databasePromise = undefined;
        await database.close();
    }

    function configure(filename) {
        if (databasePromise) {
            throw new Error('Request history storage cannot be changed after it has been opened.');
        }
        databasePath = filename;
    }

    return {
        recordRequest,
        listRecentRequests,
        listRecentRequestsByRequester,
        listAllRequests,
        listActiveRequestsByRequester,
        countActiveRequestsByRequester,
        updateStatus,
        hasUnnotifiedStatus,
        recordNotifiedStatus,
        cancelRequest,
        clearAllRequests,
        close,
        configure
    };
}

const requestHistory = createRequestHistory();

module.exports = { createRequestHistory, requestHistory };
