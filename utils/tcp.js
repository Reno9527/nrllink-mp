class TCPClient {
  constructor({ host, port, onMessage }) {
    this.host = host;
    this.port = port;
    this.onMessage = onMessage;
    this.socket = null;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const app = getApp()
      const callSign = app.globalData.userInfo && app.globalData.userInfo.callsign;
      const passcode = app.globalData.passcode; // 登录成功后写入，无凭据则拒绝连接
      if (!callSign || passcode == null) {
        reject(new Error('缺少APRS登录凭据，请先登录'));
        return;
      }

      this.socket = wx.createTCPSocket();

      this.socket.onConnect(() => {
        console.log('TCP连接成功');
        const loginPacket = `user ${callSign} pass ${passcode} vers NRLLink 1.0\n`;        
        this.socket.write(loginPacket);
        //console.log('成功发送登录包:', loginPacket); 
        resolve();
      });

      this.socket.onMessage((res) => {
        this.onMessage(res);
      });

      this.socket.onClose(() => {
        console.log('TCP连接关闭');
        this.socket = null;
      });

      this.socket.onError((err) => {
        console.error('TCP连接错误:', err);
        this.socket = null;
        reject(err);
      });

      this.socket.connect({
        address: this.host,
        port: this.port
      });
    });
  }

  async send(data) {
    //console.log('this socket:', this.socket);
    try {
      if (!this.socket ) {
        await this.connect();       
      }   
      // TCPSocket.write 无回调/Promise，写失败会在 onError 中感知
      this.socket.write(data)
    } catch (err) {
      
      console.log( '发送数据失败:', err); 

      throw err;
     
    }
  }

  close() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}

module.exports = {
  TCPClient
};
