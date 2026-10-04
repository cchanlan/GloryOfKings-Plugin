/**
 * 出图格式（`config.imgType` → `utils/imageType.js` 的 `getImgType()`）。
 *
 * 为什么给这一个取值单开测试：插件 37 处出图全部读它，而这个值直接决定图能不能发出去 ——
 * `webp` 在微信（ComWeChat）适配器下会被微信的图片接口降级成**「文件」**发出去
 * （群里收到的是 `xxx.webp` 文件卡片，不是图；2026-09-24 实测，详见 imageType.js 顶部）。
 *
 * 钉住两件事：
 *   ① 合法值原样透传、`jpg` 归一化成 `jpeg`、非法值/读配置抛异常一律兜底 `jpeg`
 *      —— 出图路径上绝不能因为一个配置写错就整张图发不出去
 *   ② **别再有第 38 处写死的格式** —— 出图格式只该有一个来源
 *
 * 用 test/helpers/sandbox.mjs：真源码 + 假 `#components`，不碰插件目录里的真配置。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { PLUGIN_DIR, makeSandbox, run, cleanup } from './helpers/sandbox.mjs'

const VALID = ['jpeg', 'png', 'webp']

const roots = []
function sandbox () {
  const root = makeSandbox()
  roots.push(root)
  return root
}

test.after(() => {
  for (const root of roots) cleanup(root)
})

/** 在沙箱里把 imgType 设成 expr，打印 getImgType() 的结果 */
function readImgType (root, expr) {
  return run(root, [
    "import { setFakeConfig } from './fake-config.mjs'",
    "setFakeConfig({ imgType: " + expr + ' })',
    "const { getImgType } = await import('./utils/imageType.js')",
    'console.log(getImgType())',
    'process.exit(0)',
    ''
  ].join('\n'))
}

test('getImgType：合法值原样透传，jpg 归一化成 jpeg', () => {
  const root = sandbox()
  const cases = [
    ['jpeg', 'jpeg'],
    ['png', 'png'],
    ['webp', 'webp'],
    // 出图后端认的是 jpeg，不是 jpg
    ['jpg', 'jpeg'],
    // 大小写 / 前后空格都要认
    ['PNG', 'png'],
    ['  WebP  ', 'webp']
  ]
  for (const [input, expect] of cases) {
    const out = readImgType(root, JSON.stringify(input))
    assert.ok(out.ok, out.stderr)
    assert.equal(out.stdout, expect, `imgType=${JSON.stringify(input)}`)
  }
})

test('getImgType：非法值一律兜底 jpeg', () => {
  const root = sandbox()
  const cases = ['bmp', 'gif', 'jpeg2000', '', '  ', 'webp2']
  for (const input of cases) {
    const out = readImgType(root, JSON.stringify(input))
    assert.ok(out.ok, out.stderr)
    assert.equal(out.stdout, 'jpeg', `imgType=${JSON.stringify(input)} 应兜底`)
  }
})

test('getImgType：配置里没有这一项 / 不是字符串，也兜底 jpeg', () => {
  const root = sandbox()
  // 注意：setFakeConfig 是浅合并，这里要显式覆盖成非字符串
  for (const expr of ['undefined', 'null', '123', 'true', '{}']) {
    const out = readImgType(root, expr)
    assert.ok(out.ok, out.stderr)
    assert.equal(out.stdout, 'jpeg', `imgType=${expr} 应兜底`)
  }
})

test('getImgType：Config 读取抛异常时也必须兜底，不能把出图整条挂掉', () => {
  const root = sandbox()
  const out = run(root, [
    "const { Config } = await import('#components')",
    "Config.getDefOrConfig = () => { throw new Error('模拟配置层炸了') }",
    "const { getImgType } = await import('./utils/imageType.js')",
    'console.log(getImgType())',
    'process.exit(0)',
    ''
  ].join('\n'))
  assert.ok(out.ok, out.stderr)
  assert.equal(out.stdout, 'jpeg')
})

test('模板里的 imgType 必须是出图后端认的合法值', () => {
  const tpl = YAML.parse(
    fs.readFileSync(path.join(PLUGIN_DIR, 'config', 'default_config', 'config.yaml'), 'utf8')
  )
  assert.ok(
    VALID.includes(tpl.imgType),
    `config/default_config/config.yaml 的 imgType=${JSON.stringify(tpl.imgType)}，应为 ${VALID.join(' / ')}`
  )
})

test('出图格式只有一个来源：全插件不该再有写死的 imgType 字面量', () => {
  const found = []
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(full)
      } else if (entry.name.endsWith('.js') && entry.name !== 'imageType.js') {
        const src = fs.readFileSync(full, 'utf8')
        // 允许 imgType: getImgType()；只揪写死的字符串
        for (const m of src.matchAll(/imgType\s*:\s*['"`]/g)) {
          found.push(`${path.relative(PLUGIN_DIR, full)}:${src.slice(0, m.index).split('\n').length}`)
        }
      }
    }
  }
  walk(path.join(PLUGIN_DIR, 'apps'))
  walk(path.join(PLUGIN_DIR, 'utils'))
  assert.deepEqual(found, [], `这些地方又写死了出图格式，应改用 getImgType()：\n  ${found.join('\n  ')}`)
})
