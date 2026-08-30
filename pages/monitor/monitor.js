import * as g711 from '../../utils/audioG711';
const audio = require('../../utils/audioPlayer');
const { updateDevice } = require('../../utils/api');

const app = getApp();
const g711Codec = new g711.G711Codec();

// 服务端 25 秒收不到任何客户端消息会断开（calls_ws.go wsCallClientTimeout），10 秒 ping 一次
const PING_INTERVAL_MS = 10000;
const RECONNECT_DELAY_MS = 2000;

// 房间类型（与后端 group.Type 一致），用于类型标签和配色（rt-<type> 样式类）
const ROOM_TYPE_NAMES = {
  0: '公共',
  1: '中继互联',
  2: '设备互联',
  4: '数模互联',
  5: '俱乐部',
  6: '车友会',
  7: '会议组',
  8: '私密房间',
  100: '其他'
};

// 群组监听+选择页：连接当前服务器的 /ws/calls，匿名可看全部公共房间，
// 已登录带 token 时可额外看到自己的私有房间。左下"收听"按钮订阅/取消订阅语音；
// 右下"加入"按钮把本机设备切到该群组（管理操作，需要当前服务器的登录态，
// 未登录时按钮置灰，点击会提示去登录）。
Page({
  data: {
    serverName: '',
    connected: false,
    rooms: [],           // 展示用数组，按 room_id 排序
    subscribedKeys: {},  // room_key -> true，便于 WXML 直接查
    stats: { total_subs: 0, connected_clients: 0, online_devices: 0 },
    serverAuthed: false, // 当前服务器是否有管理登录态（决定能否加入群组）
    currentGroupId: 0,   // 本机设备当前所在群组
    myCallsign: '',
    gridClass: 'cols-2'  // 房间格子列数（cols-2/cols-3/cols-4）
  },

  onLoad() {
    this.destroyed = false;
    this.socketTask = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.roomsByKey = {};

    const callsign = (app.globalData.userInfo && app.globalData.userInfo.callsign) || '';
    const currentDevice = app.globalData.currentDevice;

    // 列数按屏幕宽度定：手机统一 2 列，小平板 3 列、平板 4 列
    let cols = 2;
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const w = info.windowWidth || 375;
      cols = w >= 700 ? 4 : (w >= 500 ? 3 : 2);
    } catch (e) { /* 默认 2 列 */ }

    this.setData({
      serverName: (app.globalData.serverConfig && app.globalData.serverConfig.name) || '',
      serverAuthed: !!wx.getStorageSync('token'),
      myCallsign: String(callsign).toUpperCase(),
      gridClass: 'cols-' + cols,
      // 设备未建档时心跳自动落 0 号公共群组
      currentGroupId: (currentDevice && currentDevice.group_id != null) ? currentDevice.group_id : 0
    });

    // 设备群组可能在别处被改过，进页面时拉一次最新的
    this.refreshCurrentDevice();
    this.connect();
  },

  onUnload() {
    this.destroyed = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socketTask) {
      try { this.socketTask.close({}); } catch (e) { /* 忽略关闭异常 */ }
      this.socketTask = null;
    }
  },

  async refreshCurrentDevice() {
    try {
      const device = await app.globalData.getDevice(app.globalData.userInfo.callsign, 100, true);
      if (device) {
        app.globalData.currentDevice = device;
        const groupId = (device.group_id != null) ? device.group_id : 0;
        if (groupId !== this.data.currentGroupId) {
          this.setData({ currentGroupId: groupId });
          this.pushRooms();
        }
      }
    } catch (e) {
      // 拉取失败按缓存/0 号群显示，不影响监听
    }
  },

  connect() {
    if (this.destroyed) return;

    const host = app.globalData.serverConfig && app.globalData.serverConfig.host;
    if (!host) return;

    const token = wx.getStorageSync('token') || '';
    let url = 'wss://' + host + '/ws/calls';
    if (token) url += '?token=' + encodeURIComponent(token);

    // 记录本次连接状态，用于识别"带 token 被服务端秒拒"（token 失效时服务端握手后即关闭）
    this.connWithToken = !!token;
    this.connOpened = false;
    this.connGotMessage = false;

    const task = wx.connectSocket({ url });
    this.socketTask = task;

    task.onOpen(() => {
      this.connOpened = true;
      this.setData({ connected: true });
      this.startPing();
    });

    task.onMessage((res) => {
      this.connGotMessage = true;
      this.handleMessage(res.data);
    });

    task.onClose(() => {
      this.setData({ connected: false });
      this.stopPing();
      // 带 token 连接打开后被秒关且没收到任何消息 → token 无效/过期：
      // 清掉该服务器的失效凭证，降级匿名重连（匿名连接不会被拒）
      if (this.connWithToken && this.connOpened && !this.connGotMessage) {
        this.dropInvalidToken();
      }
      this.scheduleReconnect();
    });

    task.onError((err) => {
      console.warn('monitor ws error:', err);
      this.setData({ connected: false });
    });
  },

  // 清除当前服务器的失效 token（与 50008 降级同一套逻辑）
  dropInvalidToken() {
    const host = app.globalData.serverConfig && app.globalData.serverConfig.host;
    const token = wx.getStorageSync('token');
    if (!token) return;
    wx.removeStorageSync('token');
    app.globalData.token = null;
    if (host) {
      const serverTokens = wx.getStorageSync('serverTokens') || {};
      if (serverTokens[host] === token) {
        delete serverTokens[host];
        wx.setStorageSync('serverTokens', serverTokens);
      }
    }
    if (this.data.serverAuthed) {
      this.setData({ serverAuthed: false });
    }
  },

  scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  },

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.sendCommand({ action: 'ping' });
    }, PING_INTERVAL_MS);
  },

  stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  },

  sendCommand(cmd) {
    if (this.socketTask && this.data.connected) {
      this.socketTask.send({ data: JSON.stringify(cmd) });
    }
  },

  handleMessage(data) {
    if (typeof data === 'string') {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch (e) {
        return;
      }
      this.handleJson(msg);
      return;
    }

    // 二进制帧：G.711 A-law 8kHz 单声道原始字节（160 字节 = 20ms），无包头，
    // 服务端只下发已订阅房间的混流，直接解码播放即可
    const bytes = new Uint8Array(data);
    if (bytes.length === 0) return;

    const pcm = new Int16Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      pcm[i] = g711Codec.alaw2linear(bytes[i]);
    }

    audio.initWebAudio();
    audio.playPCM(pcm, { sampleRate: 8000 });
  },

  handleJson(msg) {
    switch (msg.type) {
      case 'snapshot':
        this.roomsByKey = {};
        (msg.rooms || []).forEach(room => {
          this.roomsByKey[room.room_key] = room;
        });
        this.applySubscriptions(msg.subscriptions || []);
        this.applyStats(msg);
        this.pushRooms();
        break;
      case 'rooms':
        // 全量房间列表刷新（在线人数等有变化时服务端主动推送）
        this.roomsByKey = {};
        (msg.rooms || []).forEach(room => {
          this.roomsByKey[room.room_key] = room;
        });
        this.pushRooms();
        break;
      case 'room_state':
        if (msg.room && msg.room.room_key) {
          this.roomsByKey[msg.room.room_key] = {
            ...(this.roomsByKey[msg.room.room_key] || {}),
            ...msg.room
          };
          this.pushRooms();
        }
        break;
      case 'subscriptions':
        this.applySubscriptions(msg.subscriptions || []);
        break;
      case 'stats':
        this.applyStats(msg);
        break;
      default:
        // recent_calls（不需要历史记录）/ pong / error 都不展示
        break;
    }
  },

  applyStats(msg) {
    this.setData({
      stats: {
        total_subs: msg.total_subs || 0,
        connected_clients: msg.connected_clients || 0,
        online_devices: msg.online_devices || 0
      }
    });
  },

  applySubscriptions(keys) {
    const map = {};
    keys.forEach(k => { map[k] = true; });
    this.setData({ subscribedKeys: map });
  },

  speakersText(room) {
    const speakers = (room.speakers && room.speakers.length)
      ? room.speakers
      : (room.callsign ? [{ callsign: room.callsign, ssid: room.ssid }] : []);
    return speakers.map(s => s.callsign + '-' + s.ssid).join(' / ');
  },

  pushRooms() {
    const myPrivatePrefix = 'private:' + this.data.myCallsign + ':';
    const rooms = Object.values(this.roomsByKey)
      .map(room => {
        const key = String(room.room_key || '');
        // 私有房间（个人房间1~3）的 room_id 都是 1~3，只有属于自己呼号的才算当前群组
        const isPrivate = key.indexOf('private:') === 0;
        const isCurrent = room.room_id === this.data.currentGroupId &&
          (!isPrivate || key.indexOf(myPrivatePrefix) === 0);
        return {
          ...room,
          speakersText: this.speakersText(room),
          typeName: ROOM_TYPE_NAMES[room.room_type] || '群组',
          online: room.online_dev_number || 0,
          isCurrent
        };
      })
      .sort((a, b) => (a.room_id - b.room_id) || String(a.room_key).localeCompare(String(b.room_key)));
    this.setData({ rooms });
  },

  // 点"收听"按钮：订阅/取消订阅语音
  toggleRoom(e) {
    const key = e.currentTarget.dataset.key;
    if (!key) return;

    const subscribed = !!this.data.subscribedKeys[key];
    if (!subscribed) {
      // WebAudio 需要用户手势激活，订阅动作正好是点击
      audio.initWebAudio();
      if (!audio.isRunning()) audio.resume();
    }

    this.sendCommand({
      action: subscribed ? 'unsubscribe' : 'subscribe',
      room_keys: [key]
    });
  },

  // 点"加入"：把本机设备切到该群组（管理操作，需要登录态）
  async joinGroup(e) {
    const key = e.currentTarget.dataset.key;
    const room = this.roomsByKey[key];
    if (!room || this.joining) return;

    if (!this.data.serverAuthed) {
      wx.showModal({
        title: '未登录',
        content: '加入群组需要先登录当前服务器',
        confirmText: '去登录',
        cancelText: '取消',
        success: (res) => {
          if (res.confirm) {
            // 回到通话页弹出当前服务器的登录框
            app.globalData.pendingServerLogin = true;
            wx.navigateBack();
          }
        }
      });
      return;
    }

    this.joining = true;
    wx.showLoading({ title: '正在加入...' });
    try {
      let currentDevice = app.globalData.currentDevice;
      if (!currentDevice) {
        currentDevice = await app.globalData.getDevice(app.globalData.userInfo.callsign, 100, true);
        app.globalData.currentDevice = currentDevice;
      }
      if (!currentDevice) {
        wx.showToast({ title: '设备未建档，请稍后重试', icon: 'none' });
        return;
      }

      await updateDevice({
        ...currentDevice,
        group_id: room.room_id,
        last_voice_begin_time: "0001-01-01T00:00:00Z",
        last_voice_end_time: "0001-01-01T00:00:00Z",
      });

      currentDevice.group_id = room.room_id;
      this.setData({ currentGroupId: room.room_id });
      this.pushRooms();
      wx.showToast({ title: '已加入 ' + (room.room_name || ''), icon: 'none' });
    } catch (err) {
      wx.showToast({ title: '加入失败', icon: 'none' });
    } finally {
      this.joining = false;
      wx.hideLoading();
    }
  }
});
