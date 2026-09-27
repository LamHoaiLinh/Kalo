import { decryptPayload } from './crypto.js';

async function decodeRows(rows, userId, identity) {
  const out = [];
  for (const row of rows || []) {
    let decoded;
    try {
      decoded = await decryptPayload(row.encrypted_payloads, userId, identity);
    } catch {
      decoded = { type: 'locked', text: 'Không mở được tin nhắn này trên thiết bị hiện tại.' };
    }
    out.push({ ...row, decoded });
  }
  return out;
}

export class KaloMessageService {
  constructor(supabase, userId, identity, pageSize = 100) {
    this.supabase = supabase;
    this.userId = userId;
    this.identity = identity;
    this.pageSize = pageSize;
  }

  async latest(conversationId, limit = this.pageSize) {
    const { data, error } = await this.supabase.from('kalo_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    const rows = (data || []).slice().reverse();
    return {
      messages: await decodeRows(rows, this.userId, this.identity),
      hasMore: (data || []).length >= limit,
    };
  }

  async before(conversationId, beforeIso, limit = this.pageSize) {
    let query = this.supabase.from('kalo_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (beforeIso) query = query.lt('created_at', beforeIso);
    const { data, error } = await query;
    if (error) throw error;
    const rows = (data || []).slice().reverse();
    return {
      messages: await decodeRows(rows, this.userId, this.identity),
      hasMore: (data || []).length >= limit,
    };
  }

  async around(conversationId, messageId, radius = 40) {
    const targetRes = await this.supabase.from('kalo_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .eq('id', messageId)
      .maybeSingle();
    if (targetRes.error) throw targetRes.error;
    const target = targetRes.data;
    if (!target) return [];

    const [beforeRes, afterRes] = await Promise.all([
      this.supabase.from('kalo_messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .lte('created_at', target.created_at)
        .order('created_at', { ascending: false })
        .limit(radius + 1),
      this.supabase.from('kalo_messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .gt('created_at', target.created_at)
        .order('created_at', { ascending: true })
        .limit(radius),
    ]);
    if (beforeRes.error) throw beforeRes.error;
    if (afterRes.error) throw afterRes.error;
    const rows = [...(beforeRes.data || []).reverse(), ...(afterRes.data || [])];
    const unique = [...new Map(rows.map((row) => [row.id, row])).values()]
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    return decodeRows(unique, this.userId, this.identity);
  }

  async reads(conversationId) {
    const { data, error } = await this.supabase.from('kalo_reads')
      .select('conversation_id,user_id,last_message_id,read_at')
      .eq('conversation_id', conversationId);
    if (error) throw error;
    return data || [];
  }

  async markRead(conversationId, lastMessageId) {
    if (!lastMessageId) return;
    const { error } = await this.supabase.from('kalo_reads').upsert({
      conversation_id: conversationId,
      user_id: this.userId,
      last_message_id: lastMessageId,
      read_at: new Date().toISOString(),
    }, { onConflict: 'conversation_id,user_id' });
    if (error) throw error;
  }

  async unreadCounts() {
    const { data, error } = await this.supabase.rpc('kalo_unread_counts');
    if (error) throw error;
    return new Map((data || []).map((row) => [row.conversation_id, Number(row.unread_count || 0)]));
  }
}
