
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
    oidcConfig: { enabled: false, button_name: '' }, // 当前服务器的 OIDC 配置
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

    this.getOidcConfig();
  },

  inputCustomServer(e) {
    this.setData({
      customServer: e.detail.value,
      selectedOption: 'custom' // Set selectedOption to custom when custom server is entered
    });
  },

  onLoad(options) {
    // OIDC 回调：Web 端在小程序 web-view 里用 wx.miniProgram.reLaunch 把结果带回来
    if (options && options.oidc_token) {
      this.completeOidcLogin(decodeURIComponent(options.oidc_token));
      return;
    }
    if (options && options.oidc_error) {
      wx.showToast({
        title: decodeURIComponent(options.oidc_error),
        icon: 'none',
        duration: 3000
      });
      // 不 return，继续渲染正常登录表单
    }

    // 已有登录身份信息时直接恢复并进入语音页；缺任何字段都走正常登录流程。
    // 语音通联不依赖登录态：token 按服务器 host 缓存（serverTokens），可能为空，
    // 为空时进入"未登录仅通联"模式，管理操作时再提示登录
    const userInfo = wx.getStorageSync('userInfo');
    const savedServerConfig = wx.getStorageSync('serverConfig');
    if (userInfo && userInfo.callsign && savedServerConfig && savedServerConfig.host) {
      const serverTokens = wx.getStorageSync('serverTokens') || {};
      // 优先取该服务器缓存的 token；兼容旧版只有全局 token 的存储
      const token = serverTokens[savedServerConfig.host] || wx.getStorageSync('token') || '';
      app.globalData.serverConfig = savedServerConfig;
      app.globalData.token = token || null;
      app.globalData.userInfo = userInfo;
      app.globalData.passcode = generateAPRSPasscode(userInfo.callsign);
      if (token) {
        wx.setStorageSync('token', token);
      } else {
        wx.removeStorageSync('token');
      }
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

    this.getOidcConfig();
  },

  // 当前选中的服务器（预定义或自定义）
  getSelectedServer() {
    return this.data.selectedOption === 'predefined'
      ? (this.data.serverList[this.data.serverIndex] || this.data.serverList[0])
      : { host: this.data.customServer };
  },

  // 查询当前服务器是否开启 OIDC 登录；不支持或未开启时隐藏 OIDC 按钮
  getOidcConfig() {
    const server = this.getSelectedServer();
    if (!server || !server.host) {
      this.setData({ oidcConfig: { enabled: false, button_name: '' } });
      return;
    }

    wx.request({
      url: 'https://' + server.host + '/user/oidc/config',
      method: 'GET',
      header: { 'content-type': 'application/json' },
      success: (res) => {
        // 兼容 {code: 20000, data: {...}} 包裹和直接返回两种形式
        const data = (res.data && res.data.code === 20000 ? res.data.data : res.data) || {};
        this.setData({
          oidcConfig: {
            enabled: !!data.enabled,
            button_name: data.button_name || ''
          }
        });
      },
      fail: (err) => {
        console.error('获取 OIDC 配置失败：', err);
        this.setData({ oidcConfig: { enabled: false, button_name: '' } });
      }
    });
  },

  // OIDC 登录：通过 web-view 打开后端的 OIDC 登录入口，由后端 302 到认证服务器，
  // 认证完成后回到 /oidc-callback?token=...，webview 页面从 URL 中取出 token 完成登录
  oidcLogin() {
    if (!this.data.agreedPolicies) {
      wx.showToast({
        title: '请先阅读并同意用户服务协议和隐私政策',
        icon: 'none'
      });
      return;
    }

    const selectedServer = this.getSelectedServer();
    if (!selectedServer || !selectedServer.host) return;

    app.globalData.serverConfig = {
      name: selectedServer.name || 'Custom Server',
      host: selectedServer.host,
      port: selectedServer.port || 60050
    };

    // 记住服务器选择，下次启动按 host 恢复
    try {
      wx.setStorageSync('savedServerIndex', this.data.serverIndex);
      wx.setStorageSync('savedServerHost', selectedServer.host);
    } catch (err) {
      console.error('存储失败:', err);
    }

    const url = 'https://' + selectedServer.host + '/user/oidc/login';
    wx.navigateTo({
      url: '/pages/webview/webview?mode=oidc&url=' + encodeURIComponent(url)
    });
  },

  // OIDC 登录完成（web-view 回跳携带 token）：保存 token 并按 host 缓存，
  // 复用密码登录的用户信息收尾（callsign 校验、passcode、进入语音页）
  async completeOidcLogin(token) {
    try {
      // globalData.serverConfig 由 oidcLogin() 跳转前已设置；防御性回退到本地存储
      if (!app.globalData.serverConfig || !app.globalData.serverConfig.host) {
        const saved = wx.getStorageSync('serverConfig');
        if (saved && saved.host) app.globalData.serverConfig = saved;
      }

      wx.setStorageSync('token', token);
      app.globalData.token = token;
      wx.setStorageSync('serverConfig', app.globalData.serverConfig);
      const serverTokens = wx.getStorageSync('serverTokens') || {};
      serverTokens[app.globalData.serverConfig.host] = token;
      wx.setStorageSync('serverTokens', serverTokens);

      await this.getUserInfo();
    } catch (err) {
      wx.showToast({
        title: err.message || '登录失败',
        icon: 'none'
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

    const selectedServer = this.getSelectedServer();

    app.globalData.serverConfig = {
      name: selectedServer.name || 'Custom Server',
      host: selectedServer.host,
      port: selectedServer.port || 60050 // Default port if not specified
    };

    api.login({ username, password })
      .then(res => {
        if (res && res.token) {
          wx.setStorageSync('token', res.token);
          app.globalData.token = res.token;

          // 登录成功后再保存凭据，按 host 关联避免服务器列表变动错位
          try {
            if (selectedServer && selectedServer.host) {
              const serverCredentials = wx.getStorageSync('serverCredentials') || {};
              serverCredentials[selectedServer.host] = { username, password };
              wx.setStorageSync('serverCredentials', serverCredentials);
              // token 按服务器 host 缓存，切换服务器时免登录恢复管理态
              const serverTokens = wx.getStorageSync('serverTokens') || {};
              serverTokens[selectedServer.host] = res.token;
              wx.setStorageSync('serverTokens', serverTokens);
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
        this.getOidcConfig();
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

    this.getOidcConfig();
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
