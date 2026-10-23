import { flattenText } from '../../tools/client-loader.mjs'

/** 把节点树压成一段文本再断言文案：比逐层断结构耐改（改className不该弄红测试） */
export const text = (node) => flattenText(node).join(' ')

/** 按 className 找节点，用于断言"某类元素存在/不存在" */
export function findAll(node, cls, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => findAll(n, cls, out)); return out }
  if (node.props && String(node.props.className ?? '').split(/\s+/).includes(cls)) out.push(node)
  findAll(node.children ?? [], cls, out)
  return out
}
