const { MongoClient, ObjectId } = require('mongodb');

// Super-admin analysis only — NOT the production user profile.
// One document per clinician userId; shared across all super admins.
const ALLOWED_REFERENCE_RANGE_TYPES = ['standard', 'functional', 'pediatric', '', null];

class CreateReportAnalysisSettingsService {
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

    usersCollection() {
        const name = process.env.MONGO_USERS_COLLECTION || 'users';
        return this.db.collection(name);
    }

    // Separate model from users / userprescriptions.
    analysisCollection() {
        const name = process.env.MONGO_CREATE_REPORT_ANALYSIS_COLLECTION || 'createReportAnalysisSettings';
        return this.db.collection(name);
    }

    toObjectId(userId) {
        if (!userId || !ObjectId.isValid(String(userId))) {
            throw new Error('userId must be a valid MongoDB ObjectId');
        }
        return new ObjectId(String(userId));
    }

    normalizeReferenceRangesType(value) {
        if (value === undefined) {
            return undefined;
        }
        if (!ALLOWED_REFERENCE_RANGE_TYPES.includes(value)) {
            throw new Error(
                'createReportReferenceRangesType must be "standard", "functional", "pediatric", or empty'
            );
        }
        return value === '' ? null : value;
    }

    normalizeInstructions(value) {
        if (value === undefined) {
            return undefined;
        }
        if (value === null) {
            return null;
        }
        const trimmed = String(value).trim();
        return trimmed === '' ? null : trimmed;
    }

    normalizePrescriptions(value) {
        if (value === undefined) {
            return undefined;
        }
        if (value === null) {
            return [];
        }
        if (!Array.isArray(value)) {
            throw new Error('prescriptions must be an array of strings');
        }

        const seen = new Set();
        const cleaned = [];
        for (const item of value) {
            const text = String(item || '').trim();
            if (!text) continue;
            const key = text.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            cleaned.push(text);
        }
        return cleaned;
    }

    emptyAnalysisDoc(userId) {
        return {
            userId: String(userId),
            customCreateReportInstructions: null,
            createReportReferenceRangesType: null,
            createReportVersion: null,
            prescriptions: [],
            updatedAt: null,
            createdAt: null
        };
    }

    serializeSettings(user, analysisDoc) {
        const analysis = analysisDoc || this.emptyAnalysisDoc(user._id);
        return {
            userId: String(user._id),
            name: user.name || null,
            email: user.email || null,
            specialization: user.specialization || null,
            organizationId: user.organizationId ? String(user.organizationId) : null,
            // Analysis overrides (this collection only — never users.*)
            customCreateReportInstructions: analysis.customCreateReportInstructions ?? null,
            createReportReferenceRangesType: analysis.createReportReferenceRangesType ?? null,
            createReportVersion: analysis.createReportVersion ?? null,
            prescriptions: Array.isArray(analysis.prescriptions) ? analysis.prescriptions : [],
            analysisRecordId: analysis._id ? String(analysis._id) : null,
            updatedAt: analysis.updatedAt || null,
            createdAt: analysis.createdAt || null
        };
    }

    async findUser(userId) {
        await this.connect();
        const _id = this.toObjectId(userId);
        const user = await this.usersCollection().findOne({ _id, deletedAt: null });
        if (!user) {
            throw new Error(`User not found: ${userId}`);
        }
        return user;
    }

    async findAnalysisDoc(userId) {
        await this.connect();
        const _id = this.toObjectId(userId);
        return this.analysisCollection().findOne({ userId: _id });
    }

    async getSettings(userId) {
        const user = await this.findUser(userId);
        const analysisDoc = await this.findAnalysisDoc(userId);
        return this.serializeSettings(user, analysisDoc);
    }

    // Prompt placeholders when create-report is called with userId.
    async getCreateReportOptions(userId) {
        const settings = await this.getSettings(userId);
        return {
            customInstructions: settings.customCreateReportInstructions || '',
            referenceRanges: settings.createReportReferenceRangesType || '',
            clinicianSpeciality: settings.specialization || '',
            prescriptions: settings.prescriptions || []
        };
    }

    async saveSettings(userId, payload = {}) {
        const user = await this.findUser(userId);
        const userObjectId = user._id;

        const $set = { updatedAt: new Date() };
        let touched = false;

        const instructions = this.normalizeInstructions(payload.customCreateReportInstructions);
        if (instructions !== undefined) {
            $set.customCreateReportInstructions = instructions;
            touched = true;
        }

        const referenceRanges = this.normalizeReferenceRangesType(
            payload.createReportReferenceRangesType
        );
        if (referenceRanges !== undefined) {
            $set.createReportReferenceRangesType = referenceRanges;
            touched = true;
        }

        if (payload.createReportVersion !== undefined) {
            const version = payload.createReportVersion;
            if (version !== null && version !== '' && version !== 'v1' && version !== 'v2') {
                throw new Error('createReportVersion must be "v1", "v2", null, or empty');
            }
            $set.createReportVersion = version === '' ? null : version;
            touched = true;
        }

        const prescriptions = this.normalizePrescriptions(payload.prescriptions);
        if (prescriptions !== undefined) {
            $set.prescriptions = prescriptions;
            touched = true;
        }

        if (!touched) {
            throw new Error(
                'Nothing to update. Send at least one of: customCreateReportInstructions, createReportReferenceRangesType, prescriptions, createReportVersion'
            );
        }

        await this.analysisCollection().updateOne(
            { userId: userObjectId },
            {
                $set,
                $setOnInsert: {
                    userId: userObjectId,
                    createdAt: new Date()
                }
            },
            { upsert: true }
        );

        return this.getSettings(userId);
    }
}

module.exports = new CreateReportAnalysisSettingsService();
