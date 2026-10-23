import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const DIR_NAME = 'baleen'

/**
 * 插件数据家目录。优先级：BALEEN_HOME（测试/临时）> DSH_HOME/.dsh > ~/.dsh
 * 本机 ~/.dsh 是指向 D 盘的 junction，所以默认值实际落在 D 盘。
 */
export function homeDir() {
  const override = process.env.BALEEN_HOME
  if (override && override.trim()) return override.trim()
  const explicit = process.env.DSH_HOME
  const root = explicit && explicit.trim() ? explicit.trim() : path.join(os.homedir(), '.dsh')
  return path.join(root, DIR_NAME)
}

export function ensureHome() {
  const dir = homeDir()
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })
  return dir
}

export function dbFile() {
  return path.join(ensureHome(), 'baleen.sqlite')
}
