import { FILE_CHUNK_SIZE, MAX_LOCAL_BLOB_FALLBACK, RTC_CONFIG } from './config.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function keyOf(transferId, peerId) {
  return `${transferId}:${peerId}`;
}

async function createReceiveTarget(meta) {
  if ('showSaveFilePicker' in window) {
    const handle = await window.showSaveFilePicker({
      suggestedName: meta.name || 'kalo-file',
    });
    const writable = await handle.createWritable();
    return { mode: 'stream', writable, meta, received: 0 };
  }

  if ((meta.size || 0) > MAX_LOCAL_BLOB_FALLBACK) {
    throw new Error('Trình duyệt này không hỗ trợ ghi file lớn trực tiếp. Hãy dùng Chrome/Edge trên máy tính.');
  }
  return { mode: 'memory', chunks: [], meta, received: 0 };
}

async function finishReceiveTarget(target) {
  if (target.mode === 'stream') {
    await target.writable.close();
    return;
  }
  const blob = new Blob(target.chunks, { type: target.meta.type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = target.meta.name || 'kalo-file';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export class KaloFileTransfer {
  constructor(supabase, userId, callbacks = {}) {
    this.supabase = supabase;
    this.userId = userId;
    this.callbacks = callbacks;
    this.outgoingFiles = new Map();
    this.receiveTargets = new Map();
    this.sessions = new Map();
    this.pendingCandidates = new Map();
    this.channel = null;
  }

  status(info) {
    this.callbacks.onStatus?.(info);
  }

  async start() {
    if (this.channel) return;
    this.channel = this.supabase
      .channel(`kalo-file-signals-${this.userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'kalo_webrtc_signals',
          filter: `recipient_id=eq.${this.userId}`,
        },
        (payload) => this.handleSignal(payload.new).catch((error) => {
          console.error(error);
          this.status({ type: 'error', message: error.message });
        })
      )
      .subscribe();

    // Xóa tín hiệu cũ của chính thiết bị để bảng không phình lên.
    const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    await this.supabase
      .from('kalo_webrtc_signals')
      .delete()
      .lt('created_at', cutoff)
      .or(`sender_id.eq.${this.userId},recipient_id.eq.${this.userId}`);
  }

  async stop() {
    for (const session of this.sessions.values()) {
      try { session.pc.close(); } catch {}
    }
    this.sessions.clear();
    if (this.channel) await this.supabase.removeChannel(this.channel);
    this.channel = null;
  }

  registerOutgoing(transferId, file) {
    this.outgoingFiles.set(transferId, file);
    this.status({ type: 'ready', transferId, message: 'File đang sẵn sàng để người nhận tải trực tiếp.' });
  }

  async requestReceive(transferId, senderId, meta) {
    const target = await createReceiveTarget(meta);
    this.receiveTargets.set(transferId, target);
    await this.sendSignal(transferId, senderId, 'request', { requestedAt: Date.now() });
    this.status({ type: 'waiting', transferId, message: 'Đang chờ máy người gửi kết nối...' });
  }

  async sendSignal(transferId, recipientId, signalType, payload = {}) {
    const { error } = await this.supabase.from('kalo_webrtc_signals').insert({
      transfer_id: transferId,
      sender_id: this.userId,
      recipient_id: recipientId,
      signal_type: signalType,
      payload,
    });
    if (error) throw error;
  }

  addPendingCandidate(transferId, peerId, candidate) {
    const key = keyOf(transferId, peerId);
    const list = this.pendingCandidates.get(key) || [];
    list.push(candidate);
    this.pendingCandidates.set(key, list);
  }

  async flushCandidates(transferId, peerId, pc) {
    const key = keyOf(transferId, peerId);
    const list = this.pendingCandidates.get(key) || [];
    this.pendingCandidates.delete(key);
    for (const candidate of list) {
      try { await pc.addIceCandidate(candidate); } catch (error) { console.warn(error); }
    }
  }

  createPeer(transferId, peerId, role) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const session = { pc, peerId, transferId, role, dc: null };
    this.sessions.set(keyOf(transferId, peerId), session);

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.sendSignal(transferId, peerId, 'ice', { candidate: event.candidate.toJSON() }).catch(console.error);
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.status({ type: 'connection', transferId, state });
      if (state === 'failed') {
        this.status({
          type: 'error',
          transferId,
          message: 'Mạng hiện tại không cho hai máy kết nối trực tiếp. Hãy thử mạng khác hoặc bật hotspot.',
        });
      }
      if (['closed', 'failed'].includes(state)) this.sessions.delete(keyOf(transferId, peerId));
    };
    return session;
  }

  async handleSignal(signal) {
    if (!signal || signal.recipient_id !== this.userId) return;
    const transferId = signal.transfer_id;
    const peerId = signal.sender_id;
    const payload = signal.payload || {};
    const sessionKey = keyOf(transferId, peerId);

    if (signal.signal_type === 'request') {
      const file = this.outgoingFiles.get(transferId);
      if (!file) {
        await this.sendSignal(transferId, peerId, 'cancel', {
          reason: 'Máy người gửi không còn giữ file này.',
        });
        return;
      }
      await this.startSender(transferId, peerId, file);
      return;
    }

    if (signal.signal_type === 'offer') {
      const target = this.receiveTargets.get(transferId);
      if (!target) return;
      const session = this.createPeer(transferId, peerId, 'receiver');
      session.pc.ondatachannel = (event) => {
        session.dc = event.channel;
        this.bindReceiverChannel(session, target);
      };
      await session.pc.setRemoteDescription(payload.description);
      await this.flushCandidates(transferId, peerId, session.pc);
      const answer = await session.pc.createAnswer();
      await session.pc.setLocalDescription(answer);
      await this.sendSignal(transferId, peerId, 'answer', {
        description: session.pc.localDescription,
      });
      return;
    }

    if (signal.signal_type === 'answer') {
      const session = this.sessions.get(sessionKey);
      if (!session) return;
      await session.pc.setRemoteDescription(payload.description);
      await this.flushCandidates(transferId, peerId, session.pc);
      return;
    }

    if (signal.signal_type === 'ice') {
      const session = this.sessions.get(sessionKey);
      if (!session?.pc?.remoteDescription) {
        this.addPendingCandidate(transferId, peerId, payload.candidate);
        return;
      }
      await session.pc.addIceCandidate(payload.candidate);
      return;
    }

    if (signal.signal_type === 'cancel') {
      this.status({
        type: 'error',
        transferId,
        message: payload.reason || 'Người gửi đã hủy truyền file.',
      });
      return;
    }

    if (signal.signal_type === 'done') {
      this.status({ type: 'done', transferId, message: 'Truyền file hoàn tất.' });
    }
  }

  async startSender(transferId, recipientId, file) {
    const existing = this.sessions.get(keyOf(transferId, recipientId));
    if (existing) {
      try { existing.pc.close(); } catch {}
    }

    const session = this.createPeer(transferId, recipientId, 'sender');
    const dc = session.pc.createDataChannel('kalo-file', { ordered: true });
    session.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 2 * 1024 * 1024;

    dc.onopen = () => {
      this.sendFile(session, file).catch((error) => {
        console.error(error);
        this.status({ type: 'error', transferId, message: error.message });
      });
    };

    const offer = await session.pc.createOffer();
    await session.pc.setLocalDescription(offer);
    await this.sendSignal(transferId, recipientId, 'offer', {
      description: session.pc.localDescription,
    });
    await this.flushCandidates(transferId, recipientId, session.pc);
  }

  bindReceiverChannel(session, target) {
    const { dc, transferId, peerId } = session;
    dc.binaryType = 'arraybuffer';

    dc.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.t === 'done') {
          await finishReceiveTarget(target);
          this.receiveTargets.delete(transferId);
          this.status({ type: 'done', transferId, message: 'Đã nhận xong file.' });
          await this.sendSignal(transferId, peerId, 'done', { received: target.received });
          try { session.pc.close(); } catch {}
        }
        return;
      }

      const bytes = new Uint8Array(event.data);
      target.received += bytes.byteLength;
      if (target.mode === 'stream') {
        await target.writable.write(bytes);
      } else {
        target.chunks.push(bytes);
      }
      this.status({
        type: 'progress',
        transferId,
        direction: 'receive',
        loaded: target.received,
        total: target.meta.size || 0,
      });
    };

    dc.onerror = () => {
      this.status({ type: 'error', transferId, message: 'Kết nối truyền file bị gián đoạn.' });
    };
  }

  async waitForBuffer(dc) {
    if (dc.bufferedAmount <= 8 * 1024 * 1024) return;
    await new Promise((resolve) => {
      const done = () => {
        dc.removeEventListener('bufferedamountlow', done);
        resolve();
      };
      dc.addEventListener('bufferedamountlow', done, { once: true });
      setTimeout(done, 3000);
    });
  }

  async sendFile(session, file) {
    const { dc, transferId, peerId } = session;
    dc.send(JSON.stringify({
      t: 'meta',
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
    }));

    const reader = file.stream().getReader();
    let sent = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      let offset = 0;
      while (offset < value.byteLength) {
        const end = Math.min(offset + FILE_CHUNK_SIZE, value.byteLength);
        const part = value.subarray(offset, end);
        await this.waitForBuffer(dc);
        dc.send(part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength));
        sent += part.byteLength;
        offset = end;
        this.status({
          type: 'progress',
          transferId,
          direction: 'send',
          loaded: sent,
          total: file.size,
        });
        if (dc.readyState !== 'open') throw new Error('Kết nối truyền file đã đóng.');
      }
    }
    while (dc.bufferedAmount > 0) {
      await this.waitForBuffer(dc);
      await sleep(50);
    }
    dc.send(JSON.stringify({ t: 'done' }));
    this.status({ type: 'done', transferId, message: 'Đã gửi xong file.' });
    await this.sendSignal(transferId, peerId, 'done', { sent });
    setTimeout(() => {
      try { session.pc.close(); } catch {}
    }, 1500);
  }
}
