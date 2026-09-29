import { spawnSync } from 'node:child_process'
import { PAGE } from './prefs-server.mjs'

const result = spawnSync(process.execPath, ['--check', 'scripts/prefs-server.mjs'], { stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)
const script = PAGE.match(/<script>([\s\S]*?)<\/script>/)?.[1]
if (!script) throw new Error('Editor script missing')
new Function(script)
console.log('Editor server and client syntax passed.')
