const { MongoClient, ObjectId } = require('mongodb');

class UsecaseService {
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

    async getUsecaseById(usecaseId) {
        const db = await this.connect();
        const collectionName = process.env.MONGO_USECASES_COLLECTION || 'usecases';
        const collection = db.collection(collectionName);
        const filters = [
            { _id: usecaseId },
            { id: usecaseId },
            { usecaseId },
            { key: usecaseId },
            { slug: usecaseId },
            { name: usecaseId }
        ];

        if (ObjectId.isValid(usecaseId)) {
            filters.push({ _id: new ObjectId(usecaseId) });
        }

        const usecase = await collection.findOne({ $or: filters });
        if (!usecase) {
            throw new Error(`Usecase not found in MongoDB: ${usecaseId}`);
        }

        return usecase;
    }
}

module.exports = new UsecaseService();
