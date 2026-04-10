const openAiHelper = require('./../../../helpers/openai.helper');
const geminiHelper = require('./../../../helpers/gemini.helper');
const awsTranscribeHelper = require('./../../../helpers/aws-transcribe.helper');
const googleTranscribeHelper = require('./../../../helpers/google-transcribe.helper');
const path = require("path");
const fs = require("fs");
const openAiLogRepository = require('../repositories/openAiLog.repository');
const userRepository = require('../../user/repositories/user.repository');
const translationLanguageRepository = require('../../translation-language/translation-language.repository');
const clientRepository = require('../../report/models/client.model');
const clientService = require('../../report/services/client.service');
const userPrescriptionRepo = require('../../report/repositories/user-prescriptions.repository');
const userReportTypeRepo = require('../../report/repositories/user-report-type.repository');
const usecaseService = require('./usecase.service');
const { ACTION } = require("../../../constants/common.constants");
const timeZoneConstants = require("../../../constants/timezone.constants");
const slackHelper = require("../../../helpers/slack.helper");
const sentryHelper = require('../../../helpers/sentry.helper');
const ReportLogHelper = require('../../../helpers/report-log.helper');
const moment = require('moment-timezone');
const { EMIT_EVENTS } = require("../../../socket/socket-events");
const userConversationService = require('../services/userConversation.service');
const { exec } = require('child_process');
const util = require('util');
const sharp = require('sharp');
const execPromise = util.promisify(exec);
const sessions = new Map();
class GenerateService {

    constructor() {
        this.sessions = new Map();
        this.sessionQueues = new Map(); // Queue for sequential processing
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

    async hitOpenAICompletion(params, userId, event, eventId, timeOut = 30) {
        let response;
        const maxRetries = 3; // Maximum number of retries
        let attempt = 0; // Attempt counter

        while (attempt < maxRetries) {
            try {
                // Try to get the completion from OpenAI
                const startTime = Date.now();
                response = await openAiHelper.completion(params, timeOut);
                const endTime = Date.now();
                const timeTaken = (endTime - startTime) / 1000;
                // Save logs and send the prompt to Slack if the request is successful
                this.saveOpenAIlogs(userId, params, response, event, eventId, timeTaken);
                slackHelper.sendOpenAIPrompt({
                    request: {
                        messages: params.messages,
                        model: params.model,
                        tool_choice: params.tool_choice,
                        frequency_penalty: params.frequency_penalty,
                        presence_penalty: params.presence_penalty,
                        max_tokens: params.max_tokens,
                        top_p: params.top_p,
                        temperature: params.temperature
                    },
                    response
                });
                //if both tools calls and ai response are empty then notify slack
                if (!response?.choices[0]?.message?.tool_calls && !response?.choices[0]?.message?.content) {

                    slackHelper.sendInvalidResponse({
                        request: {
                            messages: params.messages,
                            model: params.model,
                            tool_choice: params.tool_choice,
                            frequency_penalty: params.frequency_penalty,
                            presence_penalty: params.presence_penalty,
                            max_tokens: params.max_tokens,
                            top_p: params.top_p,
                            temperature: params.temperature
                        },
                        response
                    });
                }
                // Return the response if the request is successful
                return response;
            } catch (error) {
                attempt += 1;
                // If the maximum number of retries is reached, throw an error
                if (attempt === maxRetries) {
                    console.error("Failed after " + maxRetries + ' tries.')
                    this.saveOpenAIlogs(userId, params, error.message, event, eventId);
                    throw new Error(error.message + `\n event is ${event}`);
                }
            }
        }
    }

    async streamCompletion(params, userId) {
        params.stream = true;

        try {
            const response = await openAiHelper.completionWithoutTimeOut(params);

            let fullContent = '';

            // Handle the async iterable directly
            for await (const chunk of response) {
                const delta = chunk.choices?.[0]?.delta?.content;
                if (delta) {
                    fullContent += delta;
                    // Send the delta via socket
                    sendSocketEventUserSpecific(userId, EMIT_EVENTS.TRANSCRIPTION_CHUNK, { text: delta })
                }

                // Check if streaming is complete
                if (chunk.choices?.[0]?.finish_reason) {
                    sendSocketEventUserSpecific(userId, EMIT_EVENTS.TRANSCRIPTION_CHUNK_END, { isLast: true })
                    break;
                }
            }
            this.saveOpenAIlogs(userId, params, fullContent, 'create_report_ai_transcription', userId);
            return fullContent;

        } catch (error) {
            console.error('Streaming error:', error);
            sendSocketEventUserSpecific(userId, EMIT_EVENTS.TRANSCRIPTION_ERROR, { error: error.message })
            throw error;
        }
    }

    async saveOpenAIlogs(userId = 'NA', request, response, event, eventId, timeTaken = 0) {
        try {
            await openAiLogRepository.create({ userId: userId, event, eventId, request, response, timeTaken })
        } catch (err) {
            sentryHelper.catchException(err, { userId, request, response, event, eventId });
            console.error("Error in  saveOpenAIlogs ", err.message);
        }
    }


    replacePlaceholders(template, variables) {
        return template.replace(/{(\w+)}/g, (match, placeholder) => {
            return variables[placeholder] !== undefined ? variables[placeholder] : match;
        });
    }

    async processExtractorAi(userId, reportId, pdfText) {
        try {
            // Process the prompt
            await ReportLogHelper.updateLog(reportId, 'extractor', 'start');
            const response = await this.executeExtractorAi(userId, reportId, pdfText, ACTION.EXTRACTOR_AI);
            await ReportLogHelper.updateLog(reportId, 'extractor', 'end');
            return response;
        } catch (err) {
            sentryHelper.catchException(err, { userId });
            console.error("Error in processExtractorAi - ", err.message);
            throw err;
        }
    }
    async executeExtractorAi(userId, reportId, pdfText, action) {
        const usecase = await usecaseService.getUsecaseById('reportExtractorAiPrompt');
        const selectedPrompt = this.getPromptByModel(usecase);

        let messages = [];
        let sysMessage = {
            role: "system",
            content: [
                {
                    type: "text",
                    text: selectedPrompt
                }
            ]
        }
        messages.push(sysMessage);

        let userMessage = {
            role: "user",
            content: [
                {
                    type: "text",
                    text: pdfText
                }
            ]
        }
        messages.push(userMessage);
        const openAiResponse = await this.hitOpenAICompletion({
            model: usecase.model,
            messages: messages,
            temperature: usecase.temperature,
            //TODO: update based on model
            // max_tokens: usecase.max_tokens,
            top_p: usecase.top_p,
            frequency_penalty: usecase.frequency_penalty,
            presence_penalty: usecase.presence_penalty,
            // response_format: {
            //     "type": usecase?.response_format?.type ? usecase?.response_format?.type : "text"
            // }
        }, userId, action, reportId, 200);

        return openAiResponse?.choices[0]?.message?.content;
    }

    async processGeminiExtractionAi(userId, reportId, fileUrl) {
        try {
            await ReportLogHelper.updateLog(reportId, 'extractor', 'start');
            const response = await this.executeGeminiExtractionAi(userId, reportId, fileUrl, ACTION.GEMINI_OPEN_AI);
            await ReportLogHelper.updateLog(reportId, 'extractor', 'end');
            return response;
        } catch (err) {
            sentryHelper.catchException(err, { userId });
            console.error("Error in processGeminiAi - ", err.message);
            throw err;
        }
    }

    async executeGeminiExtractionAi(userId, reportId, fileUrl, action) {
        const usecase = await usecaseService.getUsecaseById('geminiReportExtractorAiPrompt');
        const prompt = usecase.prompt;

        // Download the PDF from URL
        const startTime = Date.now();
        const pdfBuffer = await geminiHelper.downloadPDF(fileUrl);

        // Use gemini helper to convert PDF to images and call Gemini API
        const { text, images, tokenUsage, error } = await geminiHelper.extractTextFromPDF(pdfBuffer, prompt, usecase.temperature, usecase.model);
        const endTime = Date.now();
        const timeTaken = (endTime - startTime) / 1000;

        if (error) {
            // Log the error and throw
            this.saveOpenAIlogs(
                userId,
                { prompt, fileUrl, model: usecase.model, tokenUsage },
                error,
                action,
                reportId,
                timeTaken
            );
            throw new Error(error);
        }

        // Save logs for tracking
        this.saveOpenAIlogs(
            userId,
            { prompt, fileUrl, model: usecase.model, tokenUsage },
            text,
            action,
            reportId,
            timeTaken
        );

        return text;
    }

    async processOneShotGeminiAi(userId, reportId, fileUrl) {
        try {
            await ReportLogHelper.updateLog(reportId, 'extractor', 'start');
            const response = await this.executeOneShotGeminiAi(userId, reportId, fileUrl, ACTION.GEMINI_AI);
            await ReportLogHelper.updateLog(reportId, 'extractor', 'end');
            return response;
        } catch (err) {
            sentryHelper.catchException(err, { userId });
            console.error("Error in processGeminiAi - ", err.message);
            throw err;
        }
    }

    async executeOneShotGeminiAi(userId, reportId, fileUrl, action) {
        const usecase = await usecaseService.getUsecaseById('geminiReportAiPrompt');
        const prompt = usecase.prompt;

        // Download the PDF from URL
        const startTime = Date.now();
        const pdfBuffer = await geminiHelper.downloadPDF(fileUrl);

        // Use gemini helper to convert PDF to images and call Gemini API
        const { text, images, tokenUsage, error } = await geminiHelper.extractTextFromPDF(pdfBuffer, prompt, usecase.temperature, usecase.model);
        const endTime = Date.now();
        const timeTaken = (endTime - startTime) / 1000;

        if (error) {
            // Log the error and throw
            this.saveOpenAIlogs(
                userId,
                { prompt, fileUrl, model: usecase.model, tokenUsage },
                error,
                action,
                reportId,
                timeTaken
            );
            throw new Error(error);
        }

        // Save logs for tracking
        this.saveOpenAIlogs(
            userId,
            { prompt, fileUrl, model: usecase.model, tokenUsage },
            text,
            action,
            reportId,
            timeTaken
        );

        return text;
    }

    async processOneShotOpenAi(userId, reportId, fileUrl) {
        try {
            await ReportLogHelper.updateLog(reportId, 'extractor', 'start');
            const response = await this.executeOneShotOpenAi(userId, reportId, fileUrl, ACTION.INTERPRETATION_AI);
            await ReportLogHelper.updateLog(reportId, 'extractor', 'end');
            return response;
        } catch (err) {
            sentryHelper.catchException(err, { userId });
            console.error("Error in processOneShotOpenAi - ", err.message);
            throw err;
        }
    }

    async executeOneShotOpenAi(userId, reportId, fileUrl, action) {
        const usecase = await usecaseService.getUsecaseById('openAiReportAiPrompt');
        const selectedPrompt = this.getPromptByModel(usecase);
        const pdfBuffer = await geminiHelper.downloadPDF(fileUrl);
        const isPdf = pdfBuffer.toString('utf8', 0, 4) === '%PDF';
        const imageBuffers = isPdf
            ? (await geminiHelper.processPDFToGridImages(pdfBuffer)).images
            : [await sharp(pdfBuffer).png().toBuffer()];

        let messages = [];
        let sysMessage = {
            role: "system",
            content: [
                {
                    type: "text",
                    text: selectedPrompt
                }
            ]
        }
        messages.push(sysMessage);

        let userMessage = {
            role: "user",
            content: imageBuffers.map((imageBuffer) => ({
                type: "image_url",
                image_url: {
                    url: `data:image/png;base64,${imageBuffer.toString('base64')}`
                }
            }))
        }
        messages.push(userMessage);
        const openAiResponse = await this.hitOpenAICompletion({
            model: usecase.model,
            messages: messages,
            temperature: usecase.temperature,
            //TODO: update based on model
            // max_tokens: usecase.max_tokens,
            top_p: usecase.top_p,
            frequency_penalty: usecase.frequency_penalty,
            presence_penalty: usecase.presence_penalty,
            // response_format: {
            //     "type": usecase?.response_format?.type ? usecase?.response_format?.type : "text"
            // }
        }, userId, action, reportId, 200);
        return openAiResponse?.choices[0]?.message?.content;
    }

    async processInterpretationAi(userId, reportId, extractionJsonOutput) {
        try {
            await ReportLogHelper.updateLog(reportId, 'interpreter', 'start');
            // Process the prompt
            extractionJsonOutput = JSON.stringify(extractionJsonOutput);
            const response = await this.executeInterpretationAi(userId, reportId, extractionJsonOutput, ACTION.INTERPRETATION_AI);
            await ReportLogHelper.updateLog(reportId, 'interpreter', 'end');
            return response;
        } catch (err) {
            sentryHelper.catchException(err, { userId });
            console.error("Error in processInterpretationAi - ", err.message);
            throw err;
        }
    }
    async executeInterpretationAi(userId, reportId, extractionJsonOutput, action) {
        const usecase = await usecaseService.getUsecaseById('reportInterpretationAiPrompt');
        const selectedPrompt = this.getPromptByModel(usecase);
        let messages = [];
        let sysMessage = {
            role: "system",
            content: [
                {
                    type: "text",
                    text: selectedPrompt
                }
            ]
        }
        messages.push(sysMessage);

        let userMessage = {
            role: "user",
            content: [
                {
                    type: "text",
                    text: extractionJsonOutput
                }
            ]
        }
        messages.push(userMessage);
        const openAiResponse = await this.hitOpenAICompletion({
            model: usecase.model,
            messages: messages,
            temperature: usecase.temperature,
            //TODO: update based on model
            // max_tokens: usecase.max_tokens,
            top_p: usecase.top_p,
            frequency_penalty: usecase.frequency_penalty,
            presence_penalty: usecase.presence_penalty,
            // response_format: {
            //     "type": usecase?.response_format?.type ? usecase?.response_format?.type : "text"
            // }
        }, userId, action, reportId, 200);
        return openAiResponse?.choices[0]?.message?.content;
    }

    cleanResponse(response) {
        if (!response) {
            throw new Error(`No response received from AI`);
        }

        // Check if the response is wrapped with ```json and ```
        const match = response.match(/```json\n([\s\S]*?)\n```/);

        let jsonString;
        if (match && match[1]) {
            // If wrapped in ```json, extract the JSON string
            jsonString = match[1];
        } else {
            // If not wrapped in ```json, assume the whole response is the JSON
            jsonString = response;
        }

        try {
            return JSON.parse(jsonString);
        } catch (error) {
            throw new Error(`Unable to parse json: ${jsonString}`);
        }
    }
}

module.exports = new GenerateService();
