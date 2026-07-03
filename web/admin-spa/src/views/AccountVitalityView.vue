<template>
  <div class="account-vitality-container space-y-4">
    <div class="card p-4 sm:p-6">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 class="mb-1 text-lg font-bold text-gray-900 dark:text-gray-100 sm:text-xl">
            账号活力
          </h3>
          <p class="text-sm text-gray-600 dark:text-gray-400">按状态分组的账号总览</p>
        </div>

        <div class="flex flex-col gap-2 sm:flex-row">
          <button
            class="group relative flex items-center justify-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 shadow-sm transition-all duration-200 hover:border-emerald-300 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-700/60 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:border-emerald-600"
            :disabled="notifying"
            @click="sendVitalityToFeishu"
          >
            <i :class="['fas', notifying ? 'fa-spinner fa-spin' : 'fa-paper-plane']" />
            <span>发送状态到飞书</span>
          </button>
          <button
            class="group relative flex items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-all duration-200 hover:border-gray-300 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-500"
            :disabled="loading"
            @click="loadAccounts"
          >
            <i :class="['fas text-emerald-500', loading ? 'fa-spinner fa-spin' : 'fa-sync-alt']" />
            <span>刷新</span>
          </button>
        </div>
      </div>

      <div class="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <div
          class="rounded-lg border border-gray-200 bg-white/70 p-3 dark:border-gray-700 dark:bg-gray-800/60"
        >
          <div class="text-xs font-medium text-gray-500 dark:text-gray-400">账号总数</div>
          <div class="mt-1 text-xl font-bold text-gray-900 dark:text-gray-100">
            {{ totalAccounts }}
          </div>
        </div>
        <div
          class="rounded-lg border border-gray-200 bg-white/70 p-3 dark:border-gray-700 dark:bg-gray-800/60"
        >
          <div class="text-xs font-medium text-gray-500 dark:text-gray-400">正常</div>
          <div class="mt-1 text-xl font-bold text-emerald-600 dark:text-emerald-400">
            {{ statusCounts.normal || 0 }}
          </div>
        </div>
        <div
          class="rounded-lg border border-gray-200 bg-white/70 p-3 dark:border-gray-700 dark:bg-gray-800/60"
        >
          <div class="text-xs font-medium text-gray-500 dark:text-gray-400">异常/受限</div>
          <div class="mt-1 text-xl font-bold text-orange-600 dark:text-orange-400">
            {{ abnormalCount }}
          </div>
        </div>
        <div
          class="rounded-lg border border-gray-200 bg-white/70 p-3 dark:border-gray-700 dark:bg-gray-800/60"
        >
          <div class="text-xs font-medium text-gray-500 dark:text-gray-400">更新时间</div>
          <div class="mt-1 truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
            {{ lastLoadedAt || '-' }}
          </div>
        </div>
      </div>

      <div
        v-if="lastNotify"
        class="mt-4 rounded-lg border border-emerald-200 bg-emerald-50/70 p-3 dark:border-emerald-800/60 dark:bg-emerald-900/20"
      >
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div class="text-sm font-bold text-emerald-800 dark:text-emerald-200">
              最近一次飞书发送成功
            </div>
            <div class="mt-0.5 text-xs text-emerald-700 dark:text-emerald-300">
              {{ getNotifyTime(lastNotify) }} · {{ getNotifyResultText(lastNotify.result) }}
            </div>
          </div>
          <div class="flex flex-wrap gap-2">
            <span
              v-for="row in lastNotifyStatusRows"
              :key="row.key"
              class="inline-flex items-center gap-1 rounded-md bg-white/80 px-2 py-1 text-xs font-semibold text-gray-700 dark:bg-gray-800/70 dark:text-gray-200"
            >
              <span :class="['h-2 w-2 rounded-sm', row.swatchClass]" />
              {{ row.label }} {{ row.count }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <div class="card p-4 sm:p-6">
      <div class="flex flex-wrap gap-3">
        <span
          v-for="group in VITALITY_STATUS_GROUPS"
          :key="group.key"
          class="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"
        >
          <span :class="['h-3 w-3 rounded-sm', group.swatchClass]" />
          {{ group.label }}
        </span>
      </div>
    </div>

    <div v-if="loading" class="card py-12 text-center">
      <div class="loading-spinner mx-auto mb-4" />
      <p class="text-gray-500 dark:text-gray-400">正在加载账号...</p>
    </div>

    <div v-else-if="totalAccounts === 0" class="card py-12 text-center">
      <div
        class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-700"
      >
        <i class="fas fa-user-circle text-xl text-gray-400" />
      </div>
      <p class="text-lg text-gray-500 dark:text-gray-400">暂无账号</p>
    </div>

    <div v-else class="space-y-4">
      <section
        v-for="group in groupedAccounts"
        :key="group.key"
        class="rounded-xl border border-gray-200 bg-white/70 p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800/60"
      >
        <div class="mb-3 flex items-center justify-between gap-3">
          <div class="flex items-center gap-2">
            <span :class="['h-4 w-4 rounded-sm', group.swatchClass]" />
            <h4 class="text-sm font-bold text-gray-900 dark:text-gray-100">{{ group.label }}</h4>
          </div>
          <span class="text-xs font-semibold text-gray-500 dark:text-gray-400">
            {{ group.accounts.length }} 个
          </span>
        </div>

        <div v-if="group.accounts.length > 0" class="flex flex-wrap gap-2">
          <button
            v-for="account in group.accounts"
            :key="getAccountKey(account)"
            :aria-label="getTileTitle(account)"
            :class="[
              'h-5 w-5 rounded border border-white/70 shadow-sm transition duration-150 hover:scale-125 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2 dark:border-gray-900/50 dark:focus:ring-white dark:focus:ring-offset-gray-900',
              group.swatchClass
            ]"
            type="button"
            @blur="hideTooltip"
            @focus="showTooltip($event, account)"
            @mouseenter="showTooltip($event, account)"
            @mouseleave="hideTooltip"
            @mousemove="moveTooltip"
          />
        </div>
        <p v-else class="text-sm text-gray-400 dark:text-gray-500">暂无</p>
      </section>
    </div>

    <div
      v-if="hoveredAccount"
      class="pointer-events-none fixed z-[9999] max-w-[280px] rounded-lg bg-slate-800 px-3.5 py-3 text-sm leading-relaxed text-slate-100 shadow-2xl"
      role="tooltip"
      :style="tooltipStyle"
    >
      <div class="mb-1 break-words font-bold">{{ getAccountTooltipTitle(hoveredAccount) }}</div>
      <div
        v-for="row in hoveredAccountRows"
        :key="row.label"
        class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2"
      >
        <span class="text-slate-400">{{ row.label }}:</span>
        <span class="break-words font-semibold">{{ row.value }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import * as httpApis from '@/utils/http_apis'
import { formatDateTime, showToast } from '@/utils/tools'
import {
  VITALITY_STATUS_GROUPS,
  attachTempUnavailableStatuses,
  getAccountTooltipRows,
  getAccountTooltipTitle,
  getAccountVitalityStatus,
  groupAccountsByVitalityStatus
} from '@/utils/accountVitality'

const PLATFORM_REQUESTS = [
  { platform: 'claude', request: httpApis.getClaudeAccountsApi },
  { platform: 'claude-console', request: httpApis.getClaudeConsoleAccountsApi },
  { platform: 'bedrock', request: httpApis.getBedrockAccountsApi },
  { platform: 'gemini', request: httpApis.getGeminiAccountsApi },
  { platform: 'gemini-api', request: httpApis.getGeminiApiAccountsApi },
  { platform: 'openai', request: httpApis.getOpenAIAccountsApi },
  { platform: 'openai-responses', request: httpApis.getOpenAIResponsesAccountsApi },
  { platform: 'azure_openai', request: httpApis.getAzureOpenAIAccountsApi },
  { platform: 'ccr', request: httpApis.getCcrAccountsApi },
  { platform: 'droid', request: httpApis.getDroidAccountsApi }
]

const accounts = ref([])
const loading = ref(false)
const notifying = ref(false)
const lastLoadedAt = ref('')
const lastNotify = ref(null)
const hoveredAccount = ref(null)
const tooltipStyle = ref({ left: '0px', top: '0px' })

const getAccountKey = (account) => `${account.platform}:${account.id}`

const totalAccounts = computed(() => accounts.value.length)
const groupedAccounts = computed(() => groupAccountsByVitalityStatus(accounts.value))
const statusCounts = computed(() =>
  groupedAccounts.value.reduce((counts, group) => {
    counts[group.key] = group.accounts.length
    return counts
  }, {})
)
const abnormalCount = computed(() => totalAccounts.value - (statusCounts.value.normal || 0))
const hoveredAccountRows = computed(() =>
  hoveredAccount.value ? getAccountTooltipRows(hoveredAccount.value) : []
)
const lastNotifyStatusRows = computed(() => {
  const counts = lastNotify.value?.summary?.statusCounts || {}
  return VITALITY_STATUS_GROUPS.map((group) => ({
    ...group,
    count: counts[group.key] || 0
  }))
})

const normalizeAccountList = (data) => (Array.isArray(data) ? data : [])

const loadPlatformAccounts = async ({ platform, request }) => {
  try {
    const response = await request()
    return {
      platform,
      success: !!response?.success,
      message: response?.message || '',
      accounts: normalizeAccountList(response?.data).map((account) => ({ ...account, platform }))
    }
  } catch (error) {
    return { platform, success: false, message: error?.message || '', accounts: [] }
  }
}

const loadAccounts = async () => {
  loading.value = true
  try {
    const platformResults = await Promise.all(PLATFORM_REQUESTS.map(loadPlatformAccounts))
    const failedPlatforms = platformResults.filter((result) => !result.success)
    const allAccounts = platformResults.flatMap((result) => result.accounts)

    let tempStatuses = {}
    const tempResponse = await httpApis.getTempUnavailableApi()
    if (tempResponse?.success && tempResponse.data) {
      tempStatuses = tempResponse.data
    }

    accounts.value = attachTempUnavailableStatuses(allAccounts, tempStatuses)
    lastLoadedAt.value = formatDateTime(new Date())

    if (failedPlatforms.length > 0) {
      showToast(
        `部分平台加载失败：${failedPlatforms.map((item) => item.platform).join(', ')}`,
        'warning'
      )
    }
  } finally {
    loading.value = false
  }
}

const sendVitalityToFeishu = async () => {
  notifying.value = true
  try {
    const response = await httpApis.notifyAccountVitalityApi()
    if (!response?.success) {
      showToast(response?.message || '发送账号活力状态失败', 'error')
      return
    }

    lastNotify.value = response
    showToast('账号活力状态已发送到飞书', 'success')
  } finally {
    notifying.value = false
  }
}

const getNotifyTime = (payload) => {
  const generatedAt = payload?.summary?.generatedAt
  return generatedAt ? formatDateTime(generatedAt) : formatDateTime(new Date())
}

const getNotifyResultText = (result) => {
  if (!result) return '未返回发送结果'
  return `${result.succeeded || 0} 个平台成功，${result.failed || 0} 个平台失败`
}

const getTileTitle = (account) => {
  const status = getAccountVitalityStatus(account)
  return `${getAccountTooltipTitle(account)} · ${status.label}`
}

const positionTooltip = (clientX, clientY) => {
  const tooltipWidth = Math.min(280, window.innerWidth - 24)
  const tooltipHeight = 190
  const margin = 12
  const offset = 14
  const maxLeft = window.innerWidth - tooltipWidth - margin
  const maxTop = window.innerHeight - tooltipHeight - margin
  const left = Math.max(margin, Math.min(clientX + offset, maxLeft))
  const top = Math.max(margin, Math.min(clientY + offset, maxTop))
  tooltipStyle.value = { left: `${left}px`, top: `${top}px`, maxWidth: `${tooltipWidth}px` }
}

const showTooltip = (event, account) => {
  hoveredAccount.value = account
  const rect = event.currentTarget.getBoundingClientRect()
  positionTooltip(event.clientX || rect.left + rect.width / 2, event.clientY || rect.bottom)
}

const moveTooltip = (event) => {
  if (!hoveredAccount.value) return
  positionTooltip(event.clientX, event.clientY)
}

const hideTooltip = () => {
  hoveredAccount.value = null
}

onMounted(loadAccounts)
</script>
