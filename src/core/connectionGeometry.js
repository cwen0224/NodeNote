function isFiniteNumber(value) {
  return Number.isFinite(value);
}

function getPortDirectionVector(side) {
  switch (side) {
    case 'top':
      return { x: 0, y: -1 };
    case 'bottom':
      return { x: 0, y: 1 };
    case 'left':
      return { x: -1, y: 0 };
    case 'right':
    default:
      return { x: 1, y: 0 };
  }
}

function measureRoute(points = []) {
  return points.reduce((total, point, index) => {
    if (index === 0) {
      return 0;
    }
    const previous = points[index - 1];
    return total + Math.hypot(point.x - previous.x, point.y - previous.y);
  }, 0);
}

function scoreRoute(points, sourceBounds, targetBounds, routePadding) {
  let score = measureRoute(points);
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const insideSource = point.x >= (sourceBounds.left - routePadding)
      && point.x <= (sourceBounds.right + routePadding)
      && point.y >= (sourceBounds.top - routePadding)
      && point.y <= (sourceBounds.bottom + routePadding);
    const insideTarget = point.x >= (targetBounds.left - routePadding)
      && point.x <= (targetBounds.right + routePadding)
      && point.y >= (targetBounds.top - routePadding)
      && point.y <= (targetBounds.bottom + routePadding);
    if (insideSource || insideTarget) {
      score += 100000;
      break;
    }
  }
  return score;
}

function normalizeBounds(bounds = {}, fallbackX = 0, fallbackY = 0) {
  const safeBounds = bounds && typeof bounds === 'object' ? bounds : {};
  return {
    left: isFiniteNumber(safeBounds.left) ? safeBounds.left : fallbackX,
    right: isFiniteNumber(safeBounds.right) ? safeBounds.right : fallbackX,
    top: isFiniteNumber(safeBounds.top) ? safeBounds.top : fallbackY,
    bottom: isFiniteNumber(safeBounds.bottom) ? safeBounds.bottom : fallbackY,
  };
}

export function compressOrthogonalPoints(points = []) {
  const filtered = [];

  points.forEach((point) => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return;
    }

    const previous = filtered[filtered.length - 1];
    if (previous && previous.x === point.x && previous.y === point.y) {
      return;
    }

    filtered.push({ x: point.x, y: point.y });
  });

  if (filtered.length < 3) {
    return filtered;
  }

  const compacted = [filtered[0]];
  for (let index = 1; index < filtered.length - 1; index += 1) {
    const prev = compacted[compacted.length - 1];
    const current = filtered[index];
    const next = filtered[index + 1];
    const sameX = prev.x === current.x && current.x === next.x;
    const sameY = prev.y === current.y && current.y === next.y;
    if (sameX || sameY) {
      continue;
    }
    compacted.push(current);
  }

  compacted.push(filtered[filtered.length - 1]);
  return compacted;
}

export function buildRoundedOrthogonalPath(points = [], radius = 18) {
  const compacted = compressOrthogonalPoints(points);
  if (compacted.length < 2) {
    return '';
  }

  const parts = [`M ${compacted[0].x} ${compacted[0].y}`];

  for (let index = 1; index < compacted.length - 1; index += 1) {
    const prev = compacted[index - 1];
    const current = compacted[index];
    const next = compacted[index + 1];

    const dirIn = {
      x: Math.sign(current.x - prev.x),
      y: Math.sign(current.y - prev.y),
    };
    const dirOut = {
      x: Math.sign(next.x - current.x),
      y: Math.sign(next.y - current.y),
    };

    const isCorner = dirIn.x !== dirOut.x || dirIn.y !== dirOut.y;
    if (!isCorner) {
      parts.push(`L ${current.x} ${current.y}`);
      continue;
    }

    const lenIn = Math.hypot(current.x - prev.x, current.y - prev.y);
    const lenOut = Math.hypot(current.x - next.x, current.y - next.y);
    const cornerRadius = Math.max(6, Math.min(radius, lenIn / 2, lenOut / 2));
    const tangentIn = {
      x: current.x - (dirIn.x * cornerRadius),
      y: current.y - (dirIn.y * cornerRadius),
    };
    const tangentOut = {
      x: current.x + (dirOut.x * cornerRadius),
      y: current.y + (dirOut.y * cornerRadius),
    };
    const cross = (dirIn.x * dirOut.y) - (dirIn.y * dirOut.x);
    const sweepFlag = cross > 0 ? 1 : 0;

    parts.push(`L ${tangentIn.x} ${tangentIn.y}`);
    parts.push(`A ${cornerRadius} ${cornerRadius} 0 0 ${sweepFlag} ${tangentOut.x} ${tangentOut.y}`);
  }

  const last = compacted[compacted.length - 1];
  parts.push(`L ${last.x} ${last.y}`);
  return parts.join(' ');
}

export function selectOrthogonalRoute({
  sX,
  sY,
  tX,
  tY,
  sourcePortSide = 'right',
  targetPortSide = 'left',
  sourceBounds = null,
  targetBounds = null,
  previousCandidate = null,
}) {
  const sourceVector = getPortDirectionVector(sourcePortSide);
  const targetVector = getPortDirectionVector(targetPortSide);
  const distance = Math.max(1, Math.hypot(tX - sX, tY - sY));
  const exitDistance = Math.max(18, Math.min(56, distance * 0.09));
  const routePadding = Math.max(14, Math.min(24, Math.round(distance * 0.04)));
  const sourceIsHorizontal = sourceVector.x !== 0;
  const targetIsHorizontal = targetVector.x !== 0;
  const sourceRect = normalizeBounds(sourceBounds, sX, sY);
  const targetRect = normalizeBounds(targetBounds, tX, tY);
  const sourceExit = {
    x: sX + (sourceVector.x * exitDistance),
    y: sY + (sourceVector.y * exitDistance),
  };
  const targetEntry = {
    x: tX + (targetVector.x * exitDistance),
    y: tY + (targetVector.y * exitDistance),
  };

  const candidates = [];
  const makeRoutePoints = (innerPoints = []) => [
    { x: sX, y: sY },
    sourceExit,
    ...innerPoints,
    targetEntry,
    { x: tX, y: tY },
  ];
  const addCandidate = (name, innerPoints) => {
    const points = makeRoutePoints(innerPoints);
    candidates.push({
      name,
      points,
      score: scoreRoute(points, sourceRect, targetRect, routePadding),
    });
  };

  if (sourceIsHorizontal && targetIsHorizontal) {
    addCandidate('direct-source-y', [
      { x: sourceExit.x, y: targetEntry.y },
    ]);
    addCandidate('direct-target-y', [
      { x: targetEntry.x, y: sourceExit.y },
    ]);
    const aboveY = Math.min(sourceRect.top, targetRect.top) - routePadding;
    const belowY = Math.max(sourceRect.bottom, targetRect.bottom) + routePadding;
    addCandidate('above', [
      { x: sourceExit.x, y: aboveY },
      { x: targetEntry.x, y: aboveY },
    ]);
    addCandidate('below', [
      { x: sourceExit.x, y: belowY },
      { x: targetEntry.x, y: belowY },
    ]);
  } else if (!sourceIsHorizontal && !targetIsHorizontal) {
    addCandidate('direct-source-x', [
      { x: sourceExit.x, y: targetEntry.y },
    ]);
    addCandidate('direct-target-x', [
      { x: targetEntry.x, y: sourceExit.y },
    ]);
    const leftX = Math.min(sourceRect.left, targetRect.left) - routePadding;
    const rightX = Math.max(sourceRect.right, targetRect.right) + routePadding;
    addCandidate('left', [
      { x: leftX, y: sourceExit.y },
      { x: leftX, y: targetEntry.y },
    ]);
    addCandidate('right', [
      { x: rightX, y: sourceExit.y },
      { x: rightX, y: targetEntry.y },
    ]);
  } else if (sourceIsHorizontal && !targetIsHorizontal) {
    addCandidate('direct-a', [
      { x: sourceExit.x, y: targetEntry.y },
    ]);
    addCandidate('direct-b', [
      { x: targetEntry.x, y: sourceExit.y },
    ]);
    const routeX = sourceVector.x > 0
      ? Math.max(sourceRect.right, targetRect.right) + routePadding
      : Math.min(sourceRect.left, targetRect.left) - routePadding;
    addCandidate('detour-x', [
      { x: routeX, y: sourceExit.y },
      { x: routeX, y: targetEntry.y },
    ]);
  } else {
    addCandidate('direct-a', [
      { x: sourceExit.x, y: targetEntry.y },
    ]);
    addCandidate('direct-b', [
      { x: targetEntry.x, y: sourceExit.y },
    ]);
    const routeY = sourceVector.y > 0
      ? Math.max(sourceRect.bottom, targetRect.bottom) + routePadding
      : Math.min(sourceRect.top, targetRect.top) - routePadding;
    addCandidate('detour-y', [
      { x: sourceExit.x, y: routeY },
      { x: targetEntry.x, y: routeY },
    ]);
  }

  const routeCandidates = candidates
    .filter((candidate) => Array.isArray(candidate.points) && candidate.points.length >= 2)
    .sort((a, b) => a.score - b.score || a.points.length - b.points.length || a.name.localeCompare(b.name));
  const bestCandidate = routeCandidates[0] || {
    name: 'fallback',
    points: makeRoutePoints([]),
    score: Infinity,
  };
  const switchMargin = Math.max(8, Math.round(distance * 0.05));
  let selectedCandidate = bestCandidate;
  if (previousCandidate) {
    const cachedCandidate = routeCandidates.find((candidate) => candidate.name === previousCandidate.name);
    if (cachedCandidate && cachedCandidate.score <= bestCandidate.score + switchMargin) {
      selectedCandidate = cachedCandidate;
    }
  }

  return {
    distance,
    routePadding,
    routePoints: selectedCandidate.points,
    selectedCandidate: {
      name: selectedCandidate.name,
      score: selectedCandidate.score,
    },
    sourceExit,
    targetEntry,
  };
}
