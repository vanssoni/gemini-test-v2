require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const geminiHelper = require('./gemini-helper');
const textractHelper = require('./textract-helper');
const extractorHelper = require('./extractor-helper');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
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

// Upload and process with Textract endpoint (includes Extractor AI)
app.post('/api/extract/textract', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No PDF file uploaded' });
        }

        const fileBuffer = req.file.buffer;
        const textractStartTime = Date.now();

        try {
            // Step 1: Extract text with AWS Textract
            const textractText = await textractHelper.extractTextFromPDF(fileBuffer, req.file.originalname);
            const textractTime = Date.now() - textractStartTime;

            // Step 2: Automatically process with Extractor AI
            const extractorStartTime = Date.now();
            let extractorResult = null;

            try {
                const extractorResponse = await extractorHelper.processExtractorAi(textractText);
                extractorResult = {
                    success: true,
                    text: extractorResponse.text,
                    time: extractorResponse.time,
                    error: null
                };
            } catch (extractorError) {
                console.error('Extractor AI error:', extractorError);
                extractorResult = {
                    success: false,
                    text: '',
                    time: extractorError.time || (Date.now() - extractorStartTime),
                    error: extractorError.error || extractorError.message
                };
            }

            // Return combined results
            res.json({
                success: true,
                textract: {
                    text: textractText,
                    time: textractTime,
                    error: null
                },
                extractor: extractorResult,
                error: null
            });

        } catch (error) {
            console.error('Textract error:', error);
            res.json({
                success: false,
                textract: {
                    text: '',
                    time: Date.now() - textractStartTime,
                    error: error.message
                },
                extractor: {
                    success: false,
                    text: '',
                    time: 0,
                    error: 'Skipped due to Textract failure'
                },
                error: error.message
            });
        }
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({
            success: false,
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


app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📄 Upload PDFs to compare Gemini 2.0 Flash vs AWS Textract`);
});

// Export for Vercel serverless
module.exports = app;
