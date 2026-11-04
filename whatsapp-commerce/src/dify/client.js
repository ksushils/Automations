/**
 * Dify client – calls POST {baseUrl}/chat-messages in streaming mode.
 * Streaming works for every Dify app type (Chatbot, Chatflow and Agent; Agent apps don't support blocking).
 */
export async function difyChat({ baseUrl, apiKey, query, inputs = {}, user, conversationId, timeoutMs = 60000 }) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat-messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, inputs, user, response_mode: 'streaming', conversation_id: conversationId || '', auto_generate_name: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(`Dify ${res.status}: ${body.message || body.code || 'error'}`);
    err.status = res.status;
    err.code = body.code;
    throw err;
  }
  return parseDifyStream(res.body);
}

export async function parseDifyStream(stream) {
  const decoder = new TextDecoder();
  let buf = '';
  let answer = '';
  let conversationId = null;
  let messageId = null;
  let workflowAnswer = null;

  const handle = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    let ev;
    try { ev = JSON.parse(payload); } catch { return; }
    conversationId = ev.conversation_id || conversationId;
    messageId = ev.message_id || messageId;
    switch (ev.event) {
      case 'message':
      case 'agent_message':
        answer += ev.answer || '';
        break;
      case 'message_replace':
        answer = ev.answer || '';
        break;
      case 'workflow_finished':
        workflowAnswer = ev.data?.outputs?.answer ?? workflowAnswer;
        break;
      case 'error':
        throw Object.assign(new Error(`Dify stream error: ${ev.message || ev.code}`), { code: ev.code, status: ev.status });
    }
  };

  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      handle(line);
    }
  }
  if (buf.trim()) handle(buf.trim());
  return { answer: (answer || workflowAnswer || '').trim(), conversationId, messageId };
}

/** Quick check used by the dashboard "Test Dify" button. */
export async function difyInfo({ baseUrl, apiKey }) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/info`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Dify ${res.status}: ${body.message || 'error'}`);
  return body;
}
