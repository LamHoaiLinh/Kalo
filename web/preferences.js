export class KaloPreferences {
  constructor(supabase, userId) {
    this.supabase = supabase;
    this.userId = userId;
  }

  async load() {
    const [aliasesRes, categoriesRes, prefsRes, pinsRes] = await Promise.all([
      this.supabase.from('kalo_contact_aliases').select('contact_user_id,alias,updated_at').eq('user_id', this.userId),
      this.supabase.from('kalo_categories').select('id,name,color,sort_order,created_at,updated_at').eq('user_id', this.userId).order('sort_order').order('created_at'),
      this.supabase.from('kalo_conversation_prefs').select('conversation_id,category_id,pinned,muted,archived,updated_at').eq('user_id', this.userId),
      this.supabase.from('kalo_message_pins').select('conversation_id,message_id,created_at').eq('user_id', this.userId).order('created_at', { ascending: false }),
    ]);
    for (const result of [aliasesRes, categoriesRes, prefsRes, pinsRes]) {
      if (result.error) throw result.error;
    }
    return {
      aliases: Object.fromEntries((aliasesRes.data || []).map((x) => [x.contact_user_id, x.alias])),
      categories: categoriesRes.data || [],
      conversationPrefs: Object.fromEntries((prefsRes.data || []).map((x) => [x.conversation_id, x])),
      pins: pinsRes.data || [],
    };
  }

  async replaceAliases(aliases = {}) {
    const rows = Object.entries(aliases)
      .map(([contact_user_id, alias]) => ({
        user_id: this.userId,
        contact_user_id,
        alias: String(alias || '').trim().slice(0, 60),
        updated_at: new Date().toISOString(),
      }))
      .filter((row) => row.alias);
    const { error: deleteError } = await this.supabase.from('kalo_contact_aliases').delete().eq('user_id', this.userId);
    if (deleteError) throw deleteError;
    if (!rows.length) return;
    const { error } = await this.supabase.from('kalo_contact_aliases').insert(rows);
    if (error) throw error;
  }

  async saveAlias(contactUserId, alias) {
    const clean = String(alias || '').trim().slice(0, 60);
    if (!clean) {
      const { error } = await this.supabase.from('kalo_contact_aliases')
        .delete().eq('user_id', this.userId).eq('contact_user_id', contactUserId);
      if (error) throw error;
      return;
    }
    const { error } = await this.supabase.from('kalo_contact_aliases').upsert({
      user_id: this.userId,
      contact_user_id: contactUserId,
      alias: clean,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
  }

  async replaceCategories(categories = [], assignments = {}) {
    const safe = categories.map((item, index) => ({
      id: item.id,
      user_id: this.userId,
      name: String(item.name || 'Phân loại').trim().slice(0, 30) || 'Phân loại',
      color: /^#[0-9a-f]{6}$/i.test(item.color || '') ? item.color : '#43c77a',
      sort_order: index,
      updated_at: new Date().toISOString(),
    }));
    const current = await this.supabase.from('kalo_categories').select('id').eq('user_id', this.userId);
    if (current.error) throw current.error;
    const currentIds = new Set((current.data || []).map((x) => x.id));
    const wantedIds = new Set(safe.map((x) => x.id));
    const stale = [...currentIds].filter((id) => !wantedIds.has(id));
    if (stale.length) {
      const { error } = await this.supabase.from('kalo_categories').delete().eq('user_id', this.userId).in('id', stale);
      if (error) throw error;
    }
    if (safe.length) {
      const { error } = await this.supabase.from('kalo_categories').upsert(safe);
      if (error) throw error;
    }
    for (const [conversationId, categoryId] of Object.entries(assignments || {})) {
      await this.setConversationCategory(conversationId, categoryId || null);
    }
  }

  async saveCategory(item, sortOrder = 0) {
    const { error } = await this.supabase.from('kalo_categories').upsert({
      id: item.id,
      user_id: this.userId,
      name: String(item.name || '').trim().slice(0, 30),
      color: item.color,
      sort_order: sortOrder,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
  }

  async deleteCategory(id) {
    const { error } = await this.supabase.from('kalo_categories').delete().eq('user_id', this.userId).eq('id', id);
    if (error) throw error;
  }

  async setConversationCategory(conversationId, categoryId = null) {
    const { error } = await this.supabase.from('kalo_conversation_prefs').upsert({
      user_id: this.userId,
      conversation_id: conversationId,
      category_id: categoryId || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,conversation_id' });
    if (error) throw error;
  }

  async setConversationFlag(conversationId, field, value) {
    if (!['pinned', 'muted', 'archived'].includes(field)) throw new Error('Cờ hội thoại không hợp lệ.');
    const row = {
      user_id: this.userId,
      conversation_id: conversationId,
      [field]: Boolean(value),
      updated_at: new Date().toISOString(),
    };
    const { error } = await this.supabase.from('kalo_conversation_prefs').upsert(row, { onConflict: 'user_id,conversation_id' });
    if (error) throw error;
  }

  async pinMessage(conversationId, messageId) {
    const { error } = await this.supabase.from('kalo_message_pins').upsert({
      user_id: this.userId,
      conversation_id: conversationId,
      message_id: messageId,
    }, { onConflict: 'user_id,message_id' });
    if (error) throw error;
  }

  async unpinMessage(messageId) {
    const { error } = await this.supabase.from('kalo_message_pins').delete()
      .eq('user_id', this.userId).eq('message_id', messageId);
    if (error) throw error;
  }
}

export function draftKey(userId, conversationId) {
  return `kalo-draft:${userId || 'guest'}:${conversationId || 'none'}`;
}

export function getDraft(userId, conversationId) {
  try { return localStorage.getItem(draftKey(userId, conversationId)) || ''; } catch { return ''; }
}

export function setDraft(userId, conversationId, value) {
  try {
    const key = draftKey(userId, conversationId);
    const text = String(value || '');
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch {}
}

export function clearDraft(userId, conversationId) {
  try { localStorage.removeItem(draftKey(userId, conversationId)); } catch {}
}

export function exportDrafts(userId) {
  const out = {};
  try {
    const prefix = `kalo-draft:${userId}:`;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) out[key.slice(prefix.length)] = localStorage.getItem(key) || '';
    }
  } catch {}
  return out;
}

export function importDrafts(userId, drafts = {}) {
  for (const [conversationId, value] of Object.entries(drafts || {})) {
    setDraft(userId, conversationId, value);
  }
}
