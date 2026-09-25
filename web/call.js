import { RTC_CONFIG } from './config.js';

function sessionKey(callId, peerId) {
  return `${callId}:${peerId}`;
}

export class KaloCallManager {
  constructor(supabase, userId, callbacks = {}) {
    this.supabase = supabase;
    this.userId = userId;
    this.callbacks = callbacks;
    this.channel = null;
    this.sessions = new Map();
    this.pendingIncoming = new Map();
    this.pendingCandidates = new Map();
  }

  emit(type, data = {}) {
    this.callbacks[type]?.(data);
  }

  async start() {
    if (this.channel) return;
    this.channel = this.supabase
      .channel(`kalo-calls-${this.userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'kalo_call_signals',
          filter: `recipient_id=eq.${this.userId}`,
        },
        (payload) => this.handleSignal(payload.new).catch((error) => {
          console.error(error);
          this.emit('onError', { message: error.message || 'Lỗi cuộc gọi.' });
        })
      )
      .subscribe();

    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await this.supabase
      .from('kalo_call_signals')
      .delete()
      .lt('created_at', cutoff)
      .or(`sender_id.eq.${this.userId},recipient_id.eq.${this.userId}`);
  }

  async stop() {
    for (const session of this.sessions.values()) this.closeSession(session, false);
    this.sessions.clear();
    if (this.channel) await this.supabase.removeChannel(this.channel);
    this.channel = null;
  }

  async send(callId, peerId, signalType, payload = {}) {
    const { error } = await this.supabase.from('kalo_call_signals').insert({
      call_id: callId,
      sender_id: this.userId,
      recipient_id: peerId,
      signal_type: signalType,
      payload,
    });
    if (error) throw error;
  }

  async getMedia(mode) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Trình duyệt này không hỗ trợ cuộc gọi.');
    }
    return navigator.mediaDevices.getUserMedia({
      audio: true,
      video: mode === 'video' ? {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 },
      } : false,
    });
  }

  async createSession(callId, peerId, mode, role, stream) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const session = {
      callId,
      peerId,
      mode,
      role,
      pc,
      localStream: stream,
      remoteStream: new MediaStream(),
      muted: false,
      cameraOff: mode !== 'video',
    };
    this.sessions.set(sessionKey(callId, peerId), session);

    for (const track of stream.getTracks()) pc.addTrack(track, stream);

    pc.ontrack = (event) => {
      for (const track of event.streams[0]?.getTracks?.() || [event.track]) {
        if (!session.remoteStream.getTracks().some((t) => t.id === track.id)) {
          session.remoteStream.addTrack(track);
        }
      }
      this.emit('onRemoteStream', { session, stream: session.remoteStream });
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.send(callId, peerId, 'ice', { candidate: event.candidate.toJSON() }).catch(console.error);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.emit('onState', { session, state });
      if (state === 'connected') this.emit('onConnected', { session });
      if (['failed', 'closed', 'disconnected'].includes(state)) {
        if (state === 'failed') {
          this.emit('onError', {
            session,
            message: 'Không kết nối được cuộc gọi trực tiếp. Mạng hiện tại có thể đang chặn WebRTC.',
          });
        }
      }
    };
    return session;
  }

  addPendingCandidate(callId, peerId, candidate) {
    const key = sessionKey(callId, peerId);
    const list = this.pendingCandidates.get(key) || [];
    list.push(candidate);
    this.pendingCandidates.set(key, list);
  }

  async flushCandidates(session) {
    const key = sessionKey(session.callId, session.peerId);
    const list = this.pendingCandidates.get(key) || [];
    this.pendingCandidates.delete(key);
    for (const candidate of list) {
      try { await session.pc.addIceCandidate(candidate); } catch {}
    }
  }

  async startCall(peerId, mode = 'audio') {
    if ([...this.sessions.values()].some((s) => s.pc.connectionState !== 'closed')) {
      throw new Error('Bạn đang có một cuộc gọi khác.');
    }
    const callId = crypto.randomUUID();
    const stream = await this.getMedia(mode);
    const session = await this.createSession(callId, peerId, mode, 'caller', stream);
    await this.send(callId, peerId, 'invite', { mode, createdAt: Date.now() });
    this.emit('onOutgoing', { session });
    return session;
  }

  async accept(callId) {
    const incoming = this.pendingIncoming.get(callId);
    if (!incoming) throw new Error('Cuộc gọi không còn khả dụng.');
    const stream = await this.getMedia(incoming.mode);
    const session = await this.createSession(callId, incoming.peerId, incoming.mode, 'callee', stream);
    this.pendingIncoming.delete(callId);
    await this.send(callId, incoming.peerId, 'accept', { mode: incoming.mode });
    this.emit('onAccepted', { session });
    return session;
  }

  async reject(callId) {
    const incoming = this.pendingIncoming.get(callId);
    if (!incoming) return;
    this.pendingIncoming.delete(callId);
    await this.send(callId, incoming.peerId, 'reject', {});
    this.emit('onEnded', { callId, reason: 'rejected' });
  }

  async createOffer(session) {
    const offer = await session.pc.createOffer();
    await session.pc.setLocalDescription(offer);
    await this.send(session.callId, session.peerId, 'offer', {
      description: session.pc.localDescription,
    });
  }

  async hangup(session, notify = true) {
    if (!session) return;
    if (notify) {
      try { await this.send(session.callId, session.peerId, 'hangup', {}); } catch {}
    }
    this.closeSession(session, true);
  }

  closeSession(session, emit = true) {
    try { session.localStream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { session.remoteStream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { session.pc?.close(); } catch {}
    this.sessions.delete(sessionKey(session.callId, session.peerId));
    if (emit) this.emit('onEnded', { session, reason: 'hangup' });
  }

  toggleMute(session) {
    if (!session) return false;
    session.muted = !session.muted;
    session.localStream.getAudioTracks().forEach((track) => { track.enabled = !session.muted; });
    this.emit('onMediaState', { session });
    return session.muted;
  }

  toggleCamera(session) {
    if (!session || session.mode !== 'video') return true;
    session.cameraOff = !session.cameraOff;
    session.localStream.getVideoTracks().forEach((track) => { track.enabled = !session.cameraOff; });
    this.emit('onMediaState', { session });
    return session.cameraOff;
  }

  async handleSignal(signal) {
    if (!signal || signal.recipient_id !== this.userId) return;
    const callId = signal.call_id;
    const peerId = signal.sender_id;
    const payload = signal.payload || {};
    const key = sessionKey(callId, peerId);
    const session = this.sessions.get(key);

    if (signal.signal_type === 'invite') {
      const incoming = { callId, peerId, mode: payload.mode === 'video' ? 'video' : 'audio' };
      this.pendingIncoming.set(callId, incoming);
      this.emit('onIncoming', incoming);
      return;
    }

    if (signal.signal_type === 'reject') {
      if (session) this.closeSession(session, false);
      this.emit('onEnded', { session, callId, reason: 'rejected' });
      return;
    }

    if (signal.signal_type === 'hangup') {
      if (session) this.closeSession(session, false);
      this.pendingIncoming.delete(callId);
      this.emit('onEnded', { session, callId, reason: 'hangup' });
      return;
    }

    if (signal.signal_type === 'accept') {
      if (!session || session.role !== 'caller') return;
      await this.createOffer(session);
      return;
    }

    if (signal.signal_type === 'offer') {
      if (!session) return;
      await session.pc.setRemoteDescription(payload.description);
      await this.flushCandidates(session);
      const answer = await session.pc.createAnswer();
      await session.pc.setLocalDescription(answer);
      await this.send(callId, peerId, 'answer', {
        description: session.pc.localDescription,
      });
      return;
    }

    if (signal.signal_type === 'answer') {
      if (!session) return;
      await session.pc.setRemoteDescription(payload.description);
      await this.flushCandidates(session);
      return;
    }

    if (signal.signal_type === 'ice') {
      if (!session?.pc?.remoteDescription) {
        this.addPendingCandidate(callId, peerId, payload.candidate);
        return;
      }
      await session.pc.addIceCandidate(payload.candidate);
    }
  }
}
