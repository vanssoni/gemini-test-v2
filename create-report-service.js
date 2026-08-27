const fs = require('fs');
const os = require('os');
const path = require('path');
const OpenAI = require('openai');
const usecaseService = require('./usecase-service');

const USECASE_ID = 'createReportAi';

// The two models we benchmark against each other. usecase.model from Mongo is
// ignored on purpose — each run overrides it so both models see the prompt
// field that belongs to their major version (prompt vs gpt_5_prompt).
const MODELS = ['gpt-4.1', 'gpt-5.6-sol'];

// Prompt versions are decoupled from the model on purpose: the caller picks
// which usecase field to read, so gpt-4.1 can run the gpt_5_prompt text and
// vice versa. Omitting the version falls back to the model-derived rule.
const VERSION_PROMPT_FIELDS = {
    v1: 'prompt',
    v2: 'gpt_5_prompt',
};

const DEFAULT_REPORT_STRUCTURE = `
# **Patient Details**
# **Presenting Complaints**
# **Symptoms**
# **History of Present Illness**
# **Medical History**
# **Surgical History**
# **Allergies**
# **Examination**
# **Vitals**
# **Investigations**
# **Test Results**
# **Diagnosis**
# **Treatment**
# **Medications**
# **Prescriptions**
# **Impression**
# **Additional Note**`;

class CreateReportService {
    constructor() {
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });
    }

    get models() {
        return [...MODELS];
    }

    // Normalizes "v1" / "V2" / "1" / 2 to a version key, or null when the
    // caller did not pick one. Anything else is a caller error.
    normalizeVersion(version) {
        if (version === undefined || version === null || version === '') {
            return null;
        }
        const key = version.toString().trim().toLowerCase().replace(/^v?/, 'v');
        if (!VERSION_PROMPT_FIELDS[key]) {
            throw new Error(`Unsupported prompt version "${version}" (expected ${Object.keys(VERSION_PROMPT_FIELDS).join(' or ')})`);
        }
        return key;
    }

    // Which usecase field to read. An explicit version wins; without one this
    // is the onehealth rule — gpt-4.x reads `prompt`, anything else reads
    // `gpt_<major>_prompt`.
    getPromptField(model, version) {
        const key = this.normalizeVersion(version);
        if (key) {
            return VERSION_PROMPT_FIELDS[key];
        }

        const normalized = (model || '').toString().trim().toLowerCase();
        const modelMatch = normalized.match(/^gpt-(\d+)/);
        const modelMajorVersion = modelMatch ? modelMatch[1] : null;
        return modelMajorVersion && modelMajorVersion !== '4'
            ? `gpt_${modelMajorVersion}_prompt`
            : 'prompt';
    }

    // Reads the selected field, falling back to `prompt` when it is empty.
    getPromptByModel(usecase, model, version) {
        const promptField = this.getPromptField(model || usecase?.model, version);

        const modelPrompt = (usecase?.[promptField] ?? '').toString().trim();
        if (modelPrompt) {
            return modelPrompt;
        }

        return (usecase?.prompt ?? '').toString();
    }

    // Reasoning controls only exist on the gpt-5 line; sending them to gpt-4.1
    // is a 400, so they are scoped by major version here.
    getReasoningParams(usecase, model) {
        const normalized = (model || '').toString().trim().toLowerCase();
        const modelMatch = normalized.match(/^gpt-(\d+)/);
        if (!modelMatch || modelMatch[1] === '4') {
            return {};
        }

        const allowed = {
            reasoning_effort: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
            verbosity: ['low', 'medium', 'high'],
        };

        const params = {};
        for (const [field, values] of Object.entries(allowed)) {
            const value = (usecase?.[field] ?? '').toString().trim().toLowerCase();
            if (!value) continue;
            if (!values.includes(value)) {
                console.warn(`[createReport] ignoring unsupported ${field}="${value}" on usecase ${usecase?._id}`);
                continue;
            }
            params[field] = value;
        }
        return params;
    }

    replacePlaceholders(template, variables) {
        return template.replace(/{(\w+)}/g, (match, placeholder) => {
            return variables[placeholder] !== undefined ? variables[placeholder] : match;
        });
    }

    // Indented plain text -> markdown headings, so the model returns consistent
    // formatting. Already-markdown structures are left alone.
    formatReportStructure(structure) {
        if (!structure || typeof structure !== 'string') return structure;

        if (/^\s*#{1,6}\s/m.test(structure)) return structure;

        return structure
            .split('\n')
            .map((rawLine) => {
                const line = rawLine.trim();
                if (!line) return '';
                const subMatch = line.match(/^[-*•]\s*(.+)$/);
                if (subMatch) {
                    return `#### ${subMatch[1].trim()}`;
                }
                return `## ${line}`;
            })
            .join('\n')
            .trim();
    }

    currentDateTime() {
        return new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Kolkata',
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        }).format(new Date());
    }

    // Whisper, mirroring onehealth's openAiHelper.speechToText: the translations
    // endpoint (not transcriptions), whisper-1, retried up to 5 times.
    async speechToText(filePath) {
        let lastError;
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                const transcription = await this.openai.audio.translations.create({
                    file: fs.createReadStream(filePath),
                    model: 'whisper-1',
                });
                return transcription.text;
            } catch (error) {
                lastError = error;
            }
        }
        throw new Error(`Whisper failed: ${lastError?.message}`);
    }

    async transcribeBuffer(buffer, originalName = 'audio.wav') {
        const safeName = path.basename(originalName) || 'audio.wav';
        const tempPath = path.join(os.tmpdir(), `create-report-${Date.now()}-${safeName}`);
        await fs.promises.writeFile(tempPath, buffer);

        try {
            return await this.speechToText(tempPath);
        } finally {
            fs.promises.unlink(tempPath).catch(() => {});
        }
    }

    async hitOpenAICompletion(params, timeOut = 300) {
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

    buildMessages(usecase, model, transcript, options = {}, version = null) {
        const reportType = options.reportType || '';
        const reportStructure = options.reportStructure || DEFAULT_REPORT_STRUCTURE;

        const selectedPrompt = this.getPromptByModel(usecase, model, version);
        const replacedPrompt = this.replacePlaceholders(selectedPrompt, {
            report_type: reportType,
            clinician_speciality: options.clinicianSpeciality || '',
            latest_prescription_list: options.prescriptions
                ? (typeof options.prescriptions === 'string'
                    ? options.prescriptions
                    : JSON.stringify(options.prescriptions))
                : '[]',
            report_structure: this.formatReportStructure(reportStructure),
            custom_instructions: options.customInstructions || '',
            reference_ranges: options.referenceRanges || '',
            current_date_time: this.currentDateTime(),
        });

        const newAndExistingReportText = JSON.stringify({
            existingReportText: options.existingText || '',
            newText: transcript || ''
        });

        return [
            { role: 'system', content: [{ type: 'text', text: replacedPrompt }] },
            { role: 'user', content: [{ type: 'text', text: newAndExistingReportText }] }
        ];
    }

    async runModel(usecase, model, transcript, options = {}, version = null) {
        const messages = this.buildMessages(usecase, model, transcript, options, version);

        const params = {
            model,
            messages,
            temperature: usecase.temperature,
            top_p: usecase.top_p,
            frequency_penalty: usecase.frequency_penalty,
            presence_penalty: usecase.presence_penalty,
            ...this.getReasoningParams(usecase, model)
        };

        Object.keys(params).forEach((key) => {
            if (params[key] === undefined || params[key] === null || params[key] === '') {
                delete params[key];
            }
        });

        const startTime = Date.now();
        const response = await this.hitOpenAICompletion(params);

        return {
            model,
            version: this.normalizeVersion(version),
            promptField: this.getPromptField(model, version),
            output: response?.choices?.[0]?.message?.content || '',
            usage: response?.usage || null,
            timeMs: Date.now() - startTime
        };
    }

    // Accepts "gpt-4.1" or { model, version }. Throws on a bad version so the
    // route can answer 400 before any OpenAI call is made.
    normalizeModelSpec(spec) {
        const raw = typeof spec === 'string' ? { model: spec } : (spec || {});
        const model = (raw.model || '').toString().trim();
        if (!model) {
            throw new Error('Each entry in `models` needs a model name');
        }
        return { model, version: this.normalizeVersion(raw.version) };
    }

    // Every file goes to Whisper at once; the joined text keeps upload order so
    // a dictation split across clips still reads in sequence.
    async transcribeAll(files) {
        const transcripts = await Promise.all(files.map(async (file) => {
            const startTime = Date.now();
            try {
                const text = await this.transcribeBuffer(file.buffer, file.originalname);
                return {
                    file: file.originalname,
                    text: (text || '').trim(),
                    timeMs: Date.now() - startTime
                };
            } catch (error) {
                throw new Error(`Whisper failed on "${file.originalname}": ${error.message}`);
            }
        }));

        const empty = transcripts.filter(item => !item.text).map(item => item.file);
        if (empty.length === transcripts.length) {
            throw new Error('Whisper returned an empty transcript for every audio file');
        }
        if (empty.length) {
            console.warn(`[createReport] empty transcript for: ${empty.join(', ')}`);
        }

        return transcripts;
    }

    // Audio files -> parallel Whisper -> joined transcript -> models in parallel.
    async createReportFromAudio(files, options = {}) {
        const audioFiles = Array.isArray(files) ? files : [files];
        if (audioFiles.length === 0) {
            throw new Error('No audio files provided');
        }

        const specs = (Array.isArray(options.models) && options.models.length > 0
            ? options.models
            : MODELS).map(spec => this.normalizeModelSpec(spec));

        const transcriptStart = Date.now();
        const transcripts = await this.transcribeAll(audioFiles);
        const transcriptionTimeMs = Date.now() - transcriptStart;

        const transcript = transcripts
            .map(item => item.text)
            .filter(Boolean)
            .join('\n\n');

        const usecase = await usecaseService.getUsecaseById(USECASE_ID);

        const results = await Promise.all(specs.map(async ({ model, version }) => {
            try {
                return await this.runModel(usecase, model, transcript, options, version);
            } catch (error) {
                console.error(`createReport model error (${model} ${version || 'auto'}):`, error.message);
                return {
                    model,
                    version,
                    promptField: this.getPromptField(model, version),
                    output: null,
                    error: error.message,
                    timeMs: null
                };
            }
        }));

        return { transcript, transcripts, transcriptionTimeMs, results };
    }
}

module.exports = new CreateReportService();
