const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const OpenAI = require('openai');
const geminiHelper = require('./gemini-helper');
const usecaseService = require('./usecase-service');

const USECASE_IDS = {
    extractor: 'reportExtractorAiPrompt',
    geminiExtraction: 'geminiReportExtractorAiPrompt',
    oneShotGemini: 'geminiReportAiPrompt',
    oneShotOpenAi: 'openAiReportAiPrompt',
    interpretation: 'reportInterpretationAiPrompt'
};

class GenerateService {
    constructor() {
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });
    }

    getPromptByModel(usecase) {
        const model = (usecase?.model || '').toString().trim().toLowerCase();
        const modelMatch = model.match(/^gpt-(\d+)/);
        const modelMajorVersion = modelMatch ? modelMatch[1] : null;
        const promptField = modelMajorVersion && modelMajorVersion !== '4'
            ? `gpt_${modelMajorVersion}_prompt`
            : 'prompt';

        const modelPrompt = (usecase?.[promptField] ?? '').toString().trim();
        if (modelPrompt) {
            return modelPrompt;
        }

        return (usecase?.prompt ?? '').toString();
    }

    async getUsecase(usecaseId, fallbackConfigFile) {
        try {
            return await usecaseService.getUsecaseById(usecaseId);
        } catch (error) {
            if (!fallbackConfigFile || process.env.REQUIRE_MONGO_PROMPTS === 'true') {
                throw error;
            }

            const fallbackPath = path.join(__dirname, fallbackConfigFile);
            const fallback = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
            console.warn(`${error.message}. Falling back to ${fallbackConfigFile}`);
            return fallback;
        }
    }

    buildOpenAiParams(usecase, messages) {
        const params = {
            model: usecase.model,
            messages,
            temperature: usecase.temperature,
            top_p: usecase.top_p,
            frequency_penalty: usecase.frequency_penalty,
            presence_penalty: usecase.presence_penalty
        };

        // if (usecase.max_tokens) {
        //     params.max_tokens = usecase.max_tokens;
        // }

        if (usecase.response_format) {
            params.response_format = usecase.response_format;
        }

        Object.keys(params).forEach((key) => {
            if (params[key] === undefined || params[key] === null || params[key] === '') {
                delete params[key];
            }
        });

        return params;
    }

    async hitOpenAICompletion(params, timeOut = 200) {
        const maxRetries = 3;
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await this.openai.chat.completions.create(params, {
                    timeout: timeOut * 1000
                });
            } catch (error) {
                lastError = error;
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, attempt * 1000));
                }
            }
        }

        throw lastError;
    }

    getMessageContentText(text) {
        return [
            {
                type: 'text',
                text
            }
        ];
    }

    async processExtractorAi(pdfText) {
        const usecase = await this.getUsecase(USECASE_IDS.extractor, 'prompt.json');
        const selectedPrompt = this.getPromptByModel(usecase);
        const messages = [
            { role: 'system', content: this.getMessageContentText(selectedPrompt) },
            { role: 'user', content: this.getMessageContentText(pdfText) }
        ];

        const openAiResponse = await this.hitOpenAICompletion(this.buildOpenAiParams(usecase, messages));
        return openAiResponse?.choices?.[0]?.message?.content;
    }

    async processGeminiExtractionAi(fileBuffer) {
        const usecase = await this.getUsecase(USECASE_IDS.geminiExtraction, 'prompt.json');
        const prompt = this.getPromptByModel(usecase);
        const { text, error } = await geminiHelper.extractTextFromPDF(
            fileBuffer,
            prompt,
            usecase.safetySettings,
            usecase.temperature,
            usecase.model
        );

        if (error) {
            throw new Error(error);
        }

        return text;
    }

    async processOneShotGeminiAi(fileBuffer) {
        const usecase = await this.getUsecase(USECASE_IDS.oneShotGemini, 'prompt.json');
        const prompt = this.getPromptByModel(usecase);
        const { text, error } = await geminiHelper.extractTextFromPDF(
            fileBuffer,
            prompt,
            usecase.safetySettings,
            usecase.temperature,
            usecase.model
        );

        if (error) {
            throw new Error(error);
        }

        return text;
    }

    async processOneShotOpenAi(fileBuffer) {
        const usecase = await this.getUsecase(USECASE_IDS.oneShotOpenAi, 'prompt.json');
        const selectedPrompt = this.getPromptByModel(usecase);
        const isPdf = fileBuffer.toString('utf8', 0, 4) === '%PDF';
        const imageBuffers = isPdf
            ? (await geminiHelper.processPDFToGridImages(fileBuffer)).images
            : [await sharp(fileBuffer).png().toBuffer()];

        const messages = [
            { role: 'system', content: this.getMessageContentText(selectedPrompt) },
            {
                role: 'user',
                content: imageBuffers.map((imageBuffer) => ({
                    type: 'image_url',
                    image_url: {
                        url: `data:image/png;base64,${imageBuffer.toString('base64')}`
                    }
                }))
            }
        ];

        const openAiResponse = await this.hitOpenAICompletion(this.buildOpenAiParams(usecase, messages));
        return openAiResponse?.choices?.[0]?.message?.content;
    }

    async processInterpretationAi(extractionJsonOutput) {
        const usecase = await this.getUsecase(USECASE_IDS.interpretation, 'inter_prompt.json');
        const selectedPrompt = this.getPromptByModel(usecase);
        const inputText = typeof extractionJsonOutput === 'string'
            ? extractionJsonOutput
            : JSON.stringify(extractionJsonOutput);
        const messages = [
            { role: 'system', content: this.getMessageContentText(selectedPrompt) },
            { role: 'user', content: this.getMessageContentText(inputText) }
        ];

        const openAiResponse = await this.hitOpenAICompletion(this.buildOpenAiParams(usecase, messages));
        return openAiResponse?.choices?.[0]?.message?.content;
    }

    cleanResponse(response) {
        if (!response) {
            throw new Error('No response received from AI');
        }

        const trimmedResponse = typeof response === 'string' ? response.trim() : JSON.stringify(response);
        const match = trimmedResponse.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        const jsonString = match?.[1] ? match[1].trim() : trimmedResponse;

        try {
            return this.sortMedicalResponse(JSON.parse(jsonString));
        } catch (error) {
            throw new Error(`Unable to parse json: ${jsonString}`);
        }
    }

    sortMedicalResponse(value) {
        if (Array.isArray(value)) {
            return value.map((item) => this.sortMedicalResponse(item));
        }

        if (!value || typeof value !== 'object') {
            return value;
        }

        if (Array.isArray(value.testAndConditions)) {
            value.testAndConditions = value.testAndConditions
                .map((condition) => this.sortMedicalResponse(condition))
                .sort((a, b) => this.sortAlphabetically(a?.name, b?.name));
        }

        if (Array.isArray(value.metrics)) {
            value.metrics = value.metrics
                .map((metric) => this.sortMedicalResponse(metric))
                .sort((a, b) => this.sortAlphabetically(a?.metric, b?.metric));
        }

        for (const key of Object.keys(value)) {
            if (key !== 'testAndConditions' && key !== 'metrics') {
                value[key] = this.sortMedicalResponse(value[key]);
            }
        }

        return value;
    }

    sortAlphabetically(left, right) {
        return (left || '').localeCompare((right || ''), undefined, { sensitivity: 'base' });
    }
}

module.exports = new GenerateService();
