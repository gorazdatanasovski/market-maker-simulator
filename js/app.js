// ═══════════════════════════════════════════════════════════════
//  LOB SIMULATOR — Phase XIII / XIV / XV
//  Avellaneda-Stoikov · Volterra Kernel · Whisper Aesthetic
// ═══════════════════════════════════════════════════════════════

const orderBook = { bids: [], asks: [] };
const domNodes = [];
const VISIBLE_ROWS = 25;
const BLOCK_THRESHOLD = 400;

// ── User State ────────────────────────────────────────────────
const userState = {
    inventory: 0,
    avgPrice: 0.0,
    realizedPnL: 0.0,
    spreadCapture: 0.0,
    adverseSelection: 0.0
};

// ── Algo State ────────────────────────────────────────────────
let algoState = {
    active: true, // Boot active
    clipBase: 100,
    clipLive: 100,
    gamma: 0.1,
    k: 5.0,       // Calibrated arrival rate for δ ∈ [0.10, 0.50]
    activeBid: null,
    activeAsk: null
};

// ── Telemetry ─────────────────────────────────────────────────
let LTP = 100.00;
let prevBestBid = { price: 99.99, volume: 400 };
let prevBestAsk = { price: 100.01, volume: 400 };
let ofiHistory = [];
let priceHistory = [];
let currentRollingOFI = 0;
let currentHurst = 0.50;
let currentVariance = 0.0001;
let currentSigmaBps = 10;
let currentVPIN = 0.30;

// Kyle's Lambda
let lambdaWindow = [];
let currentTickBuyVol = 0;
let currentTickSellVol = 0;

// VPIN
let vpinBuckets = [];
const VPIN_BUCKET_SIZE = 200;
let vpinAccumulator = { buyVol: 0, sellVol: 0, totalVol: 0 };

// Tape
let lastTapePrice = 0;

// Fill Log with adverse detection
let fillLog = [];
let pendingAdverseChecks = [];

// Chart data (240 points = 60s @ 250ms)
let chartData = {
    spreadCapture: [],
    adverseSelection: [],
    inventory: [],
    reservationPrice: []
};
let chartFrameCount = 0;

// Stochastic engine
const SIMULATION_INTERVAL = 250;
let buyProbability = 0.5;
let simInterval = null;
let pendingSweep = { side: null, size: 0 };
const mutatedLevels = { bids: new Set(), asks: new Set() };

// ═══════════════════════════════════════════════════════════════
//  INITIALIZATION
// ═══════════════════════════════════════════════════════════════

function initOrderBook() {
    LTP = 100.00;
    enforceBookBounds();
    prevBestBid = { price: orderBook.bids[0].price, volume: orderBook.bids[0].volume };
    prevBestAsk = { price: orderBook.asks[0].price, volume: orderBook.asks[0].volume };
}

function enforceBookBounds() {
    const V0 = 400;
    const kappa = 0.05;

    // OFI skew: if OFI positive → more bid liquidity, less ask liquidity
    let bidSkew = 1.0, askSkew = 1.0;
    if (currentRollingOFI > 0.1) {
        bidSkew = 1.0 + Math.min(0.4, currentRollingOFI);
        askSkew = 1.0 - Math.min(0.3, currentRollingOFI * 0.75);
    } else if (currentRollingOFI < -0.1) {
        askSkew = 1.0 + Math.min(0.4, Math.abs(currentRollingOFI));
        bidSkew = 1.0 - Math.min(0.3, Math.abs(currentRollingOFI) * 0.75);
    }

    let newAsks = [];
    for (let i = 1; i <= 100; i++) {
        let p = Math.round((LTP + (i * 0.01)) * 100) / 100;
        let existing = orderBook.asks.find(a => a.price === p);
        if (existing) {
            newAsks.push(existing);
        } else {
            let epsilon = Math.floor(Math.random() * 50);
            let vol = Math.floor((V0 * Math.exp(-kappa * i) + epsilon) * askSkew);
            newAsks.push({ price: p, volume: Math.max(1, vol), userVolume: 0 });
        }
    }
    for (const ask of orderBook.asks) {
        if (ask.userVolume > 0 && !newAsks.some(a => a.price === ask.price)) newAsks.push(ask);
    }

    let newBids = [];
    for (let i = 1; i <= 100; i++) {
        let p = Math.round((LTP - (i * 0.01)) * 100) / 100;
        let existing = orderBook.bids.find(b => b.price === p);
        if (existing) {
            newBids.push(existing);
        } else {
            let epsilon = Math.floor(Math.random() * 50);
            let vol = Math.floor((V0 * Math.exp(-kappa * i) + epsilon) * bidSkew);
            newBids.push({ price: p, volume: Math.max(1, vol), userVolume: 0 });
        }
    }
    for (const bid of orderBook.bids) {
        if (bid.userVolume > 0 && !newBids.some(b => b.price === bid.price)) newBids.push(bid);
    }

    newAsks.sort((a, b) => a.price - b.price);
    newBids.sort((a, b) => b.price - a.price);
    orderBook.asks = newAsks;
    orderBook.bids = newBids;
}

// ═══════════════════════════════════════════════════════════════
//  DOM CONSTRUCTION
// ═══════════════════════════════════════════════════════════════

function buildDOM() {
    const grid = document.getElementById('lob-grid');
    grid.innerHTML = '';
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < VISIBLE_ROWS; i++) {
        const bidVolEl = document.createElement('div');
        bidVolEl.className = 'cell bid-vol empty-vol';
        const priceEl = document.createElement('div');
        priceEl.className = 'cell price empty-level';
        const askVolEl = document.createElement('div');
        askVolEl.className = 'cell ask-vol empty-vol';
        const priceElText = document.createElement('span');
        priceEl.appendChild(priceElText);
        fragment.appendChild(bidVolEl);
        fragment.appendChild(priceEl);
        fragment.appendChild(askVolEl);
        domNodes.push({ bidVolEl, priceEl, priceElText, askVolEl, lastPrice: null, lastAskVol: null, lastBidVol: null, lastPriceClass: null });
    }
    grid.appendChild(fragment);
}

function triggerFlash(element) {
    if (element.flashTimeout) clearTimeout(element.flashTimeout);
    element.classList.remove('flash-active');
    void element.offsetWidth;
    element.classList.add('flash-active');
    element.flashTimeout = setTimeout(() => element.classList.remove('flash-active'), 100);
}

// ═══════════════════════════════════════════════════════════════
//  RENDER LOOP (60 FPS)
// ═══════════════════════════════════════════════════════════════

function renderDelta() {
    if (orderBook.asks.length === 0 || orderBook.bids.length === 0) {
        requestAnimationFrame(renderDelta);
        return;
    }

    const topPrice = Math.round((LTP + 0.12) * 100) / 100;

    const askMap = new Map();
    for (const ask of orderBook.asks) askMap.set(ask.price, ask);
    const bidMap = new Map();
    for (const bid of orderBook.bids) bidMap.set(bid.price, bid);

    let maxVol = 1;
    for (let i = 0; i < VISIBLE_ROWS; i++) {
        const rp = Math.round((topPrice - (i * 0.01)) * 100) / 100;
        const a = askMap.get(rp), b = bidMap.get(rp);
        if (a && a.volume > maxVol) maxVol = a.volume;
        if (b && b.volume > maxVol) maxVol = b.volume;
    }

    for (let i = 0; i < VISIBLE_ROWS; i++) {
        const rowPrice = Math.round((topPrice - (i * 0.01)) * 100) / 100;
        const node = domNodes[i];
        const ask = askMap.get(rowPrice);
        const bid = bidMap.get(rowPrice);

        if (node.lastPrice !== rowPrice) {
            node.priceElText.textContent = rowPrice.toFixed(2);
            node.lastPrice = rowPrice;
        }

        let priceClass = 'empty-level';
        if (ask) priceClass = 'ask-level';
        else if (bid) priceClass = 'bid-level';
        if (node.lastPriceClass !== priceClass) {
            node.priceEl.className = 'cell price ' + priceClass;
            node.lastPriceClass = priceClass;
        }

        let newAskVol = ask ? (ask.volume + (ask.userVolume > 0 ? ` (*${ask.userVolume})` : '')) : '-';
        if (node.lastAskVol !== newAskVol) {
            node.askVolEl.textContent = newAskVol;
            node.lastAskVol = newAskVol;
            node.askVolEl.className = newAskVol === '-' ? 'cell ask-vol empty-vol' : 'cell ask-vol';
        }
        if (mutatedLevels.asks.has(rowPrice) && newAskVol !== '-') triggerFlash(node.askVolEl);

        let newBidVol = bid ? (bid.volume + (bid.userVolume > 0 ? ` (*${bid.userVolume})` : '')) : '-';
        if (node.lastBidVol !== newBidVol) {
            node.bidVolEl.textContent = newBidVol;
            node.lastBidVol = newBidVol;
            node.bidVolEl.className = newBidVol === '-' ? 'cell bid-vol empty-vol' : 'cell bid-vol';
        }
        if (mutatedLevels.bids.has(rowPrice) && newBidVol !== '-') triggerFlash(node.bidVolEl);

        // Depth histogram bars at 15% opacity using #3A5068
        let askPct = ask ? Math.min(100, Math.round((ask.volume / maxVol) * 100)) : 0;
        let bidPct = bid ? Math.min(100, Math.round((bid.volume / maxVol) * 100)) : 0;
        node.askVolEl.style.background = `linear-gradient(to right, rgba(58, 80, 104, 0.15) ${askPct}%, transparent ${askPct}%)`;
        node.bidVolEl.style.background = `linear-gradient(to left, rgba(58, 80, 104, 0.15) ${bidPct}%, transparent ${bidPct}%)`;
    }

    mutatedLevels.asks.clear();
    mutatedLevels.bids.clear();

    updateStatsDOM();
    computeTheoreticalState();

    // Chart update every ~500ms (30 frames)
    chartFrameCount++;
    if (chartFrameCount >= 30) {
        chartFrameCount = 0;
        sampleChartData();
        renderAllCharts();
    }

    requestAnimationFrame(renderDelta);
}

// ═══════════════════════════════════════════════════════════════
//  STATS DOM
// ═══════════════════════════════════════════════════════════════

function updateStatsDOM() {
    if (orderBook.asks.length === 0 || orderBook.bids.length === 0) return;

    const bestBid = orderBook.bids[0].price;
    const bestAsk = orderBook.asks[0].price;

    let uPnl = 0;
    if (userState.inventory > 0) uPnl = (bestBid - userState.avgPrice) * userState.inventory;
    else if (userState.inventory < 0) uPnl = (userState.avgPrice - bestAsk) * Math.abs(userState.inventory);

    let totalPnL = userState.realizedPnL + uPnl;
    userState.adverseSelection = totalPnL - userState.spreadCapture;

    const spreadEl = document.getElementById('spread-pnl');
    spreadEl.textContent = `${userState.spreadCapture >= 0 ? '+' : '-'}$${Math.abs(userState.spreadCapture).toFixed(2)}`;
    spreadEl.className = 'stat-val' + (userState.spreadCapture > 0.01 ? ' profit' : (userState.spreadCapture < -0.01 ? ' loss' : ''));

    const advEl = document.getElementById('adv-select');
    advEl.textContent = `${userState.adverseSelection >= 0 ? '+' : '-'}$${Math.abs(userState.adverseSelection).toFixed(2)}`;
    advEl.className = 'stat-val' + (userState.adverseSelection > 0.01 ? ' profit' : (userState.adverseSelection < -0.01 ? ' loss' : ''));

    document.getElementById('inventory').textContent = userState.inventory;
    document.getElementById('avg-px').textContent = userState.avgPrice.toFixed(2);
}

// ═══════════════════════════════════════════════════════════════
//  AVELLANEDA-STOIKOV (Always Live)
// ═══════════════════════════════════════════════════════════════

function computeTheoreticalState() {
    if (orderBook.asks.length === 0 || orderBook.bids.length === 0) return;

    const bestAsk = orderBook.asks[0].price;
    const bestBid = orderBook.bids[0].price;
    const midPrice = (bestAsk + bestBid) / 2;

    const sigma_decimal = currentSigmaBps / 10000;
    const q = userState.inventory;

    // r(s,t) = s - q × γ × σ² × (T-t)
    const r = midPrice - (q * algoState.gamma * sigma_decimal * sigma_decimal * 1);

    // δ = (γ × σ² × (T-t))/2  +  (1/γ) × ln(1 + γ/k)
    let delta = (algoState.gamma * sigma_decimal * sigma_decimal * 1) / 2
              + (1 / algoState.gamma) * Math.log(1 + algoState.gamma / algoState.k);

    // Hurst regime multiplier
    if (currentHurst > 0.55) delta *= 2.5;
    else if (currentHurst < 0.45) delta *= 0.75;

    // VPIN circuit breaker: exponential widening above 0.75
    if (currentVPIN > 0.75) {
        delta *= Math.exp(10 * (currentVPIN - 0.75));
    }

    // Dynamic clip: Q_clip = floor( Q_base / (1 + α_damp × σ_bps) )
    const alphaDamp = 0.02;
    algoState.clipLive = Math.max(1, Math.floor(algoState.clipBase / (1 + alphaDamp * currentSigmaBps)));

    let targetBidPrice = Math.round((r - delta / 2) * 100) / 100;
    let targetAskPrice = Math.round((r + delta / 2) * 100) / 100;

    // Prevent crossing
    targetBidPrice = Math.min(targetBidPrice, Math.round((bestAsk - 0.01) * 100) / 100);
    targetAskPrice = Math.max(targetAskPrice, Math.round((bestBid + 0.01) * 100) / 100);

    // Always display theoretical state
    document.getElementById('stat-r').textContent = r.toFixed(3);
    document.getElementById('stat-delta').textContent = delta.toFixed(4);
    document.getElementById('stat-bid').textContent = targetBidPrice.toFixed(2);
    document.getElementById('stat-ask').textContent = targetAskPrice.toFixed(2);
    document.getElementById('stat-clip').textContent = algoState.clipLive;

    // Only inject orders if active
    if (!algoState.active) return;

    // VPIN extreme toxicity: pull quotes entirely
    if (currentVPIN > 0.78) {
        cancelUserOrders();
        return;
    }

    let currentBidVol = 0, currentAskVol = 0;
    if (algoState.activeBid) {
        const b = orderBook.bids.find(l => l.price === algoState.activeBid.price);
        if (b) currentBidVol = b.userVolume;
    }
    if (algoState.activeAsk) {
        const a = orderBook.asks.find(l => l.price === algoState.activeAsk.price);
        if (a) currentAskVol = a.userVolume;
    }

    const needNew = (!algoState.activeBid || algoState.activeBid.price !== targetBidPrice || currentBidVol !== algoState.clipLive)
                 || (!algoState.activeAsk || algoState.activeAsk.price !== targetAskPrice || currentAskVol !== algoState.clipLive);

    if (needNew) {
        cancelUserOrders();
        insertLimitOrder('bids', targetBidPrice, algoState.clipLive);
        algoState.activeBid = { price: targetBidPrice, size: algoState.clipLive };
        insertLimitOrder('asks', targetAskPrice, algoState.clipLive);
        algoState.activeAsk = { price: targetAskPrice, size: algoState.clipLive };
        if (typeof quotesPlaced !== 'undefined') quotesPlaced += 2;
    }
}

// ═══════════════════════════════════════════════════════════════
//  TELEMETRY ENGINE
// ═══════════════════════════════════════════════════════════════

function calculateTelemetry() {
    if (orderBook.asks.length === 0 || orderBook.bids.length === 0) return;

    const bestBid = orderBook.bids[0];
    const bestAsk = orderBook.asks[0];
    const midPrice = (bestAsk.price + bestBid.price) / 2;

    // ── OFI ──────────────────────────────────────────────
    let vBid = 0; orderBook.bids.forEach(b => vBid += b.volume);
    let vAsk = 0; orderBook.asks.forEach(a => vAsk += a.volume);
    const currentOFI = (vBid - vAsk) / (vBid + vAsk);
    ofiHistory.push(currentOFI);
    if (ofiHistory.length > 20) ofiHistory.shift();
    currentRollingOFI = ofiHistory.reduce((a, b) => a + b, 0) / ofiHistory.length;

    const ofiEl = document.getElementById('ofi-val');
    ofiEl.textContent = currentRollingOFI > 0 ? `+${currentRollingOFI.toFixed(3)}` : `${currentRollingOFI.toFixed(3)}`;
    ofiEl.className = 'telem-val' + (currentRollingOFI > 0.2 ? ' profit' : (currentRollingOFI < -0.2 ? ' loss' : ''));

    prevBestBid = { price: bestBid.price, volume: bestBid.volume };
    prevBestAsk = { price: bestAsk.price, volume: bestAsk.volume };

    // ── Volatility (clamped [5, 30] bps) ─────────────────
    priceHistory.push(midPrice);
    if (priceHistory.length > 240) priceHistory.shift();

    if (priceHistory.length > 10) {
        let returns = [];
        for (let i = 1; i < priceHistory.length; i++) {
            returns.push((priceHistory[i] - priceHistory[i - 1]) / priceHistory[i - 1]);
        }
        let mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        let rawVar = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
        let rawBps = Math.sqrt(rawVar) * 10000;
        currentSigmaBps = Math.max(5, Math.min(30, rawBps));
        currentVariance = Math.pow(currentSigmaBps / 10000, 2);
        document.getElementById('vol-val').textContent = `${currentSigmaBps.toFixed(1)} bps`;

        // ── Hurst (displacement/path, clamped [0.40, 0.65]) ──
        let disp = Math.abs(priceHistory[priceHistory.length - 1] - priceHistory[0]);
        let pathLen = 0;
        for (let i = 1; i < priceHistory.length; i++) pathLen += Math.abs(priceHistory[i] - priceHistory[i - 1]);
        let ratio = pathLen > 0 ? disp / pathLen : 0;
        currentHurst = Math.max(0.40, Math.min(0.65, 0.30 + ratio * 0.60));
        document.getElementById('hurst-val').textContent = currentHurst.toFixed(2);

        // Regime dot
        const dot = document.getElementById('regime-dot');
        if (currentHurst > 0.55) dot.style.backgroundColor = '#8B5C5C';
        else if (currentHurst < 0.45) dot.style.backgroundColor = '#7B9E87';
        else dot.style.backgroundColor = '#6B6B6B';
    }

    // ── Kyle's Lambda ────────────────────────────────────
    let netVol = currentTickBuyVol - currentTickSellVol;
    lambdaWindow.push({ price: midPrice, netVol });
    if (lambdaWindow.length > 100) lambdaWindow.shift();
    let deltaP = lambdaWindow[lambdaWindow.length - 1].price - lambdaWindow[0].price;
    let sumVol = lambdaWindow.reduce((a, b) => a + b.netVol, 0);
    let lambda = sumVol === 0 ? 0 : Math.abs(deltaP / sumVol);
    document.getElementById('lambda-val').textContent = lambda.toFixed(6);

    // ── VPIN (clamped [0.30, 0.80]) ──────────────────────
    vpinAccumulator.buyVol += currentTickBuyVol;
    vpinAccumulator.sellVol += currentTickSellVol;
    vpinAccumulator.totalVol += (currentTickBuyVol + currentTickSellVol);

    if (vpinAccumulator.totalVol >= VPIN_BUCKET_SIZE) {
        vpinBuckets.push({
            imbalance: Math.abs(vpinAccumulator.buyVol - vpinAccumulator.sellVol),
            total: vpinAccumulator.totalVol
        });
        if (vpinBuckets.length > 50) vpinBuckets.shift();
        vpinAccumulator = { buyVol: 0, sellVol: 0, totalVol: 0 };
    }

    if (vpinBuckets.length > 0) {
        let sumImb = vpinBuckets.reduce((a, b) => a + b.imbalance, 0);
        let sumTot = vpinBuckets.reduce((a, b) => a + b.total, 0);
        let rawVpin = sumTot > 0 ? sumImb / sumTot : 0;
        currentVPIN = Math.max(0.30, Math.min(0.80, rawVpin));
        const vpinEl = document.getElementById('vpin-val');
        vpinEl.textContent = currentVPIN.toFixed(3);
        vpinEl.className = 'telem-val' + (currentVPIN > 0.60 ? ' loss' : '');
    }

    // ── Adverse fill detection ───────────────────────────
    checkAdverseFills(midPrice);

    currentTickBuyVol = 0;
    currentTickSellVol = 0;
}

// ═══════════════════════════════════════════════════════════════
//  TAPE
// ═══════════════════════════════════════════════════════════════

function logToTape(side, size, price) {
    const feed = document.getElementById('tape-feed');
    const row = document.createElement('div');

    // Uptick / downtick / block coloring
    let rowClass = 'tape-row';
    if (size >= BLOCK_THRESHOLD) {
        rowClass += side === 'BUY' ? ' tape-block-buy' : ' tape-block-sell';
    } else if (lastTapePrice > 0) {
        if (price > lastTapePrice) rowClass += ' tape-uptick';
        else if (price < lastTapePrice) rowClass += ' tape-downtick';
    }
    lastTapePrice = price;
    row.className = rowClass;

    const d = new Date();
    const ts = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0').slice(0, 2)}`;
    row.innerHTML = `<div>${ts}</div><div>${size}</div><div>${price.toFixed(2)}</div>`;
    feed.prepend(row);
    if (feed.children.length > 60) feed.lastChild.remove();
}

// ═══════════════════════════════════════════════════════════════
//  FILL LOG & ADVERSE DETECTION
// ═══════════════════════════════════════════════════════════════

function recordUserFill(side, size, price) {
    if (orderBook.asks.length === 0 || orderBook.bids.length === 0) return;
    const mid = (orderBook.asks[0].price + orderBook.bids[0].price) / 2;
    const d = new Date();
    const ts = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;

    const entry = { time: ts, side, size, price, adverse: null, midAtFill: mid };
    fillLog.unshift(entry);
    if (fillLog.length > 10) fillLog.pop();

    pendingAdverseChecks.push(entry);
    renderFillLog();
}

function checkAdverseFills(currentMid) {
    for (let i = pendingAdverseChecks.length - 1; i >= 0; i--) {
        const fill = pendingAdverseChecks[i];
        // Fill was BUY (we bought) → adverse if mid dropped >1 tick
        if (fill.side === 'BUY' && currentMid < fill.midAtFill - 0.01) fill.adverse = true;
        // Fill was SELL (we sold) → adverse if mid rose >1 tick
        else if (fill.side === 'SELL' && currentMid > fill.midAtFill + 0.01) fill.adverse = true;
        else fill.adverse = false;
        pendingAdverseChecks.splice(i, 1);
    }
    if (pendingAdverseChecks.length === 0 && fillLog.length > 0) renderFillLog();
}

function renderFillLog() {
    const tbody = document.getElementById('fill-log-body');
    tbody.innerHTML = '';
    
    if (fillLog.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="5" style="text-align: center; color: #A0A0A0; padding: 20px 0;">[ Awaiting data ]</td>`;
        tbody.appendChild(tr);
        return;
    }

    fillLog.forEach(f => {
        const tr = document.createElement('tr');
        tr.className = `fill-${f.side.toLowerCase()}${f.adverse ? ' fill-adverse' : ''}`;
        tr.innerHTML = `<td>${f.time}</td><td>${f.side}</td><td>${f.size}</td><td>${f.price.toFixed(2)}</td><td>${f.adverse ? '⚠' : ''}</td>`;
        tbody.appendChild(tr);
    });
}

// ═══════════════════════════════════════════════════════════════
//  USER TRADE EXECUTION & PnL
// ═══════════════════════════════════════════════════════════════

function executeUserTrade(side, execVolume, execPrice) {
    if (execVolume <= 0) return;

    const bestAsk = orderBook.asks.length > 0 ? orderBook.asks[0].price : execPrice;
    const bestBid = orderBook.bids.length > 0 ? orderBook.bids[0].price : execPrice;
    const midPrice = (bestAsk + bestBid) / 2;

    // Spread capture: edge from passive fill relative to mid
    if (side === 'BUY') userState.spreadCapture += (midPrice - execPrice) * execVolume;
    else userState.spreadCapture += (execPrice - midPrice) * execVolume;

    // Record fill for the log
    recordUserFill(side, execVolume, execPrice);
    if (typeof fillsReceived !== 'undefined') fillsReceived += 1;

    // Inventory & avg price
    if (side === 'BUY') {
        if (userState.inventory >= 0) {
            const tv = (userState.avgPrice * userState.inventory) + (execPrice * execVolume);
            userState.inventory += execVolume;
            userState.avgPrice = tv / userState.inventory;
        } else {
            const closing = Math.min(execVolume, Math.abs(userState.inventory));
            userState.realizedPnL += (userState.avgPrice - execPrice) * closing;
            if (execVolume <= Math.abs(userState.inventory)) {
                userState.inventory += execVolume;
                if (userState.inventory === 0) userState.avgPrice = 0;
            } else {
                userState.inventory = execVolume - closing;
                userState.avgPrice = execPrice;
            }
        }
    } else {
        if (userState.inventory <= 0) {
            const tv = (userState.avgPrice * Math.abs(userState.inventory)) + (execPrice * execVolume);
            userState.inventory -= execVolume;
            userState.avgPrice = tv / Math.abs(userState.inventory);
        } else {
            const closing = Math.min(execVolume, userState.inventory);
            userState.realizedPnL += (execPrice - userState.avgPrice) * closing;
            if (execVolume <= userState.inventory) {
                userState.inventory -= execVolume;
                if (userState.inventory === 0) userState.avgPrice = 0;
            } else {
                userState.inventory = -(execVolume - closing);
                userState.avgPrice = execPrice;
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════
//  MATCHING ENGINE
// ═══════════════════════════════════════════════════════════════

function matchOrder(side, size) {
    let remaining = size;
    if (side === 'BUY') {
        currentTickBuyVol += size;
        while (remaining > 0 && orderBook.asks.length > 0) {
            const best = orderBook.asks[0];
            const consume = Math.min(remaining, best.volume);
            mutatedLevels.asks.add(best.price);
            if (best.userVolume > 0) {
                const uc = Math.min(consume, best.userVolume);
                executeUserTrade('SELL', uc, best.price);
                best.userVolume -= uc;
            }
            logToTape('BUY', consume, best.price);
            LTP = best.price;
            best.volume -= consume;
            remaining -= consume;
            if (best.volume <= 0) orderBook.asks.shift();
        }
    } else {
        currentTickSellVol += size;
        while (remaining > 0 && orderBook.bids.length > 0) {
            const best = orderBook.bids[0];
            const consume = Math.min(remaining, best.volume);
            mutatedLevels.bids.add(best.price);
            if (best.userVolume > 0) {
                const uc = Math.min(consume, best.userVolume);
                executeUserTrade('BUY', uc, best.price);
                best.userVolume -= uc;
            }
            logToTape('SELL', consume, best.price);
            LTP = best.price;
            best.volume -= consume;
            remaining -= consume;
            if (best.volume <= 0) orderBook.bids.shift();
        }
    }
}

// ═══════════════════════════════════════════════════════════════
//  ORDER MANAGEMENT
// ═══════════════════════════════════════════════════════════════

function removeLimitOrder(side, price, size) {
    const book = side === 'bids' ? orderBook.bids : orderBook.asks;
    for (let i = 0; i < book.length; i++) {
        if (book[i].price === price) {
            book[i].volume -= size;
            book[i].userVolume -= size;
            mutatedLevels[side].add(price);
            if (book[i].volume <= 0) book.splice(i, 1);
            break;
        }
    }
}

function insertLimitOrder(side, price, size) {
    const book = side === 'bids' ? orderBook.bids : orderBook.asks;
    for (let i = 0; i < book.length; i++) {
        if (book[i].price === price) {
            book[i].volume += size;
            book[i].userVolume += size;
            mutatedLevels[side].add(price);
            return;
        }
    }
    let idx = 0;
    if (side === 'bids') { while (idx < book.length && book[idx].price > price) idx++; }
    else { while (idx < book.length && book[idx].price < price) idx++; }
    book.splice(idx, 0, { price, volume: size, userVolume: size });
    mutatedLevels[side].add(price);
}

function cancelUserOrders() {
    if (algoState.activeBid) {
        const lvl = orderBook.bids.find(b => b.price === algoState.activeBid.price);
        if (lvl && lvl.userVolume > 0) removeLimitOrder('bids', algoState.activeBid.price, lvl.userVolume);
        algoState.activeBid = null;
    }
    if (algoState.activeAsk) {
        const lvl = orderBook.asks.find(a => a.price === algoState.activeAsk.price);
        if (lvl && lvl.userVolume > 0) removeLimitOrder('asks', algoState.activeAsk.price, lvl.userVolume);
        algoState.activeAsk = null;
    }
}

function pullAllQuotes() {
    algoState.active = false;
    const btn = document.getElementById('btn-master');
    btn.innerHTML = '<span class="indicator"></span> System offline';
    btn.className = 'btn btn-master offline';
    cancelUserOrders();
}

function flattenInventory() {
    if (userState.inventory === 0) return;
    pullAllQuotes();
    let remaining = Math.abs(userState.inventory);
    const isLong = userState.inventory > 0;
    if (isLong) {
        while (remaining > 0 && orderBook.bids.length > 0) {
            const b = orderBook.bids[0];
            const c = Math.min(remaining, b.volume);
            executeUserTrade('SELL', c, b.price);
            b.volume -= c; remaining -= c;
            mutatedLevels.bids.add(b.price);
            logToTape('SELL', c, b.price);
            LTP = b.price;
            if (b.volume <= 0) orderBook.bids.shift();
        }
    } else {
        while (remaining > 0 && orderBook.asks.length > 0) {
            const a = orderBook.asks[0];
            const c = Math.min(remaining, a.volume);
            executeUserTrade('BUY', c, a.price);
            a.volume -= c; remaining -= c;
            mutatedLevels.asks.add(a.price);
            logToTape('BUY', c, a.price);
            LTP = a.price;
            if (a.volume <= 0) orderBook.asks.shift();
        }
    }
    enforceBookBounds();
}

// ═══════════════════════════════════════════════════════════════
//  STOCHASTIC ENGINE (OFI-Synchronized Hawkes)
// ═══════════════════════════════════════════════════════════════

function simulateMarketFlow() {
    let side, size;

    if (pendingSweep.size > 0) {
        side = pendingSweep.side;
        size = pendingSweep.size;
        pendingSweep.size = 0;
    } else {
        // OFI-synchronized: OFI biases direction so tape validates OFI
        let prob = buyProbability;
        if (currentRollingOFI > 0) prob += Math.min(0.35, currentRollingOFI * 0.0005);
        else if (currentRollingOFI < 0) prob -= Math.min(0.35, Math.abs(currentRollingOFI) * 0.0005);
        prob = Math.max(0.05, Math.min(0.95, prob));

        const isBuy = Math.random() < prob;
        if (isBuy) buyProbability = Math.min(buyProbability + 0.10, 0.80);
        else buyProbability = Math.max(buyProbability - 0.10, 0.20);
        buyProbability = (buyProbability * 0.92) + (0.5 * 0.08);

        side = isBuy ? 'BUY' : 'SELL';
        size = Math.floor(Math.random() * 200) + 30;
        if (Math.random() < 0.05) size += Math.floor(Math.random() * 800) + 300;
    }

    // 10-tick circuit breaker
    let liq = 0;
    if (side === 'BUY') {
        const cap = orderBook.asks[0].price + 0.10;
        for (const a of orderBook.asks) { if (a.price <= cap) liq += a.volume; else break; }
    } else {
        const cap = orderBook.bids[0].price - 0.10;
        for (const b of orderBook.bids) { if (b.price >= cap) liq += b.volume; else break; }
    }

    let execSize = size;
    if (size > liq) {
        execSize = liq;
        pendingSweep.side = side;
        pendingSweep.size = size - liq;
    }

    if (execSize > 0) matchOrder(side, execSize);

    enforceBookBounds();
    calculateTelemetry();
}

// ═══════════════════════════════════════════════════════════════
//  CHARTS
// ═══════════════════════════════════════════════════════════════

function sampleChartData() {
    chartData.spreadCapture.push(userState.spreadCapture);
    chartData.adverseSelection.push(userState.adverseSelection);
    chartData.inventory.push(userState.inventory);

    if (orderBook.asks.length > 0 && orderBook.bids.length > 0) {
        const mid = (orderBook.asks[0].price + orderBook.bids[0].price) / 2;
        const sigP = mid * (currentSigmaBps / 10000);
        const varP = sigP * sigP;
        const r = mid - (userState.inventory * algoState.gamma * varP);
        chartData.reservationPrice.push(r);
    } else {
        chartData.reservationPrice.push(LTP);
    }

    const maxLen = 120; // 60s at 500ms sampling
    if (chartData.spreadCapture.length > maxLen) chartData.spreadCapture.shift();
    if (chartData.adverseSelection.length > maxLen) chartData.adverseSelection.shift();
    if (chartData.inventory.length > maxLen) chartData.inventory.shift();
    if (chartData.reservationPrice.length > maxLen) chartData.reservationPrice.shift();
}

function renderLineChart(canvasId, datasets) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (datasets.length === 0 || datasets[0].data.length === 0) {
        ctx.fillStyle = '#A0A0A0';
        ctx.font = '11px "Inter", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('[ Awaiting data ]', w / 2, h / 2);
        return;
    }

    let min = Infinity, max = -Infinity;
    datasets.forEach(ds => ds.data.forEach(v => { if (v < min) min = v; if (v > max) max = v; }));
    if (min === max) { min -= 1; max += 1; }
    let pad = (max - min) * 0.1;
    min -= pad; max += pad;
    let range = max - min;

    // Grid
    ctx.strokeStyle = 'rgba(42, 42, 44, 0.6)';
    ctx.lineWidth = 0.5;
    for (let i = 1; i < 4; i++) {
        let y = (h / 4) * i;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    // Zero line
    if (min < 0 && max > 0) {
        let zy = h - ((0 - min) / range) * h;
        ctx.beginPath(); ctx.strokeStyle = 'rgba(160, 160, 160, 0.25)';
        ctx.setLineDash([2, 2]); ctx.moveTo(0, zy); ctx.lineTo(w, zy); ctx.stroke(); ctx.setLineDash([]);
    }

    // Lines
    datasets.forEach(ds => {
        if (ds.data.length < 2) return;
        ctx.beginPath();
        ctx.strokeStyle = ds.color;
        ctx.lineWidth = 1.2;
        ds.data.forEach((val, i) => {
            let x = (i / (ds.data.length - 1)) * w;
            let y = h - ((val - min) / range) * h;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
    });
}

let quotesPlaced = 0;
let fillsReceived = 0;

function renderQuoteToFillRatio() {
    const canvas = document.getElementById('chart-qtf');
    if (!canvas) return;
    
    if (!chartData.qtfRatio) chartData.qtfRatio = [];
    
    // Sample QTF
    let ratio = quotesPlaced > 0 ? (fillsReceived / quotesPlaced) : 0;
    chartData.qtfRatio.push(ratio);
    if (chartData.qtfRatio.length > 120) chartData.qtfRatio.shift();
    
    renderLineChart('chart-qtf', [
        { data: chartData.qtfRatio, color: '#7B9E87' }
    ]);
}

function renderAllCharts() {
    renderLineChart('chart-pnl', [
        { data: chartData.spreadCapture, color: '#7B9E87' },
        { data: chartData.adverseSelection, color: '#8B5C5C' }
    ]);
    renderLineChart('chart-inv', [
        { data: chartData.inventory, color: '#7B9E87' },
        { data: chartData.reservationPrice, color: '#6B6B6B' }
    ]);
    renderQuoteToFillRatio();
}

// ═══════════════════════════════════════════════════════════════
//  EVENT BINDING
// ═══════════════════════════════════════════════════════════════

function attachEvents() {
    document.getElementById('algo-gamma').addEventListener('change', e => {
        algoState.gamma = Math.max(0.01, parseFloat(e.target.value) || 0.1);
    });
    document.getElementById('algo-k').addEventListener('change', e => {
        algoState.k = Math.max(0.1, parseFloat(e.target.value) || 5.0);
    });
    document.getElementById('algo-clip').addEventListener('change', e => {
        algoState.clipBase = Math.max(1, parseInt(e.target.value) || 100);
    });

    document.getElementById('btn-master').addEventListener('click', () => {
        algoState.active = !algoState.active;
        const btn = document.getElementById('btn-master');
        if (algoState.active) {
            btn.innerHTML = '<span class="indicator"></span> System active';
            btn.className = 'btn btn-master active';
        } else {
            pullAllQuotes();
        }
    });

    document.getElementById('btn-kill').addEventListener('click', pullAllQuotes);
    document.getElementById('btn-flatten').addEventListener('click', flattenInventory);
}

// ═══════════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════════

// Poisson Engine - Execute every 1000ms when [SYSTEM: ACTIVE]
setInterval(() => {
    if (!algoState.active || !algoState.activeAsk || !algoState.activeBid) return;
    
    // Stochastic execution mapped to arrivalRate (k)
    if (Math.random() < algoState.k * 0.5) {
        const side = Math.random() < 0.5 ? 'BUY' : 'SELL';
        const fillSize = Math.floor(Math.random() * algoState.clipLive) + 1;
        
        if (side === 'BUY') {
            executeUserTrade('SELL', fillSize, algoState.activeAsk.price);
        } else {
            executeUserTrade('BUY', fillSize, algoState.activeBid.price);
        }
    }
}, 1000);

initOrderBook();
buildDOM();
renderFillLog(); // Render initial awaiting data
attachEvents();
requestAnimationFrame(renderDelta);
simInterval = setInterval(simulateMarketFlow, SIMULATION_INTERVAL);
