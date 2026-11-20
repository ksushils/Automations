import { getDb } from './db.js';

/*
 * "How did we do?" after a chat: 😀 / 😐 / 😞. Asked when the team hands a chat back to the assistant, and in the
 * website chat after a few messages and a quiet spell (once per visit). A 😞 asks what went wrong. Owners see the
 * totals in the Inbox; each rating says whether the assistant or the team handled the chat.
 */
export const RATING_BUTTONS = [{ id: 'rate:3', title: '😀 Great' }, { id: 'rate:2', title: '😐 OK' }, { id: 'rate:1', title: '😞 Not good' }];
export const ratingAsk = (text = 'Thanks for chatting with us! How did we do?') => ({ type: 'buttons', text, buttons: RATING_BUTTONS });
export const ratingsOn = (S) => S.webchat?.rating !== false;

export function saveRating(tenantId, waId, score, handledBy) {
  const s = Math.max(1, Math.min(3, Number(score) || 0));
  const d = getDb();
  // one rating per chat per day: a second tap changes it
  const prev = d.prepare("SELECT id FROM chat_ratings WHERE tenant_id = ? AND wa_id = ? AND created_at > datetime('now', '-1 day') ORDER BY id DESC LIMIT 1").get(tenantId, waId);
  if (prev) { d.prepare('UPDATE chat_ratings SET score = ?, handled_by = ? WHERE id = ?').run(s, handledBy, prev.id); return prev.id; }
  return Number(d.prepare('INSERT INTO chat_ratings (tenant_id, wa_id, score, handled_by) VALUES (?, ?, ?, ?)').run(tenantId, waId, s, handledBy).lastInsertRowid);
}
export function addRatingComment(tenantId, id, comment) {
  getDb().prepare('UPDATE chat_ratings SET comment = ? WHERE id = ? AND tenant_id = ?').run(String(comment).slice(0, 500), id, tenantId);
}
export function ratingSummary(tenantId, days = 30) {
  const d = getDb();
  const rows = d.prepare(`SELECT score, handled_by, COUNT(*) AS n FROM chat_ratings WHERE tenant_id = ? AND created_at > datetime('now', ?) GROUP BY score, handled_by`).all(tenantId, `-${days} days`);
  const sum = (f) => rows.filter(f).reduce((a, r) => a + r.n, 0);
  const latest = d.prepare(`SELECT wa_id, score, comment FROM chat_ratings WHERE tenant_id = ? AND id IN (SELECT MAX(id) FROM chat_ratings WHERE tenant_id = ? GROUP BY wa_id) ORDER BY id DESC LIMIT 500`).all(tenantId, tenantId);
  return {
    days, great: sum((r) => r.score === 3), ok: sum((r) => r.score === 2), bad: sum((r) => r.score === 1),
    ai: sum((r) => r.handled_by === 'ai'), team: sum((r) => r.handled_by === 'team'),
    byChat: Object.fromEntries(latest.map((r) => [r.wa_id, { score: r.score, comment: r.comment || '' }])),
  };
}
