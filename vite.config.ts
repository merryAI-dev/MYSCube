import { workbenchPreviewPlugin } from './scripts/workbench-preview-plugin.mjs'
import { defineConfig, loadEnv } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

function getVendorChunkName(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined

  if (
    id.includes('/react/') ||
    id.includes('/react-dom/') ||
    id.includes('/react-router/') ||
    id.includes('/scheduler/') ||
    id.includes('/@remix-run/router/')
  ) {
    return 'react-vendor'
  }

  if (id.includes('/firebase/')) {
    return 'firebase-vendor'
  }

  if (
    id.includes('/@radix-ui/') ||
    id.includes('/cmdk/') ||
    id.includes('/vaul/') ||
    id.includes('/embla-carousel') ||
    id.includes('/react-day-picker/') ||
    id.includes('/input-otp/') ||
    id.includes('/react-resizable-panels/')
  ) {
    return 'ui-vendor'
  }

  if (
    id.includes('/@mui/') ||
    id.includes('/@emotion/') ||
    id.includes('/@popperjs/')
  ) {
    return 'mui-vendor'
  }

  if (
    id.includes('/sonner/') ||
    id.includes('/lucide-react/') ||
    id.includes('/motion/') ||
    id.includes('/date-fns/') ||
    id.includes('/zod/') ||
    id.includes('/clsx/') ||
    id.includes('/class-variance-authority/') ||
    id.includes('/tailwind-merge/')
  ) {
    return 'app-vendor'
  }

  return undefined
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    define: {
      'import.meta.env.VITE_SENTRY_RELEASE': JSON.stringify(env.VITE_SENTRY_RELEASE || env.VERCEL_GIT_COMMIT_SHA || env.GITHUB_SHA || ''),
      'import.meta.env.VITE_SENTRY_ENVIRONMENT': JSON.stringify(env.VITE_SENTRY_ENVIRONMENT || env.VERCEL_ENV || 'unknown'),
    },
    plugins: [workbenchPreviewPlugin(),
      // The React and Tailwind plugins are both required for Make, even if
      // Tailwind is not being actively used – do not remove them
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        // Alias @ to the src directory
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            return getVendorChunkName(id)
          },
        },
      },
    },

    // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
    assetsInclude: ['**/*.svg', '**/*.csv'],
  }
})
