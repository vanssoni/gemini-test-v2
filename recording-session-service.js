const { ObjectId } = require('mongodb');
const path = require('path');
const fetch = require('node-fetch');
const { getDb } = require('./mongo');

// Mirrors onehealth generate.service.reprocessRecordingSession:
// load transcriptchunks for a recordingSessionId, order by mic→chunkIndex,
// download each audioUrl, then the caller runs the same create-report pipeline.

class RecordingSessionService {
    async chunksCollection() {
        const db = await getDb();
        const name = process.env.MONGO_TRANSCRIPT_CHUNKS_COLLECTION || 'transcriptchunks';
        return db.collection(name);
    }

    async reportTypesCollection() {
        const db = await getDb();
        const name = process.env.MONGO_USER_REPORT_TYPES_COLLECTION || 'userreporttypes';
        return db.collection(name);
    }

    async usersCollection() {
        const db = await getDb();
        const name = process.env.MONGO_USERS_COLLECTION || 'users';
        return db.collection(name);
    }

    async prescriptionsCollection() {
        const db = await getDb();
        const name = process.env.MONGO_USER_PRESCRIPTIONS_COLLECTION || 'userprescriptions';
        return db.collection(name);
    }

    async organizationsCollection() {
        const db = await getDb();
        const name = process.env.MONGO_ORGANIZATIONS_COLLECTION || 'organizations';
        return db.collection(name);
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
        const id = String(recordingSessionId || '').trim();
        if (!id) {
            throw new Error('recordingSessionId is required');
        }

        const raw = await (await this.chunksCollection())
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

    // One recordingSessionId can have many chunk rows. The template is the
    // newest row (createdAt desc) whose payload.reportType is not null/blank.
    async findLatestReportType(recordingSessionId) {
        const id = String(recordingSessionId || '').trim();
        if (!id) {
            return { reportType: '', userId: null, createdAt: null };
        }

        const doc = await (await this.chunksCollection())
            .find({
                recordingSessionId: id,
                'payload.reportType': { $exists: true, $type: 'string', $nin: [null, ''] }
            })
            .sort({ createdAt: -1 })
            .limit(1)
            .next();

        const reportType = (doc?.payload?.reportType || '').toString().trim();
        return {
            reportType,
            userId: doc?.userId ? String(doc.userId) : null,
            createdAt: doc?.createdAt || null
        };
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

        const _id = this.toObjectId(userId);
        const doc = await (await this.reportTypesCollection()).findOne({
            userId: _id,
            name: String(reportTypeName)
        });

        const structure = (doc?.structure || '').toString().trim();
        return structure || null;
    }

    // Same sources as onehealth executeCreateReportAi:
    // users.customCreateReportInstructions, users.createReportReferenceRangesType,
    // users.specialization, and userprescriptions.prescriptions.
    async getLiveUserCreateReportOptions(userId) {
        const _id = this.toObjectId(userId);
        const user = await (await this.usersCollection()).findOne({ _id, deletedAt: null });
        if (!user) {
            throw new Error(`User not found: ${userId}`);
        }

        const prescriptionDoc = await (await this.prescriptionsCollection()).findOne({ userId: _id });

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

    // Same text as GET /api/admin/transcript-chunks → chunks[].text:
    // the latest finalize row's AI report for this recordingSessionId.
    async getOriginalOutput(recordingSessionId) {
        const id = String(recordingSessionId || '').trim();
        if (!id) return '';

        const doc = await (await this.chunksCollection())
            .find({
                recordingSessionId: id,
                logType: 'finalize',
                text: { $exists: true, $nin: [null, ''] }
            })
            .sort({ createdAt: -1 })
            .limit(1)
            .next();

        return (doc?.text || '').toString();
    }

    // Preview / form prefill — no audio download.
    async getSessionMeta(recordingSessionId) {
        const ordered = await this.findAudioChunks(recordingSessionId);
        if (!ordered.length) {
            throw new Error('No audio found for this recording session');
        }

        const latestTemplate = await this.findLatestReportType(recordingSessionId);
        const userId = latestTemplate.userId || String(ordered[0].userId);
        const reportType = latestTemplate.reportType;
        const existingText = this.resolveExistingText(ordered);
        const reportStructure = await this.findReportStructure(userId, reportType);
        const originalOutput = await this.getOriginalOutput(recordingSessionId);

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
            reportTypeCreatedAt: latestTemplate.createdAt,
            existingText,
            reportStructure,
            originalOutput,
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

    istString(date) {
        if (!date) return null;
        return new Date(date).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });
    }

    // Audio chunks only, grouped into mic cycles. No finalize rows or health checks.
    async getChunkInspectorDetail(recordingSessionId) {
        const id = String(recordingSessionId || '').trim();
        const docs = await (await this.chunksCollection())
            .find({ recordingSessionId: id })
            .sort({ createdAt: 1, chunkIndex: 1 })
            .toArray();

        if (!docs.length) {
            return {
                user: null,
                userName: null,
                organization: null,
                organizationName: null,
                micSessions: []
            };
        }

        const userId = docs[0].userId;
        const user = userId
            ? await (await this.usersCollection()).findOne(
                { _id: userId },
                { projection: { name: 1, email: 1 } }
            )
            : null;
        const organizationId = docs.find((d) => d.organizationId)?.organizationId || null;
        const org = organizationId
            ? await (await this.organizationsCollection()).findOne(
                { _id: organizationId },
                { projection: { organizationName: 1 } }
            )
            : null;

        const audioDocs = docs.filter((doc) => (doc.logType || 'chunk') === 'chunk' && doc.audioUrl);
        const bySession = new Map();
        for (const doc of audioDocs) {
            if (!bySession.has(doc.sessionId)) bySession.set(doc.sessionId, []);
            bySession.get(doc.sessionId).push(doc);
        }

        const micSessions = [...bySession.entries()]
            .map(([sessionId, rows]) => {
                const chunks = [...rows].sort((a, b) => {
                    const byIndex = (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0);
                    return byIndex !== 0 ? byIndex : new Date(a.createdAt) - new Date(b.createdAt);
                });
                const firstAt = chunks[0]?.createdAt || null;
                const lastAt = chunks[chunks.length - 1]?.createdAt || null;
                return {
                    sessionId,
                    firstReceivedAt: firstAt,
                    firstAt: this.istString(firstAt),
                    lastAt: this.istString(lastAt),
                    chunks: chunks.map((doc) => ({
                        chunkIndex: doc.chunkIndex,
                        audioUrl: doc.audioUrl,
                        createdAt: doc.createdAt || null,
                        at: this.istString(doc.createdAt)
                    }))
                };
            })
            .sort((a, b) => new Date(a.firstReceivedAt) - new Date(b.firstReceivedAt))
            .map((mic, index) => ({
                mic: index + 1,
                sessionId: mic.sessionId,
                firstAt: mic.firstAt,
                lastAt: mic.lastAt,
                chunks: mic.chunks
            }));

        const firstAudio = audioDocs
            .slice()
            .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
        const lastAudio = audioDocs
            .slice()
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

        return {
            user: user
                ? { name: user.name || 'Unknown', email: user.email || '' }
                : null,
            userName: user?.name || null,
            organization: org?.organizationName || null,
            organizationName: org?.organizationName || null,
            firstAt: this.istString(firstAudio?.createdAt),
            lastAt: this.istString(lastAudio?.createdAt),
            micSessions
        };
    }
}

module.exports = new RecordingSessionService();
