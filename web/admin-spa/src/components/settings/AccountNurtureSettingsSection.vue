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
            <span class="text-sm text-gray-700 dark:text-gray-200">新建 Max 5x 默认开启</span>
            <input v-model="form.defaultEnabledForNewMax" type="checkbox" @change="saveConfig" />
          </label>
          <label
            class="flex items-center justify-between rounded-lg border border-gray-200 p-4 dark:border-gray-700"
          >
            <span class="text-sm text-gray-700 dark:text-gray-200">新建 Max 20x 默认开启</span>
            <input v-model="form.defaultEnabledForNewMax20x" type="checkbox" @change="saveConfig" />
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
          <div v-for="tier in tiers" :key="tier.key">
            <label class="text-sm text-gray-600 dark:text-gray-300"
              >养号期 {{ tier.label }} 日增速上限 (%)</label
            >
            <input
              v-model.number="form.maxDailySevenDayDelta[tier.key]"
              class="mt-1 w-full rounded-lg border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              type="number"
              @change="saveConfig"
            />
          </div>
        </div>
      </div>

      <div class="rounded-lg bg-white/80 p-6 shadow-lg backdrop-blur-sm dark:bg-gray-800/80">
        <h4 class="mb-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
          上游 429 冷却时间
        </h4>
        <p class="mb-4 text-sm text-gray-500 dark:text-gray-400">
          单位为秒，按养号第 1–7 天和毕业后的常驻期生效；时间须逐步缩短或保持不变。
          仅用于已开启养号护栏的账号，上游明确的额度重置时间仍须等待。
        </p>
        <div class="overflow-x-auto">
          <table class="w-full text-sm text-gray-700 dark:text-gray-200">
            <thead>
              <tr>
                <th class="p-2 text-left">套餐</th>
                <th v-for="label in cooldownLabels" :key="label" class="p-2">{{ label }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="tier in tiers" :key="tier.key">
                <th class="whitespace-nowrap p-2 text-left">{{ tier.label }}</th>
                <td v-for="(label, index) in cooldownLabels" :key="label" class="p-2">
                  <input
                    v-model.number="form.rateLimitCooldowns[tier.key][index]"
                    :aria-label="`${tier.label} ${label} 429 冷却秒数`"
                    class="w-24 rounded-lg border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                    max="86400"
                    min="1"
                    step="1"
                    type="number"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="mt-3 text-xs text-gray-500 dark:text-gray-400">
          修改后点击页面底部「保存配置」，后续发生的 429 将使用新配置。
        </p>
      </div>

      <template v-for="tier in tiers" :key="tier.key">
        <AccountNurtureDayPlansTable
          v-if="form[tier.planKey].length === 7"
          v-model:plans="form[tier.planKey]"
          :steady-caps="form.steadyCaps[tier.key]"
          :tier="tier.key"
          @change="saveConfig"
        />
      </template>

      <div
        v-for="tier in ['pro', 'max', 'max20x']"
        :key="tier"
        class="rounded-lg bg-white/80 p-6 shadow-lg backdrop-blur-sm dark:bg-gray-800/80"
      >
        <h4 class="mb-4 text-lg font-semibold uppercase text-gray-900 dark:text-gray-100">
          {{ tiers.find((item) => item.key === tier).label }} 常驻上限
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

const tiers = [
  { key: 'pro', label: 'Pro', planKey: 'proDayPlans' },
  { key: 'max', label: 'Max 5x', planKey: 'maxDayPlans' },
  { key: 'max20x', label: 'Max 20x', planKey: 'max20xDayPlans' }
]
const cooldownLabels = [
  '第 1 天',
  '第 2 天',
  '第 3 天',
  '第 4 天',
  '第 5 天',
  '第 6 天',
  '第 7 天',
  '常驻期'
]
const loading = ref(true)
const form = ref({
  enabled: true,
  defaultEnabledForNewPro: true,
  defaultEnabledForNewMax: true,
  defaultEnabledForNewMax20x: true,
  paceBuffer: 1.08,
  maxDailySevenDayDelta: { pro: 10, max: 15, max20x: 30 },
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
    },
    max20x: {
      rpm: 100,
      fiveHour: 89,
      sevenDay: 89,
      sevenDayOpus: 88,
      sevenDayVelocity: 30,
      localRequests: 960
    }
  },
  proDayPlans: [],
  maxDayPlans: [],
  max20xDayPlans: [],
  rateLimitCooldowns: { pro: [], max: [], max20x: [] }
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
  tiers.some(
    ({ key, planKey }) =>
      form.value.steadyCaps[key].localRequests < form.value[planKey][6]?.localRequestsMax
  )

const hasInvalidCooldowns = () =>
  tiers.some(({ key }) => {
    const values = form.value.rateLimitCooldowns[key]
    return (
      values.length !== 8 ||
      values.some(
        (value, index) =>
          !Number.isInteger(value) ||
          value < 1 ||
          value > 86400 ||
          (index > 0 && value > values[index - 1])
      )
    )
  })

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
  if (hasInvalidCooldowns()) {
    showToast('429 冷却须为 1–86400 秒的整数，且不能随养号天数增加而变长', 'error')
    return
  }
  if (tiers.some(({ planKey }) => hasInvalidDayPlans(form.value[planKey]))) {
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
