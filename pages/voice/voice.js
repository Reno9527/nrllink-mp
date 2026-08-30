import * as udp from '../../utils/udp';
import * as audio from '../../utils/audioPlayer';
import * as g711 from '../../utils/audioG711';
import * as opus from '../../utils/audioOpus';
import * as nrl21 from '../../utils/nrl21';
import * as mdc from '../../utils/mdc1200';
import * as nrlHelpers from '../../utils/nrlHelpers';
import { VoiceService } from './voiceService';
import { RecorderService } from './recorderService';

const { updateAvatar } = require('../../utils/api');
const app = getApp();
const HEARTBEAT_INTERVAL_MS = 2000;
const HEARTBEAT_STALE_MS = HEARTBEAT_INTERVAL_MS * 2 + 1000;

Page({
  data: {
    userInfo: {},
    isTalking: false,
    codec: 'g711',
    ReceivingCodec: 'g711',
    ReceivingCodecLabel: 'G.711',
    ReceivingMdcLabel: '',
    serverConnected: false,
    showList: false,
    currentGroup: null,
    onlineCount: 0,
    deviceCount: 0,
    serverConfig: {},
    chatLogs: [],
    lastVoiceTime: null,
    CallSign: null,
    SSID: null,
    duration: 0,
    startTime: null,
    inputText: '',
    scrollIntoView: '',
    isReceivingVoice: false,
    receivingBubbleWidth: 0,
    currentPlayingId: null,
    isVoicePlaying: false,
    showOnlineModal: false,
    onlineDevicesList: [],

    // Server Switch Data
    showServerModal: false,
    serverList: [],
    tempServerIndex: 0,
    tempUsername: '',
    tempPassword: '',
    serverAuthed: false, // 当前服务器是否有管理登录态（语音通联不依赖它）
    authedHosts: {}, // 各服务器 token 缓存，用于服务器卡片上的"已登录"标记

    // Server Login Data（管理功能需要时弹出的登录框）
    showLoginModal: false,
    oidcConfig: { enabled: false, button_name: '' }, // 当前服务器的 OIDC 配置
  },

  async onLoad() {
    // Initialize Services
    this.voiceService = new VoiceService(this);
    this.recorderService = new RecorderService(this);

    const savedCodec = wx.getStorageSync('voiceSendCodec');
    this.setData({
      userInfo: app.globalData.userInfo,
      chatLogs: app.globalData.chatLogs,
      serverConfig: app.globalData.serverConfig,
      serverAuthed: !!wx.getStorageSync('token'),
      startTime: Date.now(),
      codec: savedCodec === 'opus' ? 'opus' : 'g711'
    });

    app.registerPage(this);

    // Setup MDC, UDP, heartbeat and audio once for the page instance.
    await this.ensureVoiceConnection();
    this.ensureAudioRunning();

    // Start background tasks
    this.connectionCheckTimer = setInterval(() => this.checkConnection(), 2000);
    this.loadServerList();
  },

  async initMdcAndUdp() {
    const currentDevice = await app.globalData.getDevice(app.globalData.userInfo.callsign, 100);
    app.globalData.currentDevice = currentDevice;

    try {
      const mdcId = parseInt(app.globalData.userInfo.mdcid, 16);

      // MDC 内容只取决于 mdcid：同一账号重复重建语音会话（切服务器、断线恢复等）
      // 时沿用已编码结果，只有换了账号（mdcid 变化）才重新编码
      if (app.globalData.mdcEncodedMdcId !== mdcId || !app.globalData.mdcPacket) {
        // G711 MDC: 8000 Hz samples → A-law encode
        this.mdcEncoder = new mdc.MDC1200Encoder(8000);
        this.mdcEncoder.setPreamble(10);
        this.mdcEncoder.setPacket(0x01, 0x00, mdcId);
        const samples8k = this.mdcEncoder.getSamples();
        app.globalData.mdcPacket = g711.MDC2g711Encode(samples8k);

        // Opus MDC: native 16000 Hz samples → Opus encode (async, non-blocking)
        app.globalData.mdcOpusFrames = null;
        const mdcEncoder16k = new mdc.MDC1200Encoder(16000);
        mdcEncoder16k.setPreamble(10);
        mdcEncoder16k.setPacket(0x01, 0x00, mdcId);
        const samples16k = mdcEncoder16k.getSamples();
        opus.encodeMdcToOpusFrames(samples16k).then(frames => {
          app.globalData.mdcOpusFrames = frames;
          console.log(`MDC Opus pre-encoded: ${frames.length} frames`);
        }).catch(err => {
          console.warn('MDC Opus pre-encode failed, will fallback to G711 MDC:', err);
        });
        app.globalData.mdcEncodedMdcId = mdcId;
      }
    } catch (e) {
      console.error('MDC Init Error:', e);
    }

    const audioPacket = nrl21.createPacket({
      type: 1,
      callSign: app.globalData.userInfo.callsign,
    });
    this.g711AudioPacketHeader = new Uint8Array(audioPacket.getBuffer());

    const opusAudioPacket = nrl21.createPacket({
      type: 8,
      callSign: app.globalData.userInfo.callsign,
    });
    this.opusAudioPacketHeader = new Uint8Array(opusAudioPacket.getBuffer());

    const heartbeatPacket = nrl21.createPacket({
      type: 2,
      callSign: app.globalData.userInfo.callsign,
    });
    this.heartbeatBuffer = heartbeatPacket.getBuffer();

    // heartbeatBuffer 为空时会走到这里重建 client；先关旧的，避免双 socket 双份播放
    this.closeUdpClient();
    app.globalData.udpClient = new udp.UDPClient({
      host: app.globalData.serverConfig.host,
      port: app.globalData.serverConfig.port,
      onMessage: (data) => this.voiceService.handleMessage(data)
    });
  },

  async ensureVoiceConnection({ recreateUdp = false } = {}) {
    if (this.voiceConnectionPromise) {
      await this.voiceConnectionPromise;
      return;
    }

    this.voiceConnectionPromise = (async () => {
      if (recreateUdp && app.globalData.udpClient) {
        this.closeUdpClient();
      }

      if (
        !app.globalData.udpClient ||
        !this.heartbeatBuffer ||
        !this.g711AudioPacketHeader ||
        !this.opusAudioPacketHeader
      ) {
        await this.initMdcAndUdp();
      }

      this.ensureHeartbeat();
    })();

    try {
      await this.voiceConnectionPromise;
    } finally {
      this.voiceConnectionPromise = null;
    }
  },

  async onShow() {
    wx.setKeepScreenOn({ keepScreenOn: true });

    // 监听页上点"加入群组"但未登录时，回本页后弹出当前服务器的登录框
    if (app.globalData.pendingServerLogin) {
      app.globalData.pendingServerLogin = false;
      this.showServerLoginModal();
    }

    await this.recoverVoiceRuntime({ clearAudio: false });
    this.refreshData();
    this.startGroupRefreshTimer();
  },

  async handleAppShow() {
    await this.recoverVoiceRuntime({ clearAudio: true });
  },

  async handleAppHide() {
    // 退后台时:长按(按住发射)模式停掉;短按锁定模式按用户意图继续发射
    if (this.data.isTalking && this.pttHoldMode) {
      await this.recorderService.stopRecording();
    }
    this.clearAudioBuffer();
  },

  async recoverVoiceRuntime({ clearAudio = false } = {}) {
    // onHide/onUnload 会 dispose VoiceService，回到前台时复位
    if (this.voiceService) this.voiceService.disposed = false;

    if (clearAudio) {
      this.clearAudioBuffer();
    }

    const recoveryStartedAt = Date.now();
    const shouldRecreateUdp = this.isHeartbeatStale();

    await this.ensureVoiceConnection({ recreateUdp: shouldRecreateUdp });
    this.ensureAudioRunning();
    this.scheduleForegroundHeartbeatCheck(recoveryStartedAt);
  },

  scheduleForegroundHeartbeatCheck(recoveryStartedAt) {
    if (this.foregroundHeartbeatCheckTimer) {
      clearTimeout(this.foregroundHeartbeatCheckTimer);
    }

    this.foregroundHeartbeatCheckTimer = setTimeout(async () => {
      this.foregroundHeartbeatCheckTimer = null;

      const hasForegroundHeartbeatReply =
        this.lastMessageTime && this.lastMessageTime >= recoveryStartedAt;

      if (!hasForegroundHeartbeatReply) {
        this.closeUdpClient();
        this.stopHeartbeat();
        await this.ensureVoiceConnection();
      }
    }, 3000);
  },

  closeUdpClient() {
    if (!app.globalData.udpClient) return;

    try {
      app.globalData.udpClient.close();
    } catch (err) {
      console.warn('UDP close failed:', err);
    }
    app.globalData.udpClient = null;
  },

  async onHide() {
    this.stopGroupRefreshTimer();
    // 切页面时:长按(按住发射)模式停掉;短按锁定模式继续发射,回来再按停止
    if (this.data.isTalking && this.pttHoldMode) {
      await this.recorderService.stopRecording();
    }
    if (this.voiceService) this.voiceService.dispose();
  },

  onUnload() {
    this.stopGroupRefreshTimer();
    if (this.foregroundHeartbeatCheckTimer) {
      clearTimeout(this.foregroundHeartbeatCheckTimer);
      this.foregroundHeartbeatCheckTimer = null;
    }
    this.stopHeartbeat();
    if (this.connectionCheckTimer) clearInterval(this.connectionCheckTimer);
    if (this.voiceService) this.voiceService.dispose();
    // 不关闭 UDP socket 的话，卸载后旧 onMessage 闭包仍会对死页面收包出声
    this.closeUdpClient();
    if (this.currentAudioCtx) {
      this.currentAudioCtx.destroy();
      this.currentAudioCtx = null;
    }
  },

  startGroupRefreshTimer() {
    this.stopGroupRefreshTimer();
    this.groupRefreshTimer = setInterval(() => {
      this.refreshData(true);
    }, 15000);
  },

  stopGroupRefreshTimer() {
    if (this.groupRefreshTimer) {
      clearInterval(this.groupRefreshTimer);
      this.groupRefreshTimer = null;
    }
  },

  async refreshData(silent = false) {
    // token 可能因 50008 被拦截器降级清除，同步登录态徽标
    const authed = !!wx.getStorageSync('token');
    if (authed !== this.data.serverAuthed) {
      this.setData({ serverAuthed: authed });
    }

    const currentDevice = await app.globalData.getDevice(app.globalData.userInfo.callsign, 100, silent);
    app.globalData.currentDevice = currentDevice;
    // 设备未建档（刚切换服务器、心跳还没注册）时不存在"未加入群组"状态：
    // 按协议心跳会自动落进 0 号公共群组，直接按 0 号群显示
    const groupId = (currentDevice && currentDevice.group_id !== undefined && currentDevice.group_id !== null)
      ? currentDevice.group_id
      : 0;
    const group = await app.globalData.getGroup(groupId, silent);

    if (group) {
      const devlist = Object.values(group.devmap || {});
      const onlineCount = devlist.filter(d => d.is_online).length;
      // 数据没有变化时不触发 setData，避免列表无意义地反复刷新
      if (
        group.name !== this.data.currentGroup ||
        onlineCount !== this.data.onlineCount ||
        devlist.length !== this.data.deviceCount
      ) {
        this.setData({
          currentGroup: group.name,
          onlineCount: onlineCount,
          deviceCount: devlist.length
        });
      }
    } else if (groupId === 0) {
      // 0 号群固定是公共大厅：群组详情拉取失败（设备未建档、网络抖动等）时也直接显示，
      // 不存在"未加入群组"/STANDBY 状态
      if (this.data.currentGroup !== '公共大厅') {
        this.setData({ currentGroup: '公共大厅' });
      }
    } else if (groupId >= 1 && groupId <= 3) {
      // 1~3 号是每个账号默认的私有房间（个人房间1/2/3），名称固定；
      // 未登录时后端不返回私有群详情，直接按固定名显示
      const name = '个人房间' + groupId;
      if (this.data.currentGroup !== name) {
        this.setData({ currentGroup: name });
      }
    } else if (!this.data.currentGroup) {
      // 详情拉取失败的其他群组（网络/服务器异常），先按群号占位显示
      this.setData({ currentGroup: '群组 ' + groupId });
    }
    // 已有显示时拉取失败保持不变，不覆盖成错误状态
  },

  startHeartbeat() {
    if (!this.heartbeatBuffer) return;

    this.stopHeartbeat();
    this.sendHeartbeat();
    app.globalData.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  },

  sendHeartbeat() {
    if (app.globalData.udpClient && this.heartbeatBuffer) {
      const sent = app.globalData.udpClient.send(this.heartbeatBuffer);
      if (sent === true) {
        app.globalData.lastHeartbeatSentAt = Date.now();
      }
    }
  },

  ensureHeartbeat() {
    if (!this.isHeartbeatRunning()) {
      this.startHeartbeat();
    }
  },

  isHeartbeatRunning() {
    if (!app.globalData.heartbeatTimer) return false;
    if (!app.globalData.lastHeartbeatSentAt) return false;

    return !this.isHeartbeatStale();
  },

  isHeartbeatStale() {
    if (!app.globalData.lastHeartbeatSentAt) return true;

    return Date.now() - app.globalData.lastHeartbeatSentAt > HEARTBEAT_STALE_MS;
  },

  ensureAudioRunning() {
    audio.initWebAudio();
    if (!audio.isRunning()) {
      audio.resume();
    }
  },

  clearAudioBuffer() {
    if (audio.clearBuffer) {
      audio.clearBuffer();
    }
  },

  stopHeartbeat() {
    if (app.globalData.heartbeatTimer) {
      clearInterval(app.globalData.heartbeatTimer);
      app.globalData.heartbeatTimer = null;
    }
    app.globalData.lastHeartbeatSentAt = 0;
  },

  checkConnection() {
    // 已断线状态下不重复 setData
    if (!this.data.serverConnected) return;
    if (this.lastMessageTime && Date.now() - this.lastMessageTime > 6000) {
      this.setData({ serverConnected: false });
    }
  },

  // Event Handlers
  // 点击顶部呼号：打开当前服务器的实时语音监听页（/ws/calls）
  openMonitor() {
    wx.navigateTo({ url: '/pages/monitor/monitor' });
  },

  onCodecSelect(e) {
    if (this.data.isTalking) return;

    const codec = e.currentTarget.dataset.codec === 'opus' ? 'opus' : 'g711';
    if (codec === this.data.codec) return;
    this.setData({ codec });
    wx.setStorageSync('voiceSendCodec', codec);
  },

  onInput(e) {
    this.setData({ inputText: e.detail.value });
  },

  sendMessage() {
    const text = this.data.inputText.trim();
    if (!text) return;

    const packet = nrl21.createPacket({
      type: 5,
      callSign: app.globalData.userInfo.callsign,
    });

    const packetHead = new Uint8Array(packet.getBuffer());
    const encodedText = nrlHelpers.encodeTextToUint8Array(text);
    const fullPacket = new Uint8Array(packetHead.length + encodedText.length);
    fullPacket.set(packetHead, 0);
    fullPacket.set(encodedText, packetHead.length);

    if (app.globalData.udpClient) app.globalData.udpClient.send(fullPacket);

    const newLog = {
      id: Date.now(),
      type: 'text',
      isSelf: true,
      sender: '我',
      content: text,
      timestamp: nrlHelpers.formatLastVoiceTime(Date.now())
    };

    this.setData({ inputText: '' });
    this.voiceService.addChatLog(newLog);
  },

  // PTT 两种模式:
  // - 短按:切换(锁定)发射,切页面不停止,回来再按一次停止
  // - 长按:按住发射,松开即停
  onPttLongPress() {
    if (this.data.isTalking) return;
    this.pttHoldMode = true;
    app.globalData.recoderStartTime = Date.now();
    this.recorderService.startRecording();
  },

  onPttTouchEnd() {
    if (!this.pttHoldMode) return;
    this.pttHoldMode = false;
    // 长按松开后微信还会补发一个 tap,不能当成短按又开发射
    this.ignoreNextPttTap = true;
    if (this.data.isTalking || this.recorderService.startPromise) {
      this.recorderService.stopRecording();
    }
  },

  async toggleTalk() {
    if (this.ignoreNextPttTap) {
      this.ignoreNextPttTap = false;
      return;
    }
    if (this.data.isTalking) {
      await this.recorderService.stopRecording();
    } else {
      this.pttHoldMode = false; // 短按为锁定模式
      app.globalData.recoderStartTime = Date.now();
      await this.recorderService.startRecording();
    }
  },

  playVoice(e) {
    const { filepath, id } = e.currentTarget.dataset;
    if (!filepath) return;

    // Toggle Play/Pause if clicking the same item
    if (this.data.currentPlayingId === id && this.currentAudioCtx) {
      if (this.data.isVoicePlaying) {
        this.currentAudioCtx.pause();
      } else {
        this.currentAudioCtx.play();
      }
      return;
    }

    // Stop previous audio if any
    if (this.currentAudioCtx) {
      this.currentAudioCtx.stop();
      this.currentAudioCtx.destroy();
      this.currentAudioCtx = null;
    }

    const audioCtx = wx.createInnerAudioContext();
    this.currentAudioCtx = audioCtx;
    audioCtx.src = filepath;
    audioCtx.play();

    this.setData({
      currentPlayingId: id
    });

    audioCtx.onPlay(() => {
      this.setData({ isVoicePlaying: true });
    });

    audioCtx.onPause(() => {
      this.setData({ isVoicePlaying: false });
    });

    audioCtx.onEnded(() => {
      this.setData({
        currentPlayingId: null,
        isVoicePlaying: false
      });
      audioCtx.destroy();
      this.currentAudioCtx = null;
    });

    audioCtx.onError(() => {
      this.setData({
        currentPlayingId: null,
        isVoicePlaying: false
      });
      audioCtx.destroy();
      this.currentAudioCtx = null;
    });
  },

  onChooseAvatar(e) {
    const { avatarUrl } = e.detail;
    app.globalData.userInfo.avatar = avatarUrl;
    this.setData({ userInfo: app.globalData.userInfo });
    updateAvatar(app.globalData.userInfo).then(() => {
      wx.showToast({ title: '修改完成' });
    }).catch(err => {
      wx.showToast({ title: err.message || '修改失败', icon: 'none' });
    });
  },



  async showOnlineDevices() {
    try {
      const currentDevice = app.globalData.currentDevice;
      // 设备未建档时默认在 0 号公共群组（心跳自动落 0 号群）
      const groupId = (currentDevice && currentDevice.group_id !== undefined && currentDevice.group_id !== null)
        ? currentDevice.group_id
        : 0;

      const group = await app.globalData.getGroup(groupId);
      if (!group || !group.devmap) {
        this.setData({
          showOnlineModal: true,
          onlineDevicesList: []
        });
        return;
      }

      const onlineDevices = Object.values(group.devmap)
        .filter(device => device.is_online)
        .map(device => ({
          id: `${device.callsign}-${device.ssid}`,
          callsign: device.callsign,
          ssid: device.ssid
        }));

      this.setData({
        showOnlineModal: true,
        onlineDevicesList: onlineDevices
      });
    } catch (error) {
      console.error('Error loading online devices:', error);
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  hideOnlineDevices() {
    this.setData({ showOnlineModal: false });
  },

  stopPropagation() {
    // Prevent modal from closing when clicking inside
  },

  // --- Server Switch Logic ---

  loadServerList() {
    const url = 'https://m.nrlptt.com/platform/list';
    wx.request({
      url: url,
      method: 'GET',
      header: { 'content-type': 'application/json' },
      success: (res) => {
        if (res.data && res.data.data && res.data.data.items) {
          const servers = res.data.data.items;
          // Find current server index based on host
          const currentHost = this.data.serverConfig.host;
          let currentIndex = servers.findIndex(s => s.host === currentHost);
          if (currentIndex === -1) currentIndex = 0;

          this.setData({
            serverList: servers,
            tempServerIndex: currentIndex
          });
        }
      },
      fail: (err) => console.error('Failed to load server list:', err)
    });
  },

  handleServerClick() {
    // 刷新各服务器登录态标记（用于服务器卡片上的"已登录"提示）
    this.setData({
      showServerModal: true,
      authedHosts: wx.getStorageSync('serverTokens') || {}
    });
  },

  hideServerModal() {
    this.setData({ showServerModal: false });
  },

  onServerCardSelect(e) {
    const index = e.currentTarget.dataset.index;
    this.setData({ tempServerIndex: index });
  },

  // 管理功能（如切换群组）需要登录态时，弹出当前服务器的登录框
  showServerLoginModal() {
    const host = app.globalData.serverConfig.host;
    const serverCredentials = wx.getStorageSync('serverCredentials') || {};
    const creds = serverCredentials[host];
    this.setData({
      tempUsername: creds ? creds.username : '',
      tempPassword: creds ? creds.password : '',
      showLoginModal: true
    });
    this.getServerOidcConfig();
  },

  // 查询当前服务器是否开启 OIDC 登录；不支持或未开启时隐藏 OIDC 按钮
  getServerOidcConfig() {
    const host = app.globalData.serverConfig && app.globalData.serverConfig.host;
    if (!host) {
      this.setData({ oidcConfig: { enabled: false, button_name: '' } });
      return;
    }
    wx.request({
      url: 'https://' + host + '/user/oidc/config',
      method: 'GET',
      header: { 'content-type': 'application/json' },
      success: (res) => {
        // 兼容 {code: 20000, data: {...}} 包裹和直接返回两种形式
        const data = (res.data && res.data.code === 20000 ? res.data.data : res.data) || {};
        this.setData({
          oidcConfig: { enabled: !!data.enabled, button_name: data.button_name || '' }
        });
      },
      fail: (err) => {
        console.error('获取 OIDC 配置失败：', err);
        this.setData({ oidcConfig: { enabled: false, button_name: '' } });
      }
    });
  },

  // OIDC 登录：web-view 打开当前服务器的 OIDC 入口，认证完成后后端经 jweixin
  // reLaunch 回 /pages/login/login?oidc_token=...，由登录页收尾后回到通话页
  oidcServerLogin() {
    const host = app.globalData.serverConfig && app.globalData.serverConfig.host;
    if (!host) return;
    const url = 'https://' + host + '/user/oidc/login';
    wx.navigateTo({
      url: '/pages/webview/webview?mode=oidc&url=' + encodeURIComponent(url)
    });
  },

  hideLoginModal() {
    this.setData({ showLoginModal: false });
  },

  // 登录当前服务器（不改变语音身份之外的服务器选择），成功后恢复管理态
  async doServerLogin() {
    const { tempUsername, tempPassword } = this.data;
    if (!tempUsername || !tempPassword) {
      wx.showToast({ title: '请输入用户名和密码', icon: 'none' });
      return;
    }

    if (this.isLoggingIn) return;
    this.isLoggingIn = true;
    wx.showLoading({ title: '正在登录...' });

    const api = require('../../utils/api');
    const host = app.globalData.serverConfig.host;

    try {
      const res = await api.login({ username: tempUsername, password: tempPassword });

      if (res && res.token) {
        wx.setStorageSync('token', res.token);
        app.globalData.token = res.token;

        try {
          // token 与凭据都按 host 关联
          const serverTokens = wx.getStorageSync('serverTokens') || {};
          serverTokens[host] = res.token;
          wx.setStorageSync('serverTokens', serverTokens);
          const serverCredentials = wx.getStorageSync('serverCredentials') || {};
          serverCredentials[host] = { username: tempUsername, password: tempPassword };
          wx.setStorageSync('serverCredentials', serverCredentials);
        } catch (err) {
          console.error('存储失败:', err);
        }

        // 该服务器上的账号身份（呼号/MDC/DMR）可能与切换前不同，刷新用户信息和语音包头
        const userInfo = await api.getUserInfo();
        if (userInfo && userInfo.callsign) {
          wx.setStorageSync('userInfo', userInfo);
          app.globalData.userInfo = userInfo;
          const { generateAPRSPasscode } = require('../../utils/aprs');
          const passcode = generateAPRSPasscode(userInfo.callsign);
          app.globalData.passcode = passcode;
          wx.setStorageSync('passcode', passcode);
          this.setData({ userInfo });
        }

        this.setData({ showLoginModal: false, serverAuthed: true });
        await this.rebuildVoiceSession();
        wx.showToast({ title: '登录成功', icon: 'success' });
      } else if (res !== undefined) {
        // res === undefined 时拦截器已 toast 业务错误，不再重复提示
        wx.showToast({ title: '用户名或密码错误', icon: 'none' });
      }
    } catch (err) {
      wx.showToast({ title: err.message || '登录失败', icon: 'none' });
    } finally {
      this.isLoggingIn = false;
      wx.hideLoading();
    }
  },

  onServerUsernameInput(e) {
    this.setData({ tempUsername: e.detail.value });
  },

  onServerPasswordInput(e) {
    this.setData({ tempPassword: e.detail.value });
  },

  // 切换/登录后的语音会话重建：UDP、心跳、群组数据
  async rebuildVoiceSession() {
    this.closeUdpClient();
    this.stopHeartbeat();
    await this.initMdcAndUdp();
    this.ensureAudioRunning();
    this.startHeartbeat();
    await this.refreshData();
  },

  // 直接切换服务器：NRL 语音通联只依赖呼号+SSID（UDP 心跳），不要求登录。
  // 切换后恢复该服务器缓存的 token（如有）；没有则进入"未登录仅通联"模式，
  // 管理操作（切换群组等）时再提示登录
  async confirmServerSwitch() {
    const { tempServerIndex, serverList } = this.data;

    const selectedServer = serverList[tempServerIndex];
    if (!selectedServer) return;

    if (selectedServer.host === app.globalData.serverConfig.host) {
      this.setData({ showServerModal: false });
      return;
    }

    if (this.isSwitching) return;
    this.isSwitching = true;
    wx.showLoading({ title: '正在切换...' });

    try {
      app.globalData.serverConfig = {
        name: selectedServer.name,
        host: selectedServer.host,
        port: selectedServer.port || 60050
      };

      // 恢复该服务器上次的登录态；没有则清除当前 token，进入未登录模式
      const serverTokens = wx.getStorageSync('serverTokens') || {};
      const token = serverTokens[selectedServer.host] || '';
      if (token) {
        wx.setStorageSync('token', token);
        app.globalData.token = token;
      } else {
        wx.removeStorageSync('token');
        app.globalData.token = null;
      }

      try {
        wx.setStorageSync('serverConfig', app.globalData.serverConfig);
        wx.setStorageSync('savedServerHost', selectedServer.host);
        wx.setStorageSync('savedServerIndex', tempServerIndex);
      } catch (err) {
        console.error('存储失败:', err);
      }

      this.setData({
        serverConfig: app.globalData.serverConfig,
        serverAuthed: !!token,
        serverConnected: false, // Reset status
        showServerModal: false,
        currentGroup: null,
        onlineCount: 0,
        deviceCount: 0
      });

      // 群组/QTH 缓存是上一台服务器的数据，切换后必须清掉
      app.globalData.groupCache = {};
      app.globalData.qthCache = null;

      await this.rebuildVoiceSession();

      wx.showToast({
        title: token ? '切换成功' : '已切换，未登录仅可通联',
        icon: 'none'
      });

    } catch (err) {
      console.error('Switch Error:', err);
      wx.showToast({ title: err.message || '切换失败', icon: 'none' });
    } finally {
      this.isSwitching = false;
      wx.hideLoading();
    }
  }
});
