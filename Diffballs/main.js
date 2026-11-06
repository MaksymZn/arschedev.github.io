/**
 * Copyright (c) 2023
 * |   MaksymMNM                |
 * |   arschedev                |
 * |   A. Proydenko (wert1x),   |
 * https://github.com/wert1x
 * https://github.com/arschedev
 * https://github.com/MaksymMNM
 */

'use strict';

(() => {
  /**
   * ! Settings
   */

  // hard cap on the number of balls, keeps the game responsive
  const MAX_BALLS = 3000;
  // px/s, protects against runaway speeds after many collisions
  const MAX_SPEED = 900;
  // 1 = perfectly elastic bounces (no energy is lost)
  const RESTITUTION = 1;
  // px of free space required around a newly created ball
  const SPAWN_GAP = 1;
  // ms during which a fresh ball can't be caught,
  // so a fast double click creates two balls instead of catching the first one
  const SPAWN_GRACE_MS = 400;
  // upper bound for physics sub-steps per rendered frame
  const MAX_SUBSTEPS = 500;
  // ms of physics per frame at most: in a huge crowd the game slows down
  // a little instead of freezing
  const MIN_PHYSICS_BUDGET_MS = 8;
  const MAX_PHYSICS_BUDGET_MS = 250;
  // passes that push apart balls in a crowd (a push can create a new overlap)
  const SOLVER_PASSES = 4;
  // px of overlap that is small enough to not need another pass
  const OVERLAP_TOLERANCE = 0.25;
  // the original speeds were "px per frame" at 36 fps
  const BASE_FPS = 36;

  /**
   * ! Utils
   */

  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
  const pad2 = (n) => String(n).padStart(2, '0');

  // distance from the centre of an axis-aligned ellipse (semi-axes a, b)
  // to its edge in the direction of the unit vector (nx, ny)
  function radiusAlong(a, b, nx, ny) {
    if (a === b) return a;
    const bx = b * nx;
    const ay = a * ny;
    return (a * b) / Math.sqrt(bx * bx + ay * ay);
  }

  /**
   * ! DOM
   */

  const container = document.getElementById('container');
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');

  const fpsSelect = document.getElementById('fps');
  const sizeSelect = document.getElementById('size');
  const formSelect = document.getElementById('form');
  const borderCheckbox = document.getElementById('border');

  const ballsCounter = document.getElementById('ballons');
  const caughtCounter = document.getElementById('caught');
  const timerOutput = document.querySelector('#timer time');

  /**
   * ! Parameters
   */

  const params = {
    fps: 36,
    size: '40' /* medium */,
    form: 'smooth',
    border: false
  };

  // to default
  fpsSelect.value = String(params.fps);
  sizeSelect.value = params.size;
  formSelect.value = params.form;
  borderCheckbox.checked = params.border;

  // fps: how often the field is redrawn, the speed of the balls doesn't depend on it
  fpsSelect.addEventListener('change', () => {
    params.fps = Number(fpsSelect.value);
  });

  // size
  sizeSelect.addEventListener('change', () => {
    params.size = sizeSelect.value;
  });

  // form
  formSelect.addEventListener('change', () => {
    params.form = formSelect.value;
  });

  // border
  borderCheckbox.addEventListener('change', () => {
    params.border = borderCheckbox.checked;
    container.classList.toggle('bordered', params.border);
    resize();
  });

  function randomBaseSize() {
    // random: tiny..medium
    return params.size === 'random' ? randInt(10, 40) : Number(params.size);
  }

  /**
   * ! Game state
   */

  /**
   * x, y   - centre (px, relative to the game field)
   * vx, vy - velocity (px/s)
   * a, b   - horizontal / vertical semi-axes (px)
   * r      - bounding radius = max(a, b)
   * invMass, born
   */
  const balls = [];
  let caught = 0;

  // game field size in CSS px
  let width = 0;
  let height = 0;
  let dpr = 1;

  // biggest bounding radius / smallest semi-axis among all balls, see measureBalls()
  let maxRadius = 1;
  let minRadius = 1;

  // updates maxRadius / minRadius and returns the speed of the fastest ball
  function measureBalls() {
    let fastest2 = 0;
    maxRadius = 1;
    minRadius = Infinity;
    for (let i = 0; i < balls.length; i++) {
      const ball = balls[i];
      const speed2 = ball.vx * ball.vx + ball.vy * ball.vy;
      if (speed2 > fastest2) fastest2 = speed2;
      if (ball.r > maxRadius) maxRadius = ball.r;
      const small = ball.a < ball.b ? ball.a : ball.b;
      if (small < minRadius) minRadius = small;
    }
    return Math.sqrt(fastest2);
  }

  /**
   * ! Field size
   */

  function resize() {
    width = container.clientWidth;
    height = container.clientHeight;
    dpr = window.devicePixelRatio || 1;

    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));

    // the field may have become smaller: put every ball back inside
    for (let i = 0; i < balls.length; i++) keepInside(balls[i]);

    render();
  }

  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(container);
  // also catches devicePixelRatio changes (page zoom)
  window.addEventListener('resize', resize);

  /**
   * ! Walls
   */

  // clamps the ball into the field and makes it move away from the wall it hit.
  // velocity sign is set (not flipped), so a ball can never get stuck in a wall
  function keepInside(ball) {
    const a = ball.a;
    const b = ball.b;

    if (width <= 2 * a) {
      ball.x = width / 2;
    } else if (ball.x < a) {
      ball.x = a;
      if (ball.vx < 0) ball.vx = -ball.vx;
    } else if (ball.x > width - a) {
      ball.x = width - a;
      if (ball.vx > 0) ball.vx = -ball.vx;
    }

    if (height <= 2 * b) {
      ball.y = height / 2;
    } else if (ball.y < b) {
      ball.y = b;
      if (ball.vy < 0) ball.vy = -ball.vy;
    } else if (ball.y > height - b) {
      ball.y = height - b;
      if (ball.vy > 0) ball.vy = -ball.vy;
    }
  }

  /**
   * ! Spatial grid (broad phase)
   * Every ball is put into one cell, a cell is as big as the biggest ball,
   * so a ball can only touch balls from its own and 8 neighbouring cells.
   * This turns O(n^2) pair checks into ~O(n).
   */

  let gridSize = 1;
  let gridCols = 1;
  let gridRows = 1;
  let gridHead = new Int32Array(1);
  let gridNext = new Int32Array(64);
  let ballCol = new Int32Array(64);
  let ballRow = new Int32Array(64);

  function buildGrid() {
    const n = balls.length;

    gridSize = Math.max(2 * maxRadius, 16);
    gridCols = Math.max(1, Math.ceil(width / gridSize));
    gridRows = Math.max(1, Math.ceil(height / gridSize));

    const cells = gridCols * gridRows;
    if (gridHead.length < cells) gridHead = new Int32Array(cells);
    gridHead.fill(-1, 0, cells);

    if (gridNext.length < n) {
      const size = Math.max(n, gridNext.length * 2);
      gridNext = new Int32Array(size);
      ballCol = new Int32Array(size);
      ballRow = new Int32Array(size);
    }

    for (let i = 0; i < n; i++) {
      const ball = balls[i];
      const col = clamp(Math.floor(ball.x / gridSize), 0, gridCols - 1);
      const row = clamp(Math.floor(ball.y / gridSize), 0, gridRows - 1);
      const cell = row * gridCols + col;
      ballCol[i] = col;
      ballRow[i] = row;
      gridNext[i] = gridHead[cell];
      gridHead[cell] = i;
    }
  }

  /**
   * ! Ball to ball collision (narrow phase)
   */

  // returns how deep the balls were inside each other (0 = not touching)
  function collide(p, q) {
    let dx = q.x - p.x;
    let dy = q.y - p.y;
    const reach = p.r + q.r;
    const dist2 = dx * dx + dy * dy;
    if (dist2 >= reach * reach) return 0;

    let dist;
    if (dist2 > 1e-12) {
      dist = Math.sqrt(dist2);
      dx /= dist;
      dy /= dist;
    } else {
      // exactly the same centre: push apart in a random direction
      const angle = Math.random() * Math.PI * 2;
      dist = 0;
      dx = Math.cos(angle);
      dy = Math.sin(angle);
    }

    // (dx, dy) is now the collision normal from p to q
    const overlap = radiusAlong(p.a, p.b, dx, dy) + radiusAlong(q.a, q.b, dx, dy) - dist;
    if (overlap <= 0) return 0;

    const pInv = p.invMass;
    const qInv = q.invMass;
    const invSum = pInv + qInv;

    // 1) separate: balls never stay inside each other (heavier ball moves less)
    const push = overlap / invSum;
    p.x -= dx * push * pInv;
    p.y -= dy * push * pInv;
    q.x += dx * push * qInv;
    q.y += dy * push * qInv;

    // 2) bounce only if they are moving towards each other.
    //    Balls that are already flying apart are left alone - this is what
    //    makes them never "stick" (the old code flipped the speed every frame)
    const approach = (q.vx - p.vx) * dx + (q.vy - p.vy) * dy;
    if (approach < 0) {
      const impulse = (-(1 + RESTITUTION) * approach) / invSum;
      p.vx -= impulse * pInv * dx;
      p.vy -= impulse * pInv * dy;
      q.vx += impulse * qInv * dx;
      q.vy += impulse * qInv * dy;
    }

    return overlap;
  }

  /**
   * ! Physics
   */

  // Balls that were pushed noticeably in a solver pass may now overlap with
  // their neighbours, so only they are checked again in the next pass
  // (almost nobody when the balls are not crowded).
  let pushedList = new Int32Array(64);
  let nextPushedList = new Int32Array(64);
  let pushedStamp = new Int32Array(64);
  let checkStamp = new Int32Array(64);
  let stampId = 0;
  let pushedCount = 0;

  function ensureSolverArrays(n) {
    if (pushedList.length >= n && stampId < 1e9) return;
    const size = Math.max(n, pushedList.length * 2);
    pushedList = new Int32Array(size);
    nextPushedList = new Int32Array(size);
    pushedStamp = new Int32Array(size);
    checkStamp = new Int32Array(size);
    stampId = 0;
  }

  function markPushed(i) {
    if (pushedStamp[i] !== stampId) {
      pushedStamp[i] = stampId;
      nextPushedList[pushedCount++] = i;
    }
  }

  // the balls marked in this pass become the list for the next pass
  function swapPushedLists() {
    const list = pushedList;
    pushedList = nextPushedList;
    nextPushedList = list;
    return pushedCount;
  }

  // first pass: every pair of neighbouring balls (each pair once)
  function solveAllPairs(n) {
    stampId++;
    pushedCount = 0;
    const lastCol = gridCols - 1;
    const lastRow = gridRows - 1;

    for (let i = 0; i < n; i++) {
      const p = balls[i];
      const col = ballCol[i];
      const row = ballRow[i];
      const colFrom = col > 0 ? col - 1 : 0;
      const colTo = col < lastCol ? col + 1 : lastCol;
      const rowFrom = row > 0 ? row - 1 : 0;
      const rowTo = row < lastRow ? row + 1 : lastRow;

      for (let r = rowFrom; r <= rowTo; r++) {
        const base = r * gridCols;
        for (let c = colFrom; c <= colTo; c++) {
          for (let j = gridHead[base + c]; j !== -1; j = gridNext[j]) {
            if (j > i && collide(p, balls[j]) > OVERLAP_TOLERANCE) {
              markPushed(i);
              markPushed(j);
            }
          }
        }
      }
    }

    return swapPushedLists();
  }

  // next passes: only the balls pushed in the previous pass
  function solvePushed(count) {
    const checkId = ++stampId;
    for (let k = 0; k < count; k++) checkStamp[pushedList[k]] = checkId;

    stampId++;
    pushedCount = 0;
    const lastCol = gridCols - 1;
    const lastRow = gridRows - 1;

    for (let k = 0; k < count; k++) {
      const i = pushedList[k];
      const p = balls[i];
      const col = ballCol[i];
      const row = ballRow[i];
      const colFrom = col > 0 ? col - 1 : 0;
      const colTo = col < lastCol ? col + 1 : lastCol;
      const rowFrom = row > 0 ? row - 1 : 0;
      const rowTo = row < lastRow ? row + 1 : lastRow;

      for (let r = rowFrom; r <= rowTo; r++) {
        const base = r * gridCols;
        for (let c = colFrom; c <= colTo; c++) {
          for (let j = gridHead[base + c]; j !== -1; j = gridNext[j]) {
            // a pair of two checked balls is handled once
            if (j === i || (j < i && checkStamp[j] === checkId)) continue;
            if (collide(p, balls[j]) > OVERLAP_TOLERANCE) {
              markPushed(i);
              markPushed(j);
            }
          }
        }
      }
    }

    return swapPushedLists();
  }

  function step(h) {
    const n = balls.length;
    const maxSpeed2 = MAX_SPEED * MAX_SPEED;

    // move
    for (let i = 0; i < n; i++) {
      const ball = balls[i];
      const speed2 = ball.vx * ball.vx + ball.vy * ball.vy;
      if (speed2 > maxSpeed2) {
        const k = MAX_SPEED / Math.sqrt(speed2);
        ball.vx *= k;
        ball.vy *= k;
      }
      ball.x += ball.vx * h;
      ball.y += ball.vy * h;
      keepInside(ball);
    }

    // bounce off balls
    buildGrid();
    ensureSolverArrays(n);
    let count = solveAllPairs(n);
    for (let pass = 1; pass < SOLVER_PASSES && count > 0; pass++) {
      for (let k = 0; k < count; k++) keepInside(balls[pushedList[k]]);
      count = solvePushed(count);
    }

    // pushing balls apart must never move them out of the field
    for (let i = 0; i < n; i++) keepInside(balls[i]);
  }

  function simulate(dt, budgetMs) {
    if (!balls.length) return;

    // split the frame into small steps: during one step no ball moves more
    // than half of the smallest radius, so balls can't fly through each other
    // or through a wall, no matter how fast they are or how low the fps is
    const fastest = Math.min(measureBalls(), MAX_SPEED);
    const steps = clamp(Math.ceil((dt * fastest) / (0.5 * minRadius)), 1, MAX_SUBSTEPS);
    const h = dt / steps;

    const started = performance.now();
    for (let s = 0; s < steps; s++) {
      step(h);
      // out of time for this frame (e.g. thousands of squeezed balls):
      // skip the rest of the frame time instead of freezing the page
      if (performance.now() - started > budgetMs) break;
    }
  }

  /**
   * ! Rendering
   * One pre-rendered gradient ball, scaled to every ball's size.
   */

  const SPRITE_SIZES = [16, 32, 64, 128, 256];
  const sprites = SPRITE_SIZES.map((size) => {
    const sprite = document.createElement('canvas');
    sprite.width = size;
    sprite.height = size;
    const g = sprite.getContext('2d');
    const gradient = g.createLinearGradient(0, 0, size, 0);
    gradient.addColorStop(0, '#0700b8');
    gradient.addColorStop(1, '#00ff88');
    g.fillStyle = gradient;
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    g.fill();
    return sprite;
  });

  function spriteFor(devicePixels) {
    for (let i = 0; i < sprites.length; i++) {
      if (sprites[i].width >= devicePixels) return sprites[i];
    }
    return sprites[sprites.length - 1];
  }

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    for (let i = 0; i < balls.length; i++) {
      const ball = balls[i];
      const w = ball.a * 2;
      const h = ball.b * 2;
      ctx.drawImage(spriteFor((w > h ? w : h) * dpr), ball.x - ball.a, ball.y - ball.b, w, h);
    }
  }

  /**
   * ! Game loop
   */

  let frameId = 0;
  let tickTime = 0;
  let simTime = 0;

  function frame(now) {
    if (!balls.length) {
      frameId = 0;
      return;
    }
    frameId = requestAnimationFrame(frame);

    // limit the redraw rate to the selected fps
    const interval = 1000 / params.fps;
    const sinceTick = now - tickTime;
    if (sinceTick + 1 < interval) return;
    tickTime = sinceTick > interval * 3
      ? now
      : tickTime + interval * Math.floor((sinceTick + 1) / interval);

    // movement is time based: same speed at any fps.
    // after a long pause (hidden tab) the game just continues instead of jumping
    const maxDt = Math.max(100, 2 * interval);
    const dt = Math.min(now - simTime, maxDt) / 1000;
    simTime = now;

    const budget = clamp(interval * 0.5, MIN_PHYSICS_BUDGET_MS, MAX_PHYSICS_BUDGET_MS);
    if (dt > 0) simulate(dt, budget);
    render();
  }

  function startLoop() {
    if (frameId || !balls.length) return;
    tickTime = simTime = performance.now();
    frameId = requestAnimationFrame(frame);
  }

  /**
   * ! Creating balls
   */

  // centre position for a ball with semi-axes a, b that keeps it inside the field
  const fitX = (x, a) => (width <= 2 * a ? width / 2 : clamp(x, a, width - a));
  const fitY = (y, b) => (height <= 2 * b ? height / 2 : clamp(y, b, height - b));

  // does an ellipse at (x, y) touch any ball? Uses the grid: only nearby balls are checked
  function overlapsAny(x, y, a, b) {
    const r = a > b ? a : b;
    const range = r + maxRadius + SPAWN_GAP;
    const colFrom = clamp(Math.floor((x - range) / gridSize), 0, gridCols - 1);
    const colTo = clamp(Math.floor((x + range) / gridSize), 0, gridCols - 1);
    const rowFrom = clamp(Math.floor((y - range) / gridSize), 0, gridRows - 1);
    const rowTo = clamp(Math.floor((y + range) / gridSize), 0, gridRows - 1);

    for (let row = rowFrom; row <= rowTo; row++) {
      for (let col = colFrom; col <= colTo; col++) {
        for (let j = gridHead[row * gridCols + col]; j !== -1; j = gridNext[j]) {
          const other = balls[j];
          const dx = other.x - x;
          const dy = other.y - y;
          const reach = r + other.r + SPAWN_GAP;
          const dist2 = dx * dx + dy * dy;
          if (dist2 >= reach * reach) continue;
          if (dist2 < 1e-12) return true;
          const dist = Math.sqrt(dist2);
          const nx = dx / dist;
          const ny = dy / dist;
          if (dist < radiusAlong(a, b, nx, ny) + radiusAlong(other.a, other.b, nx, ny) + SPAWN_GAP) {
            return true;
          }
        }
      }
    }
    return false;
  }

  // the free place closest to the click (searching in growing circles),
  // so a new ball never appears inside another ball or outside the field
  function findFreeSpot(px, py, a, b) {
    // fresh grid with the current positions (balls may have been added this frame)
    measureBalls();
    buildGrid();

    let x = fitX(px, a);
    let y = fitY(py, b);
    if (!overlapsAny(x, y, a, b)) return { x, y };

    // at most ~12 circles of at most ~80 points: a click is always cheap,
    // even when the field is full
    const maxDistance = Math.max(a, b) * 6 + 40;
    const stepSize = Math.max(2, Math.min(a, b) * 0.5, maxDistance / 12);
    for (let distance = stepSize; distance <= maxDistance; distance += stepSize) {
      const count = Math.ceil((2 * Math.PI * distance) / stepSize);
      const offset = Math.random() * Math.PI * 2;
      for (let k = 0; k < count; k++) {
        const angle = offset + (k * 2 * Math.PI) / count;
        x = fitX(px + Math.cos(angle) * distance, a);
        y = fitY(py + Math.sin(angle) * distance, b);
        if (!overlapsAny(x, y, a, b)) return { x, y };
      }
    }

    // no room around the click
    return null;
  }

  function createBall(px, py, now) {
    if (balls.length >= MAX_BALLS) return false;

    const w = randomBaseSize() + randInt(0, 19);
    const h = params.form === 'smooth' ? w : randomBaseSize() + randInt(0, 19);
    const a = w / 2;
    const b = h / 2;

    const spot = findFreeSpot(px, py, a, b);
    if (!spot) return false;

    // same speed range as the original game, but never zero
    const angle = Math.random() * Math.PI * 2;
    const speed = (4 + Math.random() * 6) * BASE_FPS;

    balls.push({
      x: spot.x,
      y: spot.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      a,
      b,
      r: Math.max(a, b),
      invMass: 1 / (a * b), // mass ~ area
      born: now
    });
    return true;
  }

  /**
   * ! Catching balls
   */

  // index of the top-most ball under the pointer that can be caught, or -1
  function catchableBallAt(px, py, now) {
    for (let i = balls.length - 1; i >= 0; i--) {
      const ball = balls[i];
      const dx = (px - ball.x) / ball.a;
      const dy = (py - ball.y) / ball.b;
      if (dx * dx + dy * dy <= 1 && now - ball.born >= SPAWN_GRACE_MS) return i;
    }
    return -1;
  }

  /**
   * ! Counters
   */

  function updateCounters() {
    ballsCounter.textContent = pad2(balls.length);
    caughtCounter.textContent = pad2(caught);
  }

  /**
   * ! Click
   */

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const now = performance.now();

    const index = catchableBallAt(x, y, now);
    if (index !== -1) {
      // caught
      balls.splice(index, 1);
      caught++;
    } else if (!createBall(x, y, now)) {
      return;
    }

    updateCounters();
    render();
    startLoop();
  });

  /**
   * ! Timer
   * by MaksymMNM
   */

  const startedAt = Date.now();

  function timerTick() {
    const total = Math.floor((Date.now() - startedAt) / 1000);
    const hour = Math.floor(total / 3600);
    const min = Math.floor(total / 60) % 60;
    const sec = total % 60;
    timerOutput.textContent = `${pad2(hour)}:${pad2(min)}:${pad2(sec)}`;
  }

  setInterval(timerTick, 1000);

  /**
   * ! Start
   */

  resize();
  updateCounters();
})();
