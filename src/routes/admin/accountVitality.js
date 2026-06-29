const express = require('express')
const { authenticateAdmin } = require('../../middleware/auth')
const accountVitalityMonitorService = require('../../services/accountVitalityMonitorService')
const logger = require('../../utils/logger')

const router = express.Router()

router.post('/account-vitality/notify', authenticateAdmin, async (_req, res) => {
  try {
    const { summary, result } = await accountVitalityMonitorService.sendCurrentSummary()
    return res.json({
      success: true,
      message: '账号活力状态已发送到飞书',
      summary,
      result
    })
  } catch (error) {
    logger.error('发送账号活力状态失败:', error)
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: `发送账号活力状态失败: ${error.message}`
    })
  }
})

module.exports = router
