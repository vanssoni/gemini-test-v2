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

const pathways = {
    aws: {
        endpoint: '/api/aws',
        label: 'AWS',
        text: document.getElementById('awsText'),
        time: document.getElementById('awsTime'),
        accuracy: document.getElementById('awsAccuracy'),
        count: document.getElementById('awsCharCount'),
        copy: document.getElementById('copyAws'),
        compareValue(data) {
            return data.interpretationOutput ?? data.output ?? data.interpretationRawOutput;
        },
        sections(data) {
            return [
                ['Final Interpretation Output', data.interpretationOutput ?? data.output ?? data.interpretationRawOutput ?? data.extractorOutput]
            ];
        }
    },
    geminiOpenAi: {
        endpoint: '/api/gemini_openai',
        label: 'Gemini + OpenAI',
        text: document.getElementById('geminiOpenAiText'),
        time: document.getElementById('geminiOpenAiTime'),
        accuracy: document.getElementById('geminiOpenAiAccuracy'),
        count: document.getElementById('geminiOpenAiCharCount'),
        copy: document.getElementById('copyGeminiOpenAi'),
        compareValue(data) {
            return data.extractorOutput ?? data.geminiOutput ?? data.output;
        },
        sections(data) {
            return [
                ['Final Gemini Output', data.geminiOutput ?? data.output ?? data.geminiRawOutput ?? data.extractorOutput]
            ];
        }
    },
    gemini: {
        endpoint: '/api/gemini',
        label: 'Gemini',
        text: document.getElementById('geminiText'),
        time: document.getElementById('geminiTime'),
        accuracy: document.getElementById('geminiAccuracy'),
        count: document.getElementById('geminiCharCount'),
        copy: document.getElementById('copyGemini'),
        compareValue(data) {
            return data.output ?? data.rawOutput;
        },
        sections(data) {
            return [
                ['Final Gemini Output (One Shot)', data.output ?? data.rawOutput]
            ];
        }
    },
    openai: {
        endpoint: '/api/openai',
        label: 'OpenAI',
        text: document.getElementById('openaiText'),
        time: document.getElementById('openaiTime'),
        accuracy: document.getElementById('openaiAccuracy'),
        count: document.getElementById('openaiCharCount'),
        copy: document.getElementById('copyOpenai'),
        compareValue(data) {
            return data.output ?? data.rawOutput;
        },
        sections(data) {
            return [
                ['Final OpenAI Output (One Shot)', data.output ?? data.rawOutput]
            ];
        }
    }
};

let selectedFile = null;
let pdfText = '';
let latestOutputs = {};

uploadButton.addEventListener('click', (event) => {
    event.stopPropagation();
    fileInput.click();
});
fileInput.addEventListener('change', handleFileSelect);
removeButton.addEventListener('click', clearFile);
processButton.addEventListener('click', processFile);
newUploadButton.addEventListener('click', resetToUpload);

dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('drag-over');
});

dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('drag-over');
});

dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('drag-over');

    const files = event.dataTransfer.files;
    if (files.length > 0) {
        handleFile(files[0]);
    }
});

dropzone.addEventListener('click', (event) => {
    if (event.target !== uploadButton && !uploadButton.contains(event.target)) {
        fileInput.click();
    }
});

Object.values(pathways).forEach((pathway) => {
    pathway.copy.addEventListener('click', () => copyToClipboard(pathway.text.textContent, pathway.copy));
});

function handleFileSelect(event) {
    const file = event.target.files[0];
    if (file) {
        handleFile(file);
    }
}

function handleFile(file) {
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    const isImage = file.type.startsWith('image/');

    if (!isPdf && !isImage) {
        alert('Please select a PDF or image file');
        return;
    }

    if (file.size > 20 * 1024 * 1024) {
        alert('File size must be less than 20MB');
        return;
    }

    selectedFile = file;
    fileName.textContent = file.name;
    fileSize.textContent = formatFileSize(file.size);
    dropzone.style.display = 'block';
    fileInfo.style.display = 'block';
}

function clearFile() {
    selectedFile = null;
    fileInput.value = '';
    fileInfo.style.display = 'none';
    dropzone.style.display = 'block';
}

function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function makeFormData() {
    const formData = new FormData();
    formData.append('pdf', selectedFile);
    return formData;
}

async function processFile() {
    if (!selectedFile) return;

    pdfText = '';
    latestOutputs = {};
    uploadSection.style.display = 'none';
    loadingSection.style.display = 'block';
    resultsSection.style.display = 'none';

    resetCardsForRun();

    setTimeout(() => {
        loadingSection.style.display = 'none';
        resultsSection.style.display = 'block';
    }, 100);

    Object.entries(pathways).forEach(([key, pathway]) => {
        runPathway(key, pathway);
    });
}

function resetCardsForRun() {
    Object.values(pathways).forEach((pathway) => {
        pathway.text.innerHTML = '';
        const placeholder = document.createElement('p');
        placeholder.className = 'placeholder-text';
        placeholder.textContent = `Processing ${pathway.label}...`;
        pathway.text.appendChild(placeholder);
        setTime(pathway, '...', true);
        setAccuracy(pathway, 'Accuracy: waiting for PDF text', 'pending');
        pathway.count.textContent = '0 characters';
    });
}

async function runPathway(key, pathway) {
    const startedAt = Date.now();

    try {
        const response = await fetch(pathway.endpoint, {
            method: 'POST',
            body: makeFormData(),
            keepalive: false
        });
        const data = await response.json();

        if (key === 'aws' && data.pdfText) {
            pdfText = data.pdfText;
        }

        latestOutputs[key] = data;
        renderPathway(pathway, data, Date.now() - startedAt);

        if (data.success === false && !pathway.compareValue(data)) {
            setAccuracy(pathway, 'Accuracy: unavailable', 'error');
            return;
        }

        if (pdfText) {
            await comparePathway(key, pathway, data);
            await compareCompletedPathways();
        } else {
            setAccuracy(pathway, 'Accuracy: waiting for PDF text', 'pending');
        }
    } catch (error) {
        console.error(`${pathway.label} error:`, error);
        renderError(pathway, error.message, Date.now() - startedAt);
    }
}

function renderPathway(pathway, data, fallbackTime) {
    pathway.text.innerHTML = '';

    if (data.error && data.success === false) {
        appendError(pathway.text, data.error);
    }

    const sections = pathway.sections(data)
        .filter(([, value]) => value !== undefined && value !== null && value !== '');

    if (sections.length === 0) {
        const placeholder = document.createElement('p');
        placeholder.className = 'placeholder-text';
        placeholder.textContent = `${pathway.label} returned no output`;
        pathway.text.appendChild(placeholder);
    } else {
        sections.forEach(([title, value]) => appendSection(pathway.text, title, value));
    }

    const visibleText = pathway.text.textContent || '';
    pathway.count.textContent = `${visibleText.length.toLocaleString()} characters`;
    setTime(pathway, formatTime(data.time ?? fallbackTime), data.success !== false);
}

function renderError(pathway, message, time) {
    pathway.text.innerHTML = '';
    appendError(pathway.text, message);
    pathway.count.textContent = '0 characters';
    setTime(pathway, formatTime(time), false);
    setAccuracy(pathway, 'Accuracy: unavailable', 'error');
}

function appendSection(container, title, value) {
    const section = document.createElement('div');
    section.className = 'output-section';

    const label = document.createElement('div');
    label.className = 'output-label';
    label.textContent = title;

    const pre = document.createElement('pre');
    pre.className = 'output-pre';
    pre.textContent = stringifyOutput(value);

    section.appendChild(label);
    section.appendChild(pre);
    container.appendChild(section);
}

function appendError(container, message) {
    const box = document.createElement('div');
    box.className = 'error-box';

    const title = document.createElement('p');
    title.className = 'error-title';
    title.textContent = 'Error';

    const text = document.createElement('p');
    text.className = 'error-message';
    text.textContent = message || 'Processing failed';

    box.appendChild(title);
    box.appendChild(text);
    container.appendChild(box);
}

async function compareCompletedPathways() {
    await Promise.all(
        Object.entries(latestOutputs)
            .filter(([key, data]) => !data.__compared && pathways[key].compareValue(data))
            .map(([key, data]) => comparePathway(key, pathways[key], data))
    );
}

async function comparePathway(key, pathway, data) {
    const output2 = pathway.compareValue(data);

    if (!pdfText || !output2 || data.__compared) {
        return;
    }

    data.__compared = true;
    setAccuracy(pathway, 'Accuracy: checking...', 'pending');

    try {
        const response = await fetch('/api/compare', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                output1: pdfText,
                output2
            }),
            keepalive: false
        });
        const compareData = await response.json();

        if (!compareData.success || compareData.error) {
            throw new Error(compareData.error || 'Compare failed');
        }

        const accuracy = compareData.data?.accuracy;
        setAccuracy(pathway, `Accuracy: ${accuracy ?? '-'}%`, 'success');
    } catch (error) {
        console.error(`${pathway.label} compare error:`, error);
        data.__compared = false;
        setAccuracy(pathway, 'Accuracy: error', 'error');
    }
}

function setTime(pathway, value, success) {
    const timeValue = pathway.time.querySelector('.time-value');
    timeValue.textContent = value;
    timeValue.style.color = success ? '#48bb78' : '#f5576c';
}

function setAccuracy(pathway, value, state) {
    pathway.accuracy.textContent = value;
    pathway.accuracy.dataset.state = state;
}

function stringifyOutput(value) {
    if (typeof value === 'string') {
        return value;
    }

    try {
        return JSON.stringify(value, null, 2);
    } catch (error) {
        return String(value);
    }
}

function formatTime(ms) {
    if (!Number.isFinite(Number(ms))) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

function resetToUpload() {
    clearFile();
    pdfText = '';
    latestOutputs = {};
    uploadSection.style.display = 'block';
    loadingSection.style.display = 'none';
    resultsSection.style.display = 'none';

    Object.values(pathways).forEach((pathway) => {
        pathway.text.innerHTML = '';
        const placeholder = document.createElement('p');
        placeholder.className = 'placeholder-text';
        placeholder.textContent = `${pathway.label} output will appear here...`;
        pathway.text.appendChild(placeholder);
        setTime(pathway, '-', true);
        setAccuracy(pathway, 'Accuracy: -', 'pending');
        pathway.count.textContent = '0 characters';
    });
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
