import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import fs from 'node:fs'

// docs/data/*.json is written only by scripts/fetch-releases.mjs, never by builds —
// so the dev server has to be taught where to find it.
function serveDataInDev(): Plugin {
  return {
    name: 'serve-data-in-dev',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = req.url?.match(/^(?:\/new-music-radar)?\/data\/([\w-]+\.json)/)
        if (match) {
          const file = path.join(import.meta.dirname, 'docs', 'data', match[1])
          if (fs.existsSync(file)) {
            res.setHeader('Content-Type', 'application/json')
            res.end(fs.readFileSync(file))
            return
          }
        }
        next()
      })
    },
  }
}

export default defineConfig({
  base: '/new-music-radar/',
  plugins: [react(), tailwindcss(), serveDataInDev()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  build: {
    outDir: 'docs',
    // docs/ doubles as the GitHub Pages root and holds live data — never wipe it.
    // Stale hashed assets are handled by `rm -rf docs/assets` in the build script.
    emptyOutDir: false,
  },
})
