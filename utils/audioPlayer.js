// audioPlayer.js
// Realtime PCM playback via scheduled BufferSourceNodes.
//
// Previously this used ScriptProcessorNode + a hand-written sinc resampler.
// ScriptProcessor callbacks run on the WeChat main thread, which on iOS
// could not keep up (setData storms, decoders) — dropped callbacks made the
// hardware repeat blocks, heard as constant hiss. Scheduling buffers lets
// the engine resample and render on the audio thread instead; WeChat does
// not support AudioWorklet, so this is the only off-main-thread option.
console.log('audioPlayer.js loaded');

import * as g711 from './audioG711';

const DEFAULT_SAMPLE_RATE = 8000;
const MAX_INPUT_SAMPLE_RATE = 16000;
// How far ahead of currentTime new audio is scheduled. This is the jitter
// buffer: larger tolerates more network/main-thread jitter, at the cost of
// playback latency.
const TARGET_LATENCY_SEC = 0.2;
// Re-anchor the timeline when the scheduled headroom falls below this
// (late packets after an underrun or a stream gap).
const MIN_AHEAD_SEC = 0.06;
// Senders with a fast clock push the timeline ever further ahead; past this
// latency, drop a packet to pull back instead of growing delay unbounded.
const MAX_LATENCY_SEC = 0.5;
const STREAM_GAP_RESET_MS = 500;

let isWebAudioInitialized = false;
let activeInputSampleRate = DEFAULT_SAMPLE_RATE;
let activeStreamId = null;
let nextStartTime = 0; // context time when the next packet starts; 0 = unanchored
let lastPacketArrivalAt = 0;
let underrunCount = 0;
let droppedPacketCount = 0;
let scheduledPacketCount = 0;
const activeSources = new Set();

const webAudioContext = wx.createWebAudioContext();
const gainNode = webAudioContext.createGain();
gainNode.connect(webAudioContext.destination);
// Was 2.5, which clips loud speech at the DAC on iOS (crackling/distortion).
gainNode.gain.value = 1.0;

const g711Codec = new g711.G711Codec();

function initWebAudio() {
    if (isWebAudioInitialized) return;

    try {
        let lastContextState = null;
        webAudioContext.onstatechange = () => {
            const state = webAudioContext.state;
            console.log('AudioContext state changed to:', state);
            // Sources scheduled before a suspension hold stale audio; drop
            // them when the context recovers so playback restarts clean.
            // Plain 'running' transitions (first start, duplicate events)
            // must NOT clear freshly scheduled audio.
            const recoveredFromInterruption =
                state === 'running' &&
                (lastContextState === 'suspended' || lastContextState === 'interrupted');
            if (recoveredFromInterruption) {
                resetJitterBuffer();
                console.log('Scheduled audio cleared after interruption.');
            }
            lastContextState = state;
        };

        wx.onAudioInterruptionEnd(() => {
            webAudioContext.resume().then(() => {
                console.log('AudioContext resumed app.');
            }).catch((err) => {
                console.error('Failed to resume AudioContext:', err);
            });
        });

        isWebAudioInitialized = true;
        console.log('Web Audio initialized successfully. Context sampleRate:', webAudioContext.sampleRate);
    } catch (err) {
        console.error('Failed to initialize Web Audio:', err);
    }
}

function suspend() {
    webAudioContext.suspend().then(() => {
        console.log('AudioContext suspend.');
    }).catch((err) => {
        console.error('Failed to suspend AudioContext:', err);
    });
    resetJitterBuffer();
}

function clearBuffer() {
    resetJitterBuffer();
}

function resume() {
    if (isRunning()) return;

    webAudioContext.resume().then(() => {
        console.log('AudioContext resume.');
    }).catch((err) => {
        console.error('Failed to resume AudioContext:', err);
    });
    resetJitterBuffer();
}

function getState() {
    return webAudioContext.state;
}

function isRunning() {
    return webAudioContext.state === 'running';
}

// Receive G.711 data and decode it. Kept for compatibility with old callers.
async function play(data, type) {
    if (type !== 1) return;

    const pcmData = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) {
        pcmData[i] = g711Codec.alaw2linear(data[i]);
    }
    playPCM(pcmData);
}

function playPCM(pcmData, options = {}) {
    if (!pcmData || pcmData.length === 0) return;

    const now = Date.now();
    const inputSampleRate = Number(options.sampleRate) || DEFAULT_SAMPLE_RATE;
    if (inputSampleRate <= 0 || inputSampleRate > MAX_INPUT_SAMPLE_RATE) {
        console.warn(`Unsupported PCM sample rate: ${inputSampleRate}`);
        return;
    }
    const streamId = options.streamId == null ? null : String(options.streamId);

    if (
        (streamId !== null && activeStreamId !== null && streamId !== activeStreamId) ||
        (nextStartTime > 0 && activeInputSampleRate !== inputSampleRate) ||
        (lastPacketArrivalAt > 0 && now - lastPacketArrivalAt > STREAM_GAP_RESET_MS)
    ) {
        resetJitterBuffer({ keepStreamId: true });
    }
    if (streamId !== null) activeStreamId = streamId;
    activeInputSampleRate = inputSampleRate;
    lastPacketArrivalAt = now;

    const currentTime = webAudioContext.currentTime;

    // Anchor (or re-anchor after an underrun/gap) one latency-target ahead.
    if (nextStartTime < currentTime + MIN_AHEAD_SEC) {
        if (nextStartTime > 0) underrunCount++;
        nextStartTime = currentTime + TARGET_LATENCY_SEC;
    }

    // Fast-clock sender: skip this packet's 20 ms of audio. The timeline
    // stays continuous, so this is a tiny splice every ~20 s at 1.5% drift
    // instead of ever-growing latency.
    if (nextStartTime > currentTime + MAX_LATENCY_SEC) {
        droppedPacketCount++;
        return;
    }

    const buffer = webAudioContext.createBuffer(1, pcmData.length, inputSampleRate);
    const channelData = buffer.getChannelData(0);
    for (let i = 0; i < pcmData.length; i++) {
        channelData[i] = Math.max(-1, Math.min(1, pcmData[i] / 32768.0));
    }

    const source = webAudioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(gainNode);
    source.onended = () => activeSources.delete(source);
    activeSources.add(source);
    source.start(nextStartTime);
    nextStartTime += pcmData.length / inputSampleRate;
    scheduledPacketCount++;
}

function resetJitterBuffer({ keepStreamId = false } = {}) {
    for (const source of activeSources) {
        try {
            source.stop();
        } catch (err) {
            // Already ended; harmless.
        }
    }
    activeSources.clear();
    nextStartTime = 0;
    activeInputSampleRate = DEFAULT_SAMPLE_RATE;
    lastPacketArrivalAt = 0;
    if (!keepStreamId) activeStreamId = null;
}

function getBufferStats() {
    const currentTime = webAudioContext.currentTime;
    return {
        bufferedMs: Math.round(Math.max(0, nextStartTime - currentTime) * 1000),
        activeSources: activeSources.size,
        scheduledPacketCount,
        droppedPacketCount,
        underrunCount,
        sampleRate: activeInputSampleRate,
        contextState: webAudioContext.state,
        contextSampleRate: webAudioContext.sampleRate,
    };
}

module.exports = {
    initWebAudio,
    play,
    playPCM,
    suspend,
    resume,
    clearBuffer,
    resetJitterBuffer,
    getBufferStats,
    getState,
    isRunning,
};
