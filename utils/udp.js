export class UDPClient {
  constructor({ host, port, onMessage }) {
    this.host = host;
    this.port = port;
    this.onMessage = onMessage;
    this.closed = false;
    this.retryTimer = null;
    this.retryCount = 0;
    this.maxRetries = 5;
    this.socket = null;
    this.messageHandler = null;
    this.initSocket();
  }

  initSocket() {
    if (this.closed) return;

    // 重试前关闭旧 socket，避免句柄泄漏
    if (this.socket) {
      try { this.socket.close(); } catch (e) {}
      this.socket = null;
    }

    try {
      this.socket = wx.createUDPSocket();
      this.socket.bind();
      this.messageHandler = (res) => {
        // 单条畸形报文只记日志，不中断后续收包
        try {
          this.onMessage(res.message);
        } catch (err) {
          console.error('UDP 报文处理失败:', err);
        }
      };
      this.socket.onMessage(this.messageHandler);
      if (this.socket.onError) {
        this.socket.onError((err) => {
          console.error('UDP socket 错误:', err);
        });
      }
      this.retryCount = 0;
    } catch (error) {
      console.error('UDP socket 创建失败:', error);
      this.socket = null;
      // 失败重试，带次数上限和退避
      if (this.closed || this.retryCount >= this.maxRetries) return;
      this.retryCount++;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.initSocket();
      }, 3000 * this.retryCount);
    }
  }

  send(data) {
    // 立即发送但不等待响应
    if (!this.socket) return false;
    try {
      this.socket.send({
        address: this.host,
        port: this.port,
        message: data
      });
      return true;
    } catch (e) {
      console.error('UDP发送失败:', e);
      return false;
    }
  }

  close() {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.socket) {
      if (this.messageHandler && this.socket.offMessage) {
        try { this.socket.offMessage(this.messageHandler); } catch (e) {}
        this.messageHandler = null;
      }
      try { this.socket.close(); } catch (e) {}
      this.socket = null;
    }
    console.log('UDP socket closed');
  }
}

export default {
  UDPClient
};
