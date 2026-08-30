// 基础配置
 
const getDefaultHeaders = () => ({
  'Content-Type': 'application/json',
  'x-token': wx.getStorageSync('token') || ''
});

// 请求拦截器
const requestInterceptor = (config) => {
  // wx.showLoading({
  //   title: '加载中...',
  //   mask: true
  // });
  return config;
};

// 响应拦截器
const responseInterceptor = (response, config = {}) => {
  // wx.hideLoading();
  if (response.statusCode !== 200) {
    throw new Error('网络请求失败');
  }

  //console.log('response', response)
  // 20000 和 20001 都是有效状态码
  if (response.data.code === 20000 || response.data.code === 60204) {
    return response.data.data;
  } else if (response.data.code === 20001) {
    // 服务器的错误消息在 data.message 里（顶层 message 可能为空）
    if (!config.silent) {
      wx.showToast({
        title: response.data.message || (response.data.data && response.data.data.message) || '操作失败',
        icon: 'error',
        duration: 5000 // Further increase the duration for the success message
      });
    }

    return

  } else if (response.data.code === 50008) {
    // 登录态失效（token 过期或服务器重启）：降级为未登录。
    // 只清除"这次请求实际携带的 token"对应服务器的凭证 —— 不能无条件清全局 token，
    // 否则切换服务器后旧服务器的迟到 50008 响应会误清新服务器的登录态
    const reqToken = config.header && config.header['x-token'];
    const hostMatch = /^https:\/\/([^/]+)/.exec(config.url || '');
    const reqHost = hostMatch && hostMatch[1];
    if (reqToken && reqHost) {
      const app = getApp();
      // 缓存的还是这个 token 才删除（可能已被新登录刷新）
      const serverTokens = wx.getStorageSync('serverTokens') || {};
      if (serverTokens[reqHost] === reqToken) {
        delete serverTokens[reqHost];
        wx.setStorageSync('serverTokens', serverTokens);
      }
      // 只有当前仍连着这台服务器、且当前 token 就是失效的那个，才降级全局登录态
      const curHost = app.globalData.serverConfig && app.globalData.serverConfig.host;
      if (reqHost === curHost && wx.getStorageSync('token') === reqToken) {
        wx.removeStorageSync('token');
        app.globalData.token = null;
        if (!config.silent) {
          wx.showToast({
            title: '登录已过期，管理功能需重新登录',
            icon: 'none'
          });
        }
      }
    }
    // 业务确定性错误，打标记让重试循环直接抛出，调用方据此提示"请先登录"
    const error = new Error('未登录或登录已过期');
    error.authError = true;
    error.noRetry = true;
    throw error;
  }

  // 其他状态码需要跳转登录页
  getApp().globalData.token = null;
  wx.removeStorageSync('token');
  wx.removeStorageSync('userInfo');

  wx.showToast({
    title: '登录已过期，请重新登录',
    icon: 'none'
  });
  wx.reLaunch({
    url: '/pages/login/login'
  });
  // 业务确定性错误，打标记让重试循环直接抛出
  const error = new Error('登录已过期');
  error.noRetry = true;
  throw error;

};

// 统一请求方法
const request = async (options, retries = 3, timeout = 10000) => {

  const app = getApp();

  //console.log('request.header:', options.header);

  const config = requestInterceptor({
    url: 'https://' + app.globalData.serverConfig.host + options.url,
    method: options.method || 'GET',
    header: {
      ...getDefaultHeaders(), // 获取默认的 header
      ...options.header       // 覆盖 options.header 中的字段
    },

    data: options.data || {},
    timeout: timeout // Ensure timeout is passed to local config
  });

  if (!options.silent) {
    wx.showLoading({
      title: '加载中...',
      mask: true
    });
  }

  try {
    for (let i = 0; i < retries; i++) {
      try {
        const result = await new Promise((resolve, reject) => {
          wx.request({
            ...config,
            success: (res) => {
              try {
                const data = responseInterceptor(res, { url: config.url, header: config.header, silent: !!options.silent });
                resolve(data);
              } catch (error) {
                reject(error);
              }
            },
            fail: reject
          });
        });

        return result;
      } catch (error) {
        // token 过期等业务确定性错误不重试
        if (error && error.noRetry) throw error;

        if (i === retries - 1) {
          throw error;
        }

        // 等待一段时间后重试
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      }
    }
  } finally {
    if (!options.silent) wx.hideLoading();
  }
};

// API 集合
export const api = {
  // 获取群组列表
  getGroupList() {
    return request({
      url: '/group/list',
      method: 'POST'
    });
  },

  // 获取群组mini列表
  getGroup(data, silent = false) {
    return request({
      url: '/group/get',
      method: 'POST',
      data,
      silent
    });
  },

  // 获取群组mini列表
  getGroupListMini() {
    return request({
      url: '/group/list/mini',
      method: 'POST'
    });
  },



  // 获取设备列表
  getDeviceList() {
    return request({
      url: '/device/list', // 修改为新的接口地址
      method: 'POST'
    });
  },

  // 获取设备列表
  getDevice(data, silent = false) {
    return request({
      url: '/device/get', // 修改为新的接口地址
      method: 'POST',
      data,
      silent
    });
  },

  getMyDevices() {
    return request({
      url: '/device/mydevlist', // 修改为新的接口地址
      method: 'GET',
    });
  },

  getQTH(data, silent = false) {
    return request({
      url: '/device/qths', // 修改为新的接口地址
      method: 'POST',
      data,
      silent
    });
  },



  // getQTHmap() {
  //   return request({
  //     url: '/device/qthmap', // 修改为新的接口地址
  //     method: 'GET',
  //   });
  // },




  // 获取设备列表
  getplatformList() {
    return request({
      url: '/platform/list', // 修改为新的接口地址
      method: 'POST'
    });
  },




  // 更新设备信息
  updateDevice(device) {
    return request({
      url: '/device/update',
      method: 'POST',
      data: device
    });
  },

  updateAvatar(avatar) {
    return request({
      url: '/user/update/avatar',
      method: 'POST',
      data: avatar
    });
  },


  // 用户登录
  login(credentials) {
    return request({
      url: '/user/login',
      method: 'POST',
      data: credentials
    });
  },

  // 用户登录
  logout(data) {
    return request({
      url: '/user/logout',
      method: 'POST',
      data

    });
  },


  // 获取用户信息
  getUserInfo() {
    return request({
      url: '/user/info',
      method: 'GET'
    });
  },


  queryDevice(data) {
    return request({
      url: '/device/query',
      method: 'post',
      data
    })
  },

  // 通过服务器向设备发送 AT 指令（服务器经 UDP type-11 中继给设备）。
  // data: { callsign, ssid, type, atcommand, data }，type 1=查询 2=写入。
  // 注意：AT 回复是异步的，返回的 last_atcommand 可能是上一次的，
  // 调用方需要用 getDevice 轮询等待刷新。
  deviceAT(data, silent = false) {
    return request({
      url: '/device/at',
      method: 'POST',
      data,
      silent
    })
  },

  bingDevice(data) {
    return request({
      url: '/device/binddevice',
      method: 'post',
      data
    })
  },

  changeDeviceParm(data) {
    // const formData = Object.keys(data)
    // .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`)
    // .join('&');

    //console.log(data);

    return request({
      url: '/device/change',
      method: 'POST',
      header: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data
    })
  },

  changeDevice1w(data) {
    return request({
      url: '/device/change1w',
      method: 'post',
      data
    })
  },

  changeDevice2w(data) {
    return request({
      url: '/device/change2w',
      method: 'post',
      data
    })
  },

  fetchDeviceStats(data) {
    return request({
      url: '/device/stats',
      method: 'post',
      data
    })
  },

  fetchRelayList(data) {
    return request({
      url: '/relay/list',
      method: 'post',
      data
    })
  },


  // 用户注册
  register(data, host) {
    return new Promise((resolve, reject) => {
      // 封装 wx.uploadFile 为 Promise
      const uploadFile = (url, filePath, name, formData) => {
        return new Promise((resolve, reject) => {
          wx.uploadFile({
            url,
            filePath,
            name,
            formData,
            success: (res) => {
              resolve(res); // 成功时返回响应对象
            },
            fail: (err) => {
              reject(err); // 失败时返回错误
            }
          });
        });
      };

      // 构造上传任务
      const licenseTask = uploadFile(
        'https://' + host + '/user/reg/create',
        data.license,
        'license',
        {
          ...data,
          license: undefined
        }
      );


      // 使用 Promise.all 处理并发任务
      Promise.all([licenseTask])
        .then(results => {
          const [licenseRes] = results;

          console.log('licenseRes', licenseRes);
          //console.log('certificateRes', certificateRes);

          // 检查上传结果的状态码
          if (!licenseRes || licenseRes.statusCode !== 200) {
            reject(new Error('电台执照上传失败'));
            return;
          }

          // if (!certificateRes || certificateRes.statusCode !== 200) {
          //   reject(new Error('操作证上传失败'));
          //   return;
          // }

          // 尝试解析响应数据
          try {
            resolve(JSON.parse(licenseRes.data || '{}'));
          } catch (e) {
            reject(new Error('解析响应数据失败'));
          }
        })
        .catch(err => {
          reject(err);
        });
    });
  }

};

export const {
  getGroupList,
  getGroup,
  getGroupListMini,
  getDeviceList,
  getDevice,
  getMyDevices,
  getQTH,
  getplatformList,
  updateDevice,
  updateAvatar,
  login,
  logout,
  getUserInfo,
  queryDevice,
  deviceAT,
  bingDevice,
  changeDeviceParm,
  changeDevice1w,
  changeDevice2w,
  fetchDeviceStats,
  fetchRelayList,
  register
} = api;

export default api;
