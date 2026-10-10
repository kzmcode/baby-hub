'use strict';
module.exports = input => {
  const stack = [[input, 0]];
  const seen = new Set();
  let count = 0;
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (depth > 64 || ++count > 65536 || seen.has(node)) throw new SyntaxError('Brace AST exceeds security limit');
    seen.add(node);
    if (Array.isArray(node.nodes)) for (const child of node.nodes) stack.push([child, depth + 1]);
  }
};
