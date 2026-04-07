export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function getNodeLabel(node) {
  if (!node || typeof node !== 'object') {
    return '';
  }

  return String(node.title || node.content || node.id || '').trim();
}

export function createUniqueParamKey(params = {}, baseKey = 'link') {
  const normalizedBase = String(baseKey || 'link').trim() || 'link';
  if (!Object.prototype.hasOwnProperty.call(params, normalizedBase)) {
    return normalizedBase;
  }

  let suffix = 2;
  let candidate = `${normalizedBase}_${suffix}`;
  while (Object.prototype.hasOwnProperty.call(params, candidate)) {
    suffix += 1;
    candidate = `${normalizedBase}_${suffix}`;
  }
  return candidate;
}

export function getPortSide(portEl) {
  if (!portEl) {
    return null;
  }

  const classes = Array.from(portEl.classList);
  return ['top', 'right', 'bottom', 'left'].find((side) => classes.includes(side)) || null;
}
