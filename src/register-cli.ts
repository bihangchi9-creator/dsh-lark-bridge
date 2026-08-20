/**
 * The `dsh-lark-register` bin — a manual fallback for the registration wizard.
 *
 * The plugin auto-runs the same {@link runRegister} flow at boot when no
 * credentials exist, so most users never need this. It stays useful for
 * re-registering, switching Feishu accounts, or pre-seeding credentials before
 * the first `dsh web` launch.
 *
 * @module dsh-lark-bridge/register-cli
 */

import { runRegister } from './register.js'

runRegister()
  .then(() => {
    console.log('\n现在可以启动 dsh，本插件会自动读取这份凭证。')
    console.log('提示：把机器人拉进一个飞书群，@它 或私聊它即可开始对话。\n')
  })
  .catch((err: unknown) => {
    console.error('\n❌ 注册失败：', err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
