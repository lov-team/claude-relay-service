const express = require('express')
const { authenticateAdmin } = require('../../middleware/auth')
const accountNurtureConfigService = require('../../services/accountNurtureConfigService')
const { normalizeAccountNurtureConfig } = require('../../utils/accountNurtureDefaults')
const logger = require('../../utils/logger')

const router = express.Router()

router.get('/account-nurture-config', authenticateAdmin, async (req, res) => {
  try {
    const config = await accountNurtureConfigService.getConfig()
    return res.json({ success: true, config })
  } catch (error) {
    logger.error('Failed to get account nurture config:', error)
    return res.status(500).json({
      error: 'Failed to get account nurture config',
      message: error.message
    })
  }
})

router.put('/account-nurture-config', authenticateAdmin, async (req, res) => {
  try {
    const current = await accountNurtureConfigService.getConfig()
    const normalized = normalizeAccountNurtureConfig({
      ...current,
      ...req.body
    })
    const updated = await accountNurtureConfigService.updateConfig(
      normalized,
      req.admin?.username || 'unknown'
    )
    return res.json({
      success: true,
      message: 'Account nurture config updated',
      config: updated
    })
  } catch (error) {
    logger.error('Failed to update account nurture config:', error)
    return res.status(400).json({
      error: 'Failed to update account nurture config',
      message: error.message
    })
  }
})

router.post('/account-nurture-config/reset', authenticateAdmin, async (req, res) => {
  try {
    const updated = await accountNurtureConfigService.resetToDefaults(
      req.admin?.username || 'unknown'
    )
    return res.json({
      success: true,
      message: 'Account nurture config reset to defaults',
      config: updated
    })
  } catch (error) {
    logger.error('Failed to reset account nurture config:', error)
    return res.status(500).json({
      error: 'Failed to reset account nurture config',
      message: error.message
    })
  }
})

module.exports = router
