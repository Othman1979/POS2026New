const elements = {
    start: document.querySelector('#start'),
    talk: document.querySelector('#talk'),
    stop: document.querySelector('#stop'),
    language: document.querySelector('#language'),
    status: document.querySelector('#status'),
    statusDot: document.querySelector('#status-dot'),
    callId: document.querySelector('#call-id'),
    orderState: document.querySelector('#order-state'),
    youSaid: document.querySelector('#you-said'),
    geminiSaid: document.querySelector('#gemini-said'),
    diagnostics: document.querySelector('#diagnostics'),
    error: document.querySelector('#error'),
};

class BrowserAudio {
    constructor(onPcm) {
        this.onPcm = onPcm;
        this.context = null;
        this.stream = null;
        this.worklet = null;
        this.sources = new Set();
        this.nextStartTime = 0;
    }

    async initialize() {
        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
        });
        this.context = new AudioContext();
        await this.context.audioWorklet.addModule('/pcm-capture-worklet.js');
        const source = this.context.createMediaStreamSource(this.stream);
        this.worklet = new AudioWorkletNode(this.context, 'pcm-capture');
        this.worklet.port.onmessage = event => {
            const downsampled = this.downsample(event.data, this.context.sampleRate, 16_000);
            this.onPcm(this.toPcm16(downsampled));
        };
        const mute = this.context.createGain();
        mute.gain.value = 0;
        source.connect(this.worklet);
        this.worklet.connect(mute);
        mute.connect(this.context.destination);
        await this.context.resume();
    }

    setRecording(recording) {
        if (recording && this.context?.state === 'suspended') void this.context.resume();
        this.worklet?.port.postMessage({ recording });
    }

    playPcm(arrayBuffer) {
        if (!this.context) return false;
        if (this.context.state === 'suspended') void this.context.resume();
        // Bound actual queued speech, not packet count: Gemini can split a short
        // reply into hundreds of tiny PCM messages.
        if (this.nextStartTime - this.context.currentTime > 45) return false;
        const view = new DataView(arrayBuffer);
        const samples = new Float32Array(Math.floor(view.byteLength / 2));
        for (let index = 0; index < samples.length; index += 1) {
            samples[index] = view.getInt16(index * 2, true) / 32768;
        }
        const buffer = this.context.createBuffer(1, samples.length, 24_000);
        buffer.copyToChannel(samples, 0);
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.context.destination);
        const now = this.context.currentTime;
        this.nextStartTime = Math.max(now, this.nextStartTime);
        source.start(this.nextStartTime);
        this.nextStartTime += buffer.duration;
        this.sources.add(source);
        source.onended = () => this.sources.delete(source);
        return true;
    }

    stopPlayback() {
        for (const source of this.sources) {
            try { source.stop(); } catch { /* Source already stopped. */ }
        }
        this.sources.clear();
        if (this.context) this.nextStartTime = this.context.currentTime;
    }

    downsample(input, inputRate, outputRate) {
        if (inputRate === outputRate) return input;
        const ratio = inputRate / outputRate;
        const output = new Float32Array(Math.round(input.length / ratio));
        let inputOffset = 0;
        for (let outputOffset = 0; outputOffset < output.length; outputOffset += 1) {
            const nextInputOffset = Math.min(input.length, Math.round((outputOffset + 1) * ratio));
            let total = 0;
            let count = 0;
            for (; inputOffset < nextInputOffset; inputOffset += 1) {
                total += input[inputOffset];
                count += 1;
            }
            output[outputOffset] = count ? total / count : 0;
        }
        return output;
    }

    toPcm16(input) {
        const output = new ArrayBuffer(input.length * 2);
        const view = new DataView(output);
        input.forEach((sample, index) => {
            const bounded = Math.max(-1, Math.min(1, sample));
            view.setInt16(index * 2, bounded < 0 ? bounded * 32768 : bounded * 32767, true);
        });
        return output;
    }

    async close() {
        this.setRecording(false);
        this.stopPlayback();
        this.worklet?.disconnect();
        this.stream?.getTracks().forEach(track => track.stop());
        await this.context?.close();
        this.context = null;
        this.stream = null;
        this.worklet = null;
    }
}

let socket = null;
let audio = null;
let ready = false;
let speaking = false;
let committedInputTranscript = '';
let interimInputTranscript = '';
let turnDiagnostics = { chunks: 0, firstTranscriptMs: null, transcriptTiming: null, firstAudioMs: null };

function setStatus(text, state = '') {
    elements.status.textContent = text;
    elements.statusDot.className = `status-dot ${state}`.trim();
}

function setError(message = '') {
    elements.error.textContent = message;
}

function appendTranscript(element, text, placeholder) {
    if (!text) return;
    if (element.textContent === placeholder) element.textContent = '';
    element.textContent += text;
}

function renderInputTranscript() {
    const text = [committedInputTranscript, interimInputTranscript].filter(Boolean).join(' ');
    elements.youSaid.textContent = text || 'Your live transcript will appear here.';
}

function renderDiagnostics() {
    const values = [`Mic chunks: ${turnDiagnostics.chunks}`];
    if (turnDiagnostics.firstTranscriptMs != null) {
        const label = turnDiagnostics.transcriptTiming === 'while_speaking' ? 'live text' : 'final text after release';
        values.push(`${label}: ${turnDiagnostics.firstTranscriptMs} ms`);
    }
    if (turnDiagnostics.firstAudioMs != null) values.push(`first reply audio: ${turnDiagnostics.firstAudioMs} ms`);
    elements.diagnostics.textContent = values.join(' • ');
}

function sendControl(type) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type }));
}

function beginSpeaking(event) {
    event?.preventDefault();
    if (!ready || speaking) return;
    speaking = true;
    audio.stopPlayback();
    interimInputTranscript = '';
    turnDiagnostics = { chunks: 0, firstTranscriptMs: null, transcriptTiming: null, firstAudioMs: null };
    renderInputTranscript();
    renderDiagnostics();
    sendControl('turn_start');
    audio.setRecording(true);
    elements.talk.classList.add('speaking');
    setStatus('Listening…', 'ready');
    setError();
}

function endSpeaking(event) {
    event?.preventDefault();
    if (!speaking) return;
    speaking = false;
    audio.setRecording(false);
    sendControl('audio_end');
    elements.talk.classList.remove('speaking');
    setStatus('Thinking…', 'busy');
}

async function stopSession() {
    endSpeaking();
    ready = false;
    elements.talk.disabled = true;
    elements.stop.disabled = true;
    const endingSocket = socket;
    socket = null;
    endingSocket?.close(1000, 'User ended session');
    const endingAudio = audio;
    audio = null;
    await endingAudio?.close();
    elements.start.disabled = false;
    elements.language.disabled = false;
    setStatus('Not connected');
}

async function startSession() {
    elements.start.disabled = true;
    elements.language.disabled = true;
    setError();
    committedInputTranscript = '';
    interimInputTranscript = '';
    renderInputTranscript();
    elements.geminiSaid.textContent = 'The spoken reply transcript will appear here.';
    elements.callId.textContent = '';
    elements.orderState.textContent = 'No held order has been created in this call.';
    setStatus('Requesting microphone…', 'busy');
    try {
        audio = new BrowserAudio(pcm => {
            if (!speaking || socket?.readyState !== WebSocket.OPEN) return;
            if (socket.bufferedAmount > 256 * 1024) {
                endSpeaking();
                setError('Audio could not be sent quickly enough. Please try that turn again.');
                return;
            }
            socket.send(pcm);
            turnDiagnostics.chunks += 1;
            if (turnDiagnostics.chunks === 1 || turnDiagnostics.chunks % 25 === 0) renderDiagnostics();
        });
        await audio.initialize();
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const language = encodeURIComponent(elements.language.value);
        const sessionSocket = new WebSocket(`${protocol}//${location.host}/voice?language=${language}`);
        socket = sessionSocket;
        sessionSocket.binaryType = 'arraybuffer';
        sessionSocket.onopen = () => {
            if (socket === sessionSocket) setStatus('Connecting to Gemini Live…', 'busy');
        };
        sessionSocket.onmessage = event => {
            if (socket !== sessionSocket) return;
            if (event.data instanceof ArrayBuffer) {
                if (!audio.playPcm(event.data)) {
                    void stopSession().then(() => {
                        setStatus('Session ended', 'error');
                        setError('Audio playback fell behind. Check the held-order status before repeating the order.');
                    });
                }
                return;
            }
            const message = JSON.parse(event.data);
            if (message.type === 'session') {
                elements.callId.textContent = `Call ${message.callId}`;
            } else if (message.type === 'ready') {
                ready = true;
                elements.talk.disabled = false;
                elements.stop.disabled = false;
                setStatus('Ready — hold to speak', 'ready');
            } else if (message.type === 'reconnecting' || message.type === 'disconnected' || message.type === 'go_away') {
                ready = false;
                speaking = false;
                audio.setRecording(false);
                audio.stopPlayback();
                elements.talk.disabled = true;
                setStatus('Reconnecting…', 'busy');
            } else if (message.type === 'listening') {
                setStatus('Listening…', 'ready');
            } else if (message.type === 'thinking') {
                setStatus('Thinking…', 'busy');
                turnDiagnostics.chunks = message.audioChunks ?? turnDiagnostics.chunks;
                renderDiagnostics();
            } else if (message.type === 'input_transcript_interim') {
                interimInputTranscript = message.text;
                if (message.firstTranscriptMs != null) turnDiagnostics.firstTranscriptMs = message.firstTranscriptMs;
                turnDiagnostics.transcriptTiming = message.transcriptTiming || 'while_speaking';
                renderInputTranscript();
                renderDiagnostics();
            } else if (message.type === 'input_transcript') {
                committedInputTranscript = [committedInputTranscript, message.text].filter(Boolean).join(' ');
                interimInputTranscript = '';
                if (message.firstTranscriptMs != null) turnDiagnostics.firstTranscriptMs = message.firstTranscriptMs;
                turnDiagnostics.transcriptTiming = message.transcriptTiming || 'after_release';
                renderInputTranscript();
                renderDiagnostics();
            } else if (message.type === 'output_transcript') {
                appendTranscript(elements.geminiSaid, message.text, 'The spoken reply transcript will appear here.');
            } else if (message.type === 'interrupted') {
                audio.stopPlayback();
            } else if (message.type === 'first_audio') {
                turnDiagnostics.firstAudioMs = message.firstAudioMs;
                renderDiagnostics();
            } else if (message.type === 'tool_status') {
                setStatus(message.state === 'started' ? 'Checking POSApp…' : 'Preparing reply…', 'busy');
            } else if (message.type === 'order_status') {
                const labels = {
                    staff_required: 'Staff assistance is required. This local session cannot transfer the call.',
                    completed: 'Held order saved for cashier review.',
                    pending: 'Confirmed order delivery is still being reconciled. Do not enter it again.',
                    handoff_locked: 'Confirmed order needs staff reconciliation. Do not enter it again.',
                    blocked: 'Confirmed order needs manual review before any replacement is entered.',
                    requote_required: 'The order needs an updated quote and a new customer confirmation.',
                };
                elements.orderState.textContent = labels[message.state] || `Order state: ${message.state}`;
            } else if (message.type === 'turn_complete') {
                if (!speaking) setStatus('Ready — hold to speak', 'ready');
            } else if (message.type === 'error') {
                setError(message.message);
            } else if (message.type === 'fatal') {
                ready = false;
                elements.talk.disabled = true;
                setStatus('Session ended', 'error');
                setError(message.message);
            }
        };
        sessionSocket.onerror = () => {
            if (socket === sessionSocket) setError('The local voice connection failed.');
        };
        sessionSocket.onclose = () => {
            if (socket !== sessionSocket) return;
            socket = null;
            ready = false;
            speaking = false;
            const endedAudio = audio;
            audio = null;
            void endedAudio?.close();
            elements.talk.disabled = true;
            elements.stop.disabled = true;
            elements.start.disabled = false;
            elements.language.disabled = false;
            if (elements.status.textContent !== 'Session ended') setStatus('Disconnected', 'error');
        };
    } catch (error) {
        await audio?.close();
        audio = null;
        elements.start.disabled = false;
        elements.language.disabled = false;
        setStatus('Unable to start', 'error');
        setError(error.message || 'Microphone access failed.');
    }
}

elements.start.addEventListener('click', startSession);
elements.stop.addEventListener('click', stopSession);
elements.talk.addEventListener('pointerdown', event => {
    beginSpeaking(event);
    try { elements.talk.setPointerCapture(event.pointerId); } catch { /* Synthetic pointer events have no active pointer. */ }
});
elements.talk.addEventListener('pointerup', endSpeaking);
elements.talk.addEventListener('pointercancel', endSpeaking);
window.addEventListener('keydown', event => {
    if (event.code === 'Space' && !event.repeat && event.target === document.body) beginSpeaking(event);
});
window.addEventListener('keyup', event => {
    if (event.code === 'Space') endSpeaking(event);
});
window.addEventListener('beforeunload', () => {
    socket?.close();
    audio?.stream?.getTracks().forEach(track => track.stop());
});
