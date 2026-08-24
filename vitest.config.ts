import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const harness = fileURLToPath(new URL('../deepseek-harness', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // Type-only in tsconfig; vitest needs runnable JS — point at the
      // harness's built libs (same source of truth).
      '@deepseek-ai/schemastery': `${harness}/vendor/schemastery/lib/index.mjs`,
      '@deepseek-ai/cordis': `${harness}/vendor/cordis/lib/index.js`,
      '@deepseek-ai/dsh-llm': `${harness}/packages/llm/llm/lib/index.js`,
      '@deepseek-ai/dsh-session': `${harness}/packages/core/session/lib/index.js`,
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
