import supabase, { supabaseAdmin } from '../config/supabaseClient.js';
import env from '../config/env.js';
import { redisClient } from '../config/redis.js';
import { chatCompletion } from '../config/together.js';
import { buildMessagesForSession } from '../services/messageBuilder.js';
import { sendToUser } from '../services/push.service.js';

// Simple jittered sleep
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Generate a short ping using Together AI with session/character context
export async function generateNudgeViaAI(sessionId, userId) {
  const userInstruction = [
    'Send exactly one short re-engagement ping to the user to nudge them to continue chatting.',
    'Length: 6–12 words. Natural, warm, human-like. 1 action like **smiles** is okay.',
    'No questions unless playful and brief. Avoid repetitive phrasing or meta lines.',
  ].join(' ');
  const { messages } = await buildMessagesForSession(sessionId, userId, userInstruction, {
    includeHistory: true,
    historyLimit: 6,
    historyCharBudget: 1200,
    polish: true,
  });
  const resp = await chatCompletion(messages);
  const aiText = resp?.choices?.[0]?.message?.content?.trim();
  return aiText || '';
}

// Choose one session per user that’s inactive
async function findEligibleSessions({ inactiveHours = 24, limit = 50 }) {
  const cutoff = new Date(Date.now() - inactiveHours * 3600 * 1000).toISOString();

  // Get users with at least one session updated before cutoff
  const { data: sessions, error } = await supabaseAdmin
    .from('chat_sessions')
    .select('id, user_id, character_id, updated_at')
    .lt('updated_at', cutoff)
    .order('updated_at', { ascending: true })
    .limit(limit);
  if (error) {
    console.warn('[nudges] Failed to fetch sessions:', error?.message || error);
    return [];
  }
  if (!Array.isArray(sessions) || sessions.length === 0) return [];

  // Deduplicate by user: pick the stalest session per user
  const byUser = new Map();
  for (const s of sessions) {
    if (!byUser.has(s.user_id)) byUser.set(s.user_id, s);
  }

  // Fetch characters
  const charIds = Array.from(new Set(Array.from(byUser.values()).map(s => s.character_id).filter(Boolean)));
  let charsById = {};
  if (charIds.length) {
    const { data: chars } = await supabaseAdmin
      .from('characters')
      .select('id, name, avatar_url')
      .in('id', charIds);
    (chars || []).forEach(c => { charsById[c.id] = c; });
  }

  return Array.from(byUser.values()).map(s => ({
    sessionId: s.id,
    userId: s.user_id,
    characterId: s.character_id,
    character: charsById[s.character_id] || null,
  }));
}

// Insert an assistant message as a nudge
export async function insertAssistantMessage(sessionId, content, is_nsfw = false) {
  // Get next order_index
  let nextIdx = null;
  try {
    const { data: rows } = await supabase
      .from('chat_messages')
      .select('order_index')
      .eq('session_id', sessionId)
      .order('order_index', { ascending: false, nullsFirst: false })
      .limit(1);
    const base = Number(rows?.[0]?.order_index ?? 0);
    nextIdx = base + 1;
  } catch {}

  const { error } = await supabase
    .from('chat_messages')
    .insert([{ session_id: sessionId, role: 'assistant', content, is_nsfw, order_index: nextIdx, metadata: { nudge: true } }]);
  if (error) throw error;

  // Touch session updated_at
  await supabase
    .from('chat_sessions')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', sessionId);
}

// Optional: email ping
export async function maybeSendEmailNudge(userId, character) {
  // Email nudges are disabled; function kept for API compatibility
  return;
}

// Per-user rate limit using Redis: max per day
async function canNudgeUser(userId, maxPerDay) {
  if (!redisClient.isConnected) return true; // fail open
  const key = `nudge:user:${userId}:${new Date().toISOString().slice(0,10)}`; // YYYY-MM-DD bucket
  try {
    const currentRaw = await redisClient.client.get(key);
    const current = currentRaw ? parseInt(currentRaw, 10) : 0;
    if (current >= maxPerDay) return false;
    // increment and set TTL to end of day
    const next = current + 1;
    await redisClient.client.set(key, String(next));
    const now = new Date();
    const end = new Date(now);
    end.setUTCHours(23,59,59,999);
    const ttl = Math.max(1, Math.floor((end - now)/1000));
    await redisClient.client.expire(key, ttl);
    return true;
  } catch {
    return true; // fail open
  }
}

// Lock to avoid overlapping runs
async function acquireLock(lockKey, ttlSec = 50) {
  if (!redisClient.isConnected) return true; // no redis, skip lock
  try {
    const res = await redisClient.client.set(lockKey, '1', { NX: true, EX: ttlSec });
    return res === 'OK';
  } catch { return true; }
}

export async function runNudgeTick() {
  if (!env.NUDGE_ENABLED) return { skipped: true };

  const lockKey = 'nudge:lock';
  const gotLock = await acquireLock(lockKey, 55);
  if (!gotLock) return { skipped: true, reason: 'locked' };

  try {
    const inactiveHours = Number(env.NUDGE_MIN_INACTIVE_HOURS || 24);
    const maxPerDay = Number(env.NUDGE_MAX_PER_DAY || 1);
    const batchLimit = Number(env.NUDGE_BATCH_LIMIT || 25);

    const candidates = await findEligibleSessions({ inactiveHours, limit: batchLimit * 2 });
    if (!candidates.length) return { processed: 0 };

    let processed = 0;
    for (const c of candidates) {
      // random coin toss to keep it unpredictable
      if (Math.random() < 0.4) continue;
      const allowed = await canNudgeUser(c.userId, maxPerDay);
      if (!allowed) continue;

      let content = '';
      try {
        content = (await generateNudgeViaAI(c.sessionId, c.userId)) || '';
      } catch (e) {
        console.warn('[nudges] AI gen failed, falling back:', e?.message || e);
      }
      if (!content) {
        const name = c.character?.name || 'Hey';
        const fallback = [
          `${name} here — miss me? **smiles**`,
          `Got a minute? I was thinking about you. **grins**`,
          `Wanna pick up where we left off? **tilts head**`,
          `I found something fun to chat about. Come? **waves**`,
          `Hey, you. I’ve got a thought. **leans closer**`
        ];
        content = fallback[Math.floor(Math.random() * fallback.length)];
      }
      try {
        await insertAssistantMessage(c.sessionId, content, false);
        await maybeSendEmailNudge(c.userId, c.character);
        // Push notification (FCM)
        if (env.PUSH_ENABLED) {
          const title = `${c.character?.name || 'New message'}`;
          const body = content.length > 120 ? content.slice(0, 117) + '…' : content;
          await sendToUser(c.userId, {
            notification: { title, body },
            data: {
              type: 'nudge',
              session_id: String(c.sessionId),
              character_id: c.characterId ? String(c.characterId) : '',
            }
          });
        }
        processed += 1;
        if (processed >= batchLimit) break;
        await sleep(100 + Math.random() * 300);
      } catch (e) {
        console.warn('[nudges] insert failed:', e?.message || e);
      }
    }
    return { processed };
  } finally {
    // Let lock expire naturally
  }
}
