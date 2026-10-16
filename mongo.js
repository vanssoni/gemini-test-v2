const { AsyncLocalStorage } = require('async_hooks');
const { MongoClient } = require('mongodb');

const requestStore = new AsyncLocalStorage();

const APP_HOST = 'app.medistry.ai';

function defaultDbName() {
    return process.env.MONGO_DB_NAME || 'onehealth_ai_beta';
}

function appDbName() {
    return process.env.MONGO_DB_NAME_APP || 'onehealth_ai_stg';
}

let client = null;
let connecting = null;

function hostnameFromHeader(value) {
    if (!value) {
        return '';
    }

    const raw = String(value).trim();
    try {
        const withProtocol = raw.includes('://') ? raw : `https://${raw}`;
        return new URL(withProtocol).hostname.toLowerCase();
    } catch (error) {
        return '';
    }
}

function dbNameForRequest(req) {
    const originHost = hostnameFromHeader(req.get('origin'));
    const refererHost = hostnameFromHeader(req.get('referer'));
    if (originHost === APP_HOST || refererHost === APP_HOST) {
        return appDbName();
    }
    return defaultDbName();
}

function mongoContext(req, res, next) {
    const dbName = dbNameForRequest(req);
    const origin = req.get('origin') || '-';
    const referer = req.get('referer') || '-';
    console.log(`[mongo] ${req.method} ${req.originalUrl} origin=${origin} referer=${referer} database=${dbName}`);
    requestStore.run({ dbName }, () => next());
}

function currentDbName() {
    return requestStore.getStore()?.dbName || defaultDbName();
}

async function getClient() {
    if (!process.env.MONGO_URL) {
        throw new Error('MONGO_URL is not configured');
    }

    if (!client) {
        client = new MongoClient(process.env.MONGO_URL);
    }

    if (!connecting) {
        connecting = client.connect().catch((error) => {
            connecting = null;
            client = null;
            throw error;
        });
    }

    await connecting;
    return client;
}

async function getDb() {
    const store = requestStore.getStore();
    const dbName = store?.dbName || defaultDbName();
    if (!store) {
        console.log(`[mongo] no request context, using database=${dbName}`);
    }
    const mongoClient = await getClient();
    return mongoClient.db(dbName);
}

module.exports = {
    mongoContext,
    getDb,
    currentDbName,
    dbNameForRequest
};
