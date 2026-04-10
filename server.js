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

const app = express();
const PORT = process.env.PORT || 3000;

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
        const customPrompt = req.body.prompt; // Get custom prompt from request body
        const startTime = Date.now();

        try {
            const result = await geminiHelper.extractTextFromPDF(fileBuffer, customPrompt);
            const time = Date.now() - startTime;

            // Result now includes error field - images are always returned if available
            res.json({
                success: !result.error,
                service: 'gemini',
                text: result.text || '',
                images: result.images || [], // Always return images
                time: time,
                error: result.error
            });
        } catch (error) {
            console.error('Gemini error:', error);
            res.json({
                success: false,
                service: 'gemini',
                text: '',
                images: [], // No images if conversion itself failed
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
