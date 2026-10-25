(() => {
  'use strict';

  const SEED_MODEL = {
    suppliers: [
      { id: 'atlas', name: 'Atlas Components', shortName: 'Atlas', location: 'Austin', capacity: 98, color: '#7188d0' },
      { id: 'harbor', name: 'Harbor Supply', shortName: 'Harbor', location: 'Chicago', capacity: 94, color: '#62a484' },
      { id: 'summit', name: 'Summit Works', shortName: 'Summit', location: 'Denver', capacity: 78, color: '#dda05f' }
    ],
    regions: [
      { id: 'austin', name: 'Austin', monogram: 'AT', demand: 82, shortageWeight: 1.00 },
      { id: 'chicago', name: 'Chicago', monogram: 'CH', demand: 68, shortageWeight: 1.13 },
      { id: 'denver', name: 'Denver', monogram: 'DE', demand: 61, shortageWeight: 0.94 },
      { id: 'newark', name: 'Newark', monogram: 'NW', demand: 70, shortageWeight: 1.18 }
    ],
    costs: {
      atlas: { austin: 8, chicago: 20, denver: 14, newark: 29 },
      harbor: { austin: 22, chicago: 9, denver: 17, newark: 13 },
      summit: { austin: 18, chicago: 19, denver: 8, newark: 21 }
    }
  };

  const PRESETS = [
    { id: 'baseline', name: 'Baseline', description: 'A balanced view of current supply and demand.', icon: 'baseline', priority: 76, portDelay: false, demandSurge: false },
    { id: 'service', name: 'Service first', description: 'Lean toward protecting customer fill, even if freight rises.', icon: 'service', priority: 96, portDelay: false, demandSurge: false },
    { id: 'cost', name: 'Cost first', description: 'Favor lower freight and accept more unfilled demand.', icon: 'cost', priority: 22, portDelay: false, demandSurge: false },
    { id: 'harbor', name: 'Harbor delay', description: 'Reduce Harbor capacity and increase its lane costs.', icon: 'harbor', priority: 82, portDelay: true, demandSurge: false },
    { id: 'surge', name: 'Demand spike', description: 'Test a 12% order increase across every region.', icon: 'surge', priority: 88, portDelay: false, demandSurge: true }
  ];

  const cloneModel = (value) => JSON.parse(JSON.stringify(value));

  const state = {
    model: cloneModel(SEED_MODEL),
    priority: 76,
    portDelay: false,
    demandSurge: false,
    scenarioName: 'Baseline',
    result: null,
    dirty: true,
    expandedRegion: null,
    aiConfig: null,
    aiHistory: [],
    isSending: false,
    savedScenarios: []
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const byId = (id) => document.getElementById(id);
  const fmt = (value) => Number(value || 0).toLocaleString('en-US');
  const money = (value) => `$${Math.round(Number(value || 0)).toLocaleString('en-US')}`;
  const percent = (value, digits = 1) => `${Number(value || 0).toFixed(digits)}%`;
  const safeText = (value) => String(value ?? '').trim();

  function getEffectiveInputs() {
    const suppliers = state.model.suppliers.map((supplier) => ({
      ...supplier,
      effectiveCapacity: Math.max(0, supplier.capacity - (state.portDelay && supplier.id === 'harbor' ? 36 : 0))
    }));
    const regions = state.model.regions.map((region) => ({
      ...region,
      effectiveDemand: Math.ceil(region.demand * (state.demandSurge ? 1.12 : 1))
    }));
    const costs = {};
    for (const supplier of suppliers) {
      costs[supplier.id] = {};
      for (const region of regions) {
        const base = state.model.costs[supplier.id][region.id];
        costs[supplier.id][region.id] = Math.ceil(base * (state.portDelay && supplier.id === 'harbor' ? 1.15 : 1));
      }
    }
    return { suppliers, regions, costs };
  }

  function shortagePenalty(priority) {
    return Math.round(5 + Number(priority) * 0.52);
  }

  function addEdge(graph, from, to, capacity, cost) {
    const forward = { to, rev: graph[to].length, cap: capacity, initialCap: capacity, cost };
    const reverse = { to: from, rev: graph[from].length, cap: 0, initialCap: 0, cost: -cost };
    graph[from].push(forward);
    graph[to].push(reverse);
    return forward;
  }

  // Successive shortest augmenting paths with Bellman-Ford on the residual graph.
  // This small transportation network is solved exactly, with integer capacities and costs.
  function minCostFlow(graph, source, sink, targetFlow) {
    let flow = 0;
    let cost = 0;
    const nodeCount = graph.length;
    let iterations = 0;

    while (flow < targetFlow && iterations < 5000) {
      iterations += 1;
      const distance = Array(nodeCount).fill(Number.POSITIVE_INFINITY);
      const previousNode = Array(nodeCount).fill(-1);
      const previousEdge = Array(nodeCount).fill(-1);
      distance[source] = 0;

      for (let pass = 0; pass < nodeCount - 1; pass += 1) {
        let changed = false;
        for (let from = 0; from < nodeCount; from += 1) {
          if (!Number.isFinite(distance[from])) continue;
          for (let edgeIndex = 0; edgeIndex < graph[from].length; edgeIndex += 1) {
            const edge = graph[from][edgeIndex];
            if (edge.cap <= 0) continue;
            const candidate = distance[from] + edge.cost;
            if (candidate < distance[edge.to]) {
              distance[edge.to] = candidate;
              previousNode[edge.to] = from;
              previousEdge[edge.to] = edgeIndex;
              changed = true;
            }
          }
        }
        if (!changed) break;
      }

      if (previousNode[sink] < 0) break;
      let amount = targetFlow - flow;
      for (let node = sink; node !== source; node = previousNode[node]) {
        amount = Math.min(amount, graph[previousNode[node]][previousEdge[node]].cap);
      }
      if (!Number.isFinite(amount) || amount <= 0) break;

      for (let node = sink; node !== source; node = previousNode[node]) {
        const edge = graph[previousNode[node]][previousEdge[node]];
        edge.cap -= amount;
        graph[node][edge.rev].cap += amount;
      }
      flow += amount;
      cost += amount * distance[sink];
    }
    return { flow, cost };
  }

  function solveModel() {
    const inputs = getEffectiveInputs();
    const supplierCount = inputs.suppliers.length;
    const regionCount = inputs.regions.length;
    const source = 0;
    const firstSupplier = 1;
    const shortageNode = firstSupplier + supplierCount;
    const firstRegion = shortageNode + 1;
    const sink = firstRegion + regionCount;
    const graph = Array.from({ length: sink + 1 }, () => []);
    const totalDemand = inputs.regions.reduce((sum, region) => sum + region.effectiveDemand, 0);
    const totalSupply = inputs.suppliers.reduce((sum, supplier) => sum + supplier.effectiveCapacity, 0);
    const basePenalty = shortagePenalty(state.priority);
    const supplierEdges = new Map();
    const routeEdges = new Map();
    const shortageEdges = new Map();

    inputs.suppliers.forEach((supplier, index) => {
      const supplierNode = firstSupplier + index;
      addEdge(graph, source, supplierNode, supplier.effectiveCapacity, 0);
      supplierEdges.set(supplier.id, { node: supplierNode, capacity: supplier.effectiveCapacity });
      inputs.regions.forEach((region, regionIndex) => {
        const routeCapacity = Math.min(supplier.effectiveCapacity, region.effectiveDemand);
        const edge = addEdge(graph, supplierNode, firstRegion + regionIndex, routeCapacity, inputs.costs[supplier.id][region.id]);
        routeEdges.set(`${supplier.id}:${region.id}`, edge);
      });
    });

    addEdge(graph, source, shortageNode, totalDemand, 0);
    inputs.regions.forEach((region, index) => {
      const adjustedPenalty = Math.max(1, Math.round(basePenalty * region.shortageWeight));
      const edge = addEdge(graph, shortageNode, firstRegion + index, region.effectiveDemand, adjustedPenalty);
      shortageEdges.set(region.id, { edge, adjustedPenalty });
      addEdge(graph, firstRegion + index, sink, region.effectiveDemand, 0);
    });

    const flowResult = minCostFlow(graph, source, sink, totalDemand);
    const allocations = {};
    for (const supplier of inputs.suppliers) {
      allocations[supplier.id] = {};
      for (const region of inputs.regions) {
        const edge = routeEdges.get(`${supplier.id}:${region.id}`);
        allocations[supplier.id][region.id] = edge.initialCap - edge.cap;
      }
    }
    const unfilledByRegion = {};
    for (const region of inputs.regions) {
      const { edge, adjustedPenalty } = shortageEdges.get(region.id);
      unfilledByRegion[region.id] = { units: edge.initialCap - edge.cap, penalty: adjustedPenalty };
    }

    const regions = inputs.regions.map((region) => {
      const laneAllocations = inputs.suppliers.map((supplier) => ({
        supplierId: supplier.id,
        supplierName: supplier.name,
        shortName: supplier.shortName,
        color: supplier.color,
        units: allocations[supplier.id][region.id],
        unitCost: inputs.costs[supplier.id][region.id]
      }));
      const shipped = laneAllocations.reduce((sum, lane) => sum + lane.units, 0);
      const unfilled = unfilledByRegion[region.id].units;
      return {
        ...region,
        demand: region.effectiveDemand,
        shipped,
        unfilled,
        fillRate: region.effectiveDemand ? (shipped / region.effectiveDemand) * 100 : 100,
        penalty: unfilledByRegion[region.id].penalty,
        lanes: laneAllocations
      };
    });
    const shipped = regions.reduce((sum, region) => sum + region.shipped, 0);
    const unfilled = regions.reduce((sum, region) => sum + region.unfilled, 0);
    const totalFreight = regions.reduce((sum, region) => sum + region.lanes.reduce((subtotal, lane) => subtotal + lane.units * lane.unitCost, 0), 0);
    const totalPenalty = regions.reduce((sum, region) => sum + region.unfilled * region.penalty, 0);
    const usedBySupplier = {};
    for (const supplier of inputs.suppliers) {
      usedBySupplier[supplier.id] = Object.values(allocations[supplier.id]).reduce((sum, units) => sum + units, 0);
    }
    const capacityOkay = inputs.suppliers.every((supplier) => usedBySupplier[supplier.id] <= supplier.effectiveCapacity);
    const demandOkay = regions.every((region) => region.shipped + region.unfilled === region.demand);
    const routeOkay = regions.every((region) => region.lanes.every((lane) => lane.units >= 0 && Number.isInteger(lane.units)));
    const feasible = capacityOkay && demandOkay && routeOkay && flowResult.flow === totalDemand;

    return {
      inputs,
      regions,
      allocations,
      usedBySupplier,
      totalDemand,
      totalSupply,
      shipped,
      unfilled,
      unusedSupply: Math.max(0, totalSupply - shipped),
      fillRate: totalDemand ? (shipped / totalDemand) * 100 : 100,
      capacityUsedRate: totalSupply ? (shipped / totalSupply) * 100 : 0,
      freightSpend: totalFreight,
      avgFreight: shipped ? totalFreight / shipped : 0,
      penaltySpend: totalPenalty,
      objectiveValue: flowResult.cost,
      basePenalty,
      feasible,
      solverFlow: flowResult.flow
    };
  }

  function updateControlsUI() {
    const scenarioLabel = $('#baselineButton span');
    if (scenarioLabel) scenarioLabel.textContent = state.scenarioName;
    const priority = byId('servicePriority');
    priority.value = String(state.priority);
    byId('priorityValue').textContent = String(state.priority);
    const penalty = shortagePenalty(state.priority);
    byId('penaltyValue').textContent = money(penalty);
    priority.style.background = `linear-gradient(to right, #8aba75 0%, #8aba75 ${state.priority}%, #e2e9e3 ${state.priority}%, #e2e9e3 100%)`;
    byId('portToggle').setAttribute('aria-pressed', String(state.portDelay));
    byId('demandToggle').setAttribute('aria-pressed', String(state.demandSurge));
    const eventWords = [state.portDelay ? 'Harbor delay' : '', state.demandSurge ? 'demand spike' : ''].filter(Boolean);
    const condition = eventWords.length ? `Scenario: ${eventWords.join(' + ')}. ` : '';
    byId('objectiveSummary').textContent = `${condition}Minimize freight spend while balancing unfilled demand.`;
    if (state.result) updateInputSnapshot(state.result);
  }

  function markDirty() {
    state.dirty = true;
    state.scenarioName = 'Custom';
    byId('dirtyBadge').hidden = false;
    const status = byId('solverStatus');
    status.classList.add('is-dirty');
    const label = status.querySelector('span:last-child');
    if (label) label.textContent = 'Needs re-solve';
    updateControlsUI();
  }

  function setControlValues(values) {
    if (Number.isFinite(values.priority)) state.priority = Math.max(0, Math.min(100, Math.round(values.priority)));
    if (typeof values.portDelay === 'boolean') state.portDelay = values.portDelay;
    if (typeof values.demandSurge === 'boolean') state.demandSurge = values.demandSurge;
    updateControlsUI();
    markDirty();
  }

  function renderLegend() {
    const legend = byId('allocationLegend');
    legend.innerHTML = state.model.suppliers.map((supplier) => `<span class="legend-item"><span class="legend-swatch" style="background:${supplier.color}"></span>${supplier.shortName}</span>`).join('') + '<span class="legend-item"><span class="legend-swatch" style="background:#e8bb83"></span>Unfilled</span>';
  }

  function renderAllocation(result) {
    renderLegend();
    const list = byId('allocationList');
    list.innerHTML = result.regions.map((region) => {
      const demand = region.demand;
      const nonzero = region.lanes.filter((lane) => lane.units > 0);
      const segments = nonzero.map((lane) => {
        const width = demand ? (lane.units / demand) * 100 : 0;
        return `<span class="flow-segment" title="${lane.shortName}: ${lane.units} units" style="width:${width}%;background-color:${lane.color}"></span>`;
      }).join('');
      const unmetWidth = demand ? (region.unfilled / demand) * 100 : 0;
      const unmetSegment = region.unfilled ? `<span class="flow-segment unmet-segment" title="Unfilled: ${region.unfilled} units" style="width:${unmetWidth}%;background-color:#e8bb83"></span>` : '';
      const rate = region.fillRate;
      const lowFill = rate < 90 ? ' low-fill' : '';
      const laneDetails = region.lanes.filter((lane) => lane.units > 0).sort((a, b) => a.unitCost - b.unitCost).map((lane) => `<span class="route-detail"><strong>${lane.shortName}</strong> ${fmt(lane.units)} units · ${money(lane.unitCost)}/unit</span>`).join('');
      const gapDetails = region.unfilled ? `<span class="route-detail"><strong>Unfilled</strong> ${fmt(region.unfilled)} units · ${money(region.penalty)}/unit modeled penalty</span>` : '';
      const isExpanded = state.expandedRegion === region.id;
      return `<div class="allocation-entry">
        <div class="allocation-row">
          <button class="region-label" type="button" data-region="${region.id}" aria-expanded="${isExpanded}" aria-controls="details-${region.id}">
            <span class="region-monogram">${region.monogram}</span><span class="region-copy"><strong>${region.name}</strong><small>${fmt(demand)} unit demand</small></span>
          </button>
          <div class="flow-track" role="img" aria-label="${region.name}: ${fmt(region.shipped)} units shipped, ${fmt(region.unfilled)} unfilled">${segments}${unmetSegment}</div>
          <div class="region-amount"><strong>${fmt(region.shipped)}</strong><small>/ ${fmt(demand)}</small><span class="region-fill${lowFill}">${percent(rate, 0)}</span></div>
        </div>
        <div class="region-detail-toggle" id="details-${region.id}" ${isExpanded ? '' : 'hidden'}><span class="route-details">${laneDetails || '<span class="route-detail">No shipments on active lanes</span>'}${gapDetails}</span></div>
      </div>`;
    }).join('');
  }

  function renderMetrics(result) {
    byId('metricFill').textContent = percent(result.fillRate, 1);
    byId('metricShipped').textContent = `${fmt(result.shipped)} / ${fmt(result.totalDemand)} units shipped`;
    byId('metricFillCaption').textContent = result.fillRate >= 99.95 ? 'all requested volume' : 'of requested volume';
    byId('fillProgress').style.width = `${Math.min(100, result.fillRate)}%`;
    byId('metricSpend').textContent = money(result.freightSpend);
    byId('metricAvgCost').textContent = money(result.avgFreight);
    byId('metricUnfilled').textContent = `${fmt(result.unfilled)} ${result.unfilled === 1 ? 'unit' : 'units'}`;
    const unfilledPct = result.totalDemand ? (result.unfilled / result.totalDemand) * 100 : 0;
    byId('metricUnfilledPct').textContent = percent(unfilledPct, 1);
    byId('shortfallMessage').textContent = result.unfilled ? 'Review affected regions below' : 'All demand covered in this scenario';
    byId('metricCapacity').textContent = percent(result.capacityUsedRate, 1);
    byId('metricCapacityUnits').textContent = `${fmt(result.shipped)} / ${fmt(result.totalSupply)} units`;
    byId('unusedCapacity').textContent = result.unusedSupply ? `${fmt(result.unusedSupply)} units held back by cost priority` : 'All available supplier capacity allocated';
  }

  function explainResult(result) {
    const worst = [...result.regions].sort((a, b) => b.unfilled - a.unfilled)[0];
    const activeLanes = result.regions.flatMap((region) => region.lanes.map((lane) => ({ ...lane, regionName: region.name, regionId: region.id, penalty: region.penalty }))).filter((lane) => lane.units > 0).sort((a, b) => a.unitCost - b.unitCost);
    let intro;
    if (result.unfilled === 0) {
      intro = `The plan covers all ${fmt(result.totalDemand)} requested units at ${money(result.freightSpend)} in modeled freight. Unfilled-demand penalties do not bind in this scenario.`;
    } else if (result.unusedSupply > 0) {
      intro = `The plan ships ${fmt(result.shipped)} of ${fmt(result.totalDemand)} units. It holds back ${fmt(result.unusedSupply)} available units because the remaining lanes cost more than the selected shortage penalty at this cost-first setting.`;
    } else {
      intro = `The plan ships ${fmt(result.shipped)} of ${fmt(result.totalDemand)} units and uses all ${fmt(result.totalSupply)} available units. The remaining ${fmt(result.unfilled)} units reflect a real supply gap in the model, not a capacity violation.`;
    }
    const points = [];
    if (result.unfilled > 0 && worst) {
      points.push(`Largest gap: ${worst.name} has ${fmt(worst.unfilled)} unfilled units out of ${fmt(worst.demand)}. Its modeled shortage penalty is ${money(worst.penalty)} per unit.`);
    }
    if (activeLanes.length) {
      const low = activeLanes[0];
      points.push(`A lowest-cost active lane is ${low.shortName} → ${low.regionName} at ${money(low.unitCost)} per unit; route costs and supplier limits are both respected.`);
    }
    points.push(`Constraint check: every supplier stays within capacity, every region is accounted for, and no shipment is fractional.`);
    byId('explanationIntro').textContent = intro;
    byId('explanationPoints').replaceChildren(...points.map((text) => {
      const item = document.createElement('li');
      item.textContent = text;
      return item;
    }));
  }

  function updateInputSnapshot() {
    const inputs = getEffectiveInputs();
    const totalCapacity = inputs.suppliers.reduce((sum, supplier) => sum + supplier.effectiveCapacity, 0);
    const totalDemand = inputs.regions.reduce((sum, region) => sum + region.effectiveDemand, 0);
    const minCost = Math.min(...Object.values(inputs.costs).flatMap((lanes) => Object.values(lanes)));
    const maxCost = Math.max(...Object.values(inputs.costs).flatMap((lanes) => Object.values(lanes)));
    byId('sourceCapacity').textContent = `${fmt(totalCapacity)} available units · ${inputs.suppliers.length} suppliers`;
    byId('sourceDemand').textContent = `${fmt(totalDemand)} units · ${inputs.regions.length} regions`;
    const laneSmall = $('.lanes-source').parentElement.querySelector('.source-copy small');
    if (laneSmall) laneSmall.textContent = `${inputs.suppliers.length * inputs.regions.length} routes · ${money(minCost)}–${money(maxCost)} per unit`;
  }

  function runOptimization(showNotice = false) {
    state.result = solveModel();
    state.dirty = false;
    state.expandedRegion = null;
    byId('dirtyBadge').hidden = true;
    byId('solverStatus').classList.remove('is-dirty');
    const statusLabel = byId('solverStatus').querySelector('span:last-child');
    if (statusLabel) statusLabel.textContent = state.result.feasible ? 'Optimal' : 'Review model';
    byId('lastSolved').textContent = `Solved ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    byId('allocationSummary').textContent = `${fmt(state.result.shipped)} of ${fmt(state.result.totalDemand)} units shipped · ${money(state.result.freightSpend)} freight`;
    renderMetrics(state.result);
    renderAllocation(state.result);
    explainResult(state.result);
    updateControlsUI();
    updateInputSnapshot(state.result);
    if (showNotice) {
      toast(state.result.feasible ? 'Plan re-optimized · constraints verified' : 'Review model inputs before using this plan', !state.result.feasible);
    }
    return state.result;
  }

  function toast(message, warning = false) {
    const toastNode = document.createElement('div');
    toastNode.className = `toast${warning ? ' is-warning' : ''}`;
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = warning ? '!' : '✓';
    const text = document.createElement('span');
    text.textContent = message;
    toastNode.append(icon, text);
    byId('toastRegion').append(toastNode);
    window.setTimeout(() => toastNode.remove(), 3300);
  }

  function applyPreset(preset) {
    if (preset.model) state.model = cloneModel(preset.model);
    setControlValues({ priority: preset.priority, portDelay: preset.portDelay, demandSurge: preset.demandSurge });
    state.scenarioName = preset.name;
    updateControlsUI();
    runOptimization(false);
    closeDialog('scenarioDialog');
    toast(`${preset.name} loaded · plan re-solved`);
  }

  function evaluatePreset(preset) {
    const previous = { priority: state.priority, portDelay: state.portDelay, demandSurge: state.demandSurge };
    state.priority = preset.priority;
    state.portDelay = preset.portDelay;
    state.demandSurge = preset.demandSurge;
    const result = solveModel();
    Object.assign(state, previous);
    return result;
  }

  function openDialog(id) {
    const dialog = byId(id);
    if (dialog && typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
  }

  function closeDialog(id) {
    const dialog = byId(id);
    if (dialog && dialog.open) dialog.close();
  }

  function renderInputEditor() {
    const suppliers = state.model.suppliers;
    const regions = state.model.regions;
    const supplierInputs = suppliers.map((supplier) => `<label class="editor-field"><span>${supplier.name}</span><input type="number" min="0" max="100000" step="1" required value="${supplier.capacity}" data-supplier-capacity="${supplier.id}" aria-label="${supplier.name} capacity in units"></label>`).join('');
    const regionInputs = regions.map((region) => `<label class="editor-field"><span>${region.name}</span><input type="number" min="0" max="100000" step="1" required value="${region.demand}" data-region-demand="${region.id}" aria-label="${region.name} demand in units"></label>`).join('');
    const headers = regions.map((region) => `<th scope="col">${region.name}</th>`).join('');
    const rows = suppliers.map((supplier) => `<tr><td>${supplier.shortName}</td>${regions.map((region) => `<td><input type="number" min="0" max="100000" step="1" required value="${state.model.costs[supplier.id][region.id]}" data-lane-cost="${supplier.id}:${region.id}" aria-label="${supplier.shortName} to ${region.name} freight cost per unit"></td>`).join('')}</tr>`).join('');
    byId('inputsEditor').innerHTML = `<section class="editor-section"><h3>Supplier capacity <span class="editor-unit">· units available</span></h3><div class="editor-grid">${supplierInputs}</div></section><section class="editor-section"><h3>Regional demand <span class="editor-unit">· units requested</span></h3><div class="editor-grid">${regionInputs}</div></section><section class="editor-section"><h3>Lane cost <span class="editor-unit">· dollars per unit</span></h3><div class="route-editor-wrap"><table class="route-editor"><thead><tr><th scope="col">Supplier</th>${headers}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  function saveInputChanges(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const updated = cloneModel(state.model);
    $$('[data-supplier-capacity]', form).forEach((input) => {
      updated.suppliers.find((supplier) => supplier.id === input.dataset.supplierCapacity).capacity = Math.round(Number(input.value));
    });
    $$('[data-region-demand]', form).forEach((input) => {
      updated.regions.find((region) => region.id === input.dataset.regionDemand).demand = Math.round(Number(input.value));
    });
    $$('[data-lane-cost]', form).forEach((input) => {
      const [supplierId, regionId] = input.dataset.laneCost.split(':');
      updated.costs[supplierId][regionId] = Math.round(Number(input.value));
    });
    state.model = updated;
    closeDialog('inputsDialog');
    markDirty();
    runOptimization(false);
    toast('Inputs updated · exact solver returned a new plan');
  }

  function renderSavedScenarios() {
    const area = byId('savedScenarioArea');
    const list = byId('savedScenarioList');
    const count = byId('scenarioCount');
    count.textContent = String(PRESETS.length + state.savedScenarios.length);
    area.hidden = state.savedScenarios.length === 0;
    list.replaceChildren();
    state.savedScenarios.forEach((scenario, index) => {
      const row = document.createElement('div');
      row.className = 'saved-scenario-row';
      const name = document.createElement('span');
      name.className = 'saved-scenario-name';
      name.textContent = scenario.name;
      const meta = document.createElement('span');
      meta.className = 'saved-scenario-meta';
      const tags = [
        `Service ${scenario.priority}`,
        scenario.portDelay ? 'Harbor delay' : '',
        scenario.demandSurge ? 'Demand +12%' : ''
      ].filter(Boolean);
      meta.textContent = tags.join(' · ');
      const load = document.createElement('button');
      load.type = 'button';
      load.textContent = 'Load';
      load.dataset.savedScenario = String(index);
      row.append(name, meta, load);
      list.append(row);
    });
  }

  const SCENARIO_ICONS = {
    baseline: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h14M5 3.5V6m10-2.5V6M4 6v10h12V6"/><path d="M7 10h2m2 0h2m-6 3h2"/></svg>',
    service: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.8 12 7l4.6.7-3.3 3.2.8 4.6-4.1-2.2-4.1 2.2.8-4.6-3.3-3.2L8 7z"/></svg>',
    cost: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v14m3-10.5c0-1.1-1.2-2-3-2s-3 1-3 2.2 1 1.9 3 2.3 3 1.1 3 2.4-1.2 2.4-3 2.4-3-1-3-2.2"/></svg>',
    harbor: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 15.5h14M5 13V6h10v7M8 6V3.5h4V6M3.5 10.5h13"/><path d="m6 16.5 1.2-1.2m2.3 1.2 1.2-1.2m2.3 1.2 1.2-1.2"/></svg>',
    surge: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 16h14M4.5 13.5l3-3.5 2.4 2L15.5 6"/><path d="M12 6h3.5v3.5"/></svg>'
  };

  function renderScenarioLibrary() {
    const container = byId('scenarioLibrary');
    container.innerHTML = PRESETS.map((preset, index) => {
      const result = evaluatePreset(preset);
      const comparison = `<span class="scenario-card-stats"><strong>${percent(result.fillRate, 1)} filled</strong><span>·</span><span>${money(result.freightSpend)} freight</span><span>·</span><span>${fmt(result.unfilled)} unfilled</span></span>`;
      return `<button class="scenario-card" type="button" data-preset-index="${index}"><span class="scenario-card-icon">${SCENARIO_ICONS[preset.icon]}</span><span class="scenario-card-copy"><strong>${preset.name}</strong><small>${preset.description}</small>${comparison}</span><span class="scenario-card-arrow"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9m-4-4 4 4-4 4"/></svg></span></button>`;
    }).join('');
    renderSavedScenarios();
  }

  function openInputs() {
    renderInputEditor();
    openDialog('inputsDialog');
  }

  function openScenarios() {
    renderScenarioLibrary();
    openDialog('scenarioDialog');
  }

  function openAiSettings() {
    byId('aiEndpoint').value = state.aiConfig?.endpoint || 'https://api.openai.com/v1/chat/completions';
    byId('aiModel').value = state.aiConfig?.model || 'gpt-4o-mini';
    byId('aiKey').value = '';
    openDialog('aiDialog');
  }

  function updateCopilotMode() {
    const connected = Boolean(state.aiConfig);
    byId('copilotMode').textContent = connected ? 'CONNECTED' : 'DEMO';
    byId('copilotMode').classList.toggle('is-connected', connected);
    byId('copilotModeText').textContent = connected ? `Connected · ${state.aiConfig.model}` : 'Local assistant · no data sent';
    byId('copilotDisclaimer').textContent = connected
      ? 'Your prompt and sample inputs go directly to your selected provider; the solver remains local.'
      : 'Demo mode uses transparent local rules. Add your own compatible model if desired.';
    const connectButton = $('#connectAiButton span');
    if (connectButton) connectButton.textContent = connected ? 'AI connected' : 'Connect AI';
  }

  function connectAi(event) {
    event.preventDefault();
    const endpoint = safeText(byId('aiEndpoint').value);
    const model = safeText(byId('aiModel').value);
    const key = safeText(byId('aiKey').value);
    let parsed;
    try {
      parsed = new URL(endpoint);
    } catch {
      toast('Enter a valid chat completions URL', true);
      return;
    }
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      toast('Use an HTTP or HTTPS model endpoint', true);
      return;
    }
    if (!model || !key) {
      toast('Enter a model name and API key', true);
      return;
    }
    state.aiConfig = { endpoint, model, key };
    state.aiHistory = [];
    byId('aiKey').value = '';
    closeDialog('aiDialog');
    updateCopilotMode();
    toast('Model connected for this browser tab only');
  }

  function addAssistantMessage(text, receipt = '') {
    const wrapper = document.createElement('div');
    wrapper.className = 'assistant-message';
    const avatar = document.createElement('span');
    avatar.className = 'assistant-avatar';
    avatar.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5v3M10 14.5v3M2.5 10h3m9 0h3M4.7 4.7l2.1 2.1m6.4 6.4 2.1 2.1m0-10.6-2.1 2.1m-6.4 6.4-2.1 2.1"/><circle cx="10" cy="10" r="2.8"/></svg>';
    const body = document.createElement('div');
    body.className = 'message-body';
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const name = document.createElement('strong');
    name.textContent = state.aiConfig ? `Arcway · ${state.aiConfig.model}` : 'Arcway assistant';
    const time = document.createElement('span');
    time.textContent = 'Just now';
    meta.append(name, time);
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    body.append(meta, paragraph);
    wrapper.append(avatar, body);
    byId('chatThread').append(wrapper);
    if (receipt && state.result) {
      const receiptNode = document.createElement('div');
      receiptNode.className = 'solver-receipt';
      receiptNode.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>';
      const receiptText = document.createElement('span');
      receiptText.textContent = `Local solver · ${percent(state.result.fillRate, 1)} fill · ${money(state.result.freightSpend)} freight · ${fmt(state.result.unfilled)} unfilled`;
      receiptNode.append(receiptText);
      byId('chatThread').append(receiptNode);
    }
    byId('chatThread').scrollTop = byId('chatThread').scrollHeight;
  }

  function addUserMessage(text) {
    const wrapper = document.createElement('div');
    wrapper.className = 'user-message';
    const bubble = document.createElement('div');
    bubble.className = 'user-bubble';
    bubble.textContent = text;
    wrapper.append(bubble);
    byId('chatThread').append(wrapper);
    byId('chatThread').scrollTop = byId('chatThread').scrollHeight;
  }

  function addThinkingMessage() {
    const wrapper = document.createElement('div');
    wrapper.className = 'assistant-message';
    wrapper.dataset.thinking = 'true';
    const avatar = document.createElement('span');
    avatar.className = 'assistant-avatar';
    avatar.textContent = '…';
    const body = document.createElement('div');
    body.className = 'message-body';
    const paragraph = document.createElement('p');
    paragraph.innerHTML = '<span class="thinking-indicator" aria-label="Thinking"><i></i><i></i><i></i></span>';
    body.append(paragraph);
    wrapper.append(avatar, body);
    byId('chatThread').append(wrapper);
    byId('chatThread').scrollTop = byId('chatThread').scrollHeight;
    return wrapper;
  }

  function addReceiptOnly() {
    if (!state.result) return;
    const receiptNode = document.createElement('div');
    receiptNode.className = 'solver-receipt';
    receiptNode.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>';
    const receiptText = document.createElement('span');
    receiptText.textContent = `Local solver · ${percent(state.result.fillRate, 1)} fill · ${money(state.result.freightSpend)} freight · ${fmt(state.result.unfilled)} unfilled`;
    receiptNode.append(receiptText);
    byId('chatThread').append(receiptNode);
    byId('chatThread').scrollTop = byId('chatThread').scrollHeight;
  }

  function controlContext() {
    const inputs = getEffectiveInputs();
    const result = state.result;
    return {
      dataIsSynthetic: true,
      guardrails: 'Only suggest the service priority, Harbor delay toggle, or demand spike toggle. The deterministic local optimizer makes and validates the allocation.',
      controls: { servicePriority: state.priority, harborDelay: state.portDelay, demandSpike: state.demandSurge },
      suppliers: inputs.suppliers.map((supplier) => ({ name: supplier.name, capacityUnits: supplier.effectiveCapacity })),
      regionalDemand: inputs.regions.map((region) => ({ name: region.name, demandUnits: region.effectiveDemand, shortageWeight: region.shortageWeight })),
      laneCostsDollarsPerUnit: inputs.costs,
      currentPlan: result ? {
        fillRatePercent: Number(result.fillRate.toFixed(1)),
        shippedUnits: result.shipped,
        totalDemandUnits: result.totalDemand,
        unfilledUnits: result.unfilled,
        unusedSupplyUnits: result.unusedSupply,
        freightSpendDollars: Math.round(result.freightSpend),
        allocationByRegion: result.regions.map((region) => ({
          region: region.name,
          demandUnits: region.demand,
          shippedUnits: region.shipped,
          unfilledUnits: region.unfilled,
          supplierLanes: region.lanes.filter((lane) => lane.units > 0).map((lane) => ({ supplier: lane.shortName, units: lane.units, dollarsPerUnit: lane.unitCost }))
        }))
      } : null
    };
  }

  const AI_SYSTEM_PROMPT = `You are Arcway's operations copilot. Help a planner understand a small synthetic fulfillment model. Do not claim to solve or certify anything: a deterministic min-cost-flow optimizer runs locally after you propose an allowed control update. Never invent input values or claim a route is feasible unless it appears in the supplied context. You may only suggest three changes: servicePriority (integer 0 to 100), portDisruption (boolean), and demandSurge (boolean). Do not generate code or change supplier capacities, demand, or lane costs. If the user asks for unsupported changes, explain what controls are available. Return only valid JSON with this exact shape: {"reply":"concise plain-language answer","updates":{"servicePriority":null,"portDisruption":null,"demandSurge":null}}. Use null for controls that should not change. Only update a control when the user clearly asks for a what-if or change. For an explanation request, use the provided plan and assumptions, distinguish the model objective from real-world costs, and mention that a human must review the plan.`;

  function extractJson(text) {
    const cleaned = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try { return JSON.parse(cleaned); } catch { /* try the first JSON object below */ }
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(cleaned.slice(first, last + 1));
    throw new Error('The connected model did not return the expected JSON response.');
  }

  async function askConnectedModel(text) {
    const context = controlContext();
    const prompt = `Current synthetic model context (authoritative values):\n${JSON.stringify(context)}\n\nPlanner request: ${text}`;
    const messages = [
      { role: 'system', content: AI_SYSTEM_PROMPT },
      ...state.aiHistory.slice(-8),
      { role: 'user', content: prompt }
    ];
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    let response;
    try {
      response = await fetch(state.aiConfig.endpoint, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.aiConfig.key}` },
        body: JSON.stringify({
          model: state.aiConfig.model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages
        })
      });
    } finally {
      window.clearTimeout(timeout);
    }
    let responseBody;
    try { responseBody = await response.json(); } catch { responseBody = {}; }
    if (!response.ok) {
      const providerMessage = responseBody?.error?.message;
      throw new Error(providerMessage || `The model endpoint returned ${response.status}.`);
    }
    const content = responseBody?.choices?.[0]?.message?.content;
    if (!content) throw new Error('The model endpoint returned an empty response.');
    const parsed = extractJson(content);
    const updates = parsed && typeof parsed.updates === 'object' ? parsed.updates : {};
    const safeUpdates = {
      priority: Number.isFinite(Number(updates.servicePriority)) && updates.servicePriority !== null ? Math.max(0, Math.min(100, Math.round(Number(updates.servicePriority)))) : undefined,
      portDelay: typeof updates.portDisruption === 'boolean' ? updates.portDisruption : undefined,
      demandSurge: typeof updates.demandSurge === 'boolean' ? updates.demandSurge : undefined
    };
    const reply = safeText(parsed.reply).slice(0, 1200) || 'I reviewed the request. The local optimizer is ready to test an allowed scenario.';
    state.aiHistory.push({ role: 'user', content: text });
    state.aiHistory.push({ role: 'assistant', content: JSON.stringify({ reply, updates: parsed.updates || {} }) });
    return { reply, updates: safeUpdates };
  }

  function localResponse(text) {
    const lower = text.toLowerCase();
    const updates = {};
    const current = { priority: state.priority, portDelay: state.portDelay, demandSurge: state.demandSurge };
    let recognizedChange = false;

    if (/\b(reset|baseline|clear (?:the )?scenario|back to normal)\b/.test(lower)) {
      updates.priority = 76;
      updates.portDelay = false;
      updates.demandSurge = false;
      recognizedChange = true;
    }

    if (/\b(harbor|port)\b/.test(lower) && /\b(delay(?:ed)?|slow(?:down)?|closed|down|outage|disrupt(?:ion|ed)?|blocked)\b/.test(lower)) {
      updates.portDelay = true;
      recognizedChange = true;
    } else if (/\b(harbor|port)\b/.test(lower) && /\b(restore|restored|normal|clear|resolved|back)\b/.test(lower)) {
      updates.portDelay = false;
      recognizedChange = true;
    }

    if (/\b(demand|orders?)\b/.test(lower) && /\b(spike|surge|increase|increased|higher|up 12|up by|jump)\b/.test(lower)) {
      updates.demandSurge = true;
      recognizedChange = true;
    } else if (/\b(demand|orders?)\b/.test(lower) && /\b(normal|reduce|reduced|lower|decrease|decreased|down)\b/.test(lower)) {
      updates.demandSurge = false;
      recognizedChange = true;
    }

    const percentageMatch = lower.match(/(\d{1,3})\s?(?:%|percent)/);
    const mentionsService = /\b(service|fill(?: rate)?|customer|stockout|shortage priority|priority)\b/.test(lower);
    if (percentageMatch && mentionsService) {
      updates.priority = Math.max(0, Math.min(100, Number(percentageMatch[1])));
      recognizedChange = true;
    } else if (/\b(service[- ]first|prioriti[sz]e service|protect (?:the )?customer|customer[- ]first)\b/.test(lower)) {
      updates.priority = 96;
      recognizedChange = true;
    } else if (/\b(cost[- ]first|save on freight|cut freight|reduce freight|lower (?:the )?cost|cost priority|budget[- ]first)\b/.test(lower)) {
      updates.priority = 22;
      recognizedChange = true;
    } else if (/\b(service|fill|customer|stockout)\b/.test(lower) && /\b(raise|increase|boost|prioriti[sz]e|improve|protect)\b/.test(lower)) {
      updates.priority = Math.min(100, current.priority + 15);
      recognizedChange = true;
    } else if (/\b(service|fill|customer|stockout|priority)\b/.test(lower) && /\b(lower|reduce|decrease|ease)\b/.test(lower)) {
      updates.priority = Math.max(0, current.priority - 15);
      recognizedChange = true;
    }

    const explanationRequest = /\b(explain|why|shortfall|gap|recommend|plan|allocation|how does|how do)\b/.test(lower);
    if (recognizedChange) {
      const applied = {};
      if (updates.priority !== undefined && updates.priority !== state.priority) applied.priority = updates.priority;
      if (updates.portDelay !== undefined && updates.portDelay !== state.portDelay) applied.portDelay = updates.portDelay;
      if (updates.demandSurge !== undefined && updates.demandSurge !== state.demandSurge) applied.demandSurge = updates.demandSurge;
      if (Object.keys(applied).length === 0) {
        return { reply: `Those settings are already active. Current service priority is ${state.priority}/100${state.portDelay ? ', Harbor delay is on' : ''}${state.demandSurge ? ', demand spike is on' : ''}.`, updates: {} };
      }
      return { reply: 'I can apply that what-if using the controls in this demo. I will not change any hard model inputs without your review.', updates: applied };
    }

    if (explanationRequest && state.result) {
      const result = state.result;
      const worst = [...result.regions].sort((a, b) => b.unfilled - a.unfilled)[0];
      let reply = `The current plan ships ${fmt(result.shipped)} of ${fmt(result.totalDemand)} units (${percent(result.fillRate, 1)}) for ${money(result.freightSpend)} in modeled freight.`;
      if (result.unfilled > 0 && result.unusedSupply > 0) {
        reply += ` It leaves ${fmt(result.unfilled)} units open and holds back ${fmt(result.unusedSupply)} units of supply: at priority ${state.priority}/100, some remaining lanes cost more than the modeled ${money(result.basePenalty)} per-unit shortage penalty.`;
      } else if (result.unfilled > 0) {
        reply += ` ${fmt(result.unfilled)} units are unfilled because the modeled supply is constrained; ${worst?.name || 'The most affected region'} has the largest gap.`;
      } else {
        reply += ' All modeled demand is covered in this scenario.';
      }
      reply += ' Click a region in the allocation to inspect its supplier lanes.';
      return { reply, updates: {} };
    }

    return {
      reply: 'In local demo mode, I can change service priority, model a Harbor delay, test a 12% demand spike, or explain the current allocation. Try “Raise service to 95%” or open Model inputs to edit the sample data.',
      updates: {}
    };
  }

  function applyAssistantUpdates(updates) {
    let changed = false;
    if (Number.isFinite(updates.priority) && updates.priority !== state.priority) {
      state.priority = Math.max(0, Math.min(100, Math.round(updates.priority)));
      changed = true;
    }
    if (typeof updates.portDelay === 'boolean' && updates.portDelay !== state.portDelay) {
      state.portDelay = updates.portDelay;
      changed = true;
    }
    if (typeof updates.demandSurge === 'boolean' && updates.demandSurge !== state.demandSurge) {
      state.demandSurge = updates.demandSurge;
      changed = true;
    }
    if (changed) {
      updateControlsUI();
      markDirty();
      runOptimization(false);
    }
    return changed;
  }

  async function handleChat(text) {
    const cleanText = safeText(text).slice(0, 500);
    if (!cleanText || state.isSending) return;
    state.isSending = true;
    byId('chatInput').value = '';
    byId('chatInput').style.height = '22px';
    byId('chatInput').disabled = true;
    $('.send-button', byId('chatForm')).disabled = true;
    addUserMessage(cleanText);
    let thinking = null;

    try {
      let answer;
      if (state.aiConfig) {
        thinking = addThinkingMessage();
        answer = await askConnectedModel(cleanText);
      } else {
        answer = localResponse(cleanText);
      }
      const changed = applyAssistantUpdates(answer.updates || {});
      if (thinking) thinking.remove();
      let responseText = answer.reply;
      if (changed) {
        const active = [];
        if (answer.updates.priority !== undefined) active.push(`service priority ${state.priority}/100`);
        if (answer.updates.portDelay !== undefined) active.push(`Harbor delay ${state.portDelay ? 'on' : 'off'}`);
        if (answer.updates.demandSurge !== undefined) active.push(`demand spike ${state.demandSurge ? 'on' : 'off'}`);
        responseText += `\n\nApplied ${active.join(', ')}. The deterministic local optimizer has re-solved the model.`;
      }
      addAssistantMessage(responseText);
      addReceiptOnly();
    } catch (error) {
      if (thinking) thinking.remove();
      const friendly = state.aiConfig
        ? `I couldn't reach the connected model, so no model controls were changed. Check the endpoint, API key, and provider CORS settings. ${error?.message ? `Details: ${error.message}` : ''}`
        : 'Something went wrong while preparing the demo response. Your plan is unchanged.';
      addAssistantMessage(friendly);
      toast(state.aiConfig ? 'AI request failed · plan unchanged' : 'Assistant response failed', true);
    } finally {
      state.isSending = false;
      byId('chatInput').disabled = false;
      $('.send-button', byId('chatForm')).disabled = false;
      byId('chatInput').focus();
    }
  }

  function csvEscape(value) {
    const string = String(value ?? '');
    return /[",\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
  }

  function exportPlan() {
    if (!state.result) return;
    const rows = [['Region', 'Demand units', 'Shipped units', 'Unfilled units', 'Supplier', 'Units', 'Cost per unit (USD)', 'Freight cost (USD)']];
    for (const region of state.result.regions) {
      for (const lane of region.lanes.filter((entry) => entry.units > 0)) {
        rows.push([region.name, region.demand, region.shipped, region.unfilled, lane.supplierName, lane.units, lane.unitCost, lane.units * lane.unitCost]);
      }
      if (region.unfilled > 0) rows.push([region.name, region.demand, region.shipped, region.unfilled, 'Unfilled demand', region.unfilled, region.penalty, 0]);
    }
    const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `arcway-fulfillment-plan-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toast('Plan exported as CSV');
  }

  function saveCurrentScenario(event) {
    event.preventDefault();
    const name = safeText(byId('scenarioNameInput').value).slice(0, 40);
    if (!name) return;
    state.savedScenarios.push({ name, priority: state.priority, portDelay: state.portDelay, demandSurge: state.demandSurge, model: cloneModel(state.model) });
    byId('scenarioNameInput').value = '';
    closeDialog('saveScenarioDialog');
    renderScenarioLibrary();
    toast(`Saved “${name}” for this session`);
  }

  function handleAction(action) {
    if (action === 'workspace') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      closeMobileSidebar();
    } else if (action === 'scenarios') {
      openScenarios();
      closeMobileSidebar();
    } else if (action === 'inputs') {
      openInputs();
      closeMobileSidebar();
    } else if (action === 'framework') {
      openDialog('frameworkDialog');
      closeMobileSidebar();
    } else if (action === 'profile') {
      toast('Maya Chen · Operations planner');
    }
  }

  function closeMobileSidebar() {
    byId('sidebar').classList.remove('is-open');
    document.body.classList.remove('sidebar-open');
  }

  function bindEvents() {
    byId('servicePriority').addEventListener('input', (event) => {
      state.priority = Number(event.currentTarget.value);
      updateControlsUI();
      markDirty();
    });
    byId('portToggle').addEventListener('click', () => {
      state.portDelay = !state.portDelay;
      updateControlsUI();
      markDirty();
    });
    byId('demandToggle').addEventListener('click', () => {
      state.demandSurge = !state.demandSurge;
      updateControlsUI();
      markDirty();
    });
    byId('runOptimization').addEventListener('click', () => runOptimization(true));
    byId('baselineButton').addEventListener('click', openScenarios);
    byId('editInputsButton').addEventListener('click', openInputs);
    byId('viewInputsButton').addEventListener('click', openInputs);
    byId('inputsForm').addEventListener('submit', saveInputChanges);
    byId('connectAiButton').addEventListener('click', openAiSettings);
    byId('copilotSettings').addEventListener('click', openAiSettings);
    byId('aiForm').addEventListener('submit', connectAi);
    byId('disconnectAiButton').addEventListener('click', () => {
      state.aiConfig = null;
      state.aiHistory = [];
      byId('aiKey').value = '';
      closeDialog('aiDialog');
      updateCopilotMode();
      toast('Switched to local demo assistant');
    });
    byId('chatForm').addEventListener('submit', (event) => {
      event.preventDefault();
      handleChat(byId('chatInput').value);
    });
    byId('chatInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        byId('chatForm').requestSubmit();
      }
    });
    byId('chatInput').addEventListener('input', (event) => {
      const input = event.currentTarget;
      input.style.height = '22px';
      input.style.height = `${Math.min(input.scrollHeight, 76)}px`;
    });
    byId('promptSuggestions').addEventListener('click', (event) => {
      const button = event.target.closest('[data-prompt]');
      if (button) handleChat(button.dataset.prompt);
    });
    byId('allocationList').addEventListener('click', (event) => {
      const button = event.target.closest('[data-region]');
      if (!button) return;
      const id = button.dataset.region;
      state.expandedRegion = state.expandedRegion === id ? null : id;
      renderAllocation(state.result);
    });
    byId('exportButton').addEventListener('click', exportPlan);
    byId('scenarioLibrary').addEventListener('click', (event) => {
      const button = event.target.closest('[data-preset-index]');
      if (button) applyPreset(PRESETS[Number(button.dataset.presetIndex)]);
    });
    byId('savedScenarioList').addEventListener('click', (event) => {
      const button = event.target.closest('[data-saved-scenario]');
      if (!button) return;
      const scenario = state.savedScenarios[Number(button.dataset.savedScenario)];
      if (scenario) applyPreset(scenario);
    });
    byId('clearSavedScenarios').addEventListener('click', () => {
      state.savedScenarios = [];
      renderScenarioLibrary();
      toast('Saved scenarios cleared for this session');
    });
    byId('saveScenarioButton').addEventListener('click', () => {
      closeDialog('scenarioDialog');
      byId('scenarioNameInput').value = '';
      openDialog('saveScenarioDialog');
      window.setTimeout(() => byId('scenarioNameInput').focus(), 30);
    });
    byId('saveScenarioForm').addEventListener('submit', saveCurrentScenario);
    byId('mobileMenu').addEventListener('click', () => {
      byId('sidebar').classList.toggle('is-open');
      document.body.classList.toggle('sidebar-open', byId('sidebar').classList.contains('is-open'));
    });
    document.addEventListener('click', (event) => {
      if (document.body.classList.contains('sidebar-open') && !byId('sidebar').contains(event.target) && !byId('mobileMenu').contains(event.target)) closeMobileSidebar();
      const action = event.target.closest('[data-action]');
      if (action) handleAction(action.dataset.action);
      const principle = event.target.closest('[data-principle]');
      if (principle) openDialog('frameworkDialog');
    });
    $$('[data-close]').forEach((button) => button.addEventListener('click', () => closeDialog(button.dataset.close)));
    $$('dialog.modal').forEach((dialog) => dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    }));
  }

  function init() {
    bindEvents();
    updateCopilotMode();
    updateControlsUI();
    renderScenarioLibrary();
    runOptimization(false);
  }

  init();
})();
