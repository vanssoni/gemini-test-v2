const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');

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
        // Using Gemini 3 Pro Preview - generally available in Google AI Studio (2026)
        this.model = this.genAI.getGenerativeModel({
            model: "gemini-3-pro-preview",
            generationConfig: {
                temperature: 0.1, // Lower temperature for more consistent extraction
            },
        });
    }

    /**
     * Extract text from PDF using Google Gemini
     * @param {Buffer} fileBuffer - PDF file buffer
     * @param {string} mimeType - File MIME type
     * @param {string} customPrompt - Optional custom prompt (uses default if not provided)
     * @returns {Promise<string>} Extracted text
     */
    async extractTextFromPDF(fileBuffer, mimeType = 'application/pdf', customPrompt = null) {
        try {
            // Convert buffer to base64
            const base64Data = fileBuffer.toString('base64');

            const imagePart = {
                inlineData: {
                    data: base64Data,
                    mimeType: mimeType
                }
            };

            // Use custom prompt if provided, otherwise use default
            const prompt = customPrompt || "Extract all text from this PDF document. Return only the extracted text without any additional commentary or formatting.";

            const result = await this.model.generateContent([prompt, imagePart]);
            const response = await result.response;
            const text = response.text();

            return text;
        } catch (error) {
            console.error('Gemini extraction error:', error);
            throw new Error(`Gemini extraction failed: ${error.message}`);
        }
    }
}

module.exports = new GeminiHelper();
