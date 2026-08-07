<template>
  <div>
    <div v-if="loading" class="py-12 text-center">
      <div class="loading-spinner mx-auto mb-4"></div>
      <p class="text-gray-500 dark:text-gray-400">正在加载养号配置...</p>
    </div>

    <div v-else class="space-y-6">
      <div class="rounded-lg bg-white/80 p-6 shadow-lg backdrop-blur-sm dark:bg-gray-800/80">
        <h4 class="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">全局开关</h4>
        <div class="grid gap-4 md:grid-cols-2">
          <label
            class="flex items-center justify-between rounded-lg border border-gray-200 p-4 dark:border-gray-700"
          >
            <span class="text-sm text-gray-700 dark:text-gray-200">启用养号护栏</span>
            <input v-model="form.enabled" type="checkbox" @change="saveConfig" />
          </label>
          <label
            class="flex items-center justify-between rounded-lg border border-gray-200 p-4 dark:border-gray-700"
          >
            <span class="text-sm text-gray-700 dark:text-gray-200">新建 Pro 默认开启</span>
            <input v-model="form.defaultEnabledForNewPro" type="checkbox" @change="saveConfig" />
          </label>
          <label
            class="flex items-center justify-between rounded-lg border border-gray-200 p-4 dark:border-gray-700"
          >
            <span class="text-sm text-gray-700 dark:text-gray-200">新建 Max 默认开启</span>
            <input v-model="form.defaultEnabledForNewMax" type="checkbox" @change="saveConfig" />
          </label>
        </div>
      </div>

      <div class="rounded-lg bg-white/80 p-6 shadow-lg backdrop-blur-sm dark:bg-gray-800/80">
        <h4 class="mb-2 text-lg font-semibold text-gray-900 dark:text-gray-100">请求与认证保护</h4>
        <p class="mb-4 text-sm text-gray-500 dark:text-gray-400">
          在选择账号和刷新 Token 前拦截异常负载；附加错误文案用于识别新的封禁或凭据撤销响应。
        </p>

        <label
          class="mb-4 flex items-center justify-between rounded-lg border border-gray-200 p-4 dark:border-gray-700"
        >
          <span class="text-sm text-gray-700 dark:text-gray-200">启用请求流量护栏</span>
          <input v-model="form.trafficGuardrails.enabled" type="checkbox" @change="saveConfig" />
        </label>

        <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <div v-for="field in trafficGuardrailFields" :key="field.key">
            <label class="text-sm text-gray-600 dark:text-gray-300">{{ field.label }}</label>
            <input
              v-model.number="form.trafficGuardrails[field.key]"
              class="mt-1 w-full rounded-lg border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              :max="field.max"
              :min="field.min"
              type="number"
              @change="saveConfig"
            />
          </div>
        </div>

        <div class="mt-5 grid gap-4 lg:grid-cols-2">
          <div>
            <label class="text-sm text-gray-600 dark:text-gray-300">附加封禁文案</label>
            <textarea
              v-model="blockedPatternsText"
              class="mt-1 min-h-28 w-full rounded-lg border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              placeholder="每行一条；内置规则会继续生效"
              @change="saveConfig"
            ></textarea>
          </div>
          <div>
            <label class="text-sm text-gray-600 dark:text-gray-300">附加凭据撤销文案</label>
            <textarea
              v-model="revokedPatternsText"
              class="mt-1 min-h-28 w-full rounded-lg border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              placeholder="每行一条，例如新的 invalid_grant 文案"
              @change="saveConfig"
            ></textarea>
          </div>
        </div>
      </div>

      <div class="rounded-lg bg-white/80 p-6 shadow-lg backdrop-blur-sm dark:bg-gray-800/80">
        <h4 class="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">节奏与增速</h4>
        <div class="grid gap-4 md:grid-cols-3">
          <div>
            <label class="text-sm text-gray-600 dark:text-gray-300">7天节奏缓冲 (1.0-1.2)</label>
            <input
              v-model.number="form.paceBuffer"
              class="mt-1 w-full rounded-lg border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              step="0.01"
              type="number"
              @change="saveConfig"
            />
          </div>
          <div>
            <label class="text-sm text-gray-600 dark:text-gray-300"
              >养号期 Pro 日增速上限 (%)</label
            >
            <input
              v-model.number="form.maxDailySevenDayDelta.pro"
              class="mt-1 w-full rounded-lg border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              type="number"
              @change="saveConfig"
            />
          </div>
          <div>
            <label class="text-sm text-gray-600 dark:text-gray-300"
              >养号期 Max 日增速上限 (%)</label
            >
            <input
              v-model.number="form.maxDailySevenDayDelta.max"
              class="mt-1 w-full rounded-lg border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              type="number"
              @change="saveConfig"
            />
          </div>
        </div>
      </div>

      <AccountNurtureDayPlansTable
        v-if="form.proDayPlans.length === 7"
        v-model:plans="form.proDayPlans"
        :steady-caps="form.steadyCaps.pro"
        tier="pro"
        @change="saveConfig"
      />

      <AccountNurtureDayPlansTable
        v-if="form.maxDayPlans.length === 7"
        v-model:plans="form.maxDayPlans"
        :steady-caps="form.steadyCaps.max"
        tier="max"
        @change="saveConfig"
      />

      <div
        v-for="tier in ['pro', 'max']"
        :key="tier"
        class="rounded-lg bg-white/80 p-6 shadow-lg backdrop-blur-sm dark:bg-gray-800/80"
      >
        <h4 class="mb-4 text-lg font-semibold uppercase text-gray-900 dark:text-gray-100">
          {{ tier }} 常驻上限
        </h4>
        <div class="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
          <div v-for="field in steadyFields" :key="`${tier}-${field.key}`">
            <label class="text-sm text-gray-600 dark:text-gray-300">{{ field.label }}</label>
            <input
              v-model.number="form.steadyCaps[tier][field.key]"
              class="mt-1 w-full rounded-lg border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              :max="['rpm', 'localRequests'].includes(field.key) ? undefined : 89"
              min="1"
              type="number"
              @change="saveConfig"
            />
          </div>
        </div>
      </div>

      <div class="flex flex-wrap gap-3">
        <button
          class="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
          @click="saveConfig"
        >
          保存配置
        </button>
        <button
          class="rounded-lg border border-gray-300 px-4 py-2 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          @click="resetDefaults"
        >
          恢复默认
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { showToast } from '@/utils/tools'
import AccountNurtureDayPlansTable from '@/components/settings/AccountNurtureDayPlansTable.vue'
import {
  getAccountNurtureConfigApi,
  updateAccountNurtureConfigApi,
  resetAccountNurtureConfigApi
} from '@/utils/http_apis'

const loading = ref(true)
const form = ref({
  enabled: true,
  defaultEnabledForNewPro: true,
  defaultEnabledForNewMax: true,
  paceBuffer: 1.08,
  maxDailySevenDayDelta: { pro: 10, max: 15 },
  oauthErrorPatterns: {
    blocked: [],
    revoked: []
  },
  trafficGuardrails: {
    enabled: false,
    maxBodyBytes: 1048576,
    maxMessages: 200,
    maxTools: 64,
    maxOutputTokens: 32768,
    retryAfterSeconds: 60
  },
  steadyCaps: {
    pro: {
      rpm: 30,
      fiveHour: 86,
      sevenDay: 82,
      sevenDayOpus: 78,
      sevenDayVelocity: 10,
      localRequests: 260
    },
    max: {
      rpm: 50,
      fiveHour: 88,
      sevenDay: 86,
      sevenDayOpus: 84,
      sevenDayVelocity: 15,
      localRequests: 480
    }
  },
  proDayPlans: [],
  maxDayPlans: []
})

const steadyFields = [
  { key: 'rpm', label: 'RPM' },
  { key: 'fiveHour', label: '5h %' },
  { key: 'sevenDay', label: '7d %' },
  { key: 'sevenDayOpus', label: '7d Opus %' },
  { key: 'sevenDayVelocity', label: '7天日增速封顶 %' },
  { key: 'localRequests', label: '本地请求数' }
]

const trafficGuardrailFields = [
  { key: 'maxBodyBytes', label: '请求体上限（字节）', min: 65536, max: 33554432 },
  { key: 'maxMessages', label: '消息数上限', min: 1, max: 1000 },
  { key: 'maxTools', label: '工具数上限', min: 1, max: 256 },
  { key: 'maxOutputTokens', label: '输出 Token 上限', min: 1, max: 128000 },
  { key: 'retryAfterSeconds', label: '重试等待（秒）', min: 1, max: 3600 }
]

const patternTextModel = (key) =>
  computed({
    get: () => {
      const value = form.value.oauthErrorPatterns?.[key]
      return Array.isArray(value) ? value.join('\n') : value || ''
    },
    set: (value) => {
      form.value.oauthErrorPatterns ||= { blocked: [], revoked: [] }
      form.value.oauthErrorPatterns[key] = value
        .split(/\r?\n/)
        .map((pattern) => pattern.trim())
        .filter(Boolean)
    }
  })

const blockedPatternsText = patternTextModel('blocked')
const revokedPatternsText = patternTextModel('revoked')

const applyConfig = (config = {}) => {
  form.value = {
    ...form.value,
    ...config,
    oauthErrorPatterns: {
      ...form.value.oauthErrorPatterns,
      ...(config.oauthErrorPatterns || {})
    },
    trafficGuardrails: {
      ...form.value.trafficGuardrails,
      ...(config.trafficGuardrails || {})
    }
  }
}

const loadConfig = async () => {
  loading.value = true
  try {
    const response = await getAccountNurtureConfigApi()
    if (response.success && response.config) {
      applyConfig(response.config)
    }
  } catch (error) {
    showToast('加载养号配置失败', 'error')
    console.error(error)
  } finally {
    loading.value = false
  }
}

const hasInvalidDayPlans = (plans) =>
  plans.some(
    (plan) =>
      plan.fiveHourMin > plan.fiveHourMax ||
      plan.sevenDayMin > plan.sevenDayMax ||
      plan.localRequestsMin > plan.localRequestsMax ||
      plan.fiveHourMax >= 90 ||
      plan.sevenDayMax >= 90
  )

const hasInvalidSteadyLocalCaps = () =>
  form.value.steadyCaps.pro.localRequests < form.value.proDayPlans[6].localRequestsMax ||
  form.value.steadyCaps.max.localRequests < form.value.maxDayPlans[6].localRequestsMax

const hasInvalidTrafficGuardrails = () =>
  trafficGuardrailFields.some(({ key, min, max }) => {
    const value = form.value.trafficGuardrails[key]
    return !Number.isInteger(value) || value < min || value > max
  })

const hasInvalidOAuthPatterns = () =>
  ['blocked', 'revoked'].some((key) => {
    const patterns = form.value.oauthErrorPatterns[key] || []
    return patterns.length > 50 || patterns.some((pattern) => pattern.length > 200)
  })

const saveConfig = async () => {
  if (hasInvalidDayPlans(form.value.proDayPlans) || hasInvalidDayPlans(form.value.maxDayPlans)) {
    showToast('七天曲线存在无效区间（min > max 或百分比 ≥ 90%）', 'error')
    return
  }
  if (hasInvalidSteadyLocalCaps()) {
    showToast('常驻本地请求数不能低于对应套餐的 Day7 上限', 'error')
    return
  }
  if (hasInvalidTrafficGuardrails()) {
    showToast('请求流量护栏参数超出允许范围', 'error')
    return
  }
  if (hasInvalidOAuthPatterns()) {
    showToast('认证错误文案每类最多 50 条、每条最多 200 个字符', 'error')
    return
  }

  try {
    const response = await updateAccountNurtureConfigApi(form.value)
    if (response.success) {
      applyConfig(response.config)
      showToast('养号配置已保存', 'success')
    }
  } catch (error) {
    showToast(error?.response?.data?.message || '保存养号配置失败', 'error')
  }
}

const resetDefaults = async () => {
  try {
    const response = await resetAccountNurtureConfigApi()
    if (response.success) {
      applyConfig(response.config)
      showToast('已恢复默认养号配置', 'success')
    }
  } catch (error) {
    showToast('恢复默认配置失败', 'error')
  }
}

onMounted(loadConfig)
</script>
