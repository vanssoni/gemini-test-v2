const { MongoClient, ObjectId } = require('mongodb');

class GoldStandardService {
    constructor() {
        this.client = null;
        this.db = null;
    }

    async connect() {
        if (this.db) {
            return this.db;
        }

        if (!process.env.MONGO_URL) {
            throw new Error('MONGO_URL is not configured');
        }

        this.client = new MongoClient(process.env.MONGO_URL);
        await this.client.connect();
        this.db = this.client.db(process.env.MONGO_DB_NAME || undefined);
        return this.db;
    }

    collection() {
        const name = process.env.MONGO_GOLD_STANDARD_COLLECTION || 'goldStandardReports';
        return this.db.collection(name);
    }

    async listGoldStandards() {
        await this.connect();
        const docs = await this.collection()
            .find({}, { projection: { testsAndConditions: 0 } })
            .toArray();
        return docs.map((doc) => ({
            _id: String(doc._id),
            fileName: doc.fileName || null,
            filePath: doc.filePath || null
        }));
    }

    async getGoldStandardsByIds(ids) {
        await this.connect();
        if (!Array.isArray(ids) || ids.length === 0) {
            return [];
        }

        const orFilters = [];
        for (const id of ids) {
            orFilters.push({ _id: id });
            if (ObjectId.isValid(id)) {
                orFilters.push({ _id: new ObjectId(id) });
            }
        }

        const docs = await this.collection().find({ $or: orFilters }).toArray();
        const byId = new Map(docs.map((doc) => [String(doc._id), doc]));

        return ids
            .map((id) => byId.get(String(id)))
            .filter(Boolean)
            .map((doc) => ({
                _id: String(doc._id),
                fileName: doc.fileName || null,
                filePath: doc.filePath || null,
                testsAndConditions: doc.testsAndConditions ?? null
            }));
    }
}

module.exports = new GoldStandardService();
