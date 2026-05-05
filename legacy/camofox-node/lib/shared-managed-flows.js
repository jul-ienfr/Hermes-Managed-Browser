const SHARED_MANAGED_FLOWS = Object.freeze({
  leboncoin: Object.freeze([
    Object.freeze({
      siteKey: 'leboncoin',
      actionKey: 'open_messaging',
      aliases: ['messaging', 'inbox', 'messages', 'open_messages', 'open_unread_filter', 'read_active_thread', 'verify_sent'],
      labels: ['Leboncoin messaging', 'open inbox'],
      side_effect_level: 'read_only',
      parameters: [],
      steps: Object.freeze([
        Object.freeze({
          kind: 'navigate',
          url: 'https://www.leboncoin.fr/messagerie',
          title: 'Leboncoin messagerie',
          replayable: true,
          expected_outcome: { url_contains: 'messagerie' },
        }),
      ]),
    }),
    Object.freeze({
      siteKey: 'leboncoin',
      actionKey: 'open_conversation',
      aliases: ['conversation', 'thread'],
      labels: ['Leboncoin open conversation'],
      side_effect_level: 'read_only',
      parameters: ['conversation_url'],
      steps: Object.freeze([
        Object.freeze({
          kind: 'navigate',
          url: '{{conversation_url}}',
          title: 'Leboncoin conversation',
          replayable: true,
          expected_outcome: { url_contains: 'messagerie' },
        }),
      ]),
    }),
    Object.freeze({
      siteKey: 'leboncoin',
      actionKey: 'read_last_message',
      aliases: ['last_message', 'read_conversation'],
      labels: ['Leboncoin read last message'],
      side_effect_level: 'read_only',
      parameters: [],
      steps: Object.freeze([
        Object.freeze({
          kind: 'evaluate',
          expression: 'document.body?.innerText || ""',
          replayable: true,
          expected_outcome: { has_text: '' },
        }),
      ]),
    }),
    Object.freeze({
      siteKey: 'leboncoin',
      actionKey: 'prepare_reply',
      aliases: ['draft_reply', 'type_reply'],
      labels: ['Leboncoin prepare reply'],
      side_effect_level: 'message_send',
      parameters: ['message'],
      steps: Object.freeze([
        Object.freeze({
          kind: 'type',
          selector: 'textarea, [contenteditable="true"], input[name="message"]',
          text: '{{message}}',
          text_parameterized: true,
          parameter_name: 'message',
          original_text_redacted: true,
          replayable: true,
          expected_outcome: { has_text: '{{message}}' },
        }),
      ]),
    }),
    Object.freeze({
      siteKey: 'leboncoin',
      actionKey: 'send_prepared_reply',
      aliases: ['send_reply'],
      labels: ['Leboncoin send prepared reply'],
      side_effect_level: 'message_send',
      parameters: [],
      steps: Object.freeze([
        Object.freeze({
          kind: 'click',
          selector: 'button[type="submit"], button:has-text("Envoyer"), [aria-label*="Envoyer"]',
          requires_confirmation: true,
          replayable: true,
          expected_outcome: { has_text: 'message' },
        }),
      ]),
    }),
    Object.freeze({
      siteKey: 'leboncoin',
      actionKey: 'checkpoint_storage',
      aliases: ['checkpoint', 'save_storage'],
      labels: ['Leboncoin storage checkpoint'],
      side_effect_level: 'read_only',
      parameters: [],
      steps: Object.freeze([
        Object.freeze({
          kind: 'evaluate',
          expression: 'document.location.href',
          replayable: true,
          expected_outcome: { has_text: '' },
        }),
      ]),
    }),
  ]),
});

function normalizeSiteKey(siteKey = '') {
  return String(siteKey || '').trim().toLowerCase();
}

function cloneFlow(flow) {
  return {
    ...flow,
    aliases: [...(flow.aliases || [])],
    labels: [...(flow.labels || [])],
    parameters: [...(flow.parameters || [])],
    steps: (flow.steps || []).map((step) => ({ ...step, expected_outcome: step.expected_outcome ? { ...step.expected_outcome } : undefined })),
  };
}

function listSharedManagedFlows(siteKey) {
  const key = normalizeSiteKey(siteKey);
  const flows = SHARED_MANAGED_FLOWS[key] || [];
  return flows.map(cloneFlow);
}

function getSharedManagedFlow(siteKey, actionKey) {
  const normalizedAction = String(actionKey || '').trim();
  return listSharedManagedFlows(siteKey).find((flow) => flow.actionKey === normalizedAction || flow.aliases.includes(normalizedAction)) || null;
}

async function seedSharedManagedFlows({ siteKey } = {}) {
  const { persistAgentHistorySteps } = await import('./agent-history-memory.js');
  const flows = listSharedManagedFlows(siteKey);
  const saved = [];
  for (const flow of flows) {
    const result = await persistAgentHistorySteps({
      siteKey: flow.siteKey,
      actionKey: flow.actionKey,
      aliases: flow.aliases,
      labels: flow.labels,
      owner_cli: 'managed-browser-wrapper',
      domain: flow.siteKey,
      side_effect_level: flow.side_effect_level,
      safe_to_share: true,
      created_by: 'shared-managed-flows',
      parameters: flow.parameters,
      steps: flow.steps,
    });
    saved.push({ actionKey: flow.actionKey, path: result.path });
  }
  return { ok: true, siteKey: normalizeSiteKey(siteKey), seeded: saved.length, total: flows.length, flows: saved };
}

async function sharedManagedFlowAvailability({ siteKey, profile } = {}) {
  const { loadAgentHistory } = await import('./agent-history-memory.js');
  const flows = listSharedManagedFlows(siteKey);
  const available = [];
  const missing = [];
  for (const flow of flows) {
    try {
      await loadAgentHistory(flow.siteKey, flow.actionKey, { profile });
      available.push(flow.actionKey);
    } catch (err) {
      missing.push(flow.actionKey);
    }
  }
  return {
    ok: missing.length === 0,
    siteKey: normalizeSiteKey(siteKey),
    flows_available: available.length,
    flows_total: flows.length,
    available,
    missing,
  };
}

export {
  getSharedManagedFlow,
  listSharedManagedFlows,
  seedSharedManagedFlows,
  sharedManagedFlowAvailability,
};
