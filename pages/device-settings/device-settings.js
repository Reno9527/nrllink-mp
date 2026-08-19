import {
  ctcssOptions
} from '../../utils/constants.js';

const { fetchRelayList, changeDeviceParm, changeDevice1w, getplatformList } = require('../../utils/api');

// pages/deviceParams/deviceParams.js
Page({
  data: {
    one_recive_cxcss: null,
    one_transmit_cxcss: null,
    temp: {
      callsign: '',
      ssid: '',
      name: '',
      device_parm: {
        local_password: '',
        local_ipaddr: '',
        netmask: '',
        gateway: '',
        dns_ipaddr: '',
        dest_domainname: '',
        peer_password: '',
        dcd_select: 0,
        ptt_enable: 0,
        ptt_level_reversed: 0,
        ptt_resistive: 0,
        monitor: 0,
        realy_status: 0,
        one_uv_power: 0,
        key_func: 0,
        add_tail_voice: 15,
        remove_tail_voice: 0,
        moto_channel: 0,
        one_recive_freq: '430.0000',
        one_transmit_freq: '430.0000',
        one_recive_cxcss: '0',
        one_transmit_cxcss: '0',
        one_volume: 0,
        one_sql_level: 0,
        one_mic_sensitivity: 0,
        two_recive_freq: '430.0000',
        two_transmit_freq: '430.0000',
        two_recive_cxcss: '0',
        two_transmit_cxcss: '0',
        two_volume: 1,
        two_sql_level: 1,
        two_mic_level: 1
      }
    },
    collapseOpen: {
      '1': false,
      '2': false,
      '3': false,
      '4': false,
      // '5': false
    },
    dcdOptions: [
      { value: 0, label: '关闭' },
      { value: 1, label: '手动' },
      { value: 2, label: 'SQL_LO' },
      { value: 3, label: 'SQL_HI' },
      { value: 4, label: 'VOX' }
    ],
    motoChannelOptions: Array.from({ length: 17 }, (_, i) => i),
    ctcssOptions: [], // 需从外部引入或定义
    relayOptions: [], // 需从 API 或本地定义
    platformOptions: [], // 新增平台列表选项
    volumeOptions: Array.from({ length: 9 }, (_, i) => i + 1),
    sqlOptions: Array.from({ length: 9 }, (_, i) => i + 1),
    micOptions: Array.from({ length: 9 }, (_, i) => i + 1),
    motoChannelIndex: 0,
    ctcssIndex1wRecive: 0,
    ctcssIndex1wTransmit: 0,
    relayIndex: 0,
    platformIndex: 0, // 新增平台索引
    current_relay_label: '空模板'
  },

  onLoad(options) {
    // 初始化数据
    if (options.device) {
      let device = null;
      try {
        device = JSON.parse(decodeURIComponent(options.device));
      } catch (e) {
        console.error('设备参数解析失败:', e);
        wx.showToast({ title: '设备参数错误', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      this.setData({
        temp: device
      });
      this.updatePickerIndex();
    }

    // 假设 ctcssOptions 和 relayOptions 从外部获取
    this.setData({
      ctcssOptions: ctcssOptions || []
    });
    this.fetchRelayOptions(); // 异步获取，完成后内部自行 setData

    // 新增调用获取平台列表的方法
    this.fetchPlatformList();
  },

  // 更新选择器索引
  updatePickerIndex() {
    const parm = this.data.temp.device_parm;
    const reciveCtcssIndex = ctcssOptions.findIndex(item => item.id === parm.one_recive_cxcss);
    const transmitCtcssIndex = ctcssOptions.findIndex(item => item.id === parm.one_transmit_cxcss);
    const platformIndex = this.data.platformOptions.findIndex(item => item.ipaddr === parm.dest_domainname);
    this.setData({
      motoChannelIndex: parm.moto_channel,
      ctcssIndex1wRecive: reciveCtcssIndex < 0 ? 0 : reciveCtcssIndex,
      ctcssIndex1wTransmit: transmitCtcssIndex < 0 ? 0 : transmitCtcssIndex,
      one_recive_cxcss: ctcssOptions.find(item => item.id === parm.one_recive_cxcss)?.name,
      one_transmit_cxcss: ctcssOptions.find(item => item.id === parm.one_transmit_cxcss)?.name,
      platformIndex: platformIndex < 0 ? 0 : platformIndex
    });
  },

  // 格式化 relayOptions
  fetchRelayOptions() {
    fetchRelayList({}).then(resp => {
      this.setData({
        relayOptions: [
          { id: 0, name: '空模板', up_freq: '430.0000', down_freq: '430.0000', send_ctss: "0", recive_ctss: "0" },
          ...resp.items
        ]
      });
      this.updatePickerIndex();
    }).catch(err => {
      console.error('Failed to fetch relayOptions:', err);
    });
  },

  // 输入框更新
  updateInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({
      [`temp.device_parm.${field}`]: e.detail.value
    });
  },

  // 单选框更新
  updateRadio(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({
      [`temp.device_parm.${field}`]: parseInt(e.detail.value)
    });
    this.changeByte(field, e.detail.value);
  },

  // 开关更新
  updateSwitch(e) {
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value ? 1 : 0;
    this.setData({
      [`temp.device_parm.${field}`]: value
    });
    this.changeByte(field, value);
  },

  // 滑块更新
  updateSlider(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({
      [`temp.device_parm.${field}`]: e.detail.value
    });
    this.changeByte(field, e.detail.value);
  },

  // 信道选择更新
  updateMotoChannel(e) {
    const value = this.data.motoChannelOptions[e.detail.value];
    this.setData({
      'temp.device_parm.moto_channel': value,
      motoChannelIndex: e.detail.value
    });
    this.changeByte('moto_channel', value);
  },

  // CTCSS选择更新
  updateCtcss(e) {

    const field = e.currentTarget.dataset.field;
    const index = Number(e.detail.value);
    const value = this.data.ctcssOptions[index].id;
    const indexField = field === 'one_recive_cxcss' ? 'ctcssIndex1wRecive' : 'ctcssIndex1wTransmit';

    this.setData({
      [`temp.device_parm.${field}`]: value,
      [indexField]: index,
      [field]: this.data.ctcssOptions[index].name
    });
  },

  // 平台选择更新
  updatePlatform(e) {
    const index = e.detail.value;
    const platform = this.data.platformOptions[index];
    this.setData({
      'temp.device_parm.dest_domainname': platform.host,
      platformIndex: index
    });
  },

  // 频点模板应用
  applyRelay(e) {
    const relay = this.data.relayOptions[e.detail.value];

    this.setData({
      'temp.device_parm.one_recive_freq': relay.down_freq,
      'temp.device_parm.one_transmit_freq': relay.up_freq,
      'temp.device_parm.one_recive_cxcss': relay.recive_ctss,
      'temp.device_parm.one_transmit_cxcss': relay.send_ctss,
      relayIndex: e.detail.value,
      current_relay_label: relay.name
    });

    this.updatePickerIndex();

    console.log('applyRelay:', relay);
    console.log('applyRelay:', this.data.temp.device_parm);
  },

  // 保存 IP 设置
  confirmIPChange() {
    wx.showModal({
      title: '确认',
      content: '请确认IP地址是否正确，错误后设备将找不到家！！！',
      success: (res) => {
        if (res.confirm) {
          this.changeIP();
        }
      }
    });
  },

  changeIP() {
    const { local_ipaddr, gateway, netmask, dns_ipaddr, dest_domainname } = this.data.temp.device_parm;
    const { dmrid, callsign, ssid } = this.data.temp;
    changeDeviceParm(
      'DMRID=' +
        dmrid +
        '&callsign=' +
        callsign +
        '&ssid=' +
        ssid +
        '&local_ipaddr=' +
        local_ipaddr +
        '&gateway=' +
        gateway +
        '&netmask=' +
        netmask +
        '&dns_ipaddr=' +
        dns_ipaddr +
        '&dest_domainname=' +
        dest_domainname
    ).then((response) => {
      // 业务失败（如 20001）时拦截器已 toast 错误，这里直接返回
      if (response === undefined) return;
      wx.showToast({ title: response.message || '保存成功', icon: 'success' });
    }).catch((err) => {
      console.error('保存IP设置失败:', err);
      wx.showToast({ title: '保存失败，请检查网络', icon: 'none' });
    });
  },

  // 保存单个参数
  changeByte(name, value) {
    const { dmrid, callsign, ssid } = this.data.temp;
    changeDeviceParm(
      'DMRID=' +
        dmrid +
        '&callsign=' +
        callsign +
        '&ssid=' +
        ssid +
        '&' +
        name +
        '=' +
        value
    ).then((response) => {
      // 业务失败（如 20001）时拦截器已 toast 错误，这里直接返回
      if (response === undefined) return;
      wx.showToast({ title: response.message || '保存成功', icon: 'success' });
    }).catch((err) => {
      console.error('保存参数失败:', err);
      wx.showToast({ title: '保存失败，请检查网络', icon: 'none' });
    });
  },

  // 保存 1W 参数
  update1w() {
    changeDevice1w(this.data.temp.device_parm).then((response) => {
      // 业务失败（如 20001）时拦截器已 toast 错误，这里直接返回
      if (response === undefined) return;
      wx.showToast({ title: response.message || '1w参数保存成功', icon: 'success' });
    }).catch((err) => {
      console.error('保存1w参数失败:', err);
      wx.showToast({ title: '保存失败，请检查网络', icon: 'none' });
    });
  },

  // 切换折叠面板
  toggleCollapse(e) {
    const name = e.currentTarget.dataset.name;
    this.setData({
      [`collapseOpen[${name}]`]: !this.data.collapseOpen[name]
    });
  },

  // 关闭页面
  closeDialog() {
    wx.navigateBack();
  },

  // 表单提交（如果需要整体保存）
  submitForm() {
    // 可选：整体保存逻辑
  },

  // 获取平台列表
  fetchPlatformList() {
    getplatformList().then((response) => {
      // 业务失败（20001）时拦截器已提示，response 为 undefined
      if (response === undefined) return;
      const platformIndex = response.items.findIndex(item => item.ipaddr === this.data.temp.device_parm.dest_domainname);
      this.setData({
        platformOptions: response.items,
        platformIndex: platformIndex < 0 ? 0 : platformIndex
      });
      this.updatePickerIndex();
    }).catch((error) => {
      console.error('获取平台列表失败', error);
      wx.showToast({
        title: '获取平台列表失败',
        icon: 'none'
      });
    });
  }
});
