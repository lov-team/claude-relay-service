<template>
  <div class="rounded-lg bg-white/80 p-6 shadow-lg backdrop-blur-sm dark:bg-gray-800/80">
    <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h4 class="text-lg font-semibold uppercase text-gray-900 dark:text-gray-100">
          {{ tierLabel }} 七天渐进曲线
        </h4>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          养号第 1–7 天每日上限区间，账户按日种子在区间内取稳定随机值
        </p>
      </div>
      <div class="text-right text-xs text-gray-500 dark:text-gray-400">
        <p>
          毕业后常驻顶：5h {{ steadyCaps.fiveHour }}% / 7d {{ steadyCaps.sevenDay }}% / 本地
          {{ steadyCaps.localRequests }} / 日增速封顶 {{ steadyCaps.sevenDayVelocity }}%
        </p>
        <p>百分比字段须 &lt; 90%</p>
      </div>
    </div>

    <div
      class="mb-6 rounded-lg border border-gray-200 bg-gray-50/80 p-4 dark:border-gray-700 dark:bg-gray-900/40"
    >
      <p class="mb-3 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        7 日利用率曲线预览（按 sevenDayMax）
      </p>
      <div class="flex items-end justify-between gap-2" style="height: 72px">
        <div
          v-for="plan in plans"
          :key="`preview-${plan.day}`"
          class="flex flex-1 flex-col items-center gap-1"
        >
          <span class="text-[10px] text-gray-500 dark:text-gray-400">{{ plan.sevenDayMax }}%</span>
          <div
            class="w-full min-w-[20px] rounded-t-md bg-gradient-to-t from-blue-600 to-blue-400 dark:from-blue-500 dark:to-blue-300"
            :style="{ height: `${barHeight(plan.sevenDayMax, percentScale)}px` }"
          />
          <span class="text-xs font-medium text-gray-600 dark:text-gray-300">D{{ plan.day }}</span>
        </div>
      </div>
    </div>

    <div class="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
      <table class="min-w-full text-sm">
        <thead class="bg-gray-50 dark:bg-gray-800/80">
          <tr>
            <th
              class="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
            >
              天数
            </th>
            <th
              class="px-3 py-3 text-center text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
            >
              RPM
            </th>
            <th
              class="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
            >
              5h 利用率 %
            </th>
            <th
              class="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
            >
              7d 利用率 %
            </th>
            <th
              class="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
            >
              本地请求数
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
          <tr
            v-for="(plan, index) in plans"
            :key="plan.day"
            class="transition-colors hover:bg-gray-50/80 dark:hover:bg-gray-700/30"
          >
            <td class="whitespace-nowrap px-3 py-3">
              <span
                class="inline-flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold"
                :class="dayBadgeClass(plan.day)"
              >
                {{ plan.day }}
              </span>
            </td>

            <td class="px-3 py-3 text-center">
              <input
                class="w-16 rounded-lg border-gray-300 text-center dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                min="1"
                type="number"
                :value="plan.rpm"
                @change="patchPlan(index, { rpm: readNumber($event) }, true)"
                @input="patchPlan(index, { rpm: readNumber($event) })"
              />
            </td>

            <td class="min-w-[200px] px-3 py-3">
              <div>
                <div class="mb-2 flex items-center justify-center gap-1">
                  <input
                    class="w-14 rounded border px-1 py-0.5 text-center text-xs dark:bg-gray-700 dark:text-white"
                    :class="rangeInputClass(plan.fiveHourMin, plan.fiveHourMax)"
                    type="number"
                    :value="plan.fiveHourMin"
                    @change="patchPlan(index, { fiveHourMin: readNumber($event) }, true)"
                    @input="patchPlan(index, { fiveHourMin: readNumber($event) })"
                  />
                  <span class="text-gray-400">—</span>
                  <input
                    class="w-14 rounded border px-1 py-0.5 text-center text-xs dark:bg-gray-700 dark:text-white"
                    :class="rangeInputClass(plan.fiveHourMin, plan.fiveHourMax)"
                    type="number"
                    :value="plan.fiveHourMax"
                    @change="patchPlan(index, { fiveHourMax: readNumber($event) }, true)"
                    @input="patchPlan(index, { fiveHourMax: readNumber($event) })"
                  />
                  <span class="text-xs text-gray-400">%</span>
                </div>
                <div class="relative h-2 rounded-full bg-gray-200 dark:bg-gray-700">
                  <div
                    class="absolute bottom-0 top-0 w-0.5 bg-amber-400/90 dark:bg-amber-300"
                    :style="referenceStyle(steadyCaps.fiveHour)"
                    title="毕业后 5h 常驻顶"
                  />
                  <div
                    class="absolute top-0 h-full rounded-full bg-blue-500/75 dark:bg-blue-400/80"
                    :class="rangeBarClass(plan.fiveHourMin, plan.fiveHourMax)"
                    :style="rangeBarStyle(plan.fiveHourMin, plan.fiveHourMax, percentScale)"
                  />
                </div>
              </div>
            </td>

            <td class="min-w-[200px] px-3 py-3">
              <div>
                <div class="mb-2 flex items-center justify-center gap-1">
                  <input
                    class="w-14 rounded border px-1 py-0.5 text-center text-xs dark:bg-gray-700 dark:text-white"
                    :class="rangeInputClass(plan.sevenDayMin, plan.sevenDayMax)"
                    type="number"
                    :value="plan.sevenDayMin"
                    @change="patchPlan(index, { sevenDayMin: readNumber($event) }, true)"
                    @input="patchPlan(index, { sevenDayMin: readNumber($event) })"
                  />
                  <span class="text-gray-400">—</span>
                  <input
                    class="w-14 rounded border px-1 py-0.5 text-center text-xs dark:bg-gray-700 dark:text-white"
                    :class="rangeInputClass(plan.sevenDayMin, plan.sevenDayMax)"
                    type="number"
                    :value="plan.sevenDayMax"
                    @change="patchPlan(index, { sevenDayMax: readNumber($event) }, true)"
                    @input="patchPlan(index, { sevenDayMax: readNumber($event) })"
                  />
                  <span class="text-xs text-gray-400">%</span>
                </div>
                <div class="relative h-2 rounded-full bg-gray-200 dark:bg-gray-700">
                  <div
                    class="absolute bottom-0 top-0 w-0.5 bg-amber-400/90 dark:bg-amber-300"
                    :style="referenceStyle(steadyCaps.sevenDay)"
                    title="毕业后 7d 常驻顶"
                  />
                  <div
                    class="absolute top-0 h-full rounded-full bg-blue-500/75 dark:bg-blue-400/80"
                    :class="rangeBarClass(plan.sevenDayMin, plan.sevenDayMax)"
                    :style="rangeBarStyle(plan.sevenDayMin, plan.sevenDayMax, percentScale)"
                  />
                </div>
              </div>
            </td>

            <td class="min-w-[200px] px-3 py-3">
              <div>
                <div class="mb-2 flex items-center justify-center gap-1">
                  <input
                    class="w-14 rounded border px-1 py-0.5 text-center text-xs dark:bg-gray-700 dark:text-white"
                    :class="rangeInputClass(plan.localRequestsMin, plan.localRequestsMax)"
                    type="number"
                    :value="plan.localRequestsMin"
                    @change="patchPlan(index, { localRequestsMin: readNumber($event) }, true)"
                    @input="patchPlan(index, { localRequestsMin: readNumber($event) })"
                  />
                  <span class="text-gray-400">—</span>
                  <input
                    class="w-14 rounded border px-1 py-0.5 text-center text-xs dark:bg-gray-700 dark:text-white"
                    :class="rangeInputClass(plan.localRequestsMin, plan.localRequestsMax)"
                    type="number"
                    :value="plan.localRequestsMax"
                    @change="patchPlan(index, { localRequestsMax: readNumber($event) }, true)"
                    @input="patchPlan(index, { localRequestsMax: readNumber($event) })"
                  />
                </div>
                <div class="relative h-2 rounded-full bg-gray-200 dark:bg-gray-700">
                  <div
                    class="absolute bottom-0 top-0 w-0.5 bg-amber-400/90 dark:bg-amber-300"
                    :style="referenceStyle(steadyCaps.localRequests, localScale)"
                    title="毕业后本地请求常驻顶"
                  />
                  <div
                    class="absolute top-0 h-full rounded-full bg-emerald-500/75 dark:bg-emerald-400/80"
                    :class="rangeBarClass(plan.localRequestsMin, plan.localRequestsMax)"
                    :style="rangeBarStyle(plan.localRequestsMin, plan.localRequestsMax, localScale)"
                  />
                </div>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  tier: {
    type: String,
    required: true,
    validator: (value) => ['pro', 'max', 'max20x'].includes(value)
  },
  plans: {
    type: Array,
    required: true
  },
  steadyCaps: {
    type: Object,
    required: true
  }
})

const emit = defineEmits(['update:plans', 'change'])

const tierLabel = computed(() => ({ pro: 'Pro', max: 'Max 5x', max20x: 'Max 20x' })[props.tier])
const percentScale = 90

const localScale = computed(() => {
  const maxValue = props.plans.reduce(
    (current, plan) => Math.max(current, Number(plan.localRequestsMax) || 0),
    Math.max(Number(props.steadyCaps.localRequests) || 0, 480)
  )
  return Math.max(maxValue, 100)
})

const barHeight = (value, scale) => {
  const num = Number(value) || 0
  return Math.max(6, Math.round((num / scale) * 56))
}

const dayBadgeClass = (day) => {
  const shades = [
    'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    'bg-blue-200 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200',
    'bg-blue-300 text-blue-900 dark:bg-blue-800/60 dark:text-blue-100',
    'bg-indigo-300 text-indigo-900 dark:bg-indigo-800/60 dark:text-indigo-100',
    'bg-indigo-400 text-indigo-950 dark:bg-indigo-700/70 dark:text-indigo-50',
    'bg-violet-400 text-violet-950 dark:bg-violet-700/70 dark:text-violet-50',
    'bg-violet-500 text-white dark:bg-violet-600 dark:text-white'
  ]
  return shades[Math.min(day - 1, shades.length - 1)]
}

const isInvalidRange = (min, max) => Number(min) > Number(max)

const rangeInputClass = (min, max) =>
  isInvalidRange(min, max)
    ? 'border-red-400 dark:border-red-500'
    : 'border-gray-300 dark:border-gray-600'

const rangeBarClass = (min, max) => (isInvalidRange(min, max) ? '!bg-red-400/70' : '')

const rangeBarStyle = (min, max, scale) => {
  const minNum = Number(min) || 0
  const maxNum = Number(max) || 0
  const left = (minNum / scale) * 100
  const width = ((maxNum - minNum) / scale) * 100
  return {
    left: `${Math.min(left, 100)}%`,
    width: `${Math.max(width, 0)}%`
  }
}

const referenceStyle = (reference, scale = percentScale) => {
  if (reference === null || reference === undefined) {
    return { display: 'none' }
  }
  return { left: `${(reference / scale) * 100}%` }
}

const readNumber = (event) => Number(event.target.value)

const patchPlan = (index, patch, shouldSave = false) => {
  const next = props.plans.map((plan, planIndex) =>
    planIndex === index ? { ...plan, ...patch } : plan
  )
  emit('update:plans', next)
  if (shouldSave) {
    emit('change')
  }
}
</script>
