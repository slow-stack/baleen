/**
 * 面板样式。**这份 CSS 里一个颜色字面量都没有**：所有颜色都从宿主 token 取，
 * 换主题（catppuccin / mocha / mica）这里自动跟着变——是"融进主题"，不是"自带皮肤"。
 *
 * token 名不是猜的：每个都在本机 dsh-study-desk（已在 0.2.1-rc.2 跑通的插件）里出现过，
 * test/css.test.js 拿那份清单卡住，写错名字等于在宿主里裸奔。
 * 也不写 `var(--x, light-dark(…))` 那种内联兜底：兜底色会在这份文件里重新引入硬编码颜色，
 * 而脱离宿主的样子是预览器的事——tools/preview.mjs 自己声明一张替身 token 表并标明是替身。
 */
export const CSS = `
.bl-root{display:flex;flex-direction:column;width:100%;min-width:0;height:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.bl-root *{box-sizing:border-box;font-weight:400}
.bl-icon{font-size:13px;line-height:1}
.bl-nav{display:flex;align-items:center;gap:8px;padding:9px 14px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto;scrollbar-width:thin}
.bl-brand{font-size:13px;font-weight:500;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.bl-navlist{display:flex;gap:2px;flex:1;min-width:0}
.bl-navitem{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;padding:6px 10px;min-height:32px;border-radius:7px;cursor:pointer;white-space:nowrap}
.bl-navitem:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.bl-navitem[aria-current="page"]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-weight:500}
.bl-band{display:flex;flex-wrap:wrap;gap:10px;padding:6px 14px;font-size:12px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.bl-body{padding:14px 16px 20px;min-width:0;flex:1;overflow-y:auto}
.bl-empty,.bl-note,.bl-more,.bl-count,.bl-gaps,.bl-pending{font-size:12px;color:var(--dsw-alias-label-secondary)}
.bl-summary{font-size:13px;color:var(--dsw-alias-label-primary)}
.bl-issues{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-state-error-primary)}
.bl-pending{font-size:12px;color:var(--dsw-alias-label-secondary)}
.bl-actions{display:flex;gap:8px;margin:10px 0 2px}
.bl-actions button,.bl-detail{appearance:none;font-family:inherit;font-size:12px;min-height:32px;padding:5px 11px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.bl-actions button:hover,.bl-detail:hover{background:var(--dsw-alias-interactive-bg-hover)}
.bl-actions button:disabled{color:var(--dsw-alias-label-dimmed);cursor:progress}
.bl-today,.bl-video,.bl-article,.bl-digest{display:flex;flex-direction:column;gap:8px;min-width:0}
.bl-rail{margin-top:18px;min-width:0}
.bl-rail h3{font-size:13px;font-weight:500;margin:0 0 8px;color:var(--dsw-alias-label-primary)}
.bl-toolbar{display:flex;flex-wrap:wrap;gap:7px;align-items:center;margin-bottom:12px}
.bl-toolbar select,.bl-toolbar input{font-family:inherit;font-size:12px;padding:5px 8px;min-height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.bl-toolbar input{flex:1;min-width:130px}
.bl-grid{display:grid;grid-template-columns:repeat(auto-fill, minmax(260px, 1fr));gap:12px;min-width:0}
.bl-card,.bl-row{appearance:none;text-align:left;font-family:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px 10px;cursor:pointer;display:flex;flex-direction:column;gap:5px;min-height:32px;min-width:0}
.bl-card:hover,.bl-row:hover,.bl-row[aria-selected="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.bl-card:focus-visible,.bl-row:focus-visible,.bl-navitem:focus-visible,.bl-actions button:focus-visible,.bl-detail:focus-visible,.bl-dbtns button:focus-visible,.bl-dbar button:focus-visible,.bl-facets input:focus-visible,.bl-collect input:focus-visible,.bl-newfolder input:focus-visible,.bl-newfolder button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.bl-card-title,.bl-row-title{font-size:13px;line-height:1.4;color:var(--dsw-alias-label-primary)}
.bl-card-meta,.bl-row-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);display:flex;gap:6px;flex-wrap:wrap}
.bl-why,.bl-row-why{font-size:12px;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l2);padding-left:7px;margin-top:auto}
.bl-tier{font-size:11px;color:var(--dsw-alias-label-primary)}
.bl-play{font-size:11px;color:var(--dsw-alias-label-dimmed)}
.bl-thumb{position:relative;aspect-ratio:16/9;border-radius:6px;background:var(--dsw-alias-bg-layer-3);display:block}
.bl-dur{position:absolute;right:5px;bottom:5px;font-size:11px;padding:1px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.bl-two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:14px;align-items:start;min-width:0}
.bl-list{display:flex;flex-direction:column;gap:8px;min-width:0}
.bl-reader{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:13px 15px;min-height:200px;min-width:0;display:flex;flex-direction:column;gap:8px}
.bl-reader h4{margin:0;font-size:13px;font-weight:500;line-height:1.4;color:var(--dsw-alias-label-primary)}
.bl-reader-by,.bl-reader-hint,.bl-reader-link{font-size:11px;color:var(--dsw-alias-label-secondary);margin:0}
.bl-reader-body{font-size:13px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary)}
.bl-library{display:grid;grid-template-columns:150px minmax(0,1fr);gap:14px;align-items:start;min-width:0}
.bl-library-body{display:flex;flex-direction:column;gap:10px;min-width:0}
.bl-facets{display:flex;flex-direction:column;gap:12px;font-size:12px;min-width:0}
.bl-facet{display:flex;flex-direction:column;gap:2px;min-width:0}
.bl-facets h4{margin:0 0 4px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary)}
.bl-facets label{display:flex;gap:6px;align-items:center;min-height:32px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.bl-empty-state{padding:18px 16px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.bl-dsum{padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:5px}
.bl-dsum h3{margin:0;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.bl-dhead{font-size:13px;color:var(--dsw-alias-label-primary);margin:0}
.bl-dpath{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0;word-break:break-all}
.bl-drawer{position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;display:flex;flex-direction:column;max-height:80vh;overflow:hidden}
.bl-dbar{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.bl-dtitle{flex:1;min-width:0;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.bl-badge{font-size:11px;color:var(--dsw-alias-brand-primary);white-space:nowrap}
.bl-dbar button{appearance:none;font-family:inherit;font-size:12px;min-height:32px;padding:4px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.bl-dbar button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.bl-dmain{padding:12px 14px;display:flex;flex-direction:column;gap:11px;overflow-y:auto;font-size:12px;min-width:0}
.bl-dmain section{display:flex;flex-direction:column;gap:4px}
.bl-dmain h5{margin:0 0 3px;font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary)}
.bl-dmain p{margin:0;word-break:break-word;color:var(--dsw-alias-label-primary)}
.bl-kv{display:flex;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary)}
.bl-missing{color:var(--dsw-alias-state-error-primary)}
.bl-collect{display:flex;flex-wrap:wrap;gap:2px 12px;font-size:12px}
.bl-collect label{display:flex;gap:6px;align-items:center;min-height:32px;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.bl-collect label:hover{color:var(--dsw-alias-label-primary)}
.bl-collect input{width:14px;height:14px;flex:none;cursor:pointer;accent-color:var(--dsw-alias-brand-primary)}
.bl-collect input:disabled{cursor:progress}
.bl-newfolder{display:flex;gap:6px;align-items:center}
.bl-newfolder input{flex:1;min-width:0;font-family:inherit;font-size:12px;padding:5px 8px;min-height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.bl-newfolder button{appearance:none;font-family:inherit;font-size:12px;min-height:32px;padding:5px 11px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}
.bl-newfolder button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.bl-newfolder button:disabled{color:var(--dsw-alias-label-dimmed);cursor:progress}
.bl-kw{font-size:11px;color:var(--dsw-alias-label-secondary)}
.bl-url{font-size:12px;color:var(--dsw-alias-brand-primary);word-break:break-all}
.bl-feedback{margin:0;padding:7px 14px;font-size:12px;background:var(--dsw-alias-bg-layer-2);border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.bl-dbtns{display:flex;gap:8px;padding:11px 14px;border-top:1px solid var(--dsw-alias-border-l1)}
.bl-dbtns button{flex:1;appearance:none;font-family:inherit;font-size:12px;min-height:32px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.bl-dbtns button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.bl-dbtns .bl-save{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
@media (max-width:820px){.bl-two,.bl-library{grid-template-columns:minmax(0,1fr)}}
@media (prefers-reduced-motion:reduce){.bl-root *{transition:none;animation:none}}
`

let injected = false

/** 只注入一次；宿主可能多次装载同一个客户端模块，重复注入会让样式表越堆越长。 */
export function injectStyles() {
  if (injected) return false
  if (typeof document === 'undefined' || !document.createElement) return false
  const el = document.createElement('style')
  el.setAttribute('data-baleen', '')
  el.textContent = CSS
  const parent = document.head || document.body
  if (!parent || typeof parent.appendChild !== 'function') return false
  parent.appendChild(el)
  injected = true
  return true
}
