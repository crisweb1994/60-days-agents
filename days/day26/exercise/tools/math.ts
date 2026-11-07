// 一个很小的算式解析器：支持 + - * / % ^、括号、小数和负号。
// 不用 eval：算式是模型生成的，eval 会把它当成 JavaScript 执行，等于让模型在你的电脑上运行任意代码。

export function evaluate(expression: string): number {
  const tokens = tokenize(expression);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  // 优先级从低到高：加减 < 乘除取余 < 负号 < 乘方 < 数字和括号
  function sum(): number {
    let value = product();
    while (peek() === '+' || peek() === '-') {
      value = next() === '+' ? value + product() : value - product();
    }
    return value;
  }
  function product(): number {
    let value = unary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next();
      const right = unary();
      value = op === '*' ? value * right : op === '/' ? value / right : value % right;
    }
    return value;
  }
  function unary(): number {
    if (peek() === '-') {
      next();
      return -unary(); // -2^2 是 -(2^2) = -4
    }
    if (peek() === '+') {
      next();
      return unary();
    }
    return power();
  }
  function power(): number {
    const base = primary();
    if (peek() !== '^') return base;
    next();
    return base ** unary(); // 乘方从右往左算：2^3^2 = 2^9
  }
  function primary(): number {
    const token = next();
    if (token === '(') {
      const value = sum();
      if (next() !== ')') throw new Error('括号没有配对');
      return value;
    }
    const value = Number(token);
    if (token === undefined || Number.isNaN(value)) {
      throw new Error(`算式不完整，或者有看不懂的内容：${token ?? '（已经到结尾了）'}`);
    }
    return value;
  }

  const result = sum();
  if (pos < tokens.length) throw new Error(`算式里有多余的内容：${tokens.slice(pos).join('')}`);
  if (!Number.isFinite(result)) throw new Error('结果不是一个有限的数，可能除以了 0');
  return result;
}

function tokenize(expression: string): string[] {
  // 顺便兼容模型偶尔写出的 × ÷ 和全角括号
  const normalized = expression.replace(/×/g, '*').replace(/÷/g, '/').replace(/（/g, '(').replace(/）/g, ')');
  const tokens = normalized.match(/\d+(?:\.\d+)?|\.\d+|[-+*/%^()]|\S/g) ?? [];
  if (tokens.length === 0) throw new Error('算式是空的');
  return tokens;
}
