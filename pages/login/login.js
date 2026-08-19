
import { generateAPRSPasscode } from '../../utils/aprs';
const app = getApp();

Page({
  data: {
    username: '',
    password: '',
    loading: false,
    serverList: [
      { name: 'NRLPTT主站', host: 'm.nrlptt.com', port: 60050 },
      { name: '江苏省无线电运动协会', host: 'js.nrlptt.com', port: 60050 },
      { name: '北京阳光无线俱乐部', host: 'ba1gm.nrlptt.com', port: 60050 },
      { name: '董哥集群', host: 'bh1osw.nrlptt.com', port: 60050 },
      { name: '徐州HAM互联', host: 'bd4two.nrlptt.com', port: 60050 },
      { name: 'BH4TDV实验场', host: 'bh4tdv.nrlptt.com', port: 60050 }
    ],
    serverIndex: 1, // 默认江苏省无线电运动协会
    customServer: '',
    selectedOption: 'predefined', // Add selectedOption to track the selection
    showServerModal: false, // 控制服务器选择弹窗显示
    agreedPolicies: false,
    thanksItems: [
      '感谢：', 'BG6FCS', 'BH4TIH', 'BA4RN', 'BA1GM', 'BA4QEK', 'BA4QAO',
      'BD4VKI', 'BH4VAP', 'BH4TDV', 'BI4UMD', 'BA4QGT', 'BG8EJT', 'BH1OSW', 'BD4RFG', 'BG4QG', 'BD1BHO', 'BG2LBF',
      '排名不分先后，还有很多，列表太长放不下了'
    ]
  },

  // 读取某台服务器保存的凭据。按 host 关联（服务器列表动态下发，下标会错位）；
  // 兼容旧版按下标存储的数据。
  getSavedCredentials(serverIndex) {
    const server = this.data.serverList[serverIndex];
    if (!server || !server.host) return null;
    const serverCredentials = wx.getStorageSync('serverCredentials') || {};
    return serverCredentials[server.host] || serverCredentials[serverIndex] || null;
  },

  bindServerChange(e) {
    const newServerIndex = e.detail.value;
    this.setData({
      serverIndex: newServerIndex,
      selectedOption: 'predefined' // Set selectedOption to predefined when server is selected
    });

    const currentServerCreds = this.getSavedCredentials(newServerIndex);

    if (currentServerCreds) {
      this.setData({
        username: currentServerCreds.username,
        password: currentServerCreds.password
      });
    } else {
      this.setData({
        username: '',
        password: ''
      });
    }
  },

  inputCustomServer(e) {
    this.setData({
      customServer: e.detail.value,
      selectedOption: 'custom' // Set selectedOption to custom when custom server is entered
    });
  },

  onLoad() {
    // 已有有效登录态时直接恢复并进入语音页；缺任何字段都走正常登录流程
    const token = wx.getStorageSync('token');
    const userInfo = wx.getStorageSync('userInfo');
    const savedServerConfig = wx.getStorageSync('serverConfig');
    if (token && userInfo && userInfo.callsign && savedServerConfig && savedServerConfig.host) {
      app.globalData.serverConfig = savedServerConfig;
      app.globalData.token = token;
      app.globalData.userInfo = userInfo;
      app.globalData.passcode = generateAPRSPasscode(userInfo.callsign);
      wx.switchTab({ url: '/pages/voice/voice' });
      return;
    }

    this.getPlatformList();

    this.restoreServerSelection();

    const currentServerCreds = this.getSavedCredentials(this.data.serverIndex);
    if (currentServerCreds) {
      this.setData({
        username: currentServerCreds.username,
        password: currentServerCreds.password
      });
    }
  },

  // 服务器列表由 getPlatformList 动态下发，下标会错位：优先按 host 恢复选中项，
  // 找不到回退到旧版 savedServerIndex 下标逻辑（兼容老用户），都无效取 0
  restoreServerSelection() {
    const savedHost = wx.getStorageSync('savedServerHost');
    if (savedHost) {
      const hostIndex = this.data.serverList.findIndex(server => server.host === savedHost);
      if (hostIndex >= 0) {
        this.setData({ serverIndex: hostIndex });
        return;
      }
    }

    // getStorageSync 在键不存在时返回 ''，需要显式排除
    const savedServerIndex = wx.getStorageSync('savedServerIndex');
    if (savedServerIndex !== '' && savedServerIndex !== undefined && savedServerIndex !== null) {
      const index = Number(savedServerIndex);
      if (Number.isInteger(index) && index >= 0 && index < this.data.serverList.length) {
        this.setData({ serverIndex: index });
        return;
      }
    }

    this.setData({ serverIndex: 0 });
  },

  inputUsername(e) {
    this.setData({ username: e.detail.value });
  },

  inputPassword(e) {
    this.setData({ password: e.detail.value });
  },

  login() {
    if (this.data.loading) return;

    const { username, password, agreedPolicies } = this.data;

    if (!agreedPolicies) {
      wx.showToast({
        title: '请先阅读并同意用户服务协议和隐私政策',
        icon: 'none'
      });
      return;
    }

    if (!username || !password) {
      wx.showToast({
        title: '请输入用户名和密码',
        icon: 'none'
      });
      return;
    }

    this.setData({ loading: true });

    const api = require('../../utils/api');

    const selectedServer = this.data.selectedOption === 'predefined'
      ? (this.data.serverList[this.data.serverIndex] || this.data.serverList[0])
      : { host: this.data.customServer };

    app.globalData.serverConfig = {
      name: selectedServer.name || 'Custom Server',
      host: selectedServer.host,
      port: selectedServer.port || 60050 // Default port if not specified
    };

    api.login({ username, password })
      .then(res => {
        if (res && res.token) {
          wx.setStorageSync('token', res.token);

          // 登录成功后再保存凭据，按 host 关联避免服务器列表变动错位
          try {
            if (selectedServer && selectedServer.host) {
              const serverCredentials = wx.getStorageSync('serverCredentials') || {};
              serverCredentials[selectedServer.host] = { username, password };
              wx.setStorageSync('serverCredentials', serverCredentials);
              wx.setStorageSync('savedServerIndex', this.data.serverIndex);
              wx.setStorageSync('savedServerHost', selectedServer.host);
              wx.setStorageSync('serverConfig', app.globalData.serverConfig);
            }
          } catch (err) {
            console.error('存储失败:', err);
          }

          this.getUserInfo();
        } else if (res !== undefined) {
          // res === undefined 时拦截器已 toast 业务错误，不再重复提示
          wx.showToast({
            title: '用户名或者密码错',
            icon: 'none'
          });
        }
      })
      .catch(err => {
        wx.showToast({
          title: err.message || '登录失败',
          icon: 'none'
        });
      })
      .finally(() => {
        this.setData({ loading: false });
      });
  },

  async getUserInfo() {
    const api = require('../../utils/api');

    try {
      const userInfo = await api.getUserInfo();

      if (!userInfo.callsign) {
        wx.showToast({
          title: '用户信息缺少呼号',
          icon: 'none'
        });
        return;
      }


      wx.setStorageSync('userInfo', userInfo);
      app.globalData.userInfo = userInfo;


      const passcode = generateAPRSPasscode(userInfo.callsign);
      app.globalData.passcode = passcode;
      wx.setStorageSync('passcode', passcode);

      wx.switchTab({ url: '/pages/voice/voice' });
    } catch (err) {
      wx.showToast({
        title: err.message || '获取用户信息失败',
        icon: 'none'
      });
    }
  },

  getPlatformList() {
    const url = 'https://m.nrlptt.com/platform/list';

    wx.request({
      url: url,
      method: 'GET',
      header: {
        'content-type': 'application/json',
      },
      success: (res) => {
        this.setData({
          serverList: res.data.data.items,
        });
        // 列表下发后下标可能变化，按 host 重新恢复选中项并回显凭据
        this.restoreServerSelection();
        const currentServerCreds = this.getSavedCredentials(this.data.serverIndex);
        if (currentServerCreds) {
          this.setData({
            username: currentServerCreds.username,
            password: currentServerCreds.password
          });
        }
      },
      fail: (err) => {
        console.error('请求失败：', err);
      },
    });
  },

  bindRadioChange(e) {
    this.setData({
      selectedOption: e.detail.value
    });
  },

  // 显示服务器选择弹窗
  showServerModal() {
    this.setData({
      showServerModal: true
    });
  },

  // 隐藏服务器选择弹窗
  hideServerModal() {
    this.setData({
      showServerModal: false
    });
  },

  // 选择服务器
  selectServer(e) {
    const index = e.currentTarget.dataset.index;
    this.setData({
      serverIndex: index,
      selectedOption: 'predefined',
      showServerModal: false
    });

    // 加载该服务器保存的账号密码
    const currentServerCreds = this.getSavedCredentials(index);

    if (currentServerCreds) {
      this.setData({
        username: currentServerCreds.username,
        password: currentServerCreds.password
      });
    } else {
      this.setData({
        username: '',
        password: ''
      });
    }
  },

  // 阻止事件冒泡
  stopPropagation() {
    // 空方法，用于阻止点击弹窗内容时触发关闭
  },


  onAgreementChange(e) {
    this.setData({
      agreedPolicies: e.detail.value.includes('agree')
    });
  },

  openUserAgreement() {
    wx.navigateTo({
      url: '/pages/user-agreement/user-agreement'
    });
  },

  openPrivacyPolicy() {
    wx.navigateTo({
      url: '/pages/privacy-policy/privacy-policy'
    });
  },

  copyDownloadLink(e) {
    const url = e.currentTarget.dataset.url;
    wx.setClipboardData({
      data: url,
      success: () => {
        wx.showToast({
          title: '链接已复制，请去浏览器打开',
          icon: 'none',
          duration: 2000
        });
      }
    });
  }
});
