const fs = require('fs');
const path = require('path');

// Polyfills for fetch in Node.js < 18
if (!globalThis.fetch) {
    const fetch = require('node-fetch');
    globalThis.fetch = fetch;
    globalThis.Headers = fetch.Headers;
    globalThis.Response = fetch.Response;
    globalThis.Request = fetch.Request;
}

class InterpreterHelper {
    constructor() {
        this.apiKey = process.env.OPENAI_API_KEY;
        this.config = this.loadConfig();
    }

    /**
     * Load configuration from inter_prompt.json
     */
    loadConfig() {
        try {
            const configPath = path.join(__dirname, 'inter_prompt.json');
            const configData = fs.readFileSync(configPath, 'utf8');
            return JSON.parse(configData);
        } catch (error) {
            console.error('Error loading inter_prompt.json:', error);
            throw new Error('Failed to load Interpreter AI configuration');
        }
    }

    /**
     * Execute Interpreter AI processing on JSON input
     * @param {string} jsonText - Extracted JSON from Gemini or Extractor
     * @returns {Promise<string>} Interpreted JSON response from OpenAI
     */
    async executeInterpreterAi(jsonText) {
        try {
            if (!this.apiKey) {
                throw new Error('OPENAI_API_KEY is not configured');
            }

            if (!jsonText || jsonText.trim().length === 0) {
                throw new Error('No text provided for interpretation');
            }

            // Build messages array
            const messages = [
                {
                    role: "system",
                    content: [
                        {
                            type: "text",
                            text: this.config.prompt
                        }
                    ]
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: jsonText
                        }
                    ]
                }
            ];

            // Prepare request body
            const requestBody = {
                model: this.config.model,
                messages: messages,
                temperature: this.config.temperature,
                max_tokens: this.config.max_tokens,
                top_p: this.config.top_p,
                frequency_penalty: this.config.frequency_penalty,
                presence_penalty: this.config.presence_penalty
            };

            // Add response_format if present in config
            if (this.config.response_format) {
                requestBody.response_format = this.config.response_format;
            }

            // 10 minute timeout for AI processing
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 600000);

            // Call OpenAI API
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(`OpenAI API error: ${response.status} - ${errorData.error?.message || 'Unknown error'}`);
            }

            const data = await response.json();

            if (!data.choices || !data.choices[0] || !data.choices[0].message) {
                throw new Error('Invalid response from OpenAI API');
            }

            return data.choices[0].message.content;

        } catch (error) {
            console.error('Interpreter AI error:', error);
            throw new Error(`Interpreter AI failed: ${error.message}`);
        }
    }

    /**
     * Process Interpreter AI with timing
     * @param {string} jsonText - Extracted JSON text
     * @returns {Promise<{text: string, time: number}>} Result with timing
     */
    async processInterpretation(jsonText) {
        const startTime = Date.now();
        try {
            const text = await this.executeInterpreterAi(jsonText);
            const time = Date.now() - startTime;
            return { text, time };
        } catch (error) {
            const time = Date.now() - startTime;
            throw { error: error.message, time };
        }
    }
}

module.exports = new InterpreterHelper();
