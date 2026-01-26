require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const geminiHelper = require('./gemini-helper');
const textractHelper = require('./textract-helper');
const extractorHelper = require('./extractor-helper');
const interpreterHelper = require('./interpreter-helper');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Configure multer for file uploads (store in memory)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 20 * 1024 * 1024 // 20MB limit
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Only PDF files are allowed'));
        }
    }
});

// Upload and process with Gemini endpoint
app.post('/api/extract/gemini', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No PDF file uploaded' });
        }

        const fileBuffer = req.file.buffer;
        const customPrompt = req.body.prompt; // Get custom prompt from request body
        const startTime = Date.now();

        try {
            const text = await geminiHelper.extractTextFromPDF(fileBuffer, req.file.mimetype, customPrompt);
            const time = Date.now() - startTime;

            res.json({
                success: true,
                service: 'gemini',
                text: text,
                time: time,
                error: null
            });
        } catch (error) {
            console.error('Gemini error:', error);
            res.json({
                success: false,
                service: 'gemini',
                text: '',
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
            const text = await textractHelper.extractTextFromPDF(fileBuffer, req.file.originalname);
            const time = Date.now() - startTime;

            res.json({
                success: true,
                service: 'textract',
                text: text,
                time: time,
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
            return res.status(400).json({ error: 'File size too large. Maximum 20MB allowed.' });
        }
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
