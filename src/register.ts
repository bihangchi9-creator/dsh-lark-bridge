/**
 * The dsh-lark-bridge registration wizard.
 *
 * Asks Feishu to create a self-built app on your behalf, prints a QR code in
 * the terminal, and — once you scan it in the Feishu mobile app and confirm —
 * receives fresh app credentials and saves them for the plugin to use.
 *
 * Two entry points share this one flow:
 *   - the plugin itself, which runs it automatically at boot when no
 *     credentials are configured yet (see index.ts), and
 *   - the standalone `dsh-lark-register` bin (see register-cli.ts), a manual
 *     fallback for re-registering or switching accounts.
 *
 * It depends only on `@larksuite/channel` + `qrcode-terminal`, so it works
 * without any dsh packages installed.
 *
 * This flow mirrors the terminal wizard shipped by the upstream
 * lark-coding-agent-bridge / trae-to-lark projects (see NOTICE / README).
 *
 * @module dsh-lark-bridge/register
 */

import { registerApp } from '@larksuite/channel'
import qrcode from 'qrcode-terminal'
import type { LarkTenant } from './config.js'
import {
  clearRegisterUrl,
  writeCredentials,
  writeRegisterUrl,
  type SavedCredentials,
} from './credentials.js'

/** Optional hooks so callers can surface progress their own way (logs, files). */
export interface RegisterHooks {
  /** Emit a human-readable status/progress line. Defaults to `console.log`. */
  log?: (line: string) => void
  /**
   * Called with the raw registration URL as soon as it is known, in addition
   * to the terminal QR code. The auto-boot path uses this to persist the URL
   * for out-of-band (browser) registration when the terminal is not visible.
   */
  onUrl?: (url: string) => void
}

/**
 * Run the interactive QR registration. Resolves with the saved credentials
 * once the user completes it. Rejects if the QR expires or the Feishu API call
 * fails before a URL is shown.
 */
export async function runRegister(hooks: RegisterHooks = {}): Promise<SavedCredentials> {
  const log = hooks.log ?? ((line: string) => console.log(line))

  log('\n🔧 dsh-lark-bridge 飞书应用创建向导\n')
  log('即将通过飞书开放平台为你自动创建一个自建应用，无需手动填写任何信息。\n')

  const result = await registerApp({
    source: 'dsh-lark-bridge',
    onQRCodeReady: info => {
      log('请用「飞书」手机 App 扫描下面的二维码，并在手机上确认创建应用：\n')
      qrcode.generate(info.url, { small: true })
      const mins = Math.max(1, Math.round(info.expireIn / 60))
      log(`\n二维码有效期：约 ${mins} 分钟`)
      log(`也可以直接在浏览器打开：${info.url}\n`)
      hooks.onUrl?.(info.url)
    },
    onStatusChange: info => {
      if (info.status === 'domain_switched') {
        log('识别到国际版（Lark）租户，已切换到 larksuite.com 域名。')
      } else if (info.status === 'slow_down') {
        log('轮询速度过快，已自动降速…')
      }
    },
  })

  const tenant: LarkTenant = result.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu'
  const path = writeCredentials({
    appId: result.client_id,
    appSecret: result.client_secret,
    tenant,
  })
  clearRegisterUrl()

  log('\n✅ 应用创建成功！')
  log(`   App ID: ${result.client_id}`)
  log(`   租户类型: ${tenant}`)
  log(`   凭证已保存到: ${path}`)

  return {
    appId: result.client_id,
    appSecret: result.client_secret,
    tenant,
    savedAt: Date.now(),
  }
}

// Re-export so the auto-boot path can wire the URL file without importing from
// two modules.
export { writeRegisterUrl }
