const { GoogleGenerativeAI } = require('@google/generative-ai');
const { fromBuffer } = require('pdf2pic');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Polyfills for fetch, Headers, and Response in Node.js < 18
if (!globalThis.fetch) {
    const fetch = require('node-fetch');
    globalThis.fetch = fetch;
    globalThis.Headers = fetch.Headers;
    globalThis.Response = fetch.Response;
    globalThis.Request = fetch.Request;
}

class GeminiHelper {
    constructor() {
        this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        this.modelConfig = {
            model: "gemini-3-pro-preview",
            safetySettings: [
                {
                    category: "HARM_CATEGORY_HATE_SPEECH",
                    threshold: "BLOCK_ONLY_HIGH",
                },
                {
                    category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                    threshold: "BLOCK_ONLY_HIGH",
                },
                {
                    category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                    threshold: "BLOCK_ONLY_HIGH",
                },
                {
                    category: "HARM_CATEGORY_HARASSMENT",
                    threshold: "BLOCK_ONLY_HIGH",
                },
            ],
        };

        // Configuration for page combining
        this.pagesPerImage = 6;
        this.gridCols = 2;
        this.gridRows = 3;
        this.pageWidth = 800;
        this.pageHeight = 1000;
    }
    //TODO get model dynamically as well
    getModel(temperature = 0.1, model = "gemini-3-pro-preview", systemInstruction = null) {
        const config = {
            ...this.modelConfig,
            model,
            generationConfig: { temperature },
        };
        if (systemInstruction) {
            config.systemInstruction = systemInstruction;
        }
        return this.genAI.getGenerativeModel(config, { timeout: 600000 });
    }
    /**
     * Get PDF page count using pdf-lib
     * @param {Buffer} pdfBuffer - PDF file buffer
     * @returns {Promise<number>} Number of pages
     */
    async getPDFPageCount(pdfBuffer) {
        const pdfDoc = await PDFDocument.load(pdfBuffer);
        return pdfDoc.getPageCount();
    }
    /**
     * Convert PDF pages to images
     * @param {Buffer} pdfBuffer - PDF file buffer
     * @returns {Promise<Buffer[]>} Array of page image buffers
     */
    async convertPDFToImages(pdfBuffer) {
        const tempDir = path.join(os.tmpdir(), `pdf_${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });

        try {
            const pageCount = await this.getPDFPageCount(pdfBuffer);
            console.log(`PDF has ${pageCount} pages`);

            const options = {
                density: 150,
                saveFilename: "page",
                savePath: tempDir,
                format: "png",
                width: this.pageWidth,
                height: this.pageHeight
            };

            const convert = fromBuffer(pdfBuffer, options);

            console.log('Converting all pages...');
            const results = await convert.bulk(-1, { responseType: "buffer" });

            console.log(`Converted ${results.length} pages to images`);

            const pageImages = results.map(r => r.buffer).filter(b => b);
            return pageImages;
        } finally {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (e) {
                console.warn('Could not clean temp dir:', e.message);
            }
        }
    }

    /**
     * Combine multiple page images into a grid
     * @param {Buffer[]} pageBuffers - Array of page image buffers
     * @returns {Promise<Buffer>} Combined image buffer
     */
    async combineImagesIntoGrid(pageBuffers) {
        const cols = this.gridCols;
        const rows = this.gridRows;
        const pageW = this.pageWidth;
        const pageH = this.pageHeight;

        const totalWidth = cols * pageW;
        const totalHeight = rows * pageH;

        const composites = [];

        for (let i = 0; i < pageBuffers.length && i < cols * rows; i++) {
            const col = i % cols;
            const row = Math.floor(i / cols);

            const resizedPage = await sharp(pageBuffers[i])
                .resize(pageW, pageH, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
                .toBuffer();

            composites.push({
                input: resizedPage,
                left: col * pageW,
                top: row * pageH
            });
        }

        const combinedImage = await sharp({
            create: {
                width: totalWidth,
                height: totalHeight,
                channels: 4,
                background: { r: 255, g: 255, b: 255, alpha: 1 }
            }
        })
            .composite(composites)
            .png()
            .toBuffer();

        return combinedImage;
    }

    /**
     * Process PDF: convert to combined grid images
     * @param {Buffer} pdfBuffer - PDF file buffer
     * @returns {Promise<{images: Buffer[], folderName: string}>} Array of combined image buffers
     */
    async processPDFToGridImages(pdfBuffer) {
        console.log('Converting PDF pages to images...');
        const pageImages = await this.convertPDFToImages(pdfBuffer);

        if (pageImages.length === 0) {
            throw new Error('No pages found in PDF');
        }

        const combinedImages = [];

        for (let i = 0; i < pageImages.length; i += this.pagesPerImage) {
            const group = pageImages.slice(i, i + this.pagesPerImage);
            console.log(`Combining pages ${i + 1} to ${i + group.length}...`);
            const combined = await this.combineImagesIntoGrid(group);
            combinedImages.push(combined);
        }

        console.log(`Created ${combinedImages.length} combined grid images`);
        return { images: combinedImages, folderName: null };
    }

    /**
     * Download PDF from URL and return as buffer
     * @param {string} url - URL of the PDF file
     * @returns {Promise<Buffer>} PDF file buffer
     */
    async downloadPDF(url) {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to download PDF: ${response.statusText}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }

    /**
     * Extract text from PDF or Image using Google Gemini with a custom prompt
     * @param {Buffer} fileBuffer - PDF or Image file buffer
     * @param {string} customPrompt - The prompt to send to Gemini (from DB usecase)
     * @returns {Promise<{text: string, images: string[], tokenUsage: { total: number, input: number, output: number }|null, error: string|null}>} Extracted text, images, token usage, and error if any
     */
    async extractTextFromPDF(fileBuffer, customPrompt, temperature = 0.1 , modelName = 'gemini-3-pro-preview') {
        let base64Images = [];
        const MAX_RETRIES = 3;
        const RETRY_DELAY_MS = 1000;

        try {
            let combinedImages = [];

            const isPdf = fileBuffer.toString('utf8', 0, 4) === '%PDF';

            if (isPdf) {
                const result = await this.processPDFToGridImages(fileBuffer);
                combinedImages = result.images;
            } else {
                const imageBuffer = await sharp(fileBuffer).png().toBuffer();
                combinedImages = [imageBuffer];
            }

            base64Images = combinedImages.map(buf => buf.toString('base64'));

            const imageParts = combinedImages.map((imgBuffer) => ({
                inlineData: {
                    data: imgBuffer.toString('base64'),
                    mimeType: 'image/png'
                }
            }));

            console.log(`Sending ${imageParts.length} combined images to Gemini... (temperature: ${temperature})`);

            const model = this.getModel(temperature, modelName, customPrompt);

            let lastError;
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    const result = await model.generateContent([...imageParts]);
                    const response = await result.response;
                    const text = response.text();

                    // Gemini SDK returns token usage via `usageMetadata` (names can vary slightly by SDK version).
                    const usageMetadata = response?.usageMetadata || result?.usageMetadata;
                    const inputTokens =
                        usageMetadata?.promptTokenCount ??
                        usageMetadata?.prompt_tokens ??
                        usageMetadata?.promptToken ??
                        null;
                    const outputTokens =
                        usageMetadata?.candidatesTokenCount ??
                        usageMetadata?.candidates_tokens ??
                        usageMetadata?.outputTokenCount ??
                        usageMetadata?.output_tokens ??
                        usageMetadata?.outputToken ??
                        null;
                    const totalTokens =
                        usageMetadata?.totalTokenCount ??
                        usageMetadata?.total_tokens ??
                        usageMetadata?.totalToken ??
                        null;

                    const tokenUsage =
                        totalTokens !== null || inputTokens !== null || outputTokens !== null
                            ? { total: totalTokens, input: inputTokens, output: outputTokens }
                            : null;

                    return { text, images: base64Images, tokenUsage, error: null };
                } catch (err) {
                    lastError = err;
                    if (attempt < MAX_RETRIES) {
                        const delay = RETRY_DELAY_MS * attempt;
                        console.warn(`Gemini attempt ${attempt} failed. Retrying in ${delay}ms...`, err.message);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                }
            }

            throw lastError;
        } catch (error) {
            console.error('Gemini extraction error:', error);
            return { text: null, images: base64Images, tokenUsage: null, error: `Gemini extraction failed: ${error.message}` };
        }
    }
}

module.exports = new GeminiHelper();
