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

    getModel(temperature = 0.1, model = "gemini-3-pro-preview", systemInstruction = null, safetySettings = null) {
        const config = {
            ...this.modelConfig,
            model,
            generationConfig: { temperature },
        };
        if (safetySettings) {
            config.safetySettings = safetySettings;
        }
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
     * @param {Array} safetySettings - Optional custom safety settings
     * @param {number} temperature - Generation temperature
     * @param {string} modelName - Model name to use
     * @returns {Promise<{text: string, images: string[], error: string|null}>} Extracted text, images, and error if any
     */
    async extractTextFromPDF(fileBuffer, customPrompt = null, safetySettings = null, temperature = 0.1 , modelName = 'gemini-3-pro-preview') {
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

            // Use custom prompt if provided, otherwise use default
            const prompt = customPrompt || `You are a ultrahigh-precision Medical Report Extractor AI. Your job is to convert the provided medical report (PDF and/or images and/or text) into a final JSON using the highest level of medical understanding across all fields of Medicine.

GOAL
- Extract and organize ALL medically relevant information present in the report, including content embedded in tables/tabular form, multi-column layouts, stamps, headers/footers when they contain relevant identifiers/metadata, and image-only regions (e.g., scan snapshots, graphs, tables rendered as images).
- Do NOT summarize or interpret clinically. Do NOT infer missing values. Do NOT add new facts.
- Do NOT duplicate information. Each distinct observation/result should appear exactly once in the correct location.
- Preserve original wording for impressions/diagnoses/recommendations/medication; preserve exact numeric values, units and names.

CRITICAL OUTPUT RULES
1) Output MUST be a single valid JSON object and nothing else (no markdown, no commentary).
2) If a field is absent in the source, use: "" (empty string), null, or [] (empty array). Never invent values.
3) Numeric values must be numeric in JSON when clearly numeric in the report (e.g., 5.2, 120, 3.4e3). If the report expresses a value as text (e.g., “Negative”), keep as a string.
5) Do not add comments (//) anywhere in the JSON.

MULTIMODAL / LAYOUT RULES (PDFs, images, tables)
- Treat the document as ground truth. Use native visual understanding to read images, scans, tests, tables, columnar sections, and image-only regions.
- TABLES: Preserve row/column relationships. Map each row to its correct test/finding. Keep “date/time” aligned with the correct result. Do not shift values between analytes.
- GRAPHS/CHARTS: If an image shows plotted values (e.g., trends), extract any explicitly labeled numeric values, axis labels, and dates. If values aren’t explicitly readable, record a concise description in test_findings_observations (e.g., “Graph present; numeric points not legible”).
- MULTI-PAGE: Extract across all pages; do not stop early.
- DUPLICATES: If the same result appears in multiple places (e.g., summary + detailed table), keep the most detailed representation once; note alternate locations in test_findings_observations only if necessary.

WHAT COUNTS AS “MEDICALLY RELEVANT”
Include:
- Patient identifiers and demographics (as present).
- Report identifiers and metadata (facility, clinician, department, specimen, accession/report ID, collection/received/reported times).
- ALL results: lab results, values, vitals, measurements, observations, imaging measurements, qualitative findings (e.g., “Reactive/Non-reactive”, “Positive/Negative”), organism names, sensitivities, staging scores, etc.
- Reference ranges (normal ranges) exactly as printed (including age/sex-specific ranges if shown).
- Units exactly as printed.
- Flags/indicators (test, chronic, acute) if present.
- Methodology/instrument/test kit names only if they are tied to results or interpretation (place in otherMetadata or observations).
- Clinical history, complaints, indications, technique, contrast details, radiation dose notes if stated.
- Imaging narrative: Findings + Impression + any structured measurements.
- Recommendations / Plan / Medicines / Follow-up instructions.

Do NOT include:
- Marketing boilerplate, generic lab disclaimers, privacy notices, billing text, unrelated informational pamphlets—unless they contain patient/report identifiers or result-specific caveats.

DATE/TIME HANDLING
- For each result, if the report provides a specific date/time for that result (collection time, performed time, observation time) and it differs from dateOfReport, include it under test_findings_date.
- If multiple timestamps exist (Collected/Received/Reported), store them with clear labels, and also use test findings date where directly tied to an individual result.

MAPPING GUIDANCE
- If the document has multiple sections (e.g., Hematology, Biochemistry, Lipid Profile, Urine, Radiology), create separate sections.
- For Imaging:
  - Put each meaningful finding/measurement as an entry.

QUALITY / CONSISTENCY CHECK (SILENT)
Before outputting JSON:
- Ensure every value/finding/result found is represented once.
- Ensure units and reference ranges are attached to the correct analyte.
- Ensure no repeated duplicates across sections.
- Ensure JSON is valid and has no comments "//" in it.

Now produce the final output JSON.
JSON SCHEMA:
  {
  "name": "", #String
  "gender": "Male",
  "age": null, #Number
  "clientId": "",
  "dob": "DD/MM/YYYY",
  "dateOfReport": "2021-11-28T13:26:00Z", // Discharge Date, or Report Date, or Document Date
  "reportTitle": "Complete Blood Count & Thyroid Panel", // Example  Report Title
  "physicians": ["Dr. Amit"]
  "ethnicity": "",
  "additionalDetails": {
      // e.g., height, weight, insurance, etc.
  },
  {
  "reportMetadata": {
    "reportTitle": "",
    "labOrHospitalName": "",
    "dateOfReport": "", // Discharge Date, or Report Date, or Document Date. Usually in Date/Month/Year format
    "doctorName": "",
    "department": "",
    "sampleType": "",
    "reportId": "",
    "otherMetadata": {
      // e.g., technician name, location, reference numbers
    }
  },
  "reports": [
    {
      "report_type": "",
      "details": [
        {
          "test_or_finding_name": "",
          "test_findings_values": "",
          "units": "",
          "reference_range": "",
          "test_findings_observations": "",
          "test_findings_date": [
            // Only fill in if test finding value date is different from report date
          ]
        }
        // Repeat to capture all test_findings as needed
      ]
    }
    // Additional "reports" objects as needed for each test/findings etc.
  ],
  "diagnoses_or_impressions": [
    // Any explicit diagnoses or impressions exactly as stated
  ],
  "recommendations_or_plan": [
    // Recommended actions, treatments, or follow-ups
  ]
}

}

If the PDF does not contain any medical-related data, then return the following JSON:
{
  "isInvalidPdf": true
}`;

            console.log(`Sending ${imageParts.length} combined images to Gemini... (temperature: ${temperature})`);

            // Use the prompt as system instruction instead of in the generateContent array
            const model = this.getModel(temperature, modelName, prompt, safetySettings);

            let lastError;
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    // Start content generation (notice the prompt is omitted here since it's the system instruction)
                    const result = await model.generateContent([...imageParts]);
                    const response = await result.response;
                    const text = response.text();
                    return { text, images: base64Images, error: null };
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
            return { text: null, images: base64Images, error: `Gemini extraction failed: ${error.message}` };
        }
    }
}

module.exports = new GeminiHelper();
