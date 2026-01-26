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
            const prompt = customPrompt || "You are a ultrahigh-precision Medical Report Extractor AI. Your job is to convert the provided medical report (PDF and/or images and/or text) into a final JSON using the highest level of medical understanding across all fields of Medicine.GOAL- Extract and organize ALL medically relevant information present in the report, including content embedded in tables, multi-column layouts, stamps, headers/footers when they contain relevant identifiers/metadata, and image-only regions (e.g., scan snapshots, graphs, tables rendered as images).- Do NOT summarize or interpret clinically. Do NOT infer missing values. Do NOT add new facts.- Do NOT duplicate information. Each distinct observation/result should appear exactly once in the correct location.- Preserve original wording for impressions/diagnoses/recommendations/medication; preserve exact numeric values, units and names.CRITICAL OUTPUT RULES1) Output MUST be a single valid JSON object and nothing else (no markdown, no commentary).2) If a field is absent in the source, use: \"\" (empty string), null, or [] (empty array). Never invent values.3) Numeric values must be numeric in JSON when clearly numeric in the report (e.g., 5.2, 120, 3.4e3). If the report expresses a value as text (e.g., \"Negative\"), keep as a string.5) Do not add comments (//) anywhere in the JSON.MULTIMODAL / LAYOUT RULES (PDFs, images, tables)- Treat the document as ground truth. Use native visual understanding to read images, scans, tests, tables, columnar sections, and image-only regions.- TABLES: Preserve row/column relationships. Map each row to its correct test/finding. Keep \"date/time\" aligned with the correct result. Do not shift values between analytes.- GRAPHS/CHARTS: If an image shows plotted values (e.g., trends), extract any explicitly labeled numeric values, axis labels, and dates. If values aren't explicitly readable, record a concise description in test_findings_observations (e.g., \"Graph present; numeric points not legible\").- MULTI-PAGE: Extract across all pages; do not stop early.- DUPLICATES: If the same result appears in multiple places (e.g., summary + detailed table), keep the most detailed representation once; note alternate locations in test_findings_observations only if necessary.WHAT COUNTS AS \"MEDICALLY RELEVANT\"Include:- Patient identifiers and demographics (as present).- Report identifiers and metadata (facility, clinician, department, specimen, accession/report ID, collection/received/reported times).- ALL results: lab results, values, vitals, measurements, observations, imaging measurements, qualitative findings (e.g., \"Reactive/Non-reactive\", \"Positive/Negative\"), organism names, sensitivities, staging scores, etc.- Reference ranges (normal ranges) exactly as printed (including age/sex-specific ranges if shown).- Units exactly as printed.- Flags/indicators (test, chronic, acute) if present.- Methodology/instrument/test kit names only if they are tied to results or interpretation (place in otherMetadata or observations).- Clinical history, complaints, indications, technique, contrast details, radiation dose notes if stated.- Imaging narrative: Findings + Impression + any structured measurements.- Recommendations / Plan / Medicines / Follow-up instructions.Do NOT include:- Marketing boilerplate, generic lab disclaimers, privacy notices, billing text, unrelated informational pamphlets—unless they contain patient/report identifiers or result-specific caveats.DATE/TIME HANDLING- For each result, if the report provides a specific date/time for that result (collection time, performed time, observation time) and it differs from dateOfReport, include it under test_findings_date.- If multiple timestamps exist (Collected/Received/Reported), store them with clear labels, and also use test findings date where directly tied to an individual result.MAPPING GUIDANCE- If the document has multiple sections (e.g., Hematology, Biochemistry, Lipid Profile, Urine, Radiology), create separate sections.- For Imaging:  - Put each meaningful finding/measurement as an entry.QUALITY / CONSISTENCY CHECK (SILENT)Before outputting JSON:- Ensure every value/finding/result found is represented once.- Ensure units and reference ranges are attached to the correct analyte.- Ensure no repeated duplicates across sections.- Ensure JSON is valid and has no comments \"//\" in it.Now produce the final output JSON.";

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
