//import { getQTH, getQTHmap,logout } from './utils/api';
import * as audio from './utils/audioPlayer';

// /group/get 结果缓存时长，避免多个页面/定时器高频重复请求同一群组
const GROUP_GET_CACHE_MS = 15000;
// /device/qths 结果缓存时长，避免每条语音/文本都全量拉一次
const QTH_GET_CACHE_MS = 15000;

import {
  getGroupList as _getGroupList,
  getGroup as _getGroup,
  getDevice as _getDevice,
  getMyDevices as _getMyDevices,
  getGroupListMini as _getGroupListMini,
  getDeviceList as _getDeviceList,
  //getQTHmap as _getQTHmap,
  getQTH as _getQTH,
  logout as _logout,
} from '/utils/api';

App({
  globalData: {
    userInfo: null,
    token: null,
    dmrid: null,
    passcode: null,
    currentGroup: null,
    currentDevice: null,
    callHistory: [],
    chatLogs: [], // Combined voice and text history
    heartbeatTimer: null,
    lastHeartbeatSentAt: 0,
    isAppInBackground: false,

    recoderStartTime: null,
    availableGroups: null,
    availableDevices: {},
    voicePage: null,
    configPage: null,
    udpClient: null,
    messagePage: null,
    serverConfig: {
      name: 'NRLPTT主站',
      host: 'm.nrlptt.com',
      port: 60050
    },

    getGroupList: async function () {
      try {


        const data = await _getGroupListMini();
        this.availableGroups = data;

        return data



      } catch (error) {
        console.error(error);
        wx.showToast({
          title: error.message || '获取群组失败',
          icon: 'none'
        });
      }
    },

    getGroup: async function (group_id, silent = false, forceRefresh = false) {

      if (group_id === undefined || group_id === null) return;

      if (!this.groupCache) this.groupCache = {};
      const cached = this.groupCache[group_id];

      if (!forceRefresh && cached) {
        // 合并进行中的相同请求，避免并发重复调用
        if (cached.promise) return cached.promise;
        if (Date.now() - cached.fetchedAt < GROUP_GET_CACHE_MS) return cached.data;
      }

      const promise = _getGroup({ group_id: group_id }, silent)
        .then((data) => {
          this.groupCache[group_id] = { fetchedAt: Date.now(), data, promise: null };
          return data;
        })
        .catch((error) => {
          if (this.groupCache[group_id] && this.groupCache[group_id].promise === promise) {
            delete this.groupCache[group_id];
          }
          if (!silent) {
            wx.showToast({
              title: error.message || '获取群组失败',
              icon: 'none'
            });
          }
          return undefined;
        });

      this.groupCache[group_id] = {
        fetchedAt: cached ? cached.fetchedAt : 0,
        data: cached ? cached.data : undefined,
        promise
      };

      return promise;
    },

    getDevice: async function (callsign, ssid, silent = false) {

      try {

        const data = await _getDevice({ callsign: callsign, ssid: ssid }, silent);
        // if (data.callsign === callsign && data.ssid === ssid) {
        //   this.globalData.currentDevice = data;
        // }
        //console.log('getDevice', data)

        return data

      } catch (error) {
        if (!silent) {
          wx.showToast({
            title: error.message || '获取设备失败',
            icon: 'none'
          });
        }
      }

    },
    getMyDevices: async function () {

      try {

        const data = await _getMyDevices();

        return data

      } catch (error) {
        wx.showToast({
          title: error.message || '获取本人设备失败',
          icon: 'none'
        });
      }

    },

    getQTH: async function (silent = false) {

      if (!this.qthCache) this.qthCache = { fetchedAt: 0, data: undefined, promise: null };
      const cached = this.qthCache;

      // 合并进行中的相同请求，避免并发重复调用
      if (cached.promise) return cached.promise;
      if (cached.data !== undefined && Date.now() - cached.fetchedAt < QTH_GET_CACHE_MS) return cached.data;

      const promise = _getQTH(undefined, silent)
        .then((data) => {
          this.qthCache = { fetchedAt: Date.now(), data, promise: null };
          return data;
        })
        .catch((error) => {
          this.qthCache = { fetchedAt: 0, data: undefined, promise: null };
          if (!silent) {
            wx.showToast({
              title: error.message || '获取设备QTH失败',
              icon: 'none'
            });
          }
          return undefined;
        });

      this.qthCache.promise = promise;
      return promise;
    },


    // getQTHmap: async function () {

    //   try {

    //     const data = await _getQTHmap();

    //     return data

    //   } catch (error) {
    //     wx.showToast({
    //       title: error.message || '获取QTH map失败',
    //       icon: 'none'
    //     });
    //   }

    // },



    async logout() {

      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }

      if (this.udpClient) {
        try {
          this.udpClient.close();
        } catch (error) {
          console.error('关闭 UDP 连接失败:', error);
        }
        this.udpClient = null;
      }
      audio.suspend();

      try {

        const data = await _logout({ ssid: 100 });

        console.log('logout', data)

      } catch (error) {
        wx.showToast({
          title: error.message || '退出失败',
          icon: 'none'
        });
      }

      // 重置会话字段，避免同设备换账号串数据
      this.userInfo = null;
      this.token = null;
      this.dmrid = null;
      this.passcode = null;
      this.currentGroup = null;
      this.currentDevice = null;
      this.callHistory = [];
      this.chatLogs = [];
      this.lastHeartbeatSentAt = 0;
      this.availableGroups = null;
      this.availableDevices = {};
      this.groupCache = {};
      this.qthCache = null;
      this.voicePage = null;
      this.configPage = null;
      this.messagePage = null;

      wx.removeStorageSync('token');
      wx.removeStorageSync('userInfo');
      wx.removeStorageSync('dmrid');
      wx.removeStorageSync('passcode');
      wx.removeStorageSync('serverTokens'); // 各服务器缓存的登录态一并清除
      //wx.removeStorageSync('serverCredentials');
      // wx.restartMiniProgram({    
      //   path: '/pages/login/login',
      //   complete: (res) => {
      //     console.log('restartMiniProgram complete', res);
      //   },
      // })

      // wx.showToast({
      //   title: '正在退出，请稍等', // 提示的内容
      //   icon: 'loading', // 图标，有效值有 success, loading, none
      //   duration: 2000, // 提示的延迟时间，单位毫秒，默认：1500
      //   mask: false // 是否显示透明蒙层，防止触摸穿透，默认为 false
      // });



      wx.reLaunch({
        url: '/pages/login/login'
      });
    },

  },

  onLaunch() {
    // const udp = require('./utils/udp');
    // const nrl = require('./utils/nrl21');

    // const token = wx.getStorageSync('token');
    // if (token) {
    //   this.globalData.token = token;
    //   wx.reLaunch({
    //     url: '/pages/login/login'
    //   });


    //   return;
    // }



  },

  onShow() {
    const wasInBackground = this.globalData.isAppInBackground;
    this.globalData.isAppInBackground = false;

    if (wasInBackground && this.globalData.voicePage && this.globalData.voicePage.handleAppShow) {
      this.globalData.voicePage.handleAppShow().catch((err) => {
        console.error('Voice foreground restore failed:', err);
      });
    }
    // if (this.globalData.udpClient) {
    //   this.globalData.udpClient.reconnect();
    // }
  },

  onHide() {
    this.globalData.isAppInBackground = true;

    if (this.globalData.voicePage && this.globalData.voicePage.handleAppHide) {
      this.globalData.voicePage.handleAppHide();
    }
  },

  formatTime(timeStr) {
    if (!timeStr) return '';
    const isoTime = timeStr.replace(' ', 'T') + 'Z';
    const date = new Date(isoTime);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).replace(/\//g, '-');
  },

  registerPage(page) {
    const route = page.__route__ || page.route;
    if (route === 'pages/voice/voice') {
      this.globalData.voicePage = page;
    } else if (route === 'pages/config/config') {
      this.globalData.configPage = page;
    }
  },

  unregisterPage(page) {
    // 保留原有注销逻辑
  }
});
