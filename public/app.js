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
const loadingTitle = document.querySelector('.loading-title');
const loadingText = document.querySelector('.loading-text');

const ACTIVE_JOB_KEY = 'reportComparisonActiveJobId';
const POLL_INTERVAL_MS = 3000;
const API_BASE_URL = (
    window.location.protocol === 'file:' || window.location.port === '5500'
        ? 'http://127.0.0.1:3004'
        : ''
).replace(/\/$/, '');

const pathways = {
    aws: {
        label: 'AWS',
        text: document.getElementById('awsText'),
        time: document.getElementById('awsTime'),
        accuracy: document.getElementById('awsAccuracy'),
        count: document.getElementById('awsCharCount'),
        copy: document.getElementById('copyAws'),
        sections(data) {
            return [
                ['Final Interpretation Output', data?.interpretationOutput ?? data?.output ?? data?.interpretationRawOutput ?? data?.extractorOutput]
            ];
        }
    },
    geminiOpenAi: {
        label: 'Gemini + OpenAI',
        text: document.getElementById('geminiOpenAiText'),
        time: document.getElementById('geminiOpenAiTime'),
        accuracy: document.getElementById('geminiOpenAiAccuracy'),
        count: document.getElementById('geminiOpenAiCharCount'),
        copy: document.getElementById('copyGeminiOpenAi'),
        sections(data) {
            return [
                ['Final Gemini Output', data?.geminiOutput ?? data?.output ?? data?.geminiRawOutput ?? data?.extractorOutput]
            ];
        }
    },
    gemini: {
        label: 'Gemini',
        text: document.getElementById('geminiText'),
        time: document.getElementById('geminiTime'),
        accuracy: document.getElementById('geminiAccuracy'),
        count: document.getElementById('geminiCharCount'),
        copy: document.getElementById('copyGemini'),
        sections(data) {
            return [
                ['Final Gemini Output (One Shot)', data?.output ?? data?.rawOutput]
            ];
        }
    },
    openai: {
        label: 'OpenAI',
        text: document.getElementById('openaiText'),
        time: document.getElementById('openaiTime'),
        accuracy: document.getElementById('openaiAccuracy'),
        count: document.getElementById('openaiCharCount'),
        copy: document.getElementById('copyOpenai'),
        sections(data) {
            return [
                ['Final OpenAI Output (One Shot)', data?.output ?? data?.rawOutput]
            ];
        }
    }
};

let selectedFile = null;
let activeJobId = localStorage.getItem(ACTIVE_JOB_KEY) || '';
let pollingTimer = null;

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

restoreActiveJob();

function apiUrl(path) {
    return `${API_BASE_URL}${path}`;
}

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
    fileInfo.style.display = 'block';
    dropzone.style.display = 'block';
}

function clearFile() {
    selectedFile = null;
    fileInput.value = '';
    fileInfo.style.display = 'none';
}

function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function makeFormData(previousJobId) {
    const formData = new FormData();
    formData.append('pdf', selectedFile);

    if (previousJobId) {
        formData.append('previousJobId', previousJobId);
    }

    return formData;
}

async function processFile() {
    if (!selectedFile) {
        return;
    }

    stopPolling();
    showLoadingState('Preparing file...', 'Starting all report pathways');
    resetCardsForRun();

    const previousJobId = activeJobId;

    try {
        const response = await fetch(apiUrl('/api/reports'), {
            method: 'POST',
            body: makeFormData(previousJobId),
            keepalive: false
        });
        const payload = await response.json();

        if (!response.ok || !payload.success || !payload.job?.jobId) {
            throw new Error(payload.error || 'Failed to create report job');
        }

        activeJobId = payload.job.jobId;
        localStorage.setItem(ACTIVE_JOB_KEY, activeJobId);

        showResultsState();
        renderJob(payload.job);
        startPolling();
    } catch (error) {
        console.error('report job create error:', error);
        showResultsState();
        renderGlobalError(error.message);
        clearStoredJob();
    }
}

async function restoreActiveJob() {
    if (!activeJobId) {
        resetCardsToEmpty();
        return;
    }

    resetCardsForRun();
    showLoadingState('Restoring last report...', 'Checking saved report progress');

    const found = await fetchAndRenderActiveJob();
    if (!found) {
        resetToUpload({ deleteServerJob: false });
    }
}

async function fetchAndRenderActiveJob() {
    if (!activeJobId) {
        return false;
    }

    try {
        const response = await fetch(apiUrl(`/api/reports/${encodeURIComponent(activeJobId)}`), {
            method: 'GET',
            cache: 'no-store'
        });
        const payload = await response.json();

        if (response.status === 404 || !payload.success || !payload.job) {
            return false;
        }

        showResultsState();
        renderJob(payload.job);

        if (isJobFinished(payload.job)) {
            stopPolling();
        } else {
            startPolling();
        }

        return true;
    } catch (error) {
        console.error('report job fetch error:', error);
        showResultsState();
        renderGlobalError('Unable to load the saved report right now');
        return true;
    }
}

function startPolling() {
    if (!activeJobId || pollingTimer) {
        return;
    }

    pollingTimer = window.setInterval(async () => {
        const found = await fetchAndRenderActiveJob();
        if (!found) {
            resetToUpload({ deleteServerJob: false });
        }
    }, POLL_INTERVAL_MS);
}

function stopPolling() {
    if (!pollingTimer) {
        return;
    }

    window.clearInterval(pollingTimer);
    pollingTimer = null;
}

function renderJob(job) {
    Object.entries(pathways).forEach(([key, pathway]) => {
        const state = job.pathways?.[key];
        renderPathwayState(pathway, state);
    });
}

function renderPathwayState(pathway, state) {
    if (!state || state.status === 'pending' || state.status === 'running') {
        renderPending(pathway, state?.status || 'pending');
        return;
    }

    if (state.status === 'error') {
        renderError(pathway, state.error || 'Processing failed', state.time);
        return;
    }

    renderSuccess(pathway, state);
}

function renderPending(pathway, status) {
    pathway.text.innerHTML = '';

    const placeholder = document.createElement('p');
    placeholder.className = 'placeholder-text';
    placeholder.textContent = status === 'running'
        ? `Processing ${pathway.label}...`
        : `${pathway.label} is queued...`;

    pathway.text.appendChild(placeholder);
    pathway.count.textContent = '0 characters';
    setTime(pathway, status === 'running' ? '...' : '-', true);
    setAccuracy(pathway, 'Accuracy: waiting for PDF text', 'pending');
}

function renderSuccess(pathway, state) {
    pathway.text.innerHTML = '';

    const data = state.data || {};

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
    setTime(pathway, formatTime(state.time), true);
    applyAccuracyState(pathway, state);
}

function applyAccuracyState(pathway, state) {
    if (state.accuracyStatus === 'success' && state.accuracy !== null) {
        setAccuracy(pathway, `Accuracy: ${state.accuracy}%`, 'success');
        return;
    }

    if (state.accuracyStatus === 'error') {
        setAccuracy(pathway, 'Accuracy: unavailable', 'error');
        return;
    }

    setAccuracy(pathway, 'Accuracy: waiting for PDF text', 'pending');
}

function renderError(pathway, message, time) {
    pathway.text.innerHTML = '';
    appendError(pathway.text, message);
    pathway.count.textContent = '0 characters';
    setTime(pathway, formatTime(time), false);
    setAccuracy(pathway, 'Accuracy: unavailable', 'error');
}

function renderGlobalError(message) {
    Object.values(pathways).forEach((pathway) => renderError(pathway, message, 0));
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
    if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

async function resetToUpload(options = {}) {
    const { deleteServerJob = true } = options;
    const jobIdToDelete = activeJobId;

    stopPolling();
    clearFile();
    clearStoredJob();

    uploadSection.style.display = 'block';
    loadingSection.style.display = 'none';
    resultsSection.style.display = 'none';

    resetCardsToEmpty();

    if (deleteServerJob && jobIdToDelete) {
        try {
            await fetch(apiUrl(`/api/reports/${encodeURIComponent(jobIdToDelete)}`), {
                method: 'DELETE'
            });
        } catch (error) {
            console.error('report job delete error:', error);
        }
    }
}

function clearStoredJob() {
    activeJobId = '';
    localStorage.removeItem(ACTIVE_JOB_KEY);
}

function resetCardsForRun() {
    Object.values(pathways).forEach((pathway) => renderPending(pathway, 'running'));
}

function resetCardsToEmpty() {
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

function showLoadingState(title, message) {
    uploadSection.style.display = 'none';
    loadingSection.style.display = 'block';
    resultsSection.style.display = 'none';
    loadingTitle.textContent = title;
    loadingText.textContent = message;
}

function showResultsState() {
    uploadSection.style.display = 'none';
    loadingSection.style.display = 'none';
    resultsSection.style.display = 'block';
}

function isJobFinished(job) {
    return Object.values(job.pathways || {}).every((pathway) => (
        pathway.status === 'success' || pathway.status === 'error'
    ));
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
