const { TCPClient } = require('../../utils/tcp.js');

const app = getApp();

Page({
  data: {
    userInfo: {    
      callSign: '默认呼号', // 保持与wxml一致   
    },
    latitude: null,
    longitude: null,
    status: '',
    webViewStatus: '未加载'
  },
  
  onLoad() {
    const app = getApp()
    
    // 确保用户信息存在
 
    this.setData({
      userInfo: {
        ...app.globalData.userInfo,
        callSign: app.globalData.userInfo.callsign
      }
    })

    // 设备型号不会变，缓存一次即可
    this.deviceModel = wx.getDeviceInfo().model || '';

    // 初始化TCP客户端
    this.tcpClient = new TCPClient({
      host: 'aprs.tv',
      port: 14580,
      onMessage: this.handleTcpMessage.bind(this)
    });

    this.tcpClient.connect().catch((err) => {
      console.error('连接APRS服务器失败:', err);
      this.setData({
        status: '连接APRS服务器失败'
      });
    });

    // 启动位置监听
    this.startLocationWatch();
    

  },

  onShow() {
   // console.log('onShow');
  },
  
  onReady() {
   // console.log('onReady');
 
  },

  handleWebViewLoad(e) {
    console.log(e.detail)
    this.setData({
      webViewStatus: 'webview加载完成'
    });
  },
  
  handleWebViewError(e){   
    console.log('web-view加载错误',e);
  },  
  
  onUnload() {
    // 清除定时器
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 关闭TCP连接
    if (this.tcpClient) {
      this.tcpClient.close();
    }
  },
  
  startLocationWatch() {
    // 获取当前位置
    wx.getLocation({
      type: 'wgs84',
      success: (res) => {
        this.setData({
          latitude: res.latitude,
          longitude: res.longitude
        });
        
        // 立即发送第一次位置
        this.sendAprsPosition(res);
        
        // 启动定时发送
        this.timer = setInterval(() => {
          wx.getLocation({
            type: 'wgs84',
            success: (res) => {
              this.setData({
                latitude: res.latitude,
                longitude: res.longitude
              });
              this.sendAprsPosition(res);
            },
            fail: (err) => {
              this.setData({
                status: '获取位置失败'
              });
              console.error('获取位置失败', err);
            }
          });
        }, 60000); // 60秒间隔
      },
      fail: (err) => {
        this.setData({
          status: '获取位置失败'
        });
        console.error('获取位置失败', err);
      }
    });
  },
  
  async sendAprsPosition(location) {
    const { latitude, longitude, userInfo } = this.data;
    let callSign = userInfo.callsign;
    
    if (latitude == null || longitude == null || !callSign) {
      return;
    }

    // 高度直接使用本次定位结果，不再重复调 wx.getLocation
    const altitude = (location && location.altitude) || 0;
    
    // 构造APRS数据包
    const aprsPacket = this.formatAprsPacket(callSign, latitude, longitude, altitude, this.deviceModel);
    
    try {
      await this.tcpClient.send(aprsPacket);
      this.setStatusText('位置已发送');
    } catch (err) {
      console.error('发送APRS位置失败:', err);
      this.setStatusText('发送失败');
    }
  },

  // 设置状态文本并延时清空，用序号防止连续触发互相清掉
  setStatusText(text) {
    this.statusSeq = (this.statusSeq || 0) + 1;
    const seq = this.statusSeq;
    this.setData({
      status: text
    });
    setTimeout(() => {
      if (seq === this.statusSeq) {
        this.setData({
          status: ''
        });
      }
    }, 2000);
  },
  
  formatAprsPacket(callSign, lat, lon, altitude, deviceModel) {

    const server = app.globalData.serverConfig.host
    const port = app.globalData.serverConfig.port
    // 格式化APRS数据包
    const latStr = this.decToAprs(lat, true);
    const lonStr = this.decToAprs(lon, false);
    // 高度按 APRS 标准 /A=ffffff（英尺，6 位），aprs.fi 等站点才能解析
    const feet = Math.round(altitude * 3.28084);
    const altStr = feet < 0 ? '000000' : String(Math.min(feet, 999999)).padStart(6, '0');
    return `${callSign}-5>NRLMP,TCPIP*:!${latStr}/${lonStr}I/A=${altStr} @udp://${server}:${port},${deviceModel},NRL微信小程序\n`;
  },
  
  decToAprs(dec, isLat) {
    // 十进制转APRS格式
    const dir = dec >= 0 ? (isLat ? 'N' : 'E') : (isLat ? 'S' : 'W');
    dec = Math.abs(dec);
    
    let deg = Math.floor(dec);
    // 先按0.01分钟取整，避免 toFixed 进位产生非法的 60.00
    let min = Math.round((dec - deg) * 6000);
    if (min >= 6000) {
      deg += 1;
      min = 0;
    }
    
    // 纬度度数2位，经度度数3位（APRS经度为DDDMM.mm）
    const degStr = deg.toString().padStart(isLat ? 2 : 3, '0');
    const minStr = (min / 100).toFixed(2).padStart(5, '0');
    return `${degStr}${minStr}${dir}`;
  },
  
  handleTcpMessage(res) {
    // 服务器响应仅为APRS-IS回执，无需更新界面
  }
})
