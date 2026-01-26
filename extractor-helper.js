const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

class ExtractorHelper {
    constructor() {
        this.apiKey = process.env.OPENAI_API_KEY;
        this.config = this.loadConfig();
        this.openai = new OpenAI({
            apiKey: this.apiKey,
        });
    }

    /**
     * Load configuration from prompt.json
     */
    loadConfig() {
        try {
            const configPath = path.join(__dirname, 'prompt.json');
            const configData = fs.readFileSync(configPath, 'utf8');
            return JSON.parse(configData);
        } catch (error) {
            console.error('Error loading prompt.json:', error);
            throw new Error('Failed to load Extractor AI configuration');
        }
    }

    /**
     * Execute Extractor AI processing on text input
     * @param {string} pdfText - Extracted text from AWS Textract
     * @returns {Promise<string>} Structured JSON response from OpenAI
     */
    async executeExtractorAi(pdfText) {
        try {
            if (!this.apiKey) {
                throw new Error('OPENAI_API_KEY is not configured');
            }

            if (!pdfText || pdfText.trim().length === 0) {
                throw new Error('No text provided for extraction');
            }

            // Build messages array
            const messages = [
                {
                    role: "system",
                    content: this.config.prompt
                },
                {
                    role: "user",
                    content: pdfText
                }
            ];

            // Call OpenAI API using SDK (default timeout is 10 minutes)
            const completion = await this.openai.chat.completions.create({
                model: this.config.model,
                messages: messages,
                temperature: this.config.temperature,
                max_tokens: this.config.max_tokens,
                top_p: this.config.top_p,
                frequency_penalty: this.config.frequency_penalty,
                presence_penalty: this.config.presence_penalty
            });

            if (!completion.choices || !completion.choices[0] || !completion.choices[0].message) {
                throw new Error('Invalid response from OpenAI API');
            }

            return completion.choices[0].message.content;

        } catch (error) {
            console.error('Extractor AI error:', error);
            throw new Error(`Extractor AI failed: ${error.message}`);
        }
    }

    /**
     * Process Extractor AI with timing
     * @param {string} pdfText - Extracted text from AWS Textract
     * @returns {Promise<{text: string, time: number}>} Result with timing
     */
    async processExtractorAi(pdfText) {
        const startTime = Date.now();
        try {
            const text = await this.executeExtractorAi(pdfText);
            const time = Date.now() - startTime;
            return { text, time };
        } catch (error) {
            const time = Date.now() - startTime;
            throw { error: error.message, time };
        }
    }
}

module.exports = new ExtractorHelper();
