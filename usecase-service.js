const { ObjectId } = require('mongodb');
const { getDb } = require('./mongo');

class UsecaseService {
    async getUsecaseById(usecaseId) {
        const db = await getDb();
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
