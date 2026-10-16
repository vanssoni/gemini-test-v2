const { ObjectId } = require('mongodb');
const { getDb } = require('./mongo');

class GoldStandardService {
    async collection() {
        const db = await getDb();
        const name = process.env.MONGO_GOLD_STANDARD_COLLECTION || 'goldStandardReports';
        return db.collection(name);
    }

    async listGoldStandards() {
        const docs = await (await this.collection())
            .find({}, { projection: { testsAndConditions: 0 } })
            .toArray();
        return docs.map((doc) => ({
            _id: String(doc._id),
            fileName: doc.fileName || null,
            filePath: doc.filePath || null
        }));
    }

    async getGoldStandardsByIds(ids) {
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

        const docs = await (await this.collection()).find({ $or: orFilters }).toArray();
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
