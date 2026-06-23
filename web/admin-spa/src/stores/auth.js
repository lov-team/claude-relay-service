import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import router from '@/router'

import { loginApi, getAuthUserApi, refreshAuthApi, getOemSettingsApi } from '@/utils/http_apis'

const ADMIN_SESSION_REFRESH_INTERVAL = 60 * 60 * 1000

export const useAuthStore = defineStore('auth', () => {
  // 状态
  const isLoggedIn = ref(false)
  const authToken = ref(localStorage.getItem('authToken') || '')
  const username = ref('')
  const loginError = ref('')
  const loginLoading = ref(false)
  const oemSettings = ref({
    siteName: 'Claude Relay Service',
    siteIcon: '',
    siteIconData: '',
    faviconData: ''
  })
  const oemLoading = ref(true)
  let refreshTimer = null

  // 计算属性
  const isAuthenticated = computed(() => !!authToken.value && isLoggedIn.value)
  const token = computed(() => authToken.value)
  const user = computed(() => ({ username: username.value }))

  // 方法
  async function login(credentials) {
    loginLoading.value = true
    loginError.value = ''

    try {
      const result = await loginApi(credentials)

      if (result.success) {
        authToken.value = result.token
        username.value = result.username || credentials.username
        isLoggedIn.value = true
        localStorage.setItem('authToken', result.token)
        startAutoRefresh()

        await router.push('/dashboard')
      } else {
        loginError.value = result.message || '登录失败'
      }
    } catch (error) {
      loginError.value = error.message || '登录失败，请检查用户名和密码'
    } finally {
      loginLoading.value = false
    }
  }

  function logout() {
    stopAutoRefresh()
    isLoggedIn.value = false
    authToken.value = ''
    username.value = ''
    localStorage.removeItem('authToken')
    router.push('/login')
  }

  function checkAuth() {
    if (authToken.value) {
      isLoggedIn.value = true
      startAutoRefresh()
      // 验证token有效性
      verifyToken()
    }
  }

  async function verifyToken() {
    try {
      const userResult = await getAuthUserApi()
      if (!userResult.success || !userResult.user) {
        logout()
        return
      }
      username.value = userResult.user.username
      refreshAdminSession({ logoutOnFailure: false })
    } catch (error) {
      logout()
    }
  }

  function startAutoRefresh() {
    if (typeof window === 'undefined') return
    stopAutoRefresh()
    refreshTimer = window.setInterval(() => {
      refreshAdminSession({ logoutOnFailure: false })
    }, ADMIN_SESSION_REFRESH_INTERVAL)
  }

  function stopAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
  }

  async function refreshAdminSession({ logoutOnFailure = true } = {}) {
    if (!authToken.value) return

    try {
      const result = await refreshAuthApi()
      if (result.success && result.token) {
        authToken.value = result.token
        localStorage.setItem('authToken', result.token)
      } else if (logoutOnFailure) {
        logout()
      }
    } catch (error) {
      if (logoutOnFailure) {
        logout()
      }
    }
  }

  async function loadOemSettings() {
    oemLoading.value = true
    try {
      const result = await getOemSettingsApi()
      if (result.success && result.data) {
        oemSettings.value = { ...oemSettings.value, ...result.data }

        if (result.data.siteIconData || result.data.siteIcon) {
          const link = document.querySelector("link[rel*='icon']") || document.createElement('link')
          link.type = 'image/x-icon'
          link.rel = 'shortcut icon'
          link.href = result.data.siteIconData || result.data.siteIcon
          document.getElementsByTagName('head')[0].appendChild(link)
        }

        if (result.data.siteName) {
          document.title = `${result.data.siteName} - 管理后台`
        }
      }
    } catch (error) {
      console.error('加载OEM设置失败:', error)
    } finally {
      oemLoading.value = false
    }
  }

  return {
    // 状态
    isLoggedIn,
    authToken,
    username,
    loginError,
    loginLoading,
    oemSettings,
    oemLoading,

    // 计算属性
    isAuthenticated,
    token,
    user,

    // 方法
    login,
    logout,
    checkAuth,
    refreshAdminSession,
    loadOemSettings
  }
})
