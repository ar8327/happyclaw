/**
 * 把主题 CSS 变量解析成具体的 rgb() 字符串。
 *
 * 为什么需要探针元素：自定义属性的计算值是「替换过 var() 的 token 流」，
 * 所以 getComputedStyle(root).getPropertyValue('--card') 对于用 color-mix()
 * 派生出来的 token 会原样返回 "color-mix(...)" 而不是最终颜色。
 * 把它赋给一个真实元素的 color，再读回 computed color，才能拿到解析后的值。
 *
 * 用于需要具体颜色值的第三方渲染器（xterm、mermaid 等）。
 */

export function resolveCssColors<T extends string>(
  varNames: readonly T[],
): Record<T, string> {
  const out = {} as Record<T, string>;
  if (typeof document === 'undefined') return out;

  const probe = document.createElement('span');
  probe.style.cssText =
    'position:absolute;width:0;height:0;visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);

  try {
    for (const name of varNames) {
      probe.style.color = '';
      probe.style.color = `var(${name})`;
      out[name] = getComputedStyle(probe).color;
    }
  } finally {
    probe.remove();
  }

  return out;
}

export function resolveCssColor(varName: string, fallback = '#000000'): string {
  return resolveCssColors([varName])[varName] || fallback;
}
