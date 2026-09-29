import { mkdtempSync, readdirSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { holdRunLock } from './run-lock.mjs'
import { writeFileAtomic } from './shared.mjs'

export function installBuild(stage, destination) {
  const index = readFileSync(join(stage, 'index.html'))
  for (const directory of ['assets', 'fonts']) {
    mkdirSync(join(destination, directory), { recursive: true })
    for (const entry of readdirSync(join(stage, directory), { withFileTypes: true })) {
      if (!entry.isFile()) throw new Error(`Unexpected build directory: ${entry.name}`)
      writeFileAtomic(join(destination, directory, entry.name), readFileSync(join(stage, directory, entry.name)))
    }
  }
  // Old HTML must remain usable until all its replacements are available.
  writeFileAtomic(join(destination, 'index.html'), index)
  for (const directory of ['assets', 'fonts']) {
    const keep = new Set(readdirSync(join(stage, directory)))
    for (const entry of readdirSync(join(destination, directory), { withFileTypes: true })) {
      if (entry.isFile() && !keep.has(entry.name)) rmSync(join(destination, directory, entry.name))
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  holdRunLock('build')
  const root = fileURLToPath(new URL('../', import.meta.url))
  const stage = mkdtempSync(join(root, '.radar-build-'))
  try {
    await build({ root, build: { outDir: stage, emptyOutDir: true } })
    installBuild(stage, join(root, 'docs'))
  } finally { rmSync(stage, { recursive: true, force: true }) }
}
