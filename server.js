require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const geminiHelper = require('./gemini-helper');
const textractHelper = require('./textract-helper');
const extractorHelper = require('./extractor-helper');
const interpreterHelper = require('./interpreter-helper');
const comparisonHelper = require('./comparison-helper');
const generateService = require('./generate-service');
const { v4: uuidv4 } = require('uuid');
const AWS = require('aws-sdk');

const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION
});

async function uploadReportToS3(file, jobId) {
    const bucket = process.env.AWS_REPORT_BUCKET;
    if (!bucket) {
        throw new Error('AWS_REPORT_BUCKET is not configured');
    }

    const reportName = `${jobId}-${file.originalname}`;
    const key = `reports/${reportName}`;

    await s3.putObject({
        Bucket: bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype
    }).promise();

    const region = process.env.AWS_REGION;
    const reportLink = `https://${bucket}.s3.${region}.amazonaws.com/${encodeURI(key)}`;

    return { reportName, reportLink, reportKey: key };
}

async function deleteReportFromS3(key) {
    if (!key || !process.env.AWS_REPORT_BUCKET) {
        return;
    }

    try {
        await s3.deleteObject({
            Bucket: process.env.AWS_REPORT_BUCKET,
            Key: key
        }).promise();
    } catch (error) {
        console.warn('Failed to delete report from S3:', error.message);
    }
}

const app = express();
const PORT = process.env.PORT || 3000;
const REPORT_JOB_TTL_MS = 60 * 60 * 1000;
const reportJobs = new Map();

// Middleware
// CORS is handled by Nginx - do not enable here to avoid duplicate headers
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(express.static('public'));

// Configure multer for file uploads (store in memory)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB limit
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only PDF and image files are allowed'));
        }
    }
});
const uploadDocument = upload.fields([
    { name: 'pdf', maxCount: 1 },
    { name: 'file', maxCount: 1 },
    { name: 'image', maxCount: 1 }
]);

function getUploadedFile(req) {
    const file = req.file ||
        req.files?.pdf?.[0] ||
        req.files?.file?.[0] ||
        req.files?.image?.[0];

    if (!file) {
        throw new Error('No PDF or image file uploaded');
    }

    return file;
}

function cleanupExpiredJobs() {
    const cutoff = Date.now() - REPORT_JOB_TTL_MS;

    for (const [jobId, job] of reportJobs.entries()) {
        if ((job.updatedAt || job.createdAt) < cutoff) {
            reportJobs.delete(jobId);
        }
    }
}

function deleteJob(jobId) {
    if (!jobId) {
        return false;
    }

    const job = reportJobs.get(jobId);
    const deleted = reportJobs.delete(jobId);
    if (job) {
        deleteReportFromS3(job.reportKey);
    }

    return deleted;
}

function createInitialPathwayState(label) {
    return {
        label,
        status: 'pending',
        startedAt: null,
        completedAt: null,
        time: null,
        accuracy: null,
        accuracyStatus: 'pending',
        data: null,
        error: null
    };
}

function serializeJob(job) {
    return {
        jobId: job.jobId,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        fileName: job.fileName,
        fileType: job.fileType,
        reportName: job.reportName || null,
        reportLink: job.reportLink || null,
        pathways: job.pathways
    };
}

function getCompareValue(service, data) {
    if (!data) {
        return null;
    }

    if (service === 'aws') {
        return data.interpretationOutput ?? data.output ?? data.interpretationRawOutput ?? null;
    }

    if (service === 'geminiOpenAi') {
        return data.extractorOutput ?? data.geminiOutput ?? data.output ?? null;
    }

    return data.output ?? data.rawOutput ?? null;
}

async function updateAccuracyForCompletedPathways(job) {
    const pdfText = job.pathways.aws.data?.pdfText;

    if (!pdfText) {
        for (const pathway of Object.values(job.pathways)) {
            if (pathway.status === 'success' && pathway.accuracy === null) {
                pathway.accuracyStatus = 'pending';
            }
        }
        return;
    }

    await Promise.all(Object.entries(job.pathways).map(async ([service, pathway]) => {
        if (pathway.status !== 'success' || pathway.accuracy !== null) {
            return;
        }

        const output2 = getCompareValue(service, pathway.data);
        if (!output2) {
            pathway.accuracyStatus = 'error';
            return;
        }

        try {
            const result = await comparisonHelper.compareMedicalOutputs(pdfText, output2);
            pathway.accuracy = result?.accuracy ?? null;
            pathway.accuracyStatus = pathway.accuracy === null ? 'error' : 'success';
        } catch (error) {
            console.error(`${service} compare error:`, error);
            pathway.accuracyStatus = 'error';
        } finally {
            job.updatedAt = Date.now();
        }
    }));
}

async function runPathwayJob(job, service, processor) {
    const pathway = job.pathways[service];
    pathway.status = 'running';
    pathway.startedAt = Date.now();
    pathway.error = null;
    job.updatedAt = Date.now();

    try {
        const data = await processor();
        pathway.status = data.success === false ? 'error' : 'success';
        pathway.completedAt = Date.now();
        pathway.time = data.time ?? (pathway.completedAt - pathway.startedAt);
        pathway.data = data;
        pathway.error = data.error || null;
    } catch (error) {
        console.error(`${service} job error:`, error);
        pathway.status = 'error';
        pathway.completedAt = Date.now();
        pathway.time = pathway.completedAt - pathway.startedAt;
        pathway.data = null;
        pathway.error = error.message;
    } finally {
        job.updatedAt = Date.now();
        await updateAccuracyForCompletedPathways(job);
    }
}

async function processReportJob(job, file) {
    job.status = 'running';
    job.updatedAt = Date.now();

    await Promise.all([
        runPathwayJob(job, 'aws', async () => {
            const startTime = Date.now();
            let extractedText = '';
            let extractorResponse = null;
            let interpretationResponse = null;
            let output = null;

            try {
                extractedText = await textractHelper.extractText(file.buffer, file.originalname, file.mimetype);
                extractorResponse = await generateService.processExtractorAi(extractedText);
                interpretationResponse = await generateService.processInterpretationAi(extractorResponse);
                output = generateService.cleanResponse(interpretationResponse);

                return {
                    success: true,
                    service: 'aws',
                    pdfText: extractedText,
                    input: extractedText,
                    extractorOutput: extractorResponse,
                    interpretationOutput: output,
                    output,
                    time: Date.now() - startTime,
                    error: null
                };
            } catch (error) {
                return {
                    success: false,
                    service: 'aws',
                    pdfText: extractedText,
                    input: extractedText,
                    extractorOutput: extractorResponse,
                    interpretationRawOutput: interpretationResponse,
                    interpretationOutput: output,
                    output,
                    time: Date.now() - startTime,
                    error: error.message
                };
            }
        }),
        runPathwayJob(job, 'geminiOpenAi', async () => {
            const startTime = Date.now();
            let extractionResponse = null;
            let interpretationResponse = null;
            let output = null;

            try {
                extractionResponse = await generateService.processGeminiExtractionAi(file.buffer);
                interpretationResponse = await generateService.processInterpretationAi(extractionResponse);
                output = generateService.cleanResponse(interpretationResponse);

                return {
                    success: true,
                    service: 'gemini_openai',
                    extractorOutput: extractionResponse,
                    geminiOutput: output,
                    output,
                    time: Date.now() - startTime,
                    error: null
                };
            } catch (error) {
                return {
                    success: false,
                    service: 'gemini_openai',
                    extractorOutput: extractionResponse,
                    geminiRawOutput: interpretationResponse,
                    geminiOutput: output,
                    output,
                    time: Date.now() - startTime,
                    error: error.message
                };
            }
        }),
        runPathwayJob(job, 'gemini', async () => {
            const startTime = Date.now();
            let response = null;
            let output = null;

            try {
                response = await generateService.processOneShotGeminiAi(file.buffer);
                output = generateService.cleanResponse(response);

                return {
                    success: true,
                    service: 'gemini',
                    rawOutput: response,
                    output,
                    time: Date.now() - startTime,
                    error: null
                };
            } catch (error) {
                return {
                    success: false,
                    service: 'gemini',
                    rawOutput: response,
                    output,
                    time: Date.now() - startTime,
                    error: error.message
                };
            }
        }),
        runPathwayJob(job, 'openai', async () => {
            const startTime = Date.now();
            let response = null;
            let output = null;

            try {
                response = await generateService.processOneShotOpenAi(file.buffer);
                output = generateService.cleanResponse(response);

                return {
                    success: true,
                    service: 'openai',
                    rawOutput: response,
                    output,
                    time: Date.now() - startTime,
                    error: null
                };
            } catch (error) {
                return {
                    success: false,
                    service: 'openai',
                    rawOutput: response,
                    output,
                    time: Date.now() - startTime,
                    error: error.message
                };
            }
        })
    ]);

    const statuses = Object.values(job.pathways).map((pathway) => pathway.status);
    job.status = statuses.every((status) => status === 'error') ? 'error' : 'completed';
    job.updatedAt = Date.now();
}

function createReportJob(file, reportUpload, jobId = uuidv4()) {
    cleanupExpiredJobs();

    const job = {
        jobId,
        status: 'queued',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        fileName: file.originalname,
        fileType: file.mimetype,
        reportName: reportUpload?.reportName || null,
        reportLink: reportUpload?.reportLink || null,
        reportKey: reportUpload?.reportKey || null,
        pathways: {
            aws: createInitialPathwayState('AWS'),
            geminiOpenAi: createInitialPathwayState('Gemini + OpenAI'),
            gemini: createInitialPathwayState('Gemini'),
            openai: createInitialPathwayState('OpenAI')
        }
    };

    reportJobs.set(job.jobId, job);
    processReportJob(job, file).catch((error) => {
        console.error('Background report job error:', error);
        job.status = 'error';
        job.updatedAt = Date.now();
    });

    return job;
}

app.post('/api/reports', uploadDocument, async (req, res) => {
    try {
        const file = getUploadedFile(req);
        const previousJobId = req.body?.previousJobId;

        cleanupExpiredJobs();
        deleteJob(previousJobId);

        const jobId = uuidv4();
        const reportUpload = await uploadReportToS3(file, jobId);
        const job = createReportJob(file, reportUpload, jobId);

        res.status(202).json({
            success: true,
            job: serializeJob(job)
        });
    } catch (error) {
        console.error('report job create error:', error);
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
});

app.get('/api/reports/:jobId', (req, res) => {
    cleanupExpiredJobs();

    const job = reportJobs.get(req.params.jobId);
    if (!job) {
        return res.status(404).json({
            success: false,
            error: 'Report job not found or expired'
        });
    }

    res.json({
        success: true,
        job: serializeJob(job)
    });
});

app.delete('/api/reports/:jobId', (req, res) => {
    cleanupExpiredJobs();

    res.json({
        success: deleteJob(req.params.jobId)
    });
});

app.post('/api/aws', uploadDocument, async (req, res) => {
    const startTime = Date.now();
    let extractedText = '';
    let extractorResponse = null;
    let interpretationResponse = null;
    let output = null;

    try {
        const file = getUploadedFile(req);
        extractedText = await textractHelper.extractText(file.buffer, file.originalname, file.mimetype);
        extractorResponse = await generateService.processExtractorAi(extractedText);
        interpretationResponse = await generateService.processInterpretationAi(extractorResponse);
        output = generateService.cleanResponse(interpretationResponse);

        res.json({
            success: true,
            service: 'aws',
            pdfText: extractedText,
            input: extractedText,
            extractorOutput: extractorResponse,
            interpretationOutput: output,
            output,
            time: Date.now() - startTime,
            error: null
        });
    } catch (error) {
        console.error('aws error:', error);
        res.json({
            success: false,
            service: 'aws',
            pdfText: extractedText,
            input: extractedText,
            extractorOutput: extractorResponse,
            interpretationRawOutput: interpretationResponse,
            interpretationOutput: output,
            output,
            time: Date.now() - startTime,
            error: error.message
        });
    }
});

app.post('/api/gemini_openai', uploadDocument, async (req, res) => {
    const startTime = Date.now();
    let extractionResponse = null;
    let interpretationResponse = null;
    let output = null;

    try {
        const file = getUploadedFile(req);
        extractionResponse = await generateService.processGeminiExtractionAi(file.buffer);
        interpretationResponse = await generateService.processInterpretationAi(extractionResponse);
        output = generateService.cleanResponse(interpretationResponse);

        res.json({
            success: true,
            service: 'gemini_openai',
            extractorOutput: extractionResponse,
            geminiOutput: output,
            output,
            time: Date.now() - startTime,
            error: null
        });
    } catch (error) {
        console.error('gemini_openai error:', error);
        res.json({
            success: false,
            service: 'gemini_openai',
            extractorOutput: extractionResponse,
            geminiRawOutput: interpretationResponse,
            geminiOutput: output,
            output,
            time: Date.now() - startTime,
            error: error.message
        });
    }
});

app.post('/api/gemini', uploadDocument, async (req, res) => {
    const startTime = Date.now();
    let response = null;
    let output = null;

    try {
        const file = getUploadedFile(req);
        response = await generateService.processOneShotGeminiAi(file.buffer);
        output = generateService.cleanResponse(response);

        res.json({
            success: true,
            service: 'gemini',
            rawOutput: response,
            output,
            time: Date.now() - startTime,
            error: null
        });
    } catch (error) {
        console.error('gemini error:', error);
        res.json({
            success: false,
            service: 'gemini',
            rawOutput: response,
            output,
            time: Date.now() - startTime,
            error: error.message
        });
    }
});

app.post('/api/openai', uploadDocument, async (req, res) => {
    const startTime = Date.now();
    let response = null;
    let output = null;

    try {
        const file = getUploadedFile(req);
        response = await generateService.processOneShotOpenAi(file.buffer);
        output = generateService.cleanResponse(response);

        res.json({
            success: true,
            service: 'openai',
            rawOutput: response,
            output,
            time: Date.now() - startTime,
            error: null
        });
    } catch (error) {
        console.error('openai error:', error);
        res.json({
            success: false,
            service: 'openai',
            rawOutput: response,
            output,
            time: Date.now() - startTime,
            error: error.message
        });
    }
});

// Upload and process with Gemini endpoint
app.post('/api/extract/gemini', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No PDF file uploaded' });
        }

        const fileBuffer = req.file.buffer;
        const customPrompt = req.body.prompt;
        const startTime = Date.now();

        try {
            const result = await geminiHelper.extractTextFromPDF(fileBuffer, customPrompt);
            const time = Date.now() - startTime;

            res.json({
                success: !result.error,
                service: 'gemini',
                text: result.text || '',
                images: result.images || [],
                time,
                error: result.error
            });
        } catch (error) {
            console.error('Gemini error:', error);
            res.json({
                success: false,
                service: 'gemini',
                text: '',
                images: [],
                time: Date.now() - startTime,
                error: error.message
            });
        }
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({
            success: false,
            service: 'gemini',
            error: error.message
        });
    }
});

// Upload and process with Textract endpoint (Textract only)
app.post('/api/extract/textract', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No PDF file uploaded' });
        }

        const fileBuffer = req.file.buffer;
        const startTime = Date.now();

        try {
            const text = await textractHelper.extractText(fileBuffer, req.file.originalname, req.file.mimetype);
            const time = Date.now() - startTime;

            res.json({
                success: true,
                service: 'textract',
                text,
                time,
                error: null
            });
        } catch (error) {
            console.error('Textract error:', error);
            res.json({
                success: false,
                service: 'textract',
                text: '',
                time: Date.now() - startTime,
                error: error.message
            });
        }
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({
            success: false,
            service: 'textract',
            error: error.message
        });
    }
});

// Extractor AI endpoint (takes text input)
app.post('/api/extract/extractor', async (req, res) => {
    try {
        const { text } = req.body;

        if (!text || text.trim().length === 0) {
            return res.status(400).json({ error: 'No text provided' });
        }

        const startTime = Date.now();

        try {
            const result = await extractorHelper.processExtractorAi(text);
            res.json({
                success: true,
                service: 'extractor',
                text: result.text,
                time: result.time,
                error: null
            });
        } catch (error) {
            console.error('Extractor error:', error);
            res.json({
                success: false,
                service: 'extractor',
                text: '',
                time: error.time || (Date.now() - startTime),
                error: error.error || error.message
            });
        }
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({
            success: false,
            service: 'extractor',
            error: error.message
        });
    }
});

// Interpretation AI endpoint (takes JSON text input)
app.post('/api/interpret', async (req, res) => {
    try {
        const { text } = req.body;

        if (!text || text.trim().length === 0) {
            return res.status(400).json({ error: 'No text provided for interpretation' });
        }

        const startTime = Date.now();

        try {
            const result = await interpreterHelper.processInterpretation(text);
            res.json({
                success: true,
                service: 'interpreter',
                text: result.text,
                time: result.time,
                error: null
            });
        } catch (error) {
            console.error('Interpreter error:', error);
            res.json({
                success: false,
                service: 'interpreter',
                text: '',
                time: error.time || (Date.now() - startTime),
                error: error.error || error.message
            });
        }
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({
            success: false,
            service: 'interpreter',
            error: error.message
        });
    }
});

// Comparison API endpoint
app.post('/api/compare', async (req, res) => {
    try {
        const { output1, output2 } = req.body;

        if (!output1 || !output2) {
            return res.status(400).json({ error: 'Both output1 and output2 are required in the request body' });
        }

        const startTime = Date.now();
        
        try {
            const result = await comparisonHelper.compareMedicalOutputs(output1, output2);
            res.json({
                success: true,
                service: 'comparison',
                data: result,
                time: Date.now() - startTime,
                error: null
            });
        } catch (error) {
            console.error('Comparison processing error:', error);
            res.json({
                success: false,
                service: 'comparison',
                data: null,
                time: Date.now() - startTime,
                error: error.message
            });
        }
    } catch (error) {
        console.error('Server error during comparison:', error);
        res.status(500).json({
            success: false,
            service: 'comparison',
            error: error.message
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve index.html for root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File size too large. Maximum 100MB allowed.' });
        }
    }
    if (error.message === 'Only PDF and image files are allowed') {
        return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
});


const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📄 Upload PDFs to compare Gemini 2.0 Flash vs AWS Textract`);
});

// Disable server timeout for long-running AI requests
server.timeout = 0; // No timeout
server.keepAliveTimeout = 0; // No keep-alive timeout

// Export for Vercel serverless
module.exports = app;
