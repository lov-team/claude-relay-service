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
          <label class="flex items-center justify-between rounded-lg border border-gray-200 p-4 dark:border-gray-700">
            <span class="text-sm text-gray-700 dark:text-gray-200">启用养号护栏</span>
            <input v-model="form.enabled" type="checkbox" @change="saveConfig" />
          </label>
          <label class="flex items-center justify-between rounded-lg border border-gray-200 p-4 dark:border-gray-700">
            <span class="text-sm text-gray-700 dark:text-gray-200">新建 Pro 默认开启</span>
            <input v-model="form.defaultEnabledForNewPro" type="checkbox" @change="saveConfig" />
          </label>
          <label class="flex items-center justify-between rounded-lg border border-gray-200 p-4 dark:border-gray-700">
            <span class="text-sm text-gray-700 dark:text-gray-200">新建 Max 默认开启</span>
            <input v-model="form.defaultEnabledForNewMax" type="checkbox" @change="saveConfig" />
          </label>
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
            <label class="text-sm text-gray-600 dark:text-gray-300">Pro 日增速上限 (%)</label>
            <input
              v-model.number="form.maxDailySevenDayDelta.pro"
              class="mt-1 w-full rounded-lg border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              type="number"
              @change="saveConfig"
            />
          </div>
          <div>
            <label class="text-sm text-gray-600 dark:text-gray-300">Max 日增速上限 (%)</label>
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
        tier="pro"
        :steady-caps="form.steadyCaps.pro"
        @change="saveConfig"
      />

      <AccountNurtureDayPlansTable
        v-if="form.maxDayPlans.length === 7"
        v-model:plans="form.maxDayPlans"
        tier="max"
        :steady-caps="form.steadyCaps.max"
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
        <div class="grid gap-4 md:grid-cols-4">
          <div v-for="field in steadyFields" :key="`${tier}-${field.key}`">
            <label class="text-sm text-gray-600 dark:text-gray-300">{{ field.label }}</label>
            <input
              v-model.number="form.steadyCaps[tier][field.key]"
              class="mt-1 w-full rounded-lg border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              :max="field.key === 'rpm' ? undefined : 89"
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
import { onMounted, ref } from 'vue'
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
  steadyCaps: {
    pro: { rpm: 30, fiveHour: 86, sevenDay: 82, sevenDayOpus: 78 },
    max: { rpm: 50, fiveHour: 88, sevenDay: 86, sevenDayOpus: 84 }
  },
  proDayPlans: [],
  maxDayPlans: []
})

const steadyFields = [
  { key: 'rpm', label: 'RPM' },
  { key: 'fiveHour', label: '5h %' },
  { key: 'sevenDay', label: '7d %' },
  { key: 'sevenDayOpus', label: '7d Opus %' }
]

const loadConfig = async () => {
  loading.value = true
  try {
    const response = await getAccountNurtureConfigApi()
    if (response.success && response.config) {
      form.value = { ...form.value, ...response.config }
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

const saveConfig = async () => {
  if (hasInvalidDayPlans(form.value.proDayPlans) || hasInvalidDayPlans(form.value.maxDayPlans)) {
    showToast('七天曲线存在无效区间（min > max 或百分比 ≥ 90%）', 'error')
    return
  }

  try {
    const response = await updateAccountNurtureConfigApi(form.value)
    if (response.success) {
      form.value = { ...form.value, ...response.config }
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
      form.value = { ...form.value, ...response.config }
      showToast('已恢复默认养号配置', 'success')
    }
  } catch (error) {
    showToast('恢复默认配置失败', 'error')
  }
}

onMounted(loadConfig)
</script>