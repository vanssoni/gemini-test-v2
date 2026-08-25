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

// ---------- Tabs ----------
const tabButtons = document.querySelectorAll('.tab-button');
const tabPanels = {
    single: document.getElementById('tabPanelSingle'),
    gold: document.getElementById('tabPanelGold'),
    audio: document.getElementById('tabPanelAudio')
};

tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
        tabButtons.forEach((b) => b.classList.toggle('active', b === btn));
        const target = btn.dataset.tab;
        Object.entries(tabPanels).forEach(([key, panel]) => {
            if (panel) panel.style.display = key === target ? '' : 'none';
        });
        if (target === 'gold' && !goldListLoaded) {
            loadGoldStandards();
        }
    });
});

// ---------- Gold Standard ----------
const GOLD_JOB_KEY = 'goldStandardActiveJobId';
const goldListEl = document.getElementById('goldList');
const goldSelectAll = document.getElementById('goldSelectAll');
const goldSelectedCount = document.getElementById('goldSelectedCount');
const goldRefreshButton = document.getElementById('goldRefreshButton');
const goldRunButton = document.getElementById('goldRunButton');
const goldClearButton = document.getElementById('goldClearButton');
const goldResults = document.getElementById('goldResults');
const goldResultsList = document.getElementById('goldResultsList');

let goldListLoaded = false;
let goldItems = [];
let goldActiveJobId = localStorage.getItem(GOLD_JOB_KEY) || '';
let goldPollingTimer = null;

goldRefreshButton.addEventListener('click', loadGoldStandards);
goldRunButton.addEventListener('click', runSelectedGoldStandards);
goldClearButton.addEventListener('click', clearGoldRun);
goldSelectAll.addEventListener('change', () => {
    goldListEl.querySelectorAll('input[type="checkbox"][data-gold-id]').forEach((cb) => {
        cb.checked = goldSelectAll.checked;
    });
    updateGoldSelectedCount();
});

if (goldActiveJobId) {
    restoreGoldJob();
}

async function loadGoldStandards() {
    goldListLoaded = true;
    goldListEl.innerHTML = '<p class="placeholder-text">Loading gold standard reports...</p>';

    try {
        const response = await fetch(apiUrl('/api/gold-standards'), { cache: 'no-store' });
        const payload = await response.json();
        if (!response.ok || !payload.success) {
            throw new Error(payload.error || 'Failed to load gold standards');
        }
        goldItems = payload.items || [];
        renderGoldList();
    } catch (error) {
        console.error('gold list error:', error);
        goldListEl.innerHTML = '';
        const box = document.createElement('div');
        box.className = 'error-box';
        box.textContent = `Unable to load gold standards: ${error.message}`;
        goldListEl.appendChild(box);
    }
}

function renderGoldList() {
    goldListEl.innerHTML = '';
    if (goldItems.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'placeholder-text';
        empty.textContent = 'No gold standard reports found in the database.';
        goldListEl.appendChild(empty);
        updateGoldSelectedCount();
        return;
    }

    goldItems.forEach((item) => {
        const row = document.createElement('label');
        row.className = 'gold-list-item';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.goldId = item._id;
        cb.addEventListener('change', updateGoldSelectedCount);

        const name = document.createElement('span');
        name.className = 'gold-file-name';
        name.textContent = item.fileName || item._id;

        row.appendChild(cb);
        row.appendChild(name);

        if (item.filePath) {
            const link = document.createElement('a');
            link.className = 'gold-file-link';
            link.href = item.filePath;
            link.target = '_blank';
            link.rel = 'noopener';
            link.textContent = 'view file';
            row.appendChild(link);
        }

        goldListEl.appendChild(row);
    });
    updateGoldSelectedCount();
}

function getSelectedGoldIds() {
    return Array.from(goldListEl.querySelectorAll('input[type="checkbox"][data-gold-id]:checked'))
        .map((cb) => cb.dataset.goldId);
}

function updateGoldSelectedCount() {
    const count = getSelectedGoldIds().length;
    goldSelectedCount.textContent = `${count} selected`;
}

function getSelectedGoldPathway() {
    const checked = document.querySelector('input[name="goldPathway"]:checked');
    return checked ? checked.value : 'aws';
}

async function runSelectedGoldStandards() {
    const ids = getSelectedGoldIds();
    if (ids.length === 0) {
        alert('Select at least one gold standard report');
        return;
    }

    const pathway = getSelectedGoldPathway();
    stopGoldPolling();

    goldRunButton.disabled = true;
    goldResults.style.display = 'block';
    goldResultsList.innerHTML = '<p class="placeholder-text">Starting run...</p>';

    try {
        const response = await fetch(apiUrl('/api/gold-standards/runs'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, pathway })
        });
        const payload = await response.json();
        if (!response.ok || !payload.success || !payload.job?.jobId) {
            throw new Error(payload.error || 'Failed to start gold standard run');
        }

        goldActiveJobId = payload.job.jobId;
        localStorage.setItem(GOLD_JOB_KEY, goldActiveJobId);
        goldClearButton.style.display = '';
        renderGoldJob(payload.job);
        startGoldPolling();
    } catch (error) {
        console.error('gold run error:', error);
        goldResultsList.innerHTML = '';
        const box = document.createElement('div');
        box.className = 'error-box';
        box.textContent = error.message;
        goldResultsList.appendChild(box);
    } finally {
        goldRunButton.disabled = false;
    }
}

async function restoreGoldJob() {
    goldResults.style.display = 'block';
    goldClearButton.style.display = '';
    const found = await fetchAndRenderGoldJob();
    if (!found) {
        clearGoldRun({ deleteServerJob: false });
    }
}

async function fetchAndRenderGoldJob() {
    if (!goldActiveJobId) return false;
    try {
        const response = await fetch(apiUrl(`/api/gold-standards/runs/${encodeURIComponent(goldActiveJobId)}`), {
            cache: 'no-store'
        });
        const payload = await response.json();
        if (response.status === 404 || !payload.success || !payload.job) {
            return false;
        }
        renderGoldJob(payload.job);
        if (isGoldJobFinished(payload.job)) {
            stopGoldPolling();
        } else {
            startGoldPolling();
        }
        return true;
    } catch (error) {
        console.error('gold job fetch error:', error);
        return true;
    }
}

function startGoldPolling() {
    if (!goldActiveJobId || goldPollingTimer) return;
    goldPollingTimer = window.setInterval(async () => {
        const found = await fetchAndRenderGoldJob();
        if (!found) {
            clearGoldRun({ deleteServerJob: false });
        }
    }, POLL_INTERVAL_MS);
}

function stopGoldPolling() {
    if (!goldPollingTimer) return;
    window.clearInterval(goldPollingTimer);
    goldPollingTimer = null;
}

function isGoldJobFinished(job) {
    return (job.reports || []).every((r) => (
        (r.status === 'success' || r.status === 'error') &&
        (r.accuracyStatus === 'success' || r.accuracyStatus === 'error')
    ));
}

function renderGoldJob(job) {
    goldResultsList.innerHTML = '';
    (job.reports || []).forEach((report) => {
        const card = document.createElement('div');
        card.className = 'gold-result-card';

        const header = document.createElement('div');
        header.className = 'gold-result-header';

        const title = document.createElement('div');
        title.className = 'gold-result-title';
        title.textContent = report.fileName || report.goldStandardId;
        header.appendChild(title);

        const meta = document.createElement('div');
        meta.className = 'gold-result-meta';
        meta.appendChild(makePill(report.status, report.status));
        meta.appendChild(makePill(`Time: ${formatTime(report.time)}`, report.status === 'success' ? 'success' : (report.status === 'error' ? 'error' : 'pending')));
        meta.appendChild(makePill(formatAccuracy(report), accuracyPillState(report)));
        header.appendChild(meta);

        card.appendChild(header);

        const body = document.createElement('div');
        body.className = 'gold-result-body';

        if (report.error) {
            const err = document.createElement('div');
            err.className = 'error-box';
            err.textContent = report.error;
            body.appendChild(err);
        }

        if (report.filePath) {
            const fileLink = document.createElement('div');
            fileLink.innerHTML = `<a class="gold-file-link" href="${report.filePath}" target="_blank" rel="noopener">View source file</a>`;
            body.appendChild(fileLink);
        }

        if (report.testsAndConditions !== null && report.testsAndConditions !== undefined) {
            const det = document.createElement('details');
            const sum = document.createElement('summary');
            sum.textContent = 'Stored testsAndConditions (input1)';
            det.appendChild(sum);
            const pre = document.createElement('pre');
            pre.textContent = stringifyOutput(report.testsAndConditions);
            det.appendChild(pre);
            body.appendChild(det);
        }

        if (report.output !== null && report.output !== undefined) {
            const det = document.createElement('details');
            det.open = true;
            const sum = document.createElement('summary');
            sum.textContent = 'Pathway output (input2)';
            det.appendChild(sum);
            const pre = document.createElement('pre');
            pre.textContent = stringifyOutput(report.output);
            det.appendChild(pre);
            body.appendChild(det);
        }

        card.appendChild(body);
        goldResultsList.appendChild(card);
    });
}

function makePill(text, state) {
    const pill = document.createElement('span');
    pill.className = `gold-pill ${state || 'pending'}`;
    pill.textContent = text;
    return pill;
}

function formatAccuracy(report) {
    if (report.accuracyStatus === 'success' && report.accuracy !== null && report.accuracy !== undefined) {
        return `Accuracy: ${report.accuracy}%`;
    }
    if (report.accuracyStatus === 'error') return 'Accuracy: unavailable';
    if (report.status === 'success') return 'Accuracy: comparing...';
    return 'Accuracy: -';
}

function accuracyPillState(report) {
    if (report.accuracyStatus === 'success') return 'success';
    if (report.accuracyStatus === 'error') return 'error';
    return 'pending';
}

async function clearGoldRun(options = {}) {
    const { deleteServerJob = true } = options;
    const jobIdToDelete = goldActiveJobId;
    stopGoldPolling();
    goldActiveJobId = '';
    localStorage.removeItem(GOLD_JOB_KEY);
    goldResultsList.innerHTML = '';
    goldResults.style.display = 'none';
    goldClearButton.style.display = 'none';
    if (deleteServerJob && jobIdToDelete) {
        try {
            await fetch(apiUrl(`/api/gold-standards/runs/${encodeURIComponent(jobIdToDelete)}`), { method: 'DELETE' });
        } catch (error) {
            console.error('gold job delete error:', error);
        }
    }
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


// ---------- Create Report AI (audio) ----------
const audioDropzone = document.getElementById('audioDropzone');
const audioFileInput = document.getElementById('audioFileInput');
const audioUploadButton = document.getElementById('audioUploadButton');
const audioFileInfo = document.getElementById('audioFileInfo');
const audioFileName = document.getElementById('audioFileName');
const audioFileSize = document.getElementById('audioFileSize');
const audioRemoveButton = document.getElementById('audioRemoveButton');
const audioPreview = document.getElementById('audioPreview');
const audioProcessButton = document.getElementById('audioProcessButton');
const audioUploadSection = document.getElementById('audioUploadSection');
const audioLoadingSection = document.getElementById('audioLoadingSection');
const audioLoadingTitle = document.getElementById('audioLoadingTitle');
const audioLoadingText = document.getElementById('audioLoadingText');
const audioResultsSection = document.getElementById('audioResultsSection');
const audioResultsGrid = document.getElementById('audioResultsGrid');
const audioNewUploadButton = document.getElementById('audioNewUploadButton');
const audioTranscriptText = document.getElementById('audioTranscriptText');
const audioTranscriptTime = document.getElementById('audioTranscriptTime');
const audioTranscriptCharCount = document.getElementById('audioTranscriptCharCount');
const audioCopyTranscript = document.getElementById('audioCopyTranscript');

const AUDIO_EXTENSIONS = ['wav', 'mp3', 'm4a', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'flac', 'webm', 'aac'];
const AUDIO_MAX_BYTES = 100 * 1024 * 1024;

let selectedAudioFile = null;
let audioPreviewUrl = null;
let audioElapsedTimer = null;

audioUploadButton.addEventListener('click', (event) => {
    event.stopPropagation();
    audioFileInput.click();
});

audioDropzone.addEventListener('click', (event) => {
    if (event.target === audioUploadButton) return;
    audioFileInput.click();
});

audioFileInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (file) handleAudioFile(file);
});

['dragover', 'dragenter'].forEach((type) => {
    audioDropzone.addEventListener(type, (event) => {
        event.preventDefault();
        audioDropzone.classList.add('dragover');
    });
});

['dragleave', 'drop'].forEach((type) => {
    audioDropzone.addEventListener(type, (event) => {
        event.preventDefault();
        audioDropzone.classList.remove('dragover');
    });
});

audioDropzone.addEventListener('drop', (event) => {
    const file = event.dataTransfer.files[0];
    if (file) handleAudioFile(file);
});

audioRemoveButton.addEventListener('click', (event) => {
    event.stopPropagation();
    clearAudioFile();
});

audioProcessButton.addEventListener('click', runCreateReport);
audioNewUploadButton.addEventListener('click', resetAudioToUpload);
audioCopyTranscript.addEventListener('click', () => {
    copyToClipboard(audioTranscriptText.textContent, audioCopyTranscript);
});

function isAudioFile(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    // Browsers report inconsistent mime types for audio, so accept by extension too.
    return file.type.startsWith('audio/') || file.type.startsWith('video/') || AUDIO_EXTENSIONS.includes(ext);
}

function handleAudioFile(file) {
    if (!isAudioFile(file)) {
        alert('Please select an audio file (wav, mp3, m4a, webm, ogg, flac).');
        return;
    }

    if (file.size > AUDIO_MAX_BYTES) {
        alert('File is too large. Maximum size is 100MB.');
        return;
    }

    selectedAudioFile = file;
    audioFileName.textContent = file.name;
    audioFileSize.textContent = formatFileSize(file.size);
    audioFileSize.style.display = '';
    audioFileInfo.style.display = 'block';

    if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl);
    audioPreviewUrl = URL.createObjectURL(file);
    audioPreview.src = audioPreviewUrl;
    audioPreview.style.display = '';
}

function clearAudioFile() {
    selectedAudioFile = null;
    audioFileInput.value = '';
    audioFileInfo.style.display = 'none';
    audioPreview.style.display = 'none';
    audioPreview.removeAttribute('src');
    if (audioPreviewUrl) {
        URL.revokeObjectURL(audioPreviewUrl);
        audioPreviewUrl = null;
    }
}

function audioOptionValue(id) {
    return (document.getElementById(id).value || '').trim();
}

async function runCreateReport() {
    if (!selectedAudioFile) {
        alert('Please select an audio file first.');
        return;
    }

    const prescriptions = audioOptionValue('audioPrescriptions');
    if (prescriptions) {
        try {
            JSON.parse(prescriptions);
        } catch (error) {
            alert('Prescriptions must be valid JSON.');
            return;
        }
    }

    const formData = new FormData();
    formData.append('audio', selectedAudioFile);

    const optionalFields = {
        reportType: 'audioReportType',
        clinicianSpeciality: 'audioClinicianSpeciality',
        referenceRanges: 'audioReferenceRanges',
        customInstructions: 'audioCustomInstructions',
        reportStructure: 'audioReportStructure',
        existingText: 'audioExistingText',
        prescriptions: 'audioPrescriptions'
    };

    for (const [field, elementId] of Object.entries(optionalFields)) {
        const value = audioOptionValue(elementId);
        if (value) formData.append(field, value);
    }

    showAudioLoading();

    try {
        const response = await fetch(apiUrl('/api/create-report'), {
            method: 'POST',
            body: formData
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.error || `Request failed with status ${response.status}`);
        }

        renderAudioResults(data);
    } catch (error) {
        console.error('create-report error:', error);
        renderAudioError(error.message);
    } finally {
        stopAudioElapsedTimer();
    }
}

// The endpoint is synchronous, so there is nothing to poll — just show how long
// the single request has been running.
function showAudioLoading() {
    audioUploadSection.style.display = 'none';
    audioResultsSection.style.display = 'none';
    audioLoadingSection.style.display = '';

    const startedAt = Date.now();
    audioLoadingTitle.textContent = 'Transcribing and generating...';
    audioLoadingText.textContent = 'Whisper, then gpt-4.1 and gpt-5.6-sol';

    stopAudioElapsedTimer();
    audioElapsedTimer = setInterval(() => {
        audioLoadingText.textContent =
            `Whisper, then gpt-4.1 and gpt-5.6-sol - ${formatTime(Date.now() - startedAt)} elapsed`;
    }, 500);
}

function stopAudioElapsedTimer() {
    if (audioElapsedTimer) {
        clearInterval(audioElapsedTimer);
        audioElapsedTimer = null;
    }
}

function renderAudioResults(data) {
    audioLoadingSection.style.display = 'none';
    audioResultsSection.style.display = '';

    const transcript = data.transcript || '';
    audioTranscriptText.textContent = transcript;
    audioTranscriptCharCount.textContent = `${transcript.length} characters`;
    audioTranscriptTime.querySelector('.time-value').textContent = formatTime(data.transcriptionTimeMs);

    audioResultsGrid.innerHTML = '';
    for (const result of (data.results || [])) {
        audioResultsGrid.appendChild(buildAudioResultCard(result));
    }
}

function buildAudioResultCard(result) {
    const card = document.createElement('div');
    card.className = 'result-card';

    const output = result.error ? '' : stringifyOutput(result.output || '');
    const usage = result.usage
        ? `${result.usage.prompt_tokens ?? '-'} in / ${result.usage.completion_tokens ?? '-'} out tokens`
        : '';

    const header = document.createElement('div');
    header.className = 'result-header';
    header.innerHTML = `
        <div class="result-title-group">
            <div class="result-icon"></div>
            <div>
                <h3 class="result-title"></h3>
                <p class="result-subtitle">Create Report AI</p>
            </div>
        </div>
        <div class="result-header-actions">
            <div class="result-time">
                <span class="time-label">Time:</span>
                <span class="time-value"></span>
            </div>
        </div>`;
    // Colour + label the badge by model family so the two cards read apart at a glance.
    const majorVersion = (result.model.match(/^gpt-(\d+)/) || [])[1];
    const icon = header.querySelector('.result-icon');
    icon.classList.add(majorVersion === '4' ? 'model-4-icon' : 'model-5-icon');
    icon.textContent = majorVersion ? `G${majorVersion}` : 'AI';
    header.querySelector('.result-title').textContent = result.model;
    header.querySelector('.time-value').textContent = formatTime(result.timeMs);
    if (usage) {
        header.querySelector('.result-subtitle').textContent = usage;
    }
    card.appendChild(header);

    const content = document.createElement('div');
    content.className = 'result-content';
    const text = document.createElement('div');
    text.className = 'result-text';

    if (result.error) {
        const errorBox = document.createElement('p');
        errorBox.className = 'placeholder-text';
        errorBox.textContent = `Error: ${result.error}`;
        text.appendChild(errorBox);
    } else {
        text.textContent = output;
    }

    content.appendChild(text);
    card.appendChild(content);

    const footer = document.createElement('div');
    footer.className = 'result-footer';
    const copyButton = document.createElement('button');
    copyButton.className = 'copy-button';
    copyButton.innerHTML = '<span class="copy-icon">⧉</span><span>Copy Output</span>';
    copyButton.addEventListener('click', () => copyToClipboard(output, copyButton));
    const charCount = document.createElement('div');
    charCount.className = 'char-count';
    charCount.textContent = `${output.length} characters`;
    footer.appendChild(copyButton);
    footer.appendChild(charCount);
    card.appendChild(footer);

    return card;
}

function renderAudioError(message) {
    audioLoadingSection.style.display = 'none';
    audioResultsSection.style.display = '';

    audioTranscriptText.textContent = '';
    const errorBox = document.createElement('p');
    errorBox.className = 'placeholder-text';
    errorBox.textContent = `Error: ${message}`;
    audioTranscriptText.appendChild(errorBox);
    audioTranscriptCharCount.textContent = '0 characters';
    audioTranscriptTime.querySelector('.time-value').textContent = '-';
    audioResultsGrid.innerHTML = '';
}

function resetAudioToUpload() {
    stopAudioElapsedTimer();
    audioResultsSection.style.display = 'none';
    audioLoadingSection.style.display = 'none';
    audioUploadSection.style.display = '';
    clearAudioFile();
}
