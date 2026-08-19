const recorderManager = wx.getRecorderManager();


// 初始化音频上下文

// const gainNode = audioContext.createGain();
// gainNode.connect(audioContext.destination);



import * as g711 from './audioG711';
const g711Codec = new g711.G711Codec();

class AudioRecorder {
  constructor(codec, onStop) {
    this.codec = codec;
    this.onStop = onStop;
    this.frameQueue = [];
    this.resolveNextFrame = null;
    this.resolveStart = null;
    this.rejectStart = null;
    this.stopped = false;
    this.g711Codec = g711Codec; // 使用全局实例
    this.initRecorder();
  }

  initRecorder() {
    // RecorderManager is a singleton. Remove handlers from the previous PTT
    // session so codec switches do not leave old frame queues alive.
    if (recorderManager.offStart) recorderManager.offStart();
    if (recorderManager.offStop) recorderManager.offStop();
    if (recorderManager.offFrameRecorded) recorderManager.offFrameRecorded();
    if (recorderManager.offError) recorderManager.offError();

    recorderManager.onStart(() => {
      console.log('recorder start');
      if (this.resolveStart) {
        this.resolveStart();
        this.resolveStart = null;
        this.rejectStart = null;
      }
    });

    recorderManager.onError((err) => {
      console.error('recorder error:', err);
      // 启动失败：reject start() 的 Promise，让调用方走失败处理
      if (this.rejectStart) {
        this.rejectStart(err);
        this.resolveStart = null;
        this.rejectStart = null;
      }
      // 解除 getNextAudioFrame() 的等待，返回 null 让调用方退出循环
      if (this.resolveNextFrame) {
        this.resolveNextFrame(null);
        this.resolveNextFrame = null;
      }
      if (this.onStop) this.onStop();
    });

    recorderManager.onStop(() => {
      // 解除 getNextAudioFrame() 的等待，返回 null 让调用方退出循环
      if (this.resolveNextFrame) {
        this.resolveNextFrame(null);
        this.resolveNextFrame = null;
      }
      if (this.onStop) this.onStop();
    });

    recorderManager.onFrameRecorded((res) => {
      // stop() 之后到达的帧直接丢弃，避免停止后多发一帧
      if (this.stopped) return;
      if (res.frameBuffer) {
       // console.log('getNextAudioFrame', res.frameBuffer);
        this.frameQueue.push(res.frameBuffer);
        if (this.resolveNextFrame) {
          this.resolveNextFrame(this.frameQueue.shift());
          this.resolveNextFrame = null;
        }
      }
    });
  }

  async getNextAudioFrame() {

    let frame;
    if (this.frameQueue.length > 0) {
      frame = this.frameQueue.shift();
    } else {
      frame = await new Promise((resolve) => {
        this.resolveNextFrame = resolve;
      });
    }

    if (!frame) return null;

    const raw = new Int16Array(frame);
    if (this.codec === 'g711') {
      const encoded = this.g711Codec.encode(raw);
      return { encoded, raw };
    }
    return { encoded: new Uint8Array(frame), raw };
  }

  start() {
    const sampleRate = this.codec === 'opus' ? 16000 : 8000;
    // onStart 才 resolve、onError reject，调用方才能感知启动失败
    return new Promise((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
      recorderManager.start({
        format: 'PCM',
        sampleRate,
        // RecorderManager validates this independently from the raw PCM rate.
        // Actual Opus bitrate is configured in audioOpus.js after PCM capture.
        encodeBitRate: 48000,
        numberOfChannels: 1,
        frameSize: 1,
        duration: 600000, // 最大10分钟，默认60秒
      });
    });
  }

  stop() {
    this.stopped = true;
    recorderManager.stop();
    this.frameQueue = [];
    // 挂起的 getNextAudioFrame() 按 null 返回；停止后到达的帧由 stopped 标志丢弃
    if (this.resolveNextFrame) {
      this.resolveNextFrame(null);
      this.resolveNextFrame = null;
    }
  }
}

function startRecording(codec, onStop) {
  const recorder = new AudioRecorder(codec, onStop);
  return recorder.start().then(() => recorder);
}

function stopRecording(recorder) {
  recorder.stop();
}





module.exports = {
  startRecording,
  stopRecording,

};
