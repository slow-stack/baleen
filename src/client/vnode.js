/**
 * 视图产出的节点形状：{type, props, children}，纯数据。
 *
 * 视图不直接调 React.createElement，是为了能在 Node 里把渲染结果当普通对象断言
 * （test/helpers/tree.mjs 压文本、tools/preview.mjs 出静态 HTML 都吃这个形状）。
 * 装配层用 toElement() 把这棵树交给真 React。
 */
export const vnode = (type, props, children) => ({ type, props: props ?? {}, children: children ?? [] })
