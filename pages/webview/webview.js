import { generateAPRSPasscode } from '../../utils/aprs';
const app = getApp();

Page({
    data: {
        url: '',
        mode: ''
    },
    onLoad(options) {
        if (options.url) {
            this.setData({
                url: decodeURIComponent(options.url),
                mode: options.mode || ''
            });
        }
        this.oidcHandled = false;
    },

    // OIDC 模式：后端完成认证后会把页面 302 到 Web 前端的
    // /oidc-callback?token=...（失败时 /login?oidc_error=...），
    // 从 web-view 加载完成的 URL 中取出平台 token 完成登录
    onWebviewLoad(e) {
        if (this.data.mode !== 'oidc' || this.oidcHandled) return;

        const src = (e.detail && e.detail.src) || '';
        if (!src) return;

        const tokenMatch = src.match(/[?&]token=([^&#]+)/);
        if (src.indexOf('oidc-callback') !== -1 && tokenMatch) {
            this.oidcHandled = true;
            this.completeOidcLogin(decodeURIComponent(tokenMatch[1]));
            return;
        }

        const errorMatch = src.match(/[?&]oidc_error=([^&#]+)/);
        if (errorMatch) {
            this.oidcHandled = true;
            wx.showToast({
                title: decodeURIComponent(errorMatch[1]) || 'OIDC 登录失败',
                icon: 'none',
                duration: 3000
            });
            setTimeout(() => wx.navigateBack(), 1500);
        }
    },

    // 与登录页密码登录成功后的处理一致：存 token/服务器配置，拉取用户信息后进入语音页
    async completeOidcLogin(token) {
        const api = require('../../utils/api');

        try {
            wx.setStorageSync('token', token);
            app.globalData.token = token;
            wx.setStorageSync('serverConfig', app.globalData.serverConfig);

            // token 按服务器 host 缓存，切换服务器时免登录恢复管理态
            const serverTokens = wx.getStorageSync('serverTokens') || {};
            serverTokens[app.globalData.serverConfig.host] = token;
            wx.setStorageSync('serverTokens', serverTokens);

            const userInfo = await api.getUserInfo();

            if (!userInfo || !userInfo.callsign) {
                wx.showToast({
                    title: '用户信息缺少呼号',
                    icon: 'none'
                });
                this.oidcHandled = false;
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
                title: err.message || '登录失败',
                icon: 'none'
            });
            this.oidcHandled = false;
        }
    }
});
