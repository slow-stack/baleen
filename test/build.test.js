import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { build, PARTS } from '../tools/build-client.mjs'

test('client.js 与 src/client 生成结果一致（改了源忘了生成就红）', () => {
  const actual = fs.readFileSync(path.join(process.cwd(), 'client.js'), 'utf8')
  assert.equal(actual, build(), 'client.js 已过期：跑 node tools/build-client.mjs')
})

test('PARTS 里列的文件都真的存在', () => {
  for (const p of PARTS) {
    assert.ok(fs.existsSync(path.join(process.cwd(), 'src', 'client', p)), `缺源文件 ${p}`)
  }
})

test('生成结果没有残留的 import/export（loader bundle 里不合法）', () => {
  const out = build()
  assert.doesNotMatch(out, /^\s*import\s/m, '还留着 import')
  assert.doesNotMatch(out, /^\s*export\s/m, '还留着 export')
  assert.match(out, /window\.__ModuleLoader__\.load/)
})
