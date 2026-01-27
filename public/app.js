// DOM Elements
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const uploadButton = document.getElementById('uploadButton');
const fileInfo = document.getElementById('fileInfo');
const fileName = document.getElementById('fileName');
const fileSize = document.getElementById('fileSize');
const removeButton = document.getElementById('removeButton');
const processButton = document.getElementById('processButton');
const uploadSection = document.getElementById('uploadSection');
const loadingSection = document.getElementById('loadingSection');
const resultsSection = document.getElementById('resultsSection');
const newUploadButton = document.getElementById('newUploadButton');

const geminiText = document.getElementById('geminiText');
const geminiTime = document.getElementById('geminiTime');
const geminiCharCount = document.getElementById('geminiCharCount');
const copyGemini = document.getElementById('copyGemini');

const textractText = document.getElementById('textractText');
const textractTime = document.getElementById('textractTime');
const textractCharCount = document.getElementById('textractCharCount');
const copyTextract = document.getElementById('copyTextract');

const extractorText = document.getElementById('extractorText');
const extractorTime = document.getElementById('extractorTime');
const extractorCharCount = document.getElementById('extractorCharCount');
const copyExtractor = document.getElementById('copyExtractor');

// Interpretation elements
const geminiInterpText = document.getElementById('geminiInterpText');
const geminiInterpTime = document.getElementById('geminiInterpTime');
const geminiInterpCharCount = document.getElementById('geminiInterpCharCount');
const copyGeminiInterp = document.getElementById('copyGeminiInterp');

const extractorInterpText = document.getElementById('extractorInterpText');
const extractorInterpTime = document.getElementById('extractorInterpTime');
const extractorInterpCharCount = document.getElementById('extractorInterpCharCount');
const copyExtractorInterp = document.getElementById('copyExtractorInterp');

// Image preview elements
const imagePreviewSection = document.getElementById('imagePreviewSection');
const imagePreviewGrid = document.getElementById('imagePreviewGrid');
const imageCount = document.getElementById('imageCount');

// Prompt Editor Elements
const editPromptButton = document.getElementById('editPromptButton');
const headerEditPromptButton = document.getElementById('headerEditPromptButton');
const promptModal = document.getElementById('promptModal');
const closeModal = document.getElementById('closeModal');
const promptTextarea = document.getElementById('promptTextarea');
const savePrompt = document.getElementById('savePrompt');
const cancelPrompt = document.getElementById('cancelPrompt');
const resetPrompt = document.getElementById('resetPrompt');

let selectedFile = null;

// Default Gemini prompt
const DEFAULT_GEMINI_PROMPT = "You are a ultrahigh-precision Medical Report Extractor AI. Your job is to convert the provided medical report (PDF and/or images and/or text) into a final JSON using the highest level of medical understanding across all fields of Medicine.GOAL- Extract and organize ALL medically relevant information present in the report, including content embedded in tables, multi-column layouts, stamps, headers/footers when they contain relevant identifiers/metadata, and image-only regions (e.g., scan snapshots, graphs, tables rendered as images).- Do NOT summarize or interpret clinically. Do NOT infer missing values. Do NOT add new facts.- Do NOT duplicate information. Each distinct observation/result should appear exactly once in the correct location.- Preserve original wording for impressions/diagnoses/recommendations/medication; preserve exact numeric values, units and names.CRITICAL OUTPUT RULES1) Output MUST be a single valid JSON object and nothing else (no markdown, no commentary).2) If a field is absent in the source, use: \"\" (empty string), null, or [] (empty array). Never invent values.3) Numeric values must be numeric in JSON when clearly numeric in the report (e.g., 5.2, 120, 3.4e3). If the report expresses a value as text (e.g., \"Negative\"), keep as a string.5) Do not add comments (//) anywhere in the JSON.MULTIMODAL / LAYOUT RULES (PDFs, images, tables)- Treat the document as ground truth. Use native visual understanding to read images, scans, tests, tables, columnar sections, and image-only regions.- TABLES: Preserve row/column relationships. Map each row to its correct test/finding. Keep \"date/time\" aligned with the correct result. Do not shift values between analytes.- GRAPHS/CHARTS: If an image shows plotted values (e.g., trends), extract any explicitly labeled numeric values, axis labels, and dates. If values aren't explicitly readable, record a concise description in test_findings_observations (e.g., \"Graph present; numeric points not legible\").- MULTI-PAGE: Extract across all pages; do not stop early.- DUPLICATES: If the same result appears in multiple places (e.g., summary + detailed table), keep the most detailed representation once; note alternate locations in test_findings_observations only if necessary.WHAT COUNTS AS \"MEDICALLY RELEVANT\"Include:- Patient identifiers and demographics (as present).- Report identifiers and metadata (facility, clinician, department, specimen, accession/report ID, collection/received/reported times).- ALL results: lab results, values, vitals, measurements, observations, imaging measurements, qualitative findings (e.g., \"Reactive/Non-reactive\", \"Positive/Negative\"), organism names, sensitivities, staging scores, etc.- Reference ranges (normal ranges) exactly as printed (including age/sex-specific ranges if shown).- Units exactly as printed.- Flags/indicators (test, chronic, acute) if present.- Methodology/instrument/test kit names only if they are tied to results or interpretation (place in otherMetadata or observations).- Clinical history, complaints, indications, technique, contrast details, radiation dose notes if stated.- Imaging narrative: Findings + Impression + any structured measurements.- Recommendations / Plan / Medicines / Follow-up instructions.Do NOT include:- Marketing boilerplate, generic lab disclaimers, privacy notices, billing text, unrelated informational pamphlets—unless they contain patient/report identifiers or result-specific caveats.DATE/TIME HANDLING- For each result, if the report provides a specific date/time for that result (collection time, performed time, observation time) and it differs from dateOfReport, include it under test_findings_date.- If multiple timestamps exist (Collected/Received/Reported), store them with clear labels, and also use test findings date where directly tied to an individual result.MAPPING GUIDANCE- If the document has multiple sections (e.g., Hematology, Biochemistry, Lipid Profile, Urine, Radiology), create separate sections.- For Imaging:  - Put each meaningful finding/measurement as an entry.QUALITY / CONSISTENCY CHECK (SILENT)Before outputting JSON:- Ensure every value/finding/result found is represented once.- Ensure units and reference ranges are attached to the correct analyte.- Ensure no repeated duplicates across sections.- Ensure JSON is valid and has no comments \"//\" in it.Now produce the final output JSON.";
const PROMPT_STORAGE_KEY = 'gemini_custom_prompt';

// Event Listeners
uploadButton.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
});
fileInput.addEventListener('change', handleFileSelect);
removeButton.addEventListener('click', clearFile);
processButton.addEventListener('click', processFile);
newUploadButton.addEventListener('click', resetToUpload);

// Prompt Editor Listeners
editPromptButton.addEventListener('click', openPromptModal);
headerEditPromptButton.addEventListener('click', openPromptModal);
closeModal.addEventListener('click', closePromptModal);
cancelPrompt.addEventListener('click', closePromptModal);
savePrompt.addEventListener('click', saveCustomPrompt);
resetPrompt.addEventListener('click', resetToDefaultPrompt);

// Close modal on overlay click
promptModal.addEventListener('click', (e) => {
    if (e.target === promptModal) {
        closePromptModal();
    }
});

// Drag and Drop
dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
});

dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('drag-over');
});

dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');

    const files = e.dataTransfer.files;
    if (files.length > 0) {
        handleFile(files[0]);
    }
});

dropzone.addEventListener('click', (e) => {
    // Don't trigger if clicking on the button
    if (e.target !== uploadButton && !uploadButton.contains(e.target)) {
        fileInput.click();
    }
});

// Copy buttons
copyGemini.addEventListener('click', () => copyToClipboard(geminiText.textContent, copyGemini));
copyTextract.addEventListener('click', () => copyToClipboard(textractText.textContent, copyTextract));
copyExtractor.addEventListener('click', () => copyToClipboard(extractorText.textContent, copyExtractor));
copyGeminiInterp.addEventListener('click', () => copyToClipboard(geminiInterpText.textContent, copyGeminiInterp));
copyExtractorInterp.addEventListener('click', () => copyToClipboard(extractorInterpText.textContent, copyExtractorInterp));

// Initialize
loadCustomPrompt();

// Functions
function handleFileSelect(e) {
    const file = e.target.files[0];
    if (file) {
        handleFile(file);
    }
}

function handleFile(file) {
    if (file.type !== 'application/pdf') {
        alert('Please select a PDF file');
        return;
    }

    if (file.size > 20 * 1024 * 1024) {
        alert('File size must be less than 20MB');
        return;
    }

    selectedFile = file;
    fileName.textContent = file.name;
    fileSize.textContent = formatFileSize(file.size);

    dropzone.style.display = 'none';
    fileInfo.style.display = 'block';
}

function clearFile() {
    selectedFile = null;
    fileInput.value = '';
    dropzone.style.display = 'block';
    fileInfo.style.display = 'none';
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

async function processFile() {
    if (!selectedFile) return;

    // Show loading briefly
    uploadSection.style.display = 'none';
    loadingSection.style.display = 'block';
    resultsSection.style.display = 'none';

    // Show results section immediately
    setTimeout(() => {
        loadingSection.style.display = 'none';
        resultsSection.style.display = 'block';
    }, 100);

    // Reset all results to loading state
    geminiText.innerHTML = '<p class="placeholder-text">Processing with Gemini...</p>';
    textractText.innerHTML = '<p class="placeholder-text">Processing with Textract...</p>';
    extractorText.innerHTML = '<p class="placeholder-text">Waiting for Textract...</p>';
    geminiInterpText.innerHTML = '<p class="placeholder-text">Waiting for Gemini...</p>';
    extractorInterpText.innerHTML = '<p class="placeholder-text">Waiting for Extractor...</p>';

    geminiTime.querySelector('.time-value').textContent = '...';
    textractTime.querySelector('.time-value').textContent = '...';
    extractorTime.querySelector('.time-value').textContent = '...';
    geminiInterpTime.querySelector('.time-value').textContent = '...';
    extractorInterpTime.querySelector('.time-value').textContent = '...';

    // Get custom prompt from localStorage
    const customPrompt = getCustomPrompt();

    // Create FormData for Gemini with custom prompt
    const formDataGemini = new FormData();
    formDataGemini.append('pdf', selectedFile);
    if (customPrompt) {
        formDataGemini.append('prompt', customPrompt);
    }

    // Create separate FormData for Textract
    const formDataTextract = new FormData();
    formDataTextract.append('pdf', selectedFile);

    // Flow 1: Gemini -> Gemini Interpretation (independent)
    processGeminiFlow(formDataGemini);

    // Flow 2: Textract -> Extractor -> Extractor Interpretation (chained)
    processTextractFlow(formDataTextract);
}

// Gemini Flow: Gemini -> Gemini Interpretation
async function processGeminiFlow(formData) {
    try {
        // Step 1: Call Gemini API (no timeout - AI can take several minutes)
        const geminiResponse = await fetch('/api/extract/gemini', {
            method: 'POST',
            body: formData,
            keepalive: false // Allow long-running requests
        });
        const geminiData = await geminiResponse.json();
        displayGeminiResult(geminiData);

        // Step 2: If Gemini succeeded, call Interpretation
        if (geminiData.success && geminiData.text) {
            geminiInterpText.innerHTML = '<p class="placeholder-text">Processing interpretation...</p>';

            const interpResponse = await fetch('/api/interpret', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: geminiData.text }),
                keepalive: false
            });
            const interpData = await interpResponse.json();
            displayGeminiInterpResult(interpData);
        } else {
            displayGeminiInterpResult({
                success: false,
                error: geminiData.error || 'Gemini extraction failed'
            });
        }
    } catch (error) {
        console.error('Gemini flow error:', error);
        displayGeminiResult({ success: false, error: error.message });
        displayGeminiInterpResult({ success: false, error: 'Gemini extraction failed' });
    }
}

// Textract Flow: Textract -> Extractor -> Extractor Interpretation
async function processTextractFlow(formData) {
    try {
        // Step 1: Call Textract API (no timeout - can take several minutes)
        const textractResponse = await fetch('/api/extract/textract', {
            method: 'POST',
            body: formData,
            keepalive: false
        });
        const textractData = await textractResponse.json();
        displayTextractResult(textractData);

        // Step 2: If Textract succeeded, call Extractor
        if (textractData.success && textractData.text) {
            extractorText.innerHTML = '<p class="placeholder-text">Processing with Extractor AI...</p>';

            const extractorResponse = await fetch('/api/extract/extractor', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: textractData.text }),
                keepalive: false
            });
            const extractorData = await extractorResponse.json();
            displayExtractorResult(extractorData);

            // Step 3: If Extractor succeeded, call Interpretation
            if (extractorData.success && extractorData.text) {
                extractorInterpText.innerHTML = '<p class="placeholder-text">Processing interpretation...</p>';

                const interpResponse = await fetch('/api/interpret', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: extractorData.text }),
                    keepalive: false
                });
                const interpData = await interpResponse.json();
                displayExtractorInterpResult(interpData);
            } else {
                displayExtractorInterpResult({
                    success: false,
                    error: extractorData.error || 'Extractor processing failed'
                });
            }
        } else {
            displayExtractorResult({ success: false, error: textractData.error || 'Textract extraction failed' });
            displayExtractorInterpResult({ success: false, error: 'Textract extraction failed' });
        }
    } catch (error) {
        console.error('Textract flow error:', error);
        displayTextractResult({ success: false, error: error.message });
        displayExtractorResult({ success: false, error: 'Textract extraction failed' });
        displayExtractorInterpResult({ success: false, error: 'Textract extraction failed' });
    }
}

function displayGeminiResult(data) {
    // Display images first (even if there's an error, show converted images)
    if (data.images && data.images.length > 0) {
        displayGridImages(data.images);
    } else {
        imagePreviewSection.style.display = 'none';
    }

    if (!data.success || data.error) {
        const errorMsg = formatErrorMessage(data.error, 'Gemini');
        geminiText.innerHTML = `<div class="error-box"><p class="error-title">❌ Error</p><p class="error-message">${errorMsg}</p></div>`;
        geminiTime.querySelector('.time-value').textContent = data.time ? formatTime(data.time) : 'Failed';
        geminiTime.querySelector('.time-value').style.color = '#f5576c';
        geminiCharCount.textContent = '0 characters';
    } else {
        geminiText.textContent = data.text || 'No text extracted';
        geminiTime.querySelector('.time-value').textContent = formatTime(data.time);
        geminiTime.querySelector('.time-value').style.color = '#48bb78';
        geminiCharCount.textContent = `${data.text.length.toLocaleString()} characters`;
    }
}

function displayGridImages(images) {
    imagePreviewSection.style.display = 'block';
    imageCount.textContent = `${images.length} image${images.length > 1 ? 's' : ''}`;
    imagePreviewGrid.innerHTML = '';

    images.forEach((base64, index) => {
        const container = document.createElement('div');
        container.className = 'preview-image-container';

        const img = document.createElement('img');
        img.src = `data:image/png;base64,${base64}`;
        img.className = 'preview-image';
        img.alt = `Grid ${index + 1}`;
        img.title = `Click to open Grid ${index + 1} in new tab`;
        img.onclick = () => openImageInNewTab(base64, `Grid ${index + 1}`);

        const label = document.createElement('div');
        label.className = 'preview-image-label';
        label.textContent = `Grid ${index + 1}`;

        container.appendChild(img);
        container.appendChild(label);
        imagePreviewGrid.appendChild(container);
    });
}

// Open image in new tab using blob URL (works better than base64)
function openImageInNewTab(base64, title) {
    // Convert base64 to blob
    const byteString = atob(base64);
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
    }
    const blob = new Blob([ab], { type: 'image/png' });
    const blobUrl = URL.createObjectURL(blob);

    // Open in new tab
    const newTab = window.open(blobUrl, '_blank');
    if (newTab) {
        newTab.document.title = title;
    }
}

function displayTextractResult(data) {
    if (!data.success || data.error) {
        const errorMsg = formatErrorMessage(data.error, 'Textract');
        textractText.innerHTML = `<div class="error-box"><p class="error-title">❌ Error</p><p class="error-message">${errorMsg}</p></div>`;
        textractTime.querySelector('.time-value').textContent = data.time ? formatTime(data.time) : 'Failed';
        textractTime.querySelector('.time-value').style.color = '#f5576c';
        textractCharCount.textContent = '0 characters';
    } else {
        textractText.textContent = data.text || 'No text extracted';
        textractTime.querySelector('.time-value').textContent = formatTime(data.time);
        textractTime.querySelector('.time-value').style.color = '#48bb78';
        textractCharCount.textContent = `${data.text.length.toLocaleString()} characters`;
    }
}

function displayExtractorResult(data) {
    if (!data.success || data.error) {
        const errorMsg = formatErrorMessage(data.error, 'Extractor AI');
        extractorText.innerHTML = `<div class="error-box"><p class="error-title">❌ Error</p><p class="error-message">${errorMsg}</p></div>`;
        extractorTime.querySelector('.time-value').textContent = data.time ? formatTime(data.time) : 'Failed';
        extractorTime.querySelector('.time-value').style.color = '#f5576c';
        extractorCharCount.textContent = '0 characters';
    } else {
        extractorText.textContent = data.text || 'No data extracted';
        extractorTime.querySelector('.time-value').textContent = formatTime(data.time);
        extractorTime.querySelector('.time-value').style.color = '#48bb78';
        extractorCharCount.textContent = `${data.text.length.toLocaleString()} characters`;
    }
}

function displayGeminiInterpResult(data) {
    if (!data.success || data.error) {
        const errorMsg = formatErrorMessage(data.error, 'Interpretation');
        geminiInterpText.innerHTML = `<div class="error-box"><p class="error-title">❌ Error</p><p class="error-message">${errorMsg}</p></div>`;
        geminiInterpTime.querySelector('.time-value').textContent = data.time ? formatTime(data.time) : 'Failed';
        geminiInterpTime.querySelector('.time-value').style.color = '#f5576c';
        geminiInterpCharCount.textContent = '0 characters';
    } else {
        geminiInterpText.textContent = data.text || 'No interpretation';
        geminiInterpTime.querySelector('.time-value').textContent = formatTime(data.time);
        geminiInterpTime.querySelector('.time-value').style.color = '#48bb78';
        geminiInterpCharCount.textContent = `${data.text.length.toLocaleString()} characters`;
    }
}

function displayExtractorInterpResult(data) {
    if (!data.success || data.error) {
        const errorMsg = formatErrorMessage(data.error, 'Interpretation');
        extractorInterpText.innerHTML = `<div class="error-box"><p class="error-title">❌ Error</p><p class="error-message">${errorMsg}</p></div>`;
        extractorInterpTime.querySelector('.time-value').textContent = data.time ? formatTime(data.time) : 'Failed';
        extractorInterpTime.querySelector('.time-value').style.color = '#f5576c';
        extractorInterpCharCount.textContent = '0 characters';
    } else {
        extractorInterpText.textContent = data.text || 'No interpretation';
        extractorInterpTime.querySelector('.time-value').textContent = formatTime(data.time);
        extractorInterpTime.querySelector('.time-value').style.color = '#48bb78';
        extractorInterpCharCount.textContent = `${data.text.length.toLocaleString()} characters`;
    }
}

// Show raw error messages from AI/server directly
function formatErrorMessage(error, serviceName) {
    if (!error) return `${serviceName} processing failed`;
    return error;
}

function formatTime(ms) {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

function resetToUpload() {
    clearFile();
    uploadSection.style.display = 'block';
    loadingSection.style.display = 'none';
    resultsSection.style.display = 'none';

    // Reset all results
    geminiText.innerHTML = '<p class="placeholder-text">Extracted text will appear here...</p>';
    textractText.innerHTML = '<p class="placeholder-text">Extracted text will appear here...</p>';
    extractorText.innerHTML = '<p class="placeholder-text">Extracted text will appear here...</p>';
    geminiInterpText.innerHTML = '<p class="placeholder-text">Interpreted result will appear here...</p>';
    extractorInterpText.innerHTML = '<p class="placeholder-text">Interpreted result will appear here...</p>';

    geminiTime.querySelector('.time-value').textContent = '-';
    textractTime.querySelector('.time-value').textContent = '-';
    extractorTime.querySelector('.time-value').textContent = '-';
    geminiInterpTime.querySelector('.time-value').textContent = '-';
    extractorInterpTime.querySelector('.time-value').textContent = '-';

    geminiCharCount.textContent = '0 characters';
    textractCharCount.textContent = '0 characters';
    extractorCharCount.textContent = '0 characters';
    geminiInterpCharCount.textContent = '0 characters';
    extractorInterpCharCount.textContent = '0 characters';

    // Reset image preview
    imagePreviewSection.style.display = 'none';
    imagePreviewGrid.innerHTML = '';
}

async function copyToClipboard(text, button) {
    try {
        await navigator.clipboard.writeText(text);

        const originalHTML = button.innerHTML;
        button.innerHTML = '<span class="copy-icon">✓</span><span>Copied!</span>';
        button.classList.add('copied');

        setTimeout(() => {
            button.innerHTML = originalHTML;
            button.classList.remove('copied');
        }, 2000);
    } catch (error) {
        console.error('Failed to copy:', error);
        alert('Failed to copy text to clipboard');
    }
}

// Prompt Management Functions
function loadCustomPrompt() {
    const savedPrompt = localStorage.getItem(PROMPT_STORAGE_KEY);
    if (savedPrompt) {
        promptTextarea.value = savedPrompt;
    } else {
        promptTextarea.value = DEFAULT_GEMINI_PROMPT;
    }
}

function getCustomPrompt() {
    return localStorage.getItem(PROMPT_STORAGE_KEY) || null;
}

function openPromptModal() {
    loadCustomPrompt();
    promptModal.style.display = 'flex';
}

function closePromptModal() {
    promptModal.style.display = 'none';
}

function saveCustomPrompt() {
    const newPrompt = promptTextarea.value.trim();
    if (newPrompt) {
        localStorage.setItem(PROMPT_STORAGE_KEY, newPrompt);
        closePromptModal();
        // Show success feedback
        const originalText = editPromptButton.innerHTML;
        editPromptButton.innerHTML = '<span>✓</span>';
        setTimeout(() => {
            editPromptButton.innerHTML = originalText;
        }, 2000);
    } else {
        alert('Prompt cannot be empty');
    }
}

function resetToDefaultPrompt() {
    promptTextarea.value = DEFAULT_GEMINI_PROMPT;
    localStorage.removeItem(PROMPT_STORAGE_KEY);
}
