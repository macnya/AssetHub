import { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform, Animated, Easing,
} from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { askAssistant } from '../api';
import { c } from '../theme';

// Questions about the register, answered by the backend.
//
// UNLIKE EVERY OTHER SCREEN, THIS ONE NEEDS A SIGNAL. The rest of the scanner
// queues work and syncs later, because a verification recorded offline is still
// a fact. A question is not — there is nothing to queue, and pretending
// otherwise would leave an officer waiting for an answer that never arrives.
// So this says plainly when it cannot help, and says plainly that the rest of
// the app is unaffected.

const SUGGESTIONS = [
  'What assets are at Head Office?',
  'How many days annual leave do I get?',
  'What do I do with company assets when I leave?',
];

// The face, reused at three sizes: the header, each answer, and the empty
// state. Drawn from plain views — an icon library for one glyph would be a
// dependency the app does not otherwise need.
function BotFace({ size = 40, radius = 12 }) {
  const eye = Math.max(3, size * 0.125);
  const mouthW = size * 0.35;

  return (
    <View style={[
      s.face,
      { width: size, height: size, borderRadius: radius },
    ]}>
      <View style={[s.faceEyes, { gap: size * 0.15, marginBottom: size * 0.125 }]}>
        <View style={[s.faceEye, { width: eye, height: eye, borderRadius: eye / 2 }]} />
        <View style={[s.faceEye, { width: eye, height: eye, borderRadius: eye / 2 }]} />
      </View>
      <View style={[s.faceMouth, { width: mouthW, height: Math.max(2, size * 0.06) }]} />
    </View>
  );
}

// Three dots that fade in turn while an answer is being fetched. A spinner
// says "loading"; this says "thinking", which is closer to what is happening
// and reads as less broken when it takes a moment.
function Thinking() {
  const dots = [useRef(new Animated.Value(0.3)).current,
                useRef(new Animated.Value(0.3)).current,
                useRef(new Animated.Value(0.3)).current];

  useEffect(() => {
    const animations = dots.map((d, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 160),
          Animated.timing(d, { toValue: 1, duration: 320, easing: Easing.ease, useNativeDriver: true }),
          Animated.timing(d, { toValue: 0.3, duration: 320, easing: Easing.ease, useNativeDriver: true }),
          Animated.delay((2 - i) * 160),
        ])
      )
    );
    animations.forEach((a) => a.start());
    return () => animations.forEach((a) => a.stop());
  }, []);

  return (
    <View style={s.thinking}>
      {dots.map((d, i) => (
        <Animated.View key={i} style={[s.thinkingDot, { opacity: d }]} />
      ))}
    </View>
  );
}

export default function AskScreen({ onBack }) {
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(true);
  const scrollRef = useRef(null);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setOnline(Boolean(state.isConnected && state.isInternetReachable !== false));
    });
    return unsubscribe;
  }, []);

  const send = async (text) => {
    const q = (text ?? question).trim();
    if (!q || busy) return;

    setMessages((m) => [...m, { role: 'user', text: q }]);
    setQuestion('');
    setBusy(true);

    try {
      const res = await askAssistant(q);
      setMessages((m) => [...m, { role: 'bot', text: res.answer, sources: res.sources }]);
    } catch (err) {
      // Distinguish "no signal" from "the server said no", because the two
      // need different things from the user.
      const offline = !err.response;
      setMessages((m) => [...m, {
        role: 'bot',
        error: true,
        text: offline
          ? 'I need a connection to answer that.\n\nYour scans and verifications still work offline — only questions need a signal.'
          : err.response?.data?.error || 'I could not answer that. Please try again.',
      }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={s.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
    >
      {/* The header carries the same face as the card that opened it, so the
          screen is recognisably the same thing rather than a generic form. */}
      <View style={s.header}>
        <TouchableOpacity onPress={onBack} style={s.backButton} activeOpacity={0.6}>
          <Text style={s.backChevron}>‹</Text>
        </TouchableOpacity>

        <BotFace size={32} radius={10} />

        <View style={s.headerCopy}>
          <Text style={s.headerTitle}>Ask the register</Text>
          <View style={s.headerStatus}>
            <View style={[s.statusDot, !online && s.statusDotOff]} />
            <Text style={s.headerSub}>{online ? 'Online' : 'No connection'}</Text>
          </View>
        </View>
      </View>

      <ScrollView
        ref={scrollRef}
        style={s.body}
        contentContainerStyle={s.bodyInner}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        {messages.length === 0 && (
          <View style={s.empty}>
            <BotFace size={64} radius={20} />
            <Text style={s.emptyTitle}>What would you like to know?</Text>
            <Text style={s.emptyText}>
              Assets, who holds what, and HR or ICT policy. Answers cover whatever your
              own role and branch allow.
            </Text>

            {SUGGESTIONS.map((sug) => (
              <TouchableOpacity key={sug} style={s.chip} onPress={() => send(sug)} activeOpacity={0.7}>
                <Text style={s.chipText}>{sug}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {messages.map((m, i) => (
          m.role === 'user' ? (
            <View key={i} style={s.userRow}>
              <View style={s.userBubble}>
                <Text style={s.userText}>{m.text}</Text>
              </View>
            </View>
          ) : (
            <View key={i} style={s.botRow}>
              <BotFace size={26} radius={9} />
              <View style={[s.botBubble, m.error && s.botBubbleError]}>
                <Text style={[s.botText, m.error && s.botTextError]}>{m.text}</Text>
                {m.sources?.length > 0 && (
                  <Text style={s.sources}>from {m.sources.slice(0, 3).join(', ')}</Text>
                )}
              </View>
            </View>
          )
        ))}

        {busy && (
          <View style={s.botRow}>
            <BotFace size={26} radius={9} />
            <View style={s.botBubble}>
              <Thinking />
            </View>
          </View>
        )}
      </ScrollView>

      {!online && (
        <View style={s.offlineBar}>
          <Text style={s.offlineText}>
            Questions need a signal. Scanning and verifying still work offline.
          </Text>
        </View>
      )}

      <View style={s.inputRow}>
        <TextInput
          style={s.input}
          value={question}
          onChangeText={setQuestion}
          placeholder="Ask a question…"
          placeholderTextColor={c.inkFaint}
          maxLength={500}
          editable={!busy}
          returnKeyType="send"
          onSubmitEditing={() => send()}
        />
        <TouchableOpacity
          style={[s.send, (busy || !question.trim()) && s.sendDisabled]}
          onPress={() => send()}
          disabled={busy || !question.trim()}
          activeOpacity={0.8}
        >
          <Text style={s.sendArrow}>↑</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.surface },

  // ---- the face -----------------------------------------------------------
  face: { backgroundColor: c.brand, alignItems: 'center', justifyContent: 'center' },
  faceEyes: { flexDirection: 'row' },
  faceEye: { backgroundColor: c.paper },
  faceMouth: { backgroundColor: c.paper, opacity: 0.85, borderRadius: 2 },

  // ---- header -------------------------------------------------------------
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingLeft: 4, paddingRight: 16, paddingVertical: 10,
    backgroundColor: c.deep,
  },
  backButton: { paddingHorizontal: 10, paddingVertical: 4 },
  backChevron: { fontSize: 30, lineHeight: 32, color: c.paper, fontWeight: '300' },
  headerCopy: { marginLeft: 11 },
  headerTitle: { fontSize: 15.5, fontWeight: '700', color: c.paper },
  headerStatus: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#4ADE80', marginRight: 6 },
  statusDotOff: { backgroundColor: '#F59E0B' },
  headerSub: { fontSize: 11.5, color: 'rgba(255,255,255,0.62)' },

  // ---- conversation -------------------------------------------------------
  body: { flex: 1 },
  bodyInner: { padding: 16, paddingBottom: 8 },

  empty: { alignItems: 'center', paddingTop: 24, paddingHorizontal: 6 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: c.ink, marginTop: 16, textAlign: 'center' },
  emptyText: {
    fontSize: 13.5, color: c.inkSoft, lineHeight: 20,
    textAlign: 'center', marginTop: 8, marginBottom: 22,
  },

  chip: {
    alignSelf: 'stretch',
    backgroundColor: c.paper, borderRadius: 12, borderWidth: 1, borderColor: c.rule,
    paddingVertical: 13, paddingHorizontal: 15, marginBottom: 9,
  },
  chipText: { fontSize: 14, color: c.ink },

  userRow: { alignItems: 'flex-end', marginBottom: 12 },
  userBubble: {
    backgroundColor: c.deep, borderRadius: 16, borderBottomRightRadius: 5,
    paddingVertical: 11, paddingHorizontal: 14, maxWidth: '85%',
  },
  userText: { color: c.paper, fontSize: 14.5, lineHeight: 21 },

  botRow: { flexDirection: 'row', alignItems: 'flex-end', marginBottom: 12, paddingRight: 30 },
  botBubble: {
    backgroundColor: c.paper, borderRadius: 16, borderBottomLeftRadius: 5,
    paddingVertical: 11, paddingHorizontal: 14, marginLeft: 9, flexShrink: 1,
    borderWidth: 1, borderColor: c.rule,
  },
  botBubbleError: { backgroundColor: '#FDECEA', borderColor: '#F5C6C0' },
  botText: { color: c.ink, fontSize: 14.5, lineHeight: 21 },
  botTextError: { color: c.faulty },

  sources: {
    fontSize: 11, color: c.inkFaint, marginTop: 7,
    paddingTop: 6, borderTopWidth: 1, borderTopColor: c.rule,
  },

  thinking: { flexDirection: 'row', gap: 5, paddingVertical: 4 },
  thinkingDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: c.inkFaint },

  // ---- offline ------------------------------------------------------------
  offlineBar: { backgroundColor: '#FDF3E3', paddingHorizontal: 16, paddingVertical: 9 },
  offlineText: { fontSize: 12, color: '#B26A00', lineHeight: 17 },

  // ---- input --------------------------------------------------------------
  inputRow: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 9,
    paddingHorizontal: 12, paddingTop: 10, paddingBottom: 16,
    backgroundColor: c.paper, borderTopWidth: 1, borderTopColor: c.rule,
  },
  input: {
    flex: 1, borderWidth: 1, borderColor: c.rule, borderRadius: 22,
    paddingHorizontal: 16, paddingVertical: 11, fontSize: 15,
    color: c.ink, backgroundColor: c.surface, maxHeight: 100,
  },
  send: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: c.brand, alignItems: 'center', justifyContent: 'center',
  },
  sendDisabled: { backgroundColor: c.rule },
  sendArrow: { color: c.paper, fontSize: 20, fontWeight: '700', lineHeight: 23 },
});