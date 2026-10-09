const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');
const fetch = require('node-fetch');

// Mirrors onehealth generate.service.reprocessRecordingSession:
// load transcriptchunks for a recordingSessionId, order by mic→chunkIndex,
// download each audioUrl, then the caller runs the same create-report pipeline.

class RecordingSessionService {
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

    chunksCollection() {
        const name = process.env.MONGO_TRANSCRIPT_CHUNKS_COLLECTION || 'transcriptchunks';
        return this.db.collection(name);
    }

    reportTypesCollection() {
        const name = process.env.MONGO_USER_REPORT_TYPES_COLLECTION || 'userreporttypes';
        return this.db.collection(name);
    }

    usersCollection() {
        const name = process.env.MONGO_USERS_COLLECTION || 'users';
        return this.db.collection(name);
    }

    prescriptionsCollection() {
        const name = process.env.MONGO_USER_PRESCRIPTIONS_COLLECTION || 'userprescriptions';
        return this.db.collection(name);
    }

    toObjectId(userId) {
        if (!userId || !ObjectId.isValid(String(userId))) {
            throw new Error('userId must be a valid MongoDB ObjectId');
        }
        return new ObjectId(String(userId));
    }

    // Same ordering as onehealth generate.service._orderChunksByMicThenIndex:
    // group by mic sessionId, sort chunks by chunkIndex, then order mic cycles
    // by the earliest chunk createdAt.
    orderChunksByMicThenIndex(chunks) {
        const bySession = new Map();
        for (const row of chunks) {
            if (!bySession.has(row.sessionId)) bySession.set(row.sessionId, []);
            bySession.get(row.sessionId).push(row);
        }

        return [...bySession.entries()]
            .map(([sessionId, rows]) => {
                const sorted = [...rows].sort(
                    (a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0)
                );
                const firstAt = Math.min(
                    ...sorted.map((r) => new Date(r.createdAt || 0).getTime())
                );
                return {
                    sessionId,
                    chunks: sorted,
                    firstAt: Number.isFinite(firstAt) ? firstAt : 0
                };
            })
            .sort((a, b) => a.firstAt - b.firstAt)
            .flatMap((s) => s.chunks);
    }

    async findAudioChunks(recordingSessionId) {
        await this.connect();
        const id = String(recordingSessionId || '').trim();
        if (!id) {
            throw new Error('recordingSessionId is required');
        }

        const raw = await this.chunksCollection()
            .find({
                recordingSessionId: id,
                logType: 'chunk',
                chunkIndex: { $gte: 0 },
                audioUrl: { $exists: true, $nin: [null, ''] }
            })
            .sort({ createdAt: 1, chunkIndex: 1 })
            .toArray();

        return this.orderChunksByMicThenIndex(raw);
    }

    resolveReportType(orderedChunks, override = '') {
        if (override && String(override).trim()) {
            return String(override).trim();
        }
        return (
            [...orderedChunks].reverse().find((c) => c.payload?.reportType)?.payload?.reportType ||
            orderedChunks.find((c) => c.payload?.reportType)?.payload?.reportType ||
            ''
        );
    }

    resolveExistingText(orderedChunks, override) {
        if (override !== undefined && override !== null) {
            return String(override);
        }
        const first = orderedChunks[0];
        const fromPayload = first?.payload?.existingText;
        if (fromPayload === undefined || fromPayload === null) {
            return '';
        }
        return String(fromPayload);
    }

    async findReportStructure(userId, reportTypeName) {
        if (!userId || !reportTypeName) {
            return null;
        }

        await this.connect();
        const _id = this.toObjectId(userId);
        const doc = await this.reportTypesCollection().findOne({
            userId: _id,
            name: String(reportTypeName)
        });

        const structure = (doc?.structure || '').toString().trim();
        return structure || null;
    }

    // Production create-report path: live user profile + prescriptions.
    // Used as fallback when analysis settings are empty.
    async getLiveUserCreateReportOptions(userId) {
        await this.connect();
        const _id = this.toObjectId(userId);
        const user = await this.usersCollection().findOne({ _id, deletedAt: null });
        if (!user) {
            throw new Error(`User not found: ${userId}`);
        }

        const prescriptionDoc = await this.prescriptionsCollection().findOne({ userId: _id });

        return {
            userId: String(user._id),
            name: user.name || null,
            email: user.email || null,
            clinicianSpeciality: user.specialization || '',
            customInstructions: user.customCreateReportInstructions || '',
            referenceRanges: user.createReportReferenceRangesType || '',
            prescriptions: Array.isArray(prescriptionDoc?.prescriptions)
                ? prescriptionDoc.prescriptions
                : []
        };
    }

    extensionFromAudioUrl(audioUrl, fallback = 'wav') {
        try {
            const pathname = new URL(audioUrl).pathname;
            const ext = path.extname(pathname).replace(/^\./, '').toLowerCase();
            if (ext) return ext;
        } catch (_) {
            // ignore bad URLs — caller still gets a fallback name
        }
        return fallback;
    }

    async downloadAudioBuffer(audioUrl) {
        const response = await fetch(audioUrl, { timeout: 180000 });
        if (!response.ok) {
            throw new Error(`Failed to download audio (${response.status}): ${audioUrl}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }

    // Preview / form prefill — no audio download.
    async getSessionMeta(recordingSessionId) {
        const ordered = await this.findAudioChunks(recordingSessionId);
        if (!ordered.length) {
            throw new Error('No audio found for this recording session');
        }

        const userId = String(ordered[0].userId);
        const reportType = this.resolveReportType(ordered);
        const existingText = this.resolveExistingText(ordered);
        const reportStructure = await this.findReportStructure(userId, reportType);

        const micSessions = [...new Set(ordered.map((c) => c.sessionId))];
        const chunks = ordered.map((c, index) => ({
            orderIndex: index,
            sessionId: c.sessionId,
            chunkIndex: c.chunkIndex,
            audioUrl: c.audioUrl,
            isLast: !!c.isLast,
            hasOverlap: c.payload?.hasOverlap === true,
            reportType: c.payload?.reportType || '',
            createdAt: c.createdAt || null
        }));

        return {
            recordingSessionId: String(recordingSessionId).trim(),
            userId,
            organizationId: ordered[0].organizationId
                ? String(ordered[0].organizationId)
                : null,
            patientId: ordered[0].patientId || null,
            reportType,
            existingText,
            reportStructure,
            micSessionCount: micSessions.length,
            chunkCount: ordered.length,
            chunks
        };
    }

    // Downloads every chunk into multer-shaped file objects so createReportFromAudio
    // can treat them exactly like an upload.
    async loadSessionAudioFiles(recordingSessionId) {
        const ordered = await this.findAudioChunks(recordingSessionId);
        if (!ordered.length) {
            throw new Error('No audio found for this recording session');
        }

        const files = [];
        const failed = [];

        // Mic cycle number for stable filenames (same idea as chunk-inspector export).
        const micOrder = new Map();
        for (const chunk of ordered) {
            if (!micOrder.has(chunk.sessionId)) {
                micOrder.set(chunk.sessionId, micOrder.size + 1);
            }
        }

        const settled = await Promise.all(
            ordered.map(async (chunk, orderIndex) => {
                const mic = micOrder.get(chunk.sessionId);
                const ext = this.extensionFromAudioUrl(chunk.audioUrl);
                const originalname = `mic-${String(mic).padStart(2, '0')}_chunk-${String(chunk.chunkIndex).padStart(3, '0')}.${ext}`;
                const key = `${chunk.sessionId}:${chunk.chunkIndex}`;

                try {
                    const buffer = await this.downloadAudioBuffer(chunk.audioUrl);
                    const mime = ext === 'webm'
                        ? 'audio/webm'
                        : ext === 'mp3'
                            ? 'audio/mpeg'
                            : ext === 'm4a' || ext === 'mp4'
                                ? 'audio/mp4'
                                : 'audio/wav';

                    return {
                        orderIndex,
                        ok: true,
                        file: {
                            fieldname: 'audio',
                            originalname,
                            encoding: '7bit',
                            mimetype: mime,
                            buffer,
                            size: buffer.length
                        },
                        meta: {
                            key,
                            sessionId: chunk.sessionId,
                            chunkIndex: chunk.chunkIndex,
                            audioUrl: chunk.audioUrl,
                            originalname
                        }
                    };
                } catch (error) {
                    return {
                        orderIndex,
                        ok: false,
                        error: error.message,
                        meta: {
                            key,
                            sessionId: chunk.sessionId,
                            chunkIndex: chunk.chunkIndex,
                            audioUrl: chunk.audioUrl,
                            originalname
                        }
                    };
                }
            })
        );

        settled
            .sort((a, b) => a.orderIndex - b.orderIndex)
            .forEach((row) => {
                if (row.ok) {
                    files.push(row.file);
                } else {
                    failed.push({ ...row.meta, error: row.error });
                }
            });

        if (!files.length) {
            throw new Error('Failed to download every audio chunk for this recording session');
        }

        return {
            files,
            failed,
            isPartial: failed.length > 0,
            orderedCount: ordered.length
        };
    }
}

module.exports = new RecordingSessionService();
