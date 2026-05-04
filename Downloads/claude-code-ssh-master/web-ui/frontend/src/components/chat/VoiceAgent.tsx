import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AudioWaveform, Loader2, Mic2, PhoneOff, Send, Sparkles, X } from 'lucide-react';
import { apiClient } from '@/lib/api/client';
import { useWebSocket } from '@/lib/hooks/useWebSocket';
import { useChatStore } from '@/lib/store/chatStore';
import { cn } from '@/lib/utils';

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

type VoiceState = 'ready' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';
type TranscriptRole = 'user' | 'assistant' | 'system';

interface TranscriptEntry {
  id: string;
  role: TranscriptRole;
  content: string;
  createdAt: string;
}

interface VoiceSocketPayload {
  type: string;
  state?: VoiceState;
  role?: TranscriptRole;
  content?: string;
  message?: string;
}

const TARGET_SAMPLE_RATE = 24000;

const stateCopy: Record<VoiceState, { label: string; detail: string }> = {
  ready: { label: 'Ready', detail: 'Voice channel standing by' },
  connecting: { label: 'Connecting', detail: 'Opening live channel' },
  listening: { label: 'Listening', detail: 'Speak naturally' },
  thinking: { label: 'Thinking', detail: 'Agent is forming a reply' },
  speaking: { label: 'Speaking', detail: 'Audio response playing' },
  error: { label: 'Interrupted', detail: 'Voice channel needs a restart' },
};

function linear16FromFloat32(input: Float32Array, inputSampleRate: number, outputSampleRate: number) {
  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const buffer = new ArrayBuffer(outputLength * 2);
  const view = new DataView(buffer);

  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sample = 0;
    let count = 0;

    for (let cursor = start; cursor < end; cursor += 1) {
      sample += input[cursor];
      count += 1;
    }

    sample = count > 0 ? sample / count : input[start] || 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }

  return buffer;
}

function float32FromLinear16(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const samples = new Float32Array(Math.floor(buffer.byteLength / 2));

  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  }

  return samples;
}

export function VoiceAgent() {
  const [open, setOpen] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>('ready');
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState('');
  const [isHandoffing, setIsHandoffing] = useState(false);

  const transcriptRef = useRef<TranscriptEntry[]>([]);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const voiceSocketRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const captureContextRef = useRef<AudioContext | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const playbackTimeRef = useRef(0);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);

  const {
    addActivity,
    addConsoleEvent,
    currentSessionId,
  } = useChatStore();
  const { sendMessage, isConnected } = useWebSocket();

  const active = open && ['connecting', 'listening', 'thinking', 'speaking'].includes(voiceState);

  const stopMicrophone = useCallback(() => {
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    silentGainRef.current?.disconnect();
    processorRef.current = null;
    sourceRef.current = null;
    silentGainRef.current = null;

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;

    if (captureContextRef.current?.state !== 'closed') {
      captureContextRef.current?.close().catch(() => undefined);
    }
    captureContextRef.current = null;
  }, []);

  const stopVoice = useCallback((notifyServer = true) => {
    stopMicrophone();

    if (notifyServer && voiceSocketRef.current?.readyState === WebSocket.OPEN) {
      voiceSocketRef.current.send(JSON.stringify({ type: 'close' }));
    }

    voiceSocketRef.current?.close();
    voiceSocketRef.current = null;
    setVoiceState('ready');
  }, [stopMicrophone]);

  const closeOverlay = useCallback(() => {
    stopVoice();
    setIsHandoffing(false);
    setOpen(false);
  }, [stopVoice]);

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  useEffect(() => () => stopVoice(false), [stopVoice]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeOverlay();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeOverlay, open]);

  useEffect(() => {
    if (!open) return;
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [open, transcript]);

  const appendTranscript = useCallback((entry: Omit<TranscriptEntry, 'id' | 'createdAt'>) => {
    setTranscript((current) => {
      const next = [
        ...current,
        {
          ...entry,
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        },
      ].slice(-80);
      transcriptRef.current = next;
      return next;
    });
  }, []);

  const playLinear16 = useCallback(async (buffer: ArrayBuffer) => {
    if (!buffer.byteLength) return;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const context = playbackContextRef.current || new AudioContextClass({ sampleRate: TARGET_SAMPLE_RATE });
    playbackContextRef.current = context;

    if (context.state === 'suspended') {
      await context.resume();
    }

    const samples = float32FromLinear16(buffer);
    const audioBuffer = context.createBuffer(1, samples.length, TARGET_SAMPLE_RATE);
    audioBuffer.copyToChannel(samples, 0);

    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);

    const startAt = Math.max(context.currentTime + 0.02, playbackTimeRef.current);
    source.start(startAt);
    playbackTimeRef.current = startAt + audioBuffer.duration;
  }, []);

  const startMicrophone = useCallback(async (socket: WebSocket) => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const context = new AudioContextClass({ sampleRate: TARGET_SAMPLE_RATE });
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const silentGain = context.createGain();

    silentGain.gain.value = 0;
    processor.onaudioprocess = (event) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const input = event.inputBuffer.getChannelData(0);
      socket.send(linear16FromFloat32(input, context.sampleRate, TARGET_SAMPLE_RATE));
    };

    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(context.destination);

    mediaStreamRef.current = stream;
    captureContextRef.current = context;
    sourceRef.current = source;
    processorRef.current = processor;
    silentGainRef.current = silentGain;
  }, []);

  const startVoice = useCallback(() => {
    stopVoice(false);
    setOpen(true);
    setError('');
    setIsHandoffing(false);
    setTranscript([]);
    transcriptRef.current = [];
    playbackTimeRef.current = 0;
    setVoiceState('connecting');

    const socket = apiClient.connectVoiceWebSocket();
    socket.binaryType = 'arraybuffer';
    voiceSocketRef.current = socket;

    socket.onopen = async () => {
      try {
        await startMicrophone(socket);
        setVoiceState('listening');
        addConsoleEvent({ kind: 'voice', level: 'success', label: 'Voice channel opened' });
      } catch (microphoneError) {
        const message = microphoneError instanceof Error ? microphoneError.message : 'Microphone unavailable';
        setError(message);
        setVoiceState('error');
        addActivity({ label: message, tone: 'danger' });
        addConsoleEvent({ kind: 'voice', level: 'error', label: message });
        stopVoice();
      }
    };

    socket.onmessage = async (event) => {
      if (event.data instanceof ArrayBuffer) {
        setVoiceState('speaking');
        await playLinear16(event.data);
        return;
      }

      if (event.data instanceof Blob) {
        setVoiceState('speaking');
        await playLinear16(await event.data.arrayBuffer());
        return;
      }

      try {
        const payload = JSON.parse(event.data) as VoiceSocketPayload;

        if (payload.type === 'voice_state' && payload.state) {
          setVoiceState(payload.state);
          return;
        }

        if (payload.type === 'voice_ready') {
          setVoiceState('listening');
          return;
        }

        if (payload.type === 'conversation_text' && payload.content) {
          appendTranscript({
            role: payload.role === 'user' ? 'user' : 'assistant',
            content: payload.content,
          });
          setVoiceState(payload.role === 'user' ? 'thinking' : 'speaking');
          return;
        }

        if (payload.type === 'voice_error') {
          const message = payload.message || 'Voice channel error';
          setError(message);
          setVoiceState('error');
          addActivity({ label: message, tone: 'danger' });
          addConsoleEvent({ kind: 'voice', level: 'error', label: message });
        }
      } catch {
        // Ignore unknown non-JSON voice frames.
      }
    };

    socket.onclose = () => {
      stopMicrophone();
      setVoiceState((current) => current === 'error' ? 'error' : 'ready');
    };

    socket.onerror = () => {
      setError('Voice channel failed to connect');
      setVoiceState('error');
      addActivity({ label: 'Voice channel failed to connect', tone: 'danger' });
      addConsoleEvent({ kind: 'voice', level: 'error', label: 'Voice channel failed to connect' });
    };
  }, [
    addActivity,
    addConsoleEvent,
    appendTranscript,
    playLinear16,
    startMicrophone,
    stopMicrophone,
    stopVoice,
  ]);

  const handoffTranscript = async () => {
    const captured = transcriptRef.current.filter((entry) => entry.content.trim());
    stopVoice();

    if (!captured.length) {
      addActivity({ label: 'No voice transcript captured', tone: 'warning' });
      setOpen(false);
      return;
    }

    if (!isConnected) {
      addActivity({ label: 'Agent channel offline, handoff not sent', tone: 'danger' });
      setOpen(false);
      return;
    }

    setIsHandoffing(true);

    try {
      const handoff = await apiClient.createVoiceHandoff({
        sessionId: currentSessionId,
        transcript: captured.map(({ role, content, createdAt }) => ({ role, content, createdAt })),
      });

      sendMessage(handoff.prompt, {
        mode: 'execute',
        approved: true,
        clientActionId: crypto.randomUUID(),
      });
      addActivity({ label: 'Voice handoff sent to Claude Code', tone: 'success' });
      addConsoleEvent({
        kind: 'voice',
        level: 'success',
        label: 'Voice handoff sent',
        metadata: { turns: handoff.turnCount },
      });
    } catch (handoffError) {
      const message = handoffError instanceof Error ? handoffError.message : 'Voice handoff failed';
      addActivity({ label: message, tone: 'danger' });
      addConsoleEvent({ kind: 'voice', level: 'error', label: message });
    } finally {
      setIsHandoffing(false);
      setOpen(false);
    }
  };

  const copy = stateCopy[voiceState];
  const transcriptCount = transcript.length;
  const stateSteps: VoiceState[] = ['listening', 'thinking', 'speaking'];

  return (
    <>
      <button
        className={cn('voice-orb-button', active && 'voice-orb-button-active')}
        onClick={startVoice}
        aria-label="Open voice agent"
        aria-pressed={active}
        title="Voice agent"
      >
        <span className="voice-orb-glow" />
        <span className="voice-orb-ring" />
        <Mic2 className="h-4 w-4" />
      </button>

      {open && (
        <div className="voice-overlay" role="dialog" aria-modal="true" aria-label="Voice agent">
          <div className="voice-modal">
            <div className="voice-modal-header">
              <div>
                <p>Deepgram Voice</p>
                <h2>Live agent channel</h2>
              </div>
              <span className={cn('voice-state-badge', `voice-state-badge-${voiceState}`)}>
                {copy.label}
              </span>
            </div>

            <button className="voice-close" onClick={closeOverlay} aria-label="Close voice agent">
              <X className="h-4 w-4" />
            </button>

            <div className={cn('voice-wave-stage', `voice-wave-${voiceState}`)}>
              <div className="voice-wave-ring" />
              <div className="voice-wave-core">
                {voiceState === 'connecting' ? (
                  <Loader2 className="h-8 w-8 animate-spin" />
                ) : voiceState === 'thinking' ? (
                  <Sparkles className="h-8 w-8" />
                ) : (
                  <AudioWaveform className="h-8 w-8" />
                )}
              </div>
              <div className="voice-meter" aria-hidden="true">
                {Array.from({ length: 18 }).map((_, index) => (
                  <span key={index} style={{ '--bar-index': index } as React.CSSProperties} />
                ))}
              </div>
            </div>

            <div className="voice-state-strip" aria-label="Voice progress">
              {stateSteps.map((step) => (
                <span
                  key={step}
                  className={cn(
                    'voice-state-chip',
                    voiceState === step && 'voice-state-chip-active'
                  )}
                >
                  {stateCopy[step].label}
                </span>
              ))}
            </div>

            <div className="voice-status-copy">
              <p>{copy.label}</p>
              <h3>{copy.detail}</h3>
              {error && <span role="alert">{error}</span>}
            </div>

            <div className="voice-transcript-head">
              <span>Live transcript</span>
              <strong>{transcriptCount} {transcriptCount === 1 ? 'turn' : 'turns'}</strong>
            </div>

            <div className="voice-transcript" aria-live="polite" aria-label="Voice transcript">
              {transcript.length === 0 ? (
                <p className="voice-transcript-empty">Transcript will appear here.</p>
              ) : (
                transcript.map((entry) => (
                  <div key={entry.id} className={cn('voice-turn', `voice-turn-${entry.role}`)}>
                    <strong>{entry.role === 'user' ? 'You' : 'Agent'}</strong>
                    <span>{entry.content}</span>
                  </div>
                ))
              )}
              <div ref={transcriptEndRef} />
            </div>

            <div className="voice-actions">
              <button className="quiet-action" onClick={closeOverlay} disabled={isHandoffing}>
                <PhoneOff className="h-4 w-4" />
                End
              </button>
              <button
                className="primary-action"
                onClick={handoffTranscript}
                disabled={transcript.length === 0 || isHandoffing}
              >
                {isHandoffing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {isHandoffing ? 'Handing off' : 'End & hand off'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
